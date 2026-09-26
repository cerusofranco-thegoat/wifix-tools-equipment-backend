// Campos 1-5 y 7 — respuesta COMPUESTA (ver ADR-07).
//
// La identidad (nombres, dirección, teléfonos, email, coordenada) sale de FSM
// `/account/process`; el plan y la velocidad contratada siguen viniendo del
// mock de Comarch, porque `fsm-data-ms` no los expone y quitarlos de la pantalla
// sería una regresión visible. El bloque `sources` dice, campo por campo, de
// dónde salió cada dato para que la UI marque lo simulado.
//
// Con FSM en `real` (decisión de Franco, 2026-09-26) la identidad NUNCA se
// inventa: lo que FSM no trae sale `null` con `sources.<campo>='NONE'`. El
// nombre tiene un respaldo real: la whitelist de clientes de Xtrim
// (`sources.fullName='WHITELIST'`). Plan y velocidades siguen del mock.
// En `mock` y `fixture` no cambia nada: son modos de demo declarados.
//
// El PUT no cambia de fondo: FSM es de solo lectura y sigue escribiendo en
// Comarch (mock).

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { connectorMode } from '../../config/env.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import { ApiError } from '../../middleware/error-handler.js';
import {
  getClientProfileOverrides,
  getComarchConnector,
  getFsmConnector,
  type AccountOrders,
  type ClientProfile,
  type Degraded,
} from '../../connectors/index.js';
import type { FsmBrand } from '../../connectors/http/fsm-token.js';
import { findWhitelistFullName } from '../whitelist/whitelist.service.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

const brandQuerySchema = z.object({
  brand: z.string().optional(),
});

const clientProfileUpdateSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    phones: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => v.fullName !== undefined || v.address !== undefined || v.phones !== undefined, {
    message: 'Indica al menos un campo a actualizar (fullName, address o phones).',
  });

/** De dónde salió cada campo del perfil. */
type FieldSource = 'FSM' | 'MOCK' | 'COMARCH' | 'WHITELIST' | 'NONE';

interface ComposedClientProfile {
  accountNumber: string;
  /** `null` solo con FSM real sin nombre y sin respaldo en la whitelist. */
  fullName: string | null;
  address: string | null;
  phones: string[] | null;
  planName: string;
  contractedDownloadMbps: number;
  contractedUploadMbps: number;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  sources: Record<string, FieldSource>;
}

interface EditedFields {
  fullName?: boolean;
  address?: boolean;
  phones?: boolean;
}

interface ComposeOptions {
  /**
   * FSM real: nada de identidad inventada. Lo que FSM no trae queda `null` /
   * `NONE` (salvo lo editado a mano con el PUT, que es dato del técnico).
   */
  strict: boolean;
  /** Nombre de la whitelist, respaldo de `fullName` en modo estricto. */
  whitelistName?: string | null;
}

/**
 * Compone el perfil: lo editado a mano (PUT) manda sobre FSM, y FSM manda sobre
 * el mock de Comarch. El plan y las velocidades son siempre del mock.
 *
 * En modo estricto (FSM real) el mock de Comarch NO rellena identidad: el
 * orden es editado → FSM → (solo fullName) whitelist → `null`/`NONE`.
 */
function composeProfile(
  base: ClientProfile,
  fsm: AccountOrders | null,
  edited: EditedFields,
  opts: ComposeOptions = { strict: false },
): ComposedClientProfile {
  const client = fsm?.client ?? null;
  const sources: Record<string, FieldSource> = {};
  const plan = {
    planName: base.planName,
    contractedDownloadMbps: base.contractedDownloadMbps,
    contractedUploadMbps: base.contractedUploadMbps,
  };

  if (opts.strict) {
    let fullName: string | null = null;
    if (edited.fullName) {
      fullName = base.fullName;
      sources.fullName = 'MOCK';
    } else if (client?.names) {
      fullName = client.names;
      sources.fullName = 'FSM';
    } else if (opts.whitelistName) {
      fullName = opts.whitelistName;
      sources.fullName = 'WHITELIST';
    } else {
      sources.fullName = 'NONE';
    }

    let address: string | null = null;
    if (edited.address) {
      address = base.address;
      sources.address = 'MOCK';
    } else if (client?.address) {
      address = client.address;
      sources.address = 'FSM';
    } else {
      sources.address = 'NONE';
    }

    let phones: string[] | null = null;
    if (edited.phones) {
      phones = base.phones ?? [];
      sources.phones = 'MOCK';
    } else if (client?.phoneNumber) {
      phones = [client.phoneNumber];
      sources.phones = 'FSM';
    } else {
      sources.phones = 'NONE';
    }

    const email = client?.email ?? null;
    const latitude = client?.latitude ?? null;
    const longitude = client?.longitude ?? null;
    sources.email = email !== null ? 'FSM' : 'NONE';
    sources.latitude = latitude !== null ? 'FSM' : 'NONE';
    sources.longitude = longitude !== null ? 'FSM' : 'NONE';
    sources.planName = 'MOCK';
    sources.contractedDownloadMbps = 'MOCK';
    sources.contractedUploadMbps = 'MOCK';

    return {
      accountNumber: base.accountNumber,
      fullName,
      address,
      phones,
      ...plan,
      email,
      latitude,
      longitude,
      sources,
    };
  }

  // --- mock / fixture: comportamiento histórico, sin cambios ---------------
  const useFsmName = !edited.fullName && Boolean(client?.names);
  const fullName = useFsmName ? (client?.names as string) : base.fullName;
  sources.fullName = useFsmName ? 'FSM' : 'MOCK';

  const useFsmAddress = !edited.address && Boolean(client?.address);
  const address = useFsmAddress ? (client?.address as string) : base.address;
  sources.address = useFsmAddress ? 'FSM' : 'MOCK';

  // FSM solo trae `phoneNumber`: se expone como array de un elemento. Nunca null.
  const useFsmPhones = !edited.phones && Boolean(client?.phoneNumber);
  const phones = useFsmPhones ? [client?.phoneNumber as string] : (base.phones ?? []);
  sources.phones = useFsmPhones ? 'FSM' : 'MOCK';

  sources.email = client ? 'FSM' : 'MOCK';
  sources.latitude = client ? 'FSM' : 'MOCK';
  sources.longitude = client ? 'FSM' : 'MOCK';
  sources.planName = 'MOCK';
  sources.contractedDownloadMbps = 'MOCK';
  sources.contractedUploadMbps = 'MOCK';

  return {
    accountNumber: base.accountNumber,
    fullName,
    address,
    phones,
    ...plan,
    email: client?.email ?? null,
    latitude: client?.latitude ?? null,
    longitude: client?.longitude ?? null,
    sources,
  };
}

