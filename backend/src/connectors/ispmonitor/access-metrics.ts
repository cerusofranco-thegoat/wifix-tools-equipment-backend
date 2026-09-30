// ---------------------------------------------------------------------------
// Métricas por tecnología de acceso: DOCSIS (HFC / cablemódem) u óptica
// (GPON / ONT-ONU), y el historial de caídas con hora exacta.
//
// Qué es real y qué es simulado (verificado contra tec-api el 2026-08-26/27):
//
//   | Dato                                   | Origen real               |
//   |----------------------------------------|---------------------------|
//   | Estado del equipo (up/down) 24 h       | ISP Monitor `status/{id}` |
//   | → caídas con inicio/fin/duración       | derivadas de esa serie    |
//   | SNR upstream por canal (HFC)           | ISP Monitor `cablemodem/snr` |
//   | FEC corregidos / sin corregir (HFC)    | ISP Monitor `cablemodem/codewords` |
//   | Red de acceso (puerto OLT / tarjeta CMTS) | ficha `networks`       |
//   | Potencias DOCSIS (dBmV), SNR downstream| NO expuesto → SIMULADO    |
//   | Potencia óptica Rx/Tx, OLT, PON, ONU id,| NO expuesto → SIMULADO    |
//   |   distancia, temperatura, voltaje      |                           |
//   | Causa de la caída (LOS / dying gasp)   | NO expuesto → SIMULADO en mock, UNKNOWN en real |
//
// Todo bloque lleva `simulated` y `sources` para que la UI marque lo simulado.
// Los simulados son deterministas por identificador del equipo.
// ---------------------------------------------------------------------------

import { seededRng } from '../_shared.js';
import type { Series24h, Technology, TerminalSnapshot } from './index.js';

/** De dónde salió cada grupo de datos. */
export type MetricSource = 'ISP_MONITOR' | 'SIMULATED' | 'NONE';

/** Cómo se decidió la tecnología del equipo. */
export type TechnologySource =
  /** La ficha de ISP Monitor trae `type` explícito. */
  | 'ISP_MONITOR'
  /** El cliente la indicó (`?technology=`), p. ej. por el modelo del equipo. */
  | 'HINT'
  /** Inferida del formato del id (MAC 12-hex → HFC; serial de 4 letras → GPON). */
  | 'ID_FORMAT'
  | 'UNKNOWN';

export type Health = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

/** Zona horaria de los campos `*Local` (Ecuador continental, sin horario de verano). */
export const LOCAL_TIMEZONE = 'America/Guayaquil';
const LOCAL_OFFSET_MINUTES = -5 * 60;

/**
 * ISO-8601 con la hora local de Ecuador y el offset explícito:
 * `2026-09-30T13:15:00.000Z` → `2026-09-30T08:15:00.000-05:00`.
 */
export function toLocalIso(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const shifted = new Date(ms + LOCAL_OFFSET_MINUTES * 60_000).toISOString();
  const sign = LOCAL_OFFSET_MINUTES < 0 ? '-' : '+';
  const abs = Math.abs(LOCAL_OFFSET_MINUTES);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return shifted.replace('Z', offset);
}

// ---------------------------------------------------------------------------
// Tecnología
// ---------------------------------------------------------------------------

/** Prefijos de fabricante de un serial GPON (4 letras del vendor id). */
const GPON_VENDOR_PREFIXES = ['ZTEG', 'HWTC', 'STGU', 'ALCL', 'FHTT', 'GPON', 'TPLG', 'NOKG', 'SKYW'];

/** Tecnología a partir del formato del id. `null` si no hay pista. */
export function technologyFromIdFormat(id: string): Technology | null {
  const value = id.toUpperCase();
  if (GPON_VENDOR_PREFIXES.some((p) => value.startsWith(p))) return 'GPON';
  if (/^[0-9A-F]{12}$/.test(value)) return 'HFC';
  // Serial GPON genérico: 4 letras de vendor + 8 hex.
  if (/^[A-Z]{4}[0-9A-F]{8}$/.test(value)) return 'GPON';
  return null;
}

