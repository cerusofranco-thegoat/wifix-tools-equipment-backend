import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import {
  getAcsConnector,
  getIspMonitorConnector,
  getRmsConnector,
  getNearbyNaps,
  getNapPortsByRef,
} from '../../connectors/index.js';
import { findCurrentNap } from './current-nap.service.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

/**
 * `napRef`: id numérico de FSM (`/^\d+$/`) o código de NAP (camino TEC).
 * El frontend envía `nap.napId ?? nap.napCode`.
 */
const napParamsSchema = z.object({
  napRef: z.string().min(1, 'napRef es obligatorio.'),
});

const napPortsQuerySchema = z.object({
  brand: z.string().optional(),
  // Escape hatch para probe-fsm-api.ts y soporte: la webapp NO lo envía nunca.
  withStatus: z.enum(['0', '1']).optional(),
});

/**
 * Coordenada desde la que se buscan NAPs (GPS del técnico o de la tarea).
 *
 * La operadora confirmó (2026-09-09) que `/naps/nearest` no impone tope de
 * `meters` ni de `maxRows`, pero pidió **pedir solo la NAP más cercana a las
 * coordenadas del cliente**. De ahí el default conservador de `maxRows`
 * (`NEARBY_NAPS_DEFAULTS`, 3 en vez de 5).
 *
 * El tope de 25 NO se toca: el panel NAP de la webapp ofrece 5/10/20 filas y
 * bajarlo rompería esa opción con un 400. Quien pide más filas es el técnico,
 * a propósito; lo que se evita es que el default barra el sector entero.
 */
const coordsQuerySchema = z.object({
  lat: z.coerce.number().gte(-90).lte(90),
  lng: z.coerce.number().gte(-180).lte(180),
  meters: z.coerce.number().int().gte(1).lte(2000).optional(),
  maxRows: z.coerce.number().int().gte(1).lte(25).optional(),
  brand: z.string().optional(),
});

/**
 * `lat`/`lng` opcionales: override de la coordenada (GPS del técnico). Van
 * juntos; sin ellos se usa la del cliente en FSM.
 */
/** `?lat=` vacío cuenta como ausente: `z.coerce.number('')` daría 0, no un error. */
const blankAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const currentNapQuerySchema = z
  .object({
    lat: z.preprocess(blankAsUndefined, z.coerce.number().gte(-90).lte(90).optional()),
    lng: z.preprocess(blankAsUndefined, z.coerce.number().gte(-180).lte(180).optional()),
    brand: z.string().optional(),
    // `simulated` (default): si no se identifica la NAP real, la asignada
    // simulada. `none`: comportamiento estricto (found:false / 503).
    fallback: z.preprocess(blankAsUndefined, z.enum(['simulated', 'none']).optional()),
  })
  .refine((q) => (q.lat === undefined) === (q.lng === undefined), {
    message: 'lat y lng van juntos: envía ambos o ninguno.',
    path: ['lat'],
  })
  // (0,0) es el "vacío" de los sistemas legados, no un GPS válido (ver
  // `isUsableCoord` en current-nap.service.ts).
  .refine((q) => !(q.lat === 0 && q.lng === 0), {
    message: 'La coordenada (0,0) no es válida.',
    path: ['lat'],
  });

/** Radio y número de NAPs que se piden si el cliente no especifica nada. */
const NEARBY_NAPS_DEFAULTS = { meters: 100, maxRows: 3 } as const;

const terminalParamsSchema = z.object({
  id: z.string().min(1, 'El serial GPON o la MAC del cablemódem es obligatorio.'),
});

/**
 * Pista de tecnología (`?technology=`): la app la conoce por el modelo del
 * equipo o el tipo de código escaneado. Solo se usa si la ficha de ISP Monitor
 * no trae `type` explícito. Acepta sinónimos: ONT/ONU/XPON/FIBRA → GPON;
 * CABLEMODEM/DOCSIS → HFC.
 */
const technologyQuerySchema = z.object({
  technology: z
    .preprocess(
      (v) => {
        if (typeof v !== 'string' || v.trim() === '') return undefined;
        const t = v.trim().toUpperCase();
        if (['GPON', 'ONT', 'ONU', 'XPON', 'FIBRA', 'FTTH'].includes(t)) return 'GPON';
        if (['HFC', 'CABLEMODEM', 'CM', 'DOCSIS'].includes(t)) return 'HFC';
        return t;
      },
      z.enum(['HFC', 'GPON'], {
        errorMap: () => ({ message: 'technology debe ser HFC o GPON (o ONT/ONU/XPON/CABLEMODEM).' }),
      }).optional(),
    ),
});

const seriesParamsSchema = terminalParamsSchema.extend({
  scope: z.enum(['terminal', 'network']),
  metric: z.enum(['status', 'snr', 'codewords']),
});

