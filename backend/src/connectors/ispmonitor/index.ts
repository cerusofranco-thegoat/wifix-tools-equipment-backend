// Conector hacia ISP Monitor — campos 9, 10, 11, 12, 13 (métricas de red).
//
// Endpoints reales de la API de operadora (autenticación Digest):
//   /api/isp/terminals/{id}              estado del equipo, de la red y evento asociado
//   /api/isp/status/{id}                 estado del terminal, últimas 24 h
//   /api/isp/network/online/{id}         estado de la red, últimas 24 h
//   /api/isp/cablemodem/snr/{id}         señal a ruido del terminal (DOCSIS), 24 h
//   /api/isp/network/snr/{id}            señal a ruido de la red (DOCSIS), 24 h
//   /api/isp/cablemodem/codewords/{id}   FEC corregidos / sin corregir del terminal, 24 h
//   /api/isp/network/codewords/{id}      FEC corregidos / sin corregir de la red, 24 h
//
// `{id}` es el serial GPON (fibra) o la MAC del cablemódem (HFC).

import { connectorMode } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng } from '../_shared.js';
import {
  fetchNetworkCodewords24h,
  fetchNetworkSnr24h,
  fetchNetworkStatus24h,
  fetchTerminal,
  fetchTerminalCodewords24h,
  fetchTerminalSnr24h,
  fetchTerminalStatus24h,
  normalizeTerminalId,
} from '../http/tec-api.js';
import {
  findField,
  flattenFields,
  normalizeSeries,
  toBoolish,
  toNumber,
  type FlatField,
  type NormalizedSeries,
  type SeriesPoint,
  type SeriesChannel,
} from './normalize.js';

export type Technology = 'GPON' | 'HFC';

/** Ámbito de una serie: el equipo del cliente o la red (nodo) a la que cuelga. */
export type SeriesScope = 'terminal' | 'network';

/** Métrica de la serie de 24 h. */
export type SeriesMetric = 'status' | 'snr' | 'codewords';

export interface SignalLevels {
  rxDbm: number;
  txDbm: number;
}

export interface NetworkMetrics {
  accountNumber: string;
  technology: Technology;
  signalLevels: SignalLevels;
  signalToNoiseDb?: number;
  fecCorrectedPercent?: number;
  fecUncorrectedPercent?: number;
  outagesLast24h: number;
  trafficMbpsIn: number;
  trafficMbpsOut: number;
  measuredAt: string;
}

/**
 * Equipo que pasó por ese puerto en un período (`terminals[]` de la API).
 * Sirve para ver si el equipo anterior del domicilio venía cayéndose.
 */
export interface TerminalHistoryEntry {
  /** LastHour | LastDay | LastWeek | LastMonth, tal como lo nombra la API. */
  period: string;
  ids: string[];
  statuses: string[];
  drop: string | null;
  events: string | null;
}

/** Estado puntual del equipo: enlace, nodo y evento asociado. */
export interface TerminalSnapshot {
  id: string;
  /** false cuando la API respondió 204 (ese id no existe o no tiene datos). */
  found: boolean;
  /** Estado del equipo del cliente. null si la API no lo expone. */
  online: boolean | null;
  technology: Technology | null;
  /** Ciudad donde está el equipo. */
  city: string | null;
  /** Nodos/redes a las que cuelga el equipo. */
  networkIds: number[];
  /** Evento (daño) asociado al equipo o al nodo, si lo hay. */
  event: { active: boolean; description: string | null } | null;
  /** Historial de equipos en ese puerto por período. */
  history: TerminalHistoryEntry[];
  /** Resto de la ficha aplanada (device, ifIndex, index, drop…). */
  fields: FlatField[];
  raw: unknown;
  fetchedAt: string;
}

export interface Series24h extends NormalizedSeries {
  id: string;
  scope: SeriesScope;
  metric: SeriesMetric;
  fetchedAt: string;
}