function editedFields(accountNumber: string): EditedFields {
  const override = getClientProfileOverrides(accountNumber);
  return {
    fullName: override?.fullName !== undefined,
    address: override?.address !== undefined,
    phones: override?.phones !== undefined,
  };
}

/** Órdenes de la cuenta en FSM. Una sola llamada, cacheada 60 s. */
function fetchFsmOrders(accountNumber: string, brand: FsmBrand): Promise<AccountOrders> {
  return getFsmConnector().getAccountOrders(accountNumber, { brand, estado: 'Todas' });
}

/**
 * Órdenes de FSM tolerando la indisponibilidad del sistema de la operadora.
 *
 * - Fallo de token (503 `UPSTREAM_AUTH_ERROR`): se propaga tal cual, con su
 *   `meta.reason` (MISSING / EXPIRED / REJECTED). NUNCA sale como 401 ni 404.
 * - Timeout, error de red o 5xx de FSM (hoy 502 `CONNECTOR_ERROR`): se traduce a
 *   503 `UPSTREAM_UNAVAILABLE`, también con `meta.reason`. Que la operadora no
 *   conteste no significa que la cuenta no exista.
 * - Cualquier otro error (validación, por ejemplo) se propaga sin tocar.
 */
async function fetchFsmOrdersOrUnavailable(
  accountNumber: string,
  brand: FsmBrand,
): Promise<AccountOrders> {
  try {
    return await fetchFsmOrders(accountNumber, brand);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'CONNECTOR_ERROR') {
      throw ApiError.upstreamUnavailable({
        integration: 'FSM',
        brand,
        reason: 'UPSTREAM_ERROR',
        detail: err.message,
      });
    }
    throw err;
  }
}

/**
 * Aviso de que el perfil se compuso SIN los datos de FSM: los campos de
 * identidad salen del mock (ver `sources`). Solo en `mock`/`fixture`, donde en
 * la práctica se responde 404 antes. Es un 200 degradado a propósito.
 */
function emptyFsmDegraded(accountNumber: string): Degraded {
  return {
    reason: 'FSM_UNAVAILABLE',
    message:
      `FSM no devolvió órdenes para la cuenta ${accountNumber}. Los datos del ` +
      `cliente que se muestran son simulados: verifícalos antes de usarlos.`,
  };
}

/** FSM real sin identidad para la cuenta (ver `sources`: `NONE` / `WHITELIST`). */
function noFsmDataDegraded(nameFromWhitelist: boolean): Degraded {
  return {
    reason: 'FSM_NO_DATA',
    message: nameFromWhitelist
      ? 'Sin datos en FSM para esta cuenta; nombre tomado de la base de clientes Xtrim.'
      : 'Sin datos en FSM para esta cuenta.',
  };
}

/** Nombre de la whitelist solo si hace falta (FSM sin nombre y no editado). */
async function whitelistNameIfNeeded(
  accountNumber: string,
  fsm: AccountOrders | null,
  edited: EditedFields,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (edited.fullName || fsm?.client?.names) return null;
  return findWhitelistFullName(accountNumber, (err) =>
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'client-profile: no se pudo leer el nombre de la whitelist',
    ),
  );
}