// ---------------------------------------------------------------------------
// Caídas (outages)
// ---------------------------------------------------------------------------

export type OutageCause =
  | 'LOS'
  | 'DYING_GASP'
  | 'T3_TIMEOUT'
  | 'T4_TIMEOUT'
  | 'POWER_LOSS'
  | 'UNKNOWN';

const CAUSE_LABELS: Record<OutageCause, string> = {
  LOS: 'Pérdida de señal óptica (LOS)',
  DYING_GASP: 'Corte de energía del ONT (dying gasp)',
  T3_TIMEOUT: 'Timeout T3 (ranging upstream DOCSIS)',
  T4_TIMEOUT: 'Timeout T4 (sin mantenimiento de estación DOCSIS)',
  POWER_LOSS: 'Corte de energía del cablemódem',
  UNKNOWN: 'Causa no informada por el monitoreo',
};

export interface OutageEvent {
  /** Primera muestra caída, UTC (`…Z`). */
  startedAt: string;
  /** Mismo instante en hora de Ecuador con offset (`…-05:00`). */
  startedAtLocal: string;
  /** Primera muestra de vuelta en línea; `null` si sigue caído. */
  endedAt: string | null;
  endedAtLocal: string | null;
  /** Duración en segundos; si sigue caído, hasta el momento de la consulta. */
  durationSeconds: number;
  ongoing: boolean;
  cause: OutageCause;
  causeLabel: string;
  /**
   * Resolución de la serie: el inicio real está entre la última muestra en
   * línea y `startedAt` (± este valor). 300 s en ISP Monitor.
   */
  precisionSeconds: number;
  simulated: boolean;
}

export interface OutageSummary {
  /** Origen de las caídas: la serie de estado de ISP Monitor, o simulado. */
  source: MetricSource;
  /** Origen de la causa: real no la informa (siempre `UNKNOWN`). */
  causeSource: MetricSource;
  simulated: boolean;
  timezone: string;
  window: { from: string | null; until: string; hours: 24 };
  count: number;
  totalDownSeconds: number;
  /** La más reciente primero. */
  items: OutageEvent[];
}