export interface TerminalDiagnostics {
  id: string;
  terminal: TerminalSnapshot;
  status: { terminal: Series24h | null; network: Series24h | null };
  snr: { terminal: Series24h | null; network: Series24h | null };
  codewords: { terminal: Series24h | null; network: Series24h | null };
  /** Endpoints que fallaron; el resto del payload sigue siendo válido. */
  errors: Array<{ endpoint: string; message: string }>;
  fetchedAt: string;
}

export interface IspMonitorConnector {
  getNetworkMetrics(accountNumber: string): Promise<NetworkMetrics>;
  getTerminal(id: string): Promise<TerminalSnapshot>;
  getSeries(id: string, scope: SeriesScope, metric: SeriesMetric): Promise<Series24h>;
  getDiagnostics(id: string): Promise<TerminalDiagnostics>;
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

/** 24 muestras horarias terminando en la hora actual. */
function hourlyTimestamps(count = 24): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    out.push(new Date(now - i * 3600_000).toISOString());
  }
  return out;
}

function mockSeries(id: string, scope: SeriesScope, metric: SeriesMetric): Series24h {
  const rng = seededRng(`ispmonitor:${metric}:${scope}:${id}`);
  const stamps = hourlyTimestamps();
  const points: SeriesPoint[] = [];
  let keys: string[] = [];

  if (metric === 'status') {
    keys = ['online'];
    for (const t of stamps) {
      // La red cae menos que el equipo del cliente.
      const up = rng.bool(scope === 'network' ? 0.97 : 0.9);
      points.push({ t, values: { online: up ? 1 : 0 } });
    }
  } else if (metric === 'snr') {
    keys = ['snrDown', 'snrUp'];
    for (const t of stamps) {
      points.push({
        t,
        values: {
          snrDown: rng.floatBetween(30, 41, 1),
          snrUp: rng.floatBetween(26, 38, 1),
        },
      });
    }
  } else {
    keys = ['corrected', 'uncorrected'];
    for (const t of stamps) {
      points.push({
        t,
        values: {
          corrected: rng.floatBetween(0, 4.5, 3),
          uncorrected: rng.floatBetween(0, 0.6, 3),
        },
      });
    }
  }

  return {
    id,
    scope,
    metric,
    keys,
    points,
    channels: [],
    recognized: true,
    raw: null,
    fetchedAt: new Date().toISOString(),
  };
}

function mockTerminal(id: string): TerminalSnapshot {
  const rng = seededRng(`ispmonitor:terminal:${id}`);
  // Igual que en la realidad: una MAC de 12 hex es cablemódem HFC, un serial
  // de 4 letras + 8 caracteres es un ONT de fibra.
  const technology: Technology = /^[0-9A-F]{12}$/.test(id) ? 'HFC' : 'GPON';
  const online = rng.bool(0.85);
  const hasEvent = !online || rng.bool(0.15);
  const eventText = hasEvent
    ? rng.pick(['Corte de fibra troncal', 'Mantenimiento programado', 'Falla de energía en nodo'])
    : '';
  // Mismo shape que la API real, para que el mapeo se ejercite igual en mock.
  const raw = {
    type: technology,
    city: rng.pick(['Quito', 'Guayaquil', 'Cuenca']),
    id,
    device: rng.intBetween(9000, 9999),
    ifIndex: rng.intBetween(200000000, 300000000),
    index: rng.intBetween(1, 16),
    networks: [rng.intBetween(9000, 9999)],
    status: online ? 'up' : 'down',
    drop: null,
    events: hasEvent ? eventText : null,
    terminals: [
      { Type: 'LastHour', IDs: [id], Status: [online ? 'up' : 'down'], Drop: '', Events: '' },
      { Type: 'LastDay', IDs: [id], Status: [online ? 'up' : 'down'], Drop: '', Events: '' },
      { Type: 'LastWeek', IDs: [id], Status: ['up'], Drop: '', Events: '' },
      { Type: 'LastMonth', IDs: [id, `ZTEG${rng.intBetween(10000000, 99999999)}`], Status: ['up', 'down'], Drop: '', Events: '' },
    ],
  };
  return buildSnapshot(id, raw);
}