export async function registerClientDataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/client-profile', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand } = parseQuery(brandQuerySchema, request.query);
    const effectiveBrand = brandFromRequest(request, brand);

    const fsm = await fetchFsmOrdersOrUnavailable(accountNumber, effectiveBrand);
    const withoutFsmData = fsm.client === null && fsm.orders.length === 0;

    // Con datos simulados (mock/fixture) una respuesta vacía SÍ significa
    // "cuenta desconocida": el mock inventa órdenes para cualquier cuenta con
    // formato válido, así que si no hay nada es porque la cuenta no existe en
    // ese universo. Contra FSM real no se puede concluir lo mismo: la operadora
    // devuelve `data: []` tanto para una cuenta inexistente como para una cuenta
    // sin órdenes registradas o cuando el proceso no está disponible.
    if (withoutFsmData && connectorMode('fsm') !== 'real') {
      throw ApiError.notFound(
        `FSM no tiene órdenes para la cuenta ${accountNumber} (marca ${effectiveBrand}).`,
      );
    }

    const base = await getComarchConnector().getClientProfile(accountNumber);
    const edited = editedFields(accountNumber);

    if (connectorMode('fsm') === 'real') {
      const whitelistName = await whitelistNameIfNeeded(accountNumber, fsm, edited, request.log);
      const profile = composeProfile(base, fsm, edited, { strict: true, whitelistName });
      if (fsm.client === null) {
        const degraded = noFsmDataDegraded(profile.sources.fullName === 'WHITELIST');
        reply.header('X-Wifix-Degraded', encodeURIComponent(JSON.stringify(degraded)));
        return { ...profile, degraded };
      }
      return profile;
    }

    const profile = composeProfile(base, fsm, edited);
    if (withoutFsmData) {
      const degraded = emptyFsmDegraded(accountNumber);
      reply.header('X-Wifix-Degraded', encodeURIComponent(JSON.stringify(degraded)));
      return { ...profile, degraded };
    }
    return profile;
  });

  app.put('/accounts/:accountNumber/client-profile', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(clientProfileUpdateSchema, request.body);
    const user = getAuthUser(request);
    request.log.info(
      { user: user.id, accountNumber, action: 'updateClientProfile', fields: Object.keys(body) },
      'PUT client-profile',
    );
    // FSM es de solo lectura: la edición se guarda en Comarch y se refleja
    // como `MOCK` en `sources`. El cambio NO viaja a la operadora.
    const updated = await getComarchConnector().updateClientProfile(accountNumber, body);
    const edited = editedFields(accountNumber);

    if (connectorMode('fsm') === 'real') {
      // Sin FSM el mock de Comarch rellenaría lo no editado con identidad
      // inventada. Se compone igual que el GET (órdenes cacheadas 60 s); si FSM
      // falla, lo no editado queda `null`/`NONE` en vez de romper el guardado.
      const { brand } = parseQuery(brandQuerySchema, request.query);
      let fsm: AccountOrders | null = null;
      try {
        fsm = await fetchFsmOrders(accountNumber, brandFromRequest(request, brand));
      } catch (err) {
        request.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'PUT client-profile: FSM no respondió; se devuelve solo lo editado',
        );
      }
      const whitelistName = await whitelistNameIfNeeded(accountNumber, fsm, edited, request.log);
      return composeProfile(updated, fsm, edited, { strict: true, whitelistName });
    }

    return composeProfile(updated, null, edited);
  });

  app.get('/accounts/:accountNumber/contract-status', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand } = parseQuery(brandQuerySchema, request.query);
    const effectiveBrand = brandFromRequest(request, brand);
    const connector = getFsmConnector();

    // Dos llamadas: estado (cache 5 min) + órdenes (cache 60 s, ya calentado
    // por client-profile si el técnico pasó antes por Datos Personales).
    const [status, orders] = await Promise.all([
      connector.getAccountStatus(accountNumber, { brand: effectiveBrand }),
      connector.getAccountOrders(accountNumber, { brand: effectiveBrand, estado: 'Todas' }),
    ]);

    if (status.statusCode === null && orders.orders.length === 0 && orders.client === null) {
      throw ApiError.notFound(
        `FSM no conoce la cuenta ${accountNumber} (marca ${effectiveBrand}).`,
      );
    }

    // Nombre: FSM → (solo FSM real) whitelist → ''. `clientName` sigue siendo
    // string para no romper el contrato; `clientNameSource` dice de dónde salió.
    let clientName = orders.client?.names ?? '';
    let clientNameSource: 'FSM' | 'WHITELIST' | 'NONE' = clientName ? 'FSM' : 'NONE';
    if (!clientName && connectorMode('fsm') === 'real') {
      const whitelistName = await whitelistNameIfNeeded(accountNumber, orders, {}, request.log);
      if (whitelistName) {
        clientName = whitelistName;
        clientNameSource = 'WHITELIST';
      }
    }

    return {
      clientName,
      clientNameSource,
      accounts: [
        {
          accountNumber,
          // FSM no expone contrato, solo órdenes de trabajo.
          contractId: null,
          status: status.status ?? 'DESCONOCIDA',
          statusCode: status.statusCode,
          statusDescription: status.statusDescription,
          lastWorkOrder: orders.orders[0]?.workOrder ?? null,
        },
      ],
      brand: effectiveBrand,
    };
  });
}