export interface Uptime {
  /** Segundos en línea desde la última vuelta; `null` si está caído o sin datos. */
  seconds: number | null;
  /** Desde cuándo está en línea (UTC). */
  since: string | null;
  sinceLocal: string | null;
  /** `true` → no hubo caídas en la ventana: en línea AL MENOS `seconds`. */
  lowerBound: boolean;
  source: MetricSource;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

interface StatusSample {
  ms: number;
  up: boolean;
}

function statusSamples(series: Series24h | null): StatusSample[] {
  if (!series) return [];
  const key = series.keys[0];
  if (!key) return [];
  const out: StatusSample[] = [];
  for (const p of series.points) {
    if (!p.t) continue;
    const ms = Date.parse(p.t);
    const value = p.values[key];
    if (Number.isNaN(ms) || value === undefined) continue;
    out.push({ ms, up: value > 0 });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

/**
 * Caídas a partir de la serie de estado del terminal: cada tramo continuo de
 * muestras en 0 es una caída. Inicio = primera muestra caída; fin = primera
 * muestra de vuelta en línea (`null` si la serie termina caída).
 *
 * `causeFor(i)` pone la causa de la i-ésima caída (en orden cronológico).
 */
export function deriveOutages(
  series: Series24h | null,
  opts: {
    now: Date;
    source: MetricSource;
    simulated: boolean;
    causeFor?: (index: number) => OutageCause;
  },
): { summary: OutageSummary; uptime: Uptime } {
  const samples = statusSamples(series);
  const nowMs = opts.now.getTime();
  const intervals = samples.slice(1).map((s, i) => (s.ms - (samples[i] as StatusSample).ms) / 1000);
  const precisionSeconds = Math.round(median(intervals)) || 300;

  const events: OutageEvent[] = [];
  let openStart: number | null = null;
  for (const s of samples) {
    if (!s.up && openStart === null) openStart = s.ms;
    if (s.up && openStart !== null) {
      events.push(makeOutage(openStart, s.ms, nowMs, precisionSeconds, events.length, opts));
      openStart = null;
    }
  }
  if (openStart !== null) {
    events.push(makeOutage(openStart, null, nowMs, precisionSeconds, events.length, opts));
  }

  const first = samples[0];
  const last = samples.at(-1);
  const hasData = samples.length > 0;
  const summary: OutageSummary = {
    source: hasData ? opts.source : 'NONE',
    causeSource: !hasData ? 'NONE' : opts.causeFor ? 'SIMULATED' : 'NONE',
    simulated: hasData && opts.simulated,
    timezone: LOCAL_TIMEZONE,
    window: {
      from: first ? new Date(first.ms).toISOString() : null,
      until: opts.now.toISOString(),
      hours: 24,
    },
    count: events.length,
    totalDownSeconds: events.reduce((acc, e) => acc + e.durationSeconds, 0),
    items: [...events].reverse(),
  };

  let uptime: Uptime;
  if (!hasData || !last || !last.up) {
    uptime = { seconds: null, since: null, sinceLocal: null, lowerBound: false, source: hasData ? opts.source : 'NONE' };
  } else {
    const lastRecovery = events.filter((e) => e.endedAt !== null).at(-1);
    const sinceMs = lastRecovery ? Date.parse(lastRecovery.endedAt as string) : (first as StatusSample).ms;
    const since = new Date(sinceMs).toISOString();
    uptime = {
      seconds: Math.max(0, Math.round((nowMs - sinceMs) / 1000)),
      since,
      sinceLocal: toLocalIso(since),
      lowerBound: !lastRecovery,
      source: opts.source,
    };
  }
  return { summary, uptime };
}

function makeOutage(
  startMs: number,
  endMs: number | null,
  nowMs: number,
  precisionSeconds: number,
  index: number,
  opts: { simulated: boolean; causeFor?: (index: number) => OutageCause },
): OutageEvent {
  const startedAt = new Date(startMs).toISOString();
  const endedAt = endMs === null ? null : new Date(endMs).toISOString();
  const cause = opts.causeFor ? opts.causeFor(index) : 'UNKNOWN';
  return {
    startedAt,
    startedAtLocal: toLocalIso(startedAt),
    endedAt,
    endedAtLocal: endedAt === null ? null : toLocalIso(endedAt),
    durationSeconds: Math.max(0, Math.round(((endMs ?? nowMs) - startMs) / 1000)),
    ongoing: endMs === null,
    cause,
    causeLabel: CAUSE_LABELS[cause],
    precisionSeconds,
    simulated: opts.simulated,
  };
}

/** Causas simuladas, deterministas por id, según la tecnología. */
export function simulatedCauseFor(id: string, technology: Technology): (index: number) => OutageCause {
  const pool: OutageCause[] =
    technology === 'GPON' ? ['LOS', 'DYING_GASP', 'LOS'] : ['T4_TIMEOUT', 'T3_TIMEOUT', 'POWER_LOSS'];
  return (index) => seededRng(`ispmonitor:cause:${id}:${index}`).pick(pool);
}

// ---------------------------------------------------------------------------
// DOCSIS (HFC)
// ---------------------------------------------------------------------------

export interface DocsisChannel {
  channelId: string;
  direction: 'downstream' | 'upstream';
  label: string;
  frequencyMHz: number | null;
  powerDbmv: number | null;
  snrDb: number | null;
  modulation: string | null;
  /** Campos de este canal que son simulados. */
  simulatedFields: string[];
}

export interface DocsisMetrics {
  technology: 'HFC';
  /** `true` si ALGÚN valor del bloque es simulado. */
  simulated: boolean;
  sources: { snrUpstream: MetricSource; snrDownstream: MetricSource; power: MetricSource; codewords: MetricSource };
  downstream: { powerDbmv: number | null; snrDb: number | null; channels: DocsisChannel[] };
  upstream: { powerDbmv: number | null; snrDb: number | null; channels: DocsisChannel[] };
  codewords: { correctedPercent: number | null; uncorrectedPercent: number | null };
  /** Rangos de referencia usados para `health`. */
  thresholds: {
    downstreamPowerDbmv: { min: number; max: number };
    downstreamSnrDbMin: number;
    upstreamPowerDbmv: { min: number; max: number };
    upstreamSnrDbMin: number;
    uncorrectedPercentMax: number;
  };
  health: Health;
  measuredAt: string;
}

const DOCSIS_THRESHOLDS: DocsisMetrics['thresholds'] = {
  downstreamPowerDbmv: { min: -7, max: 7 },
  downstreamSnrDbMin: 33,
  upstreamPowerDbmv: { min: 35, max: 51 },
  upstreamSnrDbMin: 27,
  uncorrectedPercentMax: 0.1,
};

function round(value: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length === 0 ? null : round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** Último valor de `key` (o de la primera clave) en una lista de puntos. */
function lastValue(points: Series24h['points'], key?: string): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const values = points[i]?.values ?? {};
    const k = key ?? Object.keys(values)[0];
    const v = k === undefined ? undefined : values[k];
    if (v !== undefined) return v;
  }
  return null;
}

/** SNR upstream por canal desde la serie real (multicanal o de un canal). */
function upstreamSnrFromSeries(series: Series24h | null): Array<{ label: string; ifIndex: number | null; snrDb: number | null }> {
  if (!series) return [];
  if (series.channels.length > 0) {
    return series.channels.map((c) => ({
      label: c.label,
      ifIndex: c.ifIndex,
      snrDb: lastValue(c.points, c.keys.find((k) => /up/i.test(k)) ?? c.keys[0]),
    }));
  }
  if (series.points.length === 0) return [];
  const upKey = series.keys.find((k) => /up/i.test(k)) ?? series.keys[0];
  return [{ label: 'Upstream', ifIndex: null, snrDb: lastValue(series.points, upKey) }];
}

function codewordsFromSeries(series: Series24h | null): { corrected: number | null; uncorrected: number | null } {
  if (!series) return { corrected: null, uncorrected: null };
  const sources = series.channels.length > 0 ? series.channels : [{ keys: series.keys, points: series.points }];
  const corrected: Array<number | null> = [];
  const uncorrected: Array<number | null> = [];
  for (const s of sources) {
    const cKey = s.keys.find((k) => /corr/i.test(k) && !/uncorr|sin/i.test(k)) ?? s.keys[0];
    const uKey = s.keys.find((k) => /uncorr|sincorr/i.test(k)) ?? s.keys[1];
    corrected.push(cKey ? lastValue(s.points, cKey) : null);
    uncorrected.push(uKey ? lastValue(s.points, uKey) : null);
  }
  const max = (vals: Array<number | null>): number | null => {
    const nums = vals.filter((v): v is number => v !== null);
    return nums.length === 0 ? null : round(Math.max(...nums), 3);
  };
  return { corrected: max(corrected), uncorrected: max(uncorrected) };
}

function worst(a: Health, b: Health): Health {
  const rank: Record<Health, number> = { UNKNOWN: 0, OK: 1, WARNING: 2, CRITICAL: 3 };
  return rank[b] > rank[a] ? b : a;
}

function docsisHealth(m: Omit<DocsisMetrics, 'health'>, online: boolean | null): Health {
  if (online === false) return 'CRITICAL';
  const t = m.thresholds;
  let h: Health = 'UNKNOWN';
  const range = (v: number | null, min: number, max: number, margin: number): Health =>
    v === null ? 'UNKNOWN' : v >= min && v <= max ? 'OK' : v >= min - margin && v <= max + margin ? 'WARNING' : 'CRITICAL';
  const floor = (v: number | null, min: number, margin: number): Health =>
    v === null ? 'UNKNOWN' : v >= min ? 'OK' : v >= min - margin ? 'WARNING' : 'CRITICAL';
  h = worst(h, range(m.downstream.powerDbmv, t.downstreamPowerDbmv.min, t.downstreamPowerDbmv.max, 3));
  h = worst(h, floor(m.downstream.snrDb, t.downstreamSnrDbMin, 3));
  h = worst(h, range(m.upstream.powerDbmv, t.upstreamPowerDbmv.min, t.upstreamPowerDbmv.max, 3));
  h = worst(h, floor(m.upstream.snrDb, t.upstreamSnrDbMin, 3));
  const u = m.codewords.uncorrectedPercent;
  if (u !== null) h = worst(h, u <= t.uncorrectedPercentMax ? 'OK' : u <= 1 ? 'WARNING' : 'CRITICAL');
  return h;
}

/**
 * Bloque DOCSIS. `snr`/`codewords` son las series del TERMINAL; si vienen de
 * ISP Monitor (`seriesSource: 'ISP_MONITOR'`) se usan sus últimos valores. Las
 * potencias y el downstream NO los publica la operadora: siempre simulados.
 */
export function buildDocsisMetrics(input: {
  id: string;
  online: boolean | null;
  snr: Series24h | null;
  codewords: Series24h | null;
  seriesSource: 'ISP_MONITOR' | 'SIMULATED';
  now: Date;
}): DocsisMetrics {
  const { id, online, now } = input;
  const rng = seededRng(`ispmonitor:docsis:${id}`);
  const down = online !== false;

  // Downstream: 4 portadoras SC-QAM de 6 MHz desde 579 MHz (plan típico).
  const dsBase = rng.floatBetween(-4, 5, 1);
  const dsSnrRandom = rng.floatBetween(34, 40, 1);
  const usSnrRandom = rng.floatBetween(28, 37, 1);
  // En mock, las series simuladas de SNR (`snrDown`/`snrUp`) mandan: así el
  // bloque coincide con el gráfico de 24 h que ve el técnico.
  const mockSeries = input.seriesSource === 'SIMULATED' ? input.snr : null;
  const dsSnrBase = (mockSeries && lastValue(mockSeries.points, 'snrDown')) ?? dsSnrRandom;
  const usSnrMock = (mockSeries && lastValue(mockSeries.points, 'snrUp')) ?? usSnrRandom;
  const downstreamChannels: DocsisChannel[] = Array.from({ length: 4 }, (_, i) => ({
    channelId: `DS${i + 1}`,
    direction: 'downstream' as const,
    label: `Downstream ${i + 1}`,
    frequencyMHz: 579 + i * 6,
    powerDbmv: down ? round(dsBase + rng.floatBetween(-0.8, 0.8, 1)) : null,
    snrDb: down ? round(dsSnrBase + rng.floatBetween(-0.6, 0.6, 1)) : null,
    modulation: '256-QAM',
    simulatedFields: ['frequencyMHz', 'powerDbmv', 'snrDb', 'modulation'],
  }));

  // Upstream: canales reales (SNR) si ISP Monitor los trae; si no, 2 simulados.
  const realUp = input.seriesSource === 'ISP_MONITOR' ? upstreamSnrFromSeries(input.snr) : [];
  const usBase = rng.floatBetween(38, 48, 1);
  const upstreamChannels: DocsisChannel[] =
    realUp.length > 0
      ? realUp.map((c, i) => ({
          channelId: c.ifIndex !== null ? String(c.ifIndex) : `US${i + 1}`,
          direction: 'upstream' as const,
          label: c.label,
          frequencyMHz: round(18.8 + i * 6.4),
          powerDbmv: down ? round(usBase + rng.floatBetween(-1, 1, 1)) : null,
          snrDb: c.snrDb,
          modulation: '64-QAM',
          simulatedFields: ['frequencyMHz', 'powerDbmv', 'modulation'],
        }))
      : Array.from({ length: 2 }, (_, i) => ({
          channelId: `US${i + 1}`,
          direction: 'upstream' as const,
          label: `Logical Upstream Channel 0/1.${i}/0`,
          frequencyMHz: round(18.8 + i * 6.4),
          powerDbmv: down ? round(usBase + rng.floatBetween(-1, 1, 1)) : null,
          snrDb: down ? round(usSnrMock + (i === 0 ? 0 : -0.4)) : null,
          modulation: '64-QAM',
          simulatedFields: ['frequencyMHz', 'powerDbmv', 'snrDb', 'modulation'],
        }));

  const cw =
    input.codewords !== null
      ? codewordsFromSeries(input.codewords)
      : { corrected: null, uncorrected: null };
  const codewordsSource: MetricSource =
    input.codewords === null ? 'NONE' : input.seriesSource;

  const base: Omit<DocsisMetrics, 'health'> = {
    technology: 'HFC',
    simulated: true, // potencias y downstream siempre lo son
    sources: {
      snrUpstream: realUp.length > 0 ? 'ISP_MONITOR' : 'SIMULATED',
      snrDownstream: 'SIMULATED',
      power: 'SIMULATED',
      codewords: codewordsSource,
    },
    downstream: {
      powerDbmv: avg(downstreamChannels.map((c) => c.powerDbmv)),
      snrDb: avg(downstreamChannels.map((c) => c.snrDb)),
      channels: downstreamChannels,
    },
    upstream: {
      powerDbmv: avg(upstreamChannels.map((c) => c.powerDbmv)),
      snrDb: avg(upstreamChannels.map((c) => c.snrDb)),
      channels: upstreamChannels,
    },
    codewords: { correctedPercent: cw.corrected, uncorrectedPercent: cw.uncorrected },
    thresholds: DOCSIS_THRESHOLDS,
    measuredAt: now.toISOString(),
  };
  return { ...base, health: docsisHealth(base, online) };
}

// ---------------------------------------------------------------------------
// GPON (ONT / ONU)
// ---------------------------------------------------------------------------

export type OnuState = 'ONLINE' | 'OFFLINE' | 'LOS' | 'DYING_GASP' | 'UNKNOWN';

export interface GponMetrics {
  technology: 'GPON';
  /** Siempre `true` hoy: ISP Monitor no publica la capa óptica. */
  simulated: boolean;
  sources: { optical: MetricSource; onuState: MetricSource; accessNetwork: MetricSource; oltTopology: MetricSource };
  onu: {
    serial: string;
    onuId: number;
    state: OnuState;
    stateLabel: string;
  };
  olt: {
    name: string;
    /** frame/slot/port de la OLT. */
    ponPort: string;
    /** Puerto de OLT según ISP Monitor (`networks` de la ficha): REAL si lo hay. */
    accessNetworkIds: number[];
  };
  optical: {
    /** Potencia recibida en el ONT (dBm). */
    rxPowerDbm: number | null;
    /** Potencia transmitida por el ONT (dBm). */
    txPowerDbm: number | null;
    /** Potencia del ONT recibida en la OLT (dBm). */
    oltRxPowerDbm: number | null;
  };
  /** Distancia OLT→ONT medida por el ranging. */
  distanceMeters: number | null;
  temperatureC: number | null;
  voltageV: number | null;
  biasCurrentMa: number | null;
  thresholds: {
    rxPowerDbm: { min: number; max: number; warnBelow: number };
    txPowerDbm: { min: number; max: number };
    oltRxPowerDbm: { min: number; max: number };
    temperatureCMax: number;
    voltageV: { min: number; max: number };
  };
  health: Health;
  measuredAt: string;
}

const GPON_THRESHOLDS: GponMetrics['thresholds'] = {
  // Clase B+ (ITU-T G.984.2).
  rxPowerDbm: { min: -27, max: -8, warnBelow: -25 },
  txPowerDbm: { min: 0.5, max: 5 },
  oltRxPowerDbm: { min: -28, max: -8 },
  temperatureCMax: 70,
  voltageV: { min: 3.1, max: 3.5 },
};

const ONU_STATE_LABELS: Record<OnuState, string> = {
  ONLINE: 'En línea',
  OFFLINE: 'Fuera de línea',
  LOS: 'Sin señal óptica (LOS)',
  DYING_GASP: 'Sin energía (dying gasp)',
  UNKNOWN: 'Desconocido',
};

function gponHealth(m: Omit<GponMetrics, 'health'>): Health {
  if (m.onu.state === 'LOS' || m.onu.state === 'DYING_GASP' || m.onu.state === 'OFFLINE') return 'CRITICAL';
  const t = m.thresholds;
  const rx = m.optical.rxPowerDbm;
  let h: Health = rx === null ? 'UNKNOWN' : rx < t.rxPowerDbm.min || rx > t.rxPowerDbm.max ? 'CRITICAL' : rx < t.rxPowerDbm.warnBelow ? 'WARNING' : 'OK';
  const tx = m.optical.txPowerDbm;
  if (tx !== null) h = worst(h, tx >= t.txPowerDbm.min && tx <= t.txPowerDbm.max ? 'OK' : 'WARNING');
  const olt = m.optical.oltRxPowerDbm;
  if (olt !== null) h = worst(h, olt >= t.oltRxPowerDbm.min && olt <= t.oltRxPowerDbm.max ? 'OK' : 'WARNING');
  if (m.temperatureC !== null && m.temperatureC > t.temperatureCMax) h = worst(h, 'WARNING');
  if (m.voltageV !== null && (m.voltageV < t.voltageV.min || m.voltageV > t.voltageV.max)) h = worst(h, 'WARNING');
  return h;
}

/**
 * Bloque óptico GPON. La capa óptica, la OLT/PON/ONU id, distancia y
 * temperatura/voltaje son SIMULADOS (ISP Monitor no los publica). El estado de
 * la ONU y los ids de red de acceso salen de la ficha real cuando existe.
 *
 * `lastOutageCause` (la de la caída en curso, si la hay) decide si la ONU
 * está en LOS o dying gasp; si no se conoce, queda `OFFLINE`.
 */
export function buildGponMetrics(input: {
  id: string;
  terminal: TerminalSnapshot;
  terminalSource: 'ISP_MONITOR' | 'SIMULATED';
  ongoingCause: OutageCause | null;
  now: Date;
}): GponMetrics {
  const { id, terminal, now } = input;
  const rng = seededRng(`ispmonitor:gpon:${id}`);
  const online = terminal.online;
  const state: OnuState =
    online === true
      ? 'ONLINE'
      : online === false
        ? input.ongoingCause === 'LOS' || input.ongoingCause === 'DYING_GASP'
          ? input.ongoingCause
          : 'OFFLINE'
        : 'UNKNOWN';
  const up = state === 'ONLINE' || state === 'UNKNOWN';
  const city = (terminal.city ?? 'GYE').slice(0, 3).toUpperCase();

  // Potencia recibida: la mayoría en rango sano, algunas cerca del límite.
  const rx = rng.bool(0.8) ? rng.floatBetween(-23.5, -15, 2) : rng.floatBetween(-27.8, -24, 2);
  const base: Omit<GponMetrics, 'health'> = {
    technology: 'GPON',
    simulated: true,
    sources: {
      optical: 'SIMULATED',
      onuState: online === null ? 'NONE' : input.terminalSource,
      accessNetwork: terminal.networkIds.length > 0 ? input.terminalSource : 'NONE',
      oltTopology: 'SIMULATED',
    },
    onu: { serial: id, onuId: rng.intBetween(1, 128), state, stateLabel: ONU_STATE_LABELS[state] },
    olt: {
      name: `OLT-${city}-${String(rng.intBetween(1, 12)).padStart(2, '0')}`,
      ponPort: `0/${rng.intBetween(1, 16)}/${rng.intBetween(0, 15)}`,
      accessNetworkIds: terminal.networkIds,
    },
    optical: {
      rxPowerDbm: up ? rx : null,
      txPowerDbm: up ? rng.floatBetween(1.2, 3.8, 2) : null,
      oltRxPowerDbm: up ? round(rx - rng.floatBetween(1, 3, 2), 2) : null,
    },
    distanceMeters: rng.intBetween(350, 14_500),
    temperatureC: up ? rng.floatBetween(38, 58, 1) : null,
    voltageV: up ? rng.floatBetween(3.24, 3.36, 2) : null,
    biasCurrentMa: up ? rng.floatBetween(8, 22, 1) : null,
    thresholds: GPON_THRESHOLDS,
    measuredAt: now.toISOString(),
  };
  return { ...base, health: gponHealth(base) };
}