const wifiBandUpdateSchema = z.object({
  band: z.enum(['2.4GHz', '5GHz']),
  ssid: z.string().min(1, 'El SSID es obligatorio.').max(32, 'El SSID excede 32 caracteres.'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres.')
    .max(63, 'La contraseña excede 63 caracteres.')
    .optional(),
});

const wifiConfigUpdateSchema = z.object({
  bands: z
    .array(wifiBandUpdateSchema)
    .min(1, 'Indica al menos una banda a actualizar.')
    .refine(
      (bands) => new Set(bands.map((b) => b.band)).size === bands.length,
      { message: 'No repitas la misma banda dos veces.' },
    ),
});

export async function registerNetworkDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  // --- Campo 6: NAPs cercanas a una coordenada ------------------------------
  app.get('/naps/nearby', async (request, reply) => {
    const { lat, lng, meters, maxRows, brand } = parseQuery(coordsQuerySchema, request.query);
    const result = await getNearbyNaps(
      { latitude: lat, longitude: lng },
      {
        brand: brandFromRequest(request, brand),
        meters: meters ?? NEARBY_NAPS_DEFAULTS.meters,
        maxRows: maxRows ?? NEARBY_NAPS_DEFAULTS.maxRows,
        rangeRequested: meters !== undefined || maxRows !== undefined,
      },
    );
    // La respuesta es un array desnudo (contrato histórico): el aviso de
    // degradación viaja en un header, no en el cuerpo.
    if (result.degraded) {
      reply.header('X-Wifix-Degraded', encodeURIComponent(JSON.stringify(result.degraded)));
    }
    return result.naps;
  });

  // --- Campo 8 (paso 1): puertos ocupados por NAP ----------------------------
  // UNA sola llamada upstream: los estados A/S/T/O/P se piden aparte con
  // POST /accounts/status-batch (automático desde 2026-10-06, solo para las 2
  // NAPs más cercanas, lotes ≤ 12, cache 5 min).
  app.get('/naps/:napRef/ports', async (request) => {
    const { napRef } = parseParams(napParamsSchema, request.params);
    const { brand, withStatus } = parseQuery(napPortsQuerySchema, request.query);
    return getNapPortsByRef(napRef, {
      brand: brandFromRequest(request, brand),
      withStatus: withStatus === '1',
    });
  });

  // --- NAP y puerto actuales de la cuenta (búsqueda inversa) -----------------
  // FSM no expone el dato: nearest (150 m, 3 filas) + `/naps/accounts` NAP por
  // NAP hasta encontrarla. Ver `current-nap.service.ts` para el presupuesto.
  app.get('/accounts/:accountNumber/current-nap', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { lat, lng, brand, fallback } = parseQuery(currentNapQuerySchema, request.query);
    const result = await findCurrentNap(accountNumber, {
      brand: brandFromRequest(request, brand),
      fallback: fallback ?? 'simulated',
      ...(lat !== undefined && lng !== undefined
        ? { coords: { latitude: lat, longitude: lng } }
        : {}),
    });
    if (result.degraded) {
      reply.header('X-Wifix-Degraded', encodeURIComponent(JSON.stringify(result.degraded)));
    }
    return result;
  });

  // --- Campos 9-13: ISP Monitor por serial GPON / MAC HFC -------------------
  // Estado del equipo, de la red y evento asociado.
  app.get('/terminals/:id', async (request) => {
    const { id } = parseParams(terminalParamsSchema, request.params);
    const { technology } = parseQuery(technologyQuerySchema, request.query);
    return getIspMonitorConnector().getTerminal(id, technology ? { technology } : {});
  });

  // Panel completo: ficha + series de 24 h que aplican a la tecnología +
  // bloque `docsis` (HFC) o `gpon` (GPON) + caídas con hora exacta.
  app.get('/terminals/:id/diagnostics', async (request) => {
    const { id } = parseParams(terminalParamsSchema, request.params);
    const { technology } = parseQuery(technologyQuerySchema, request.query);
    return getIspMonitorConnector().getDiagnostics(id, technology ? { technology } : {});
  });

  // Serie individual: /terminals/HWTC123/series/terminal/snr
  app.get('/terminals/:id/series/:scope/:metric', async (request) => {
    const { id, scope, metric } = parseParams(seriesParamsSchema, request.params);
    return getIspMonitorConnector().getSeries(id, scope, metric);
  });

  app.get('/accounts/:accountNumber/network-metrics', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getIspMonitorConnector().getNetworkMetrics(accountNumber);
  });

  app.get('/accounts/:accountNumber/node-events', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getRmsConnector().getNodeEvents(accountNumber);
  });

  app.get('/accounts/:accountNumber/lan-devices', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getLanDevices(accountNumber);
  });

  app.get('/accounts/:accountNumber/wifi-devices', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getWifiDevices(accountNumber);
  });

  app.get('/accounts/:accountNumber/wifi-config', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getWifiConfig(accountNumber);
  });

  app.put('/accounts/:accountNumber/wifi-config', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(wifiConfigUpdateSchema, request.body);
    const user = getAuthUser(request);
    request.log.info(
      {
        user: user.id,
        accountNumber,
        action: 'updateWifiConfig',
        bands: body.bands.map((b) => b.band),
      },
      'PUT wifi-config',
    );
    return getAcsConnector().updateWifiConfig(accountNumber, body);
  });
}