export const ispMonitorMock: IspMonitorConnector = {
  async getNetworkMetrics(accountNumber) {
    const rng = seededRng(`ispmonitor:metrics:${accountNumber}`);
    const technology: Technology = rng.bool(0.7) ? 'GPON' : 'HFC';
    const base: NetworkMetrics = {
      accountNumber,
      technology,
      signalLevels: {
        rxDbm: rng.floatBetween(-28, -8, 2),
        txDbm: rng.floatBetween(0, 5, 2),
      },
      outagesLast24h: rng.intBetween(0, 3),
      trafficMbpsIn: rng.floatBetween(0.5, 350, 2),
      trafficMbpsOut: rng.floatBetween(0.2, 180, 2),
      measuredAt: new Date().toISOString(),
    };
    if (technology === 'HFC') {
      base.signalToNoiseDb = rng.floatBetween(28, 42, 1);
      base.fecCorrectedPercent = rng.floatBetween(0, 5, 2);
      base.fecUncorrectedPercent = rng.floatBetween(0, 1, 3);
    }
    return base;
  },

  async getTerminal(id) {
    return mockTerminal(normalizeTerminalId(id));
  },

  async getSeries(id, scope, metric) {
    return mockSeries(normalizeTerminalId(id), scope, metric);
  },

  async getDiagnostics(id) {
    const normalized = normalizeTerminalId(id);
    return {
      id: normalized,
      terminal: mockTerminal(normalized),
      status: {
        terminal: mockSeries(normalized, 'terminal', 'status'),
        network: mockSeries(normalized, 'network', 'status'),
      },
      snr: {
        terminal: mockSeries(normalized, 'terminal', 'snr'),
        network: mockSeries(normalized, 'network', 'snr'),
      },
      codewords: {
        terminal: mockSeries(normalized, 'terminal', 'codewords'),
        network: mockSeries(normalized, 'network', 'codewords'),
      },
      errors: [],
      fetchedAt: new Date().toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

// Forma real de `GET /api/isp/terminals/{id}` (verificada 2026-08-26 con un
// ONT ZTE activo):
//
//   { "type": "GPON", "city": "Quito", "id": "ZTEGD3F9BBE5", "device": 9919,
//     "ifIndex": 285282307, "index": 11, "networks": [9198], "status": "up",
//     "drop": null, "events": null,
//     "terminals": [ { "Type": "LastMonth", "IDs": ["ZTEGD0BB8294"],
//                      "Status": ["down"], "Drop": "", "Events": "" }, … ] }
//
// `terminals` es el historial de equipos que pasaron por ese puerto/domicilio
// en la última hora, día, semana y mes: le sirve al técnico para ver si el
// equipo anterior venía cayéndose.

/** Alias de nombre de campo por concepto, para leer la ficha del terminal. */
const ALIASES = {
  online: ['status', 'estadoequipo', 'estadoterminal', 'online', 'estado'],
  technology: ['type', 'tecnologia', 'technology', 'tipo', 'tech'],
  city: ['city', 'ciudad'],
  networks: ['networks', 'network', 'nodo', 'nodos'],
  events: ['events', 'event', 'evento', 'eventos'],
  history: ['terminals', 'historial'],
} as const;

/** Claves que la ficha ya expone como campo propio y no se repiten en `fields`. */
const SURFACED_KEYS = new Set(['id', 'type', 'city', 'status', 'events', 'networks', 'terminals']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Valor de una clave del objeto, con búsqueda laxa entre varios alias. */
function pickKey(body: Record<string, unknown>, aliases: readonly string[]): unknown {
  const keys = Object.keys(body);
  for (const alias of aliases) {
    const match = keys.find((k) => k.toLowerCase() === alias.toLowerCase());
    if (match !== undefined) return body[match];
  }
  return undefined;
}

function detectTechnology(body: Record<string, unknown>, id: string): Technology | null {
  const value = pickKey(body, ALIASES.technology);
  const text = value === null || value === undefined ? '' : String(value).toUpperCase();
  if (
    text.includes('GPON') || text.includes('FIBR') || text.includes('FTTH') ||
    text.includes('ONT') || text.includes('ONU')
  ) {
    return 'GPON';
  }
  if (text.includes('HFC') || text.includes('DOCSIS') || text.includes('CABLE')) return 'HFC';
  // Sin campo explícito: una MAC de 12 hex es cablemódem; lo demás, serial GPON.
  if (/^[0-9A-F]{12}$/.test(id)) return 'HFC';
  return null;
}

/** Normaliza una entrada del historial `terminals[]`. */
export function mapHistoryEntry(entry: unknown): TerminalHistoryEntry | null {
  if (!isPlainObject(entry)) return null;

  const asList = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== '');
    if (v === null || v === undefined || String(v).trim() === '') return [];
    return [String(v)];
  };
  const asText = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const text = String(v).trim();
    return text === '' ? null : text;
  };

  const period = pickKey(entry, ['Type', 'periodo', 'period']);
  return {
    period: period === undefined ? '—' : String(period),
    ids: asList(pickKey(entry, ['IDs', 'ids', 'id'])),
    statuses: asList(pickKey(entry, ['Status', 'status', 'estado'])),
    drop: asText(pickKey(entry, ['Drop', 'drop'])),
    events: asText(pickKey(entry, ['Events', 'events', 'evento'])),
  };
}

function buildSnapshot(id: string, raw: unknown): TerminalSnapshot {
  const fetchedAt = new Date().toISOString();
  const emptySnapshot: TerminalSnapshot = {
    id,
    found: false,
    online: null,
    technology: null,
    city: null,
    networkIds: [],
    event: null,
    history: [],
    fields: [],
    raw: null,
    fetchedAt,
  };
  if (raw === null || raw === undefined) return emptySnapshot;

  // La API puede devolver el terminal suelto o dentro de un array de 1.
  const body = Array.isArray(raw) ? (raw[0] ?? null) : raw;
  if (!isPlainObject(body)) return emptySnapshot;

  const eventsValue = pickKey(body, ALIASES.events);
  const eventDescription =
    eventsValue === null || eventsValue === undefined || String(eventsValue).trim() === ''
      ? null
      : String(eventsValue).trim();

  const networksValue = pickKey(body, ALIASES.networks);
  const networkIds = (Array.isArray(networksValue) ? networksValue : [networksValue])
    .map((v) => toNumber(v))
    .filter((v): v is number => v !== null);

  const historyValue = pickKey(body, ALIASES.history);
  const history = (Array.isArray(historyValue) ? historyValue : [])
    .map(mapHistoryEntry)
    .filter((e): e is TerminalHistoryEntry => e !== null);

  // `fields` recoge lo que no tiene tratamiento propio (device, ifIndex,
  // index, drop…), sin el historial para no llenar la ficha de ruido.
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!SURFACED_KEYS.has(k.toLowerCase())) rest[k] = v;
  }

  const cityValue = pickKey(body, ALIASES.city);

  return {
    id,
    found: true,
    online: toBoolish(pickKey(body, ALIASES.online)),
    technology: detectTechnology(body, id),
    city: cityValue === null || cityValue === undefined ? null : String(cityValue),
    networkIds,
    event: { active: eventDescription !== null, description: eventDescription },
    history,
    fields: flattenFields(rest),
    raw: body,
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Nombres de columna de las series
// ---------------------------------------------------------------------------
// ISP Monitor devuelve las series como tuplas `[epoch, valor]` sin nombrar las
// columnas, así que el nombre lo pone el conector según la métrica. El número
// de columnas se lee del payload: SNR y codewords pueden traer una o dos.

function tupleColumnCount(raw: unknown): number {
  if (!Array.isArray(raw) || raw.length === 0) return 0;
  let first = raw[0];
  // Formato multicanal: las tuplas viven dentro de `data` de cada canal.
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    const channel = first as Record<string, unknown>;
    const dataKey = Object.keys(channel).find((k) => k.toLowerCase() === 'data');
    const data = dataKey === undefined ? null : channel[dataKey];
    if (!Array.isArray(data) || data.length === 0) return 0;
    first = data[0];
  }
  // Se descuenta la columna del instante.
  return Array.isArray(first) ? Math.max(0, first.length - 1) : 0;
}

export function valueNamesFor(scope: SeriesScope, metric: SeriesMetric, raw: unknown): string[] {
  const columns = tupleColumnCount(raw);
  if (metric === 'status') {
    // El endpoint de red devuelve cuántos terminales del nodo están en línea,
    // no un 0/1: nombrarlo "online" sería engañoso.
    return scope === 'network' ? ['terminalsOnline'] : ['online'];
  }
  if (metric === 'snr') {
    return columns >= 2 ? ['snrDown', 'snrUp'] : ['snr'];
  }
  return columns >= 2 ? ['corrected', 'uncorrected'] : ['errors'];
}

const SERIES_FETCHERS: Record<SeriesScope, Record<SeriesMetric, (id: string) => Promise<unknown>>> = {
  terminal: {
    status: fetchTerminalStatus24h,
    snr: fetchTerminalSnr24h,
    codewords: fetchTerminalCodewords24h,
  },
  network: {
    status: fetchNetworkStatus24h,
    snr: fetchNetworkSnr24h,
    codewords: fetchNetworkCodewords24h,
  },
};

/** Etiqueta legible de un endpoint, para el reporte de errores parciales. */
function endpointLabel(scope: SeriesScope, metric: SeriesMetric): string {
  return `${scope}/${metric}`;
}

export const ispMonitorReal: IspMonitorConnector = {
  async getTerminal(id) {
    const normalized = normalizeTerminalId(id);
    return buildSnapshot(normalized, await fetchTerminal(normalized));
  },

  async getSeries(id, scope, metric) {
    const normalized = normalizeTerminalId(id);
    const raw = await SERIES_FETCHERS[scope][metric](normalized);
    return {
      id: normalized,
      scope,
      metric,
      ...normalizeSeries(raw, valueNamesFor(scope, metric, raw)),
      fetchedAt: new Date().toISOString(),
    };
  },

  async getDiagnostics(id) {
    const normalized = normalizeTerminalId(id);
    const errors: Array<{ endpoint: string; message: string }> = [];

    const scopes: SeriesScope[] = ['terminal', 'network'];
    const metrics: SeriesMetric[] = ['status', 'snr', 'codewords'];

    // Las 7 llamadas van en paralelo: un fallo parcial no tumba el panel.
    const [terminalResult, ...seriesResults] = await Promise.all([
      fetchTerminal(normalized).then(
        (raw) => ({ ok: true as const, raw }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      ...scopes.flatMap((scope) =>
        metrics.map((metric) =>
          SERIES_FETCHERS[scope][metric](normalized).then(
            (raw) => ({ ok: true as const, scope, metric, raw }),
            (err: unknown) => ({ ok: false as const, scope, metric, err }),
          ),
        ),
      ),
    ]);

    if (!terminalResult.ok) {
      const message = terminalResult.err instanceof Error ? terminalResult.err.message : String(terminalResult.err);
      errors.push({ endpoint: 'terminals', message });
    }
    const terminal = buildSnapshot(normalized, terminalResult.ok ? terminalResult.raw : null);

    const fetchedAt = new Date().toISOString();
    const bucket: Record<SeriesMetric, { terminal: Series24h | null; network: Series24h | null }> = {
      status: { terminal: null, network: null },
      snr: { terminal: null, network: null },
      codewords: { terminal: null, network: null },
    };

    for (const result of seriesResults) {
      if (!result.ok) {
        errors.push({
          endpoint: endpointLabel(result.scope, result.metric),
          message: result.err instanceof Error ? result.err.message : String(result.err),
        });
        continue;
      }
      bucket[result.metric][result.scope] = {
        id: normalized,
        scope: result.scope,
        metric: result.metric,
        ...normalizeSeries(result.raw, valueNamesFor(result.scope, result.metric, result.raw)),
        fetchedAt,
      };
    }

    return {
      id: normalized,
      terminal,
      status: bucket.status,
      snr: bucket.snr,
      codewords: bucket.codewords,
      errors,
      fetchedAt,
    };
  },

  /**
   * Compatibilidad con el panel "Métricas de red": ISP Monitor indexa por
   * serial/MAC, no por número de cuenta, así que solo funciona si el técnico
   * pasa el identificador del equipo. Se deriva de la ficha del terminal y de
   * las series de 24 h.
   */
  async getNetworkMetrics(accountNumber) {
    const diagnostics = await ispMonitorReal.getDiagnostics(accountNumber);
    const { terminal } = diagnostics;
    if (!terminal.found) {
      throw ApiError.notFound(
        `ISP Monitor no tiene datos para "${diagnostics.id}". Verifica el serial GPON o la MAC del cablemódem.`,
      );
    }

    // La ficha de ISP Monitor no trae RX/TX en el shape verificado; se leen
    // si aparecen en algún despliegue y si no quedan en 0.
    const rx = toNumber(
      findField(terminal.fields, ['rx', 'rxpower', 'potenciarx', 'nivelrx', 'rxdbm'])?.value ?? null,
    );
    const tx = toNumber(
      findField(terminal.fields, ['tx', 'txpower', 'potenciatx', 'niveltx', 'txdbm'])?.value ?? null,
    );

    // Caídas = transiciones a 0 en la serie de estado del terminal.
    const statusPoints = diagnostics.status.terminal?.points ?? [];
    const statusKey = diagnostics.status.terminal?.keys[0];
    let outages = 0;
    if (statusKey) {
      let previous: number | null = null;
      for (const point of statusPoints) {
        const value = point.values[statusKey];
        if (value === undefined) continue;
        if (previous !== null && previous > 0 && value === 0) outages += 1;
        previous = value;
      }
    }

    const snrSeries = diagnostics.snr.terminal;
    const lastSnr = snrSeries?.points.at(-1);
    const snrKey = snrSeries?.keys[0];
    const snr = lastSnr && snrKey ? lastSnr.values[snrKey] : undefined;

    const cwSeries = diagnostics.codewords.terminal;
    const lastCw = cwSeries?.points.at(-1);
    const correctedKey = cwSeries?.keys.find((k) => /corr/i.test(k) && !/uncorr|sin/i.test(k));
    const uncorrectedKey = cwSeries?.keys.find((k) => /uncorr|sincorr/i.test(k));

    const metrics: NetworkMetrics = {
      accountNumber: diagnostics.id,
      technology: terminal.technology ?? 'GPON',
      signalLevels: { rxDbm: rx ?? 0, txDbm: tx ?? 0 },
      outagesLast24h: outages,
      trafficMbpsIn: 0,
      trafficMbpsOut: 0,
      measuredAt: diagnostics.fetchedAt,
    };
    if (snr !== undefined) metrics.signalToNoiseDb = snr;
    if (lastCw && correctedKey && lastCw.values[correctedKey] !== undefined) {
      metrics.fecCorrectedPercent = lastCw.values[correctedKey];
    }
    if (lastCw && uncorrectedKey && lastCw.values[uncorrectedKey] !== undefined) {
      metrics.fecUncorrectedPercent = lastCw.values[uncorrectedKey];
    }
    return metrics;
  },
};

export function getIspMonitorConnector(): IspMonitorConnector {
  const mode = connectorMode('ispmonitor');
  switch (mode) {
    case 'mock':
      return ispMonitorMock;
    case 'real':
      return ispMonitorReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${mode}`);
  }
}

export type { FlatField, NormalizedSeries, SeriesPoint, SeriesChannel };
