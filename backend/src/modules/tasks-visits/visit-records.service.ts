// Registros guardados en la app (speedtest, ping, traceroute, señal WiFi,
// distancia, equipos retirados) asociados a cada VISITA de la cuenta.
//
// Reemplaza al "historial de la app" (conteos sueltos de tool-history): cada
// visita dice qué se hizo, qué no y qué datos arrojó.
//
// Cómo se asocia un registro a una visita (en este orden):
//   1. `taskId` del registro == `workOrder` (ORDER/…) o `fsmTaskId` (TASK/…) de
//      la visita → `linkedBy: TASK_ID`. Es lo exacto: la app debe mandar el
//      `taskId` de la visita en curso al guardar.
//   2. Si no trae `taskId` (registros viejos) o no coincide con ninguna visita:
//      por VENTANA DE TIEMPO de la visita, misma cuenta → `linkedBy: TIME_WINDOW`.
//      Ventana = [creación de la orden (como mucho 72 h antes del fin),
//      fin de la orden + 2 h]; la pendiente llega hasta ahora + 2 h. Si cae en
//      varias ventanas gana la visita cuyo fin es el más próximo.
//   Las visitas CANCELADAS solo reciben registros por `taskId` (no hubo visita).
//
// Solo lee la base propia: cero llamadas a sistemas externos.

import { prisma } from '../../db/prisma.js';
import type { VisitItem, VisitsResult } from '../../connectors/index.js';
import { normalizeAccountNumber } from '../whitelist/whitelist.normalize.js';
import { toDistanceDto, type DistanceMeasurementDto } from '../tools/distance/distance.mappers.js';
import { toSpeedtestDto, type SpeedtestDto } from '../tools/speedtest/speedtest.mappers.js';
import { toHeatmapDto, type HeatmapDto } from '../tools/heatmap/heatmap.mappers.js';
import { toPingDto, type PingTestDto } from '../tools/ping/ping.mappers.js';
import { toTracerouteDto, type TracerouteDto } from '../tools/traceroute/traceroute.mappers.js';
import {
  toRetiredEquipmentDto,
  type RetiredEquipmentDto,
} from '../retired-equipment/retired-equipment.mappers.js';

/** Margen tras el cierre de la orden: el técnico suele guardar al salir. */
export const VISIT_WINDOW_GRACE_MS = 2 * 3600_000;
/** Tope hacia atrás desde el fin: una orden puede crearse días antes de la visita. */
export const VISIT_WINDOW_LOOKBACK_MS = 72 * 3600_000;
/** Registros por tipo que se leen por cuenta (los más recientes). */
const MAX_RECORDS_PER_TYPE = 500;

export type LinkedBy = 'TASK_ID' | 'TIME_WINDOW';

export type RecordType =
  | 'speedtest'
  | 'externalSpeedtest'
  | 'ping'
  | 'traceroute'
  | 'wifiSignal'
  | 'distance'
  | 'retiredEquipment';

const RECORD_LABELS: Record<RecordType, string> = {
  speedtest: 'Speedtest (app)',
  externalSpeedtest: 'Speedtest (dispositivo externo)',
  ping: 'Ping',
  traceroute: 'Traceroute',
  wifiSignal: 'Medición de señal WiFi',
  distance: 'Medición de distancia',
  retiredEquipment: 'Equipos retirados',
};

type Linked<T> = T & { linkedBy: LinkedBy };

export interface VisitRecords {
  /** Cómo se asociaron: TASK_ID, TIME_WINDOW, MIXED o `null` si no hay registros. */
  linkedBy: LinkedBy | 'MIXED' | null;
  /** Ventana de tiempo usada para el paso 2; `null` en visitas canceladas o sin fechas. */
  window: { from: string; until: string } | null;
  /** Qué se hizo y qué no, en orden fijo. */
  checklist: Array<{ type: RecordType; label: string; done: boolean; count: number }>;
  /** Speedtests de la app y del dispositivo externo (ver `source`). */
  speedtests: Array<Linked<SpeedtestDto>>;
  pingTests: Array<Linked<PingTestDto>>;
  tracerouteTests: Array<Linked<TracerouteDto>>;
  /** Mediciones de señal WiFi (mapa de calor por habitación y AP). */
  wifiHeatmaps: Array<Linked<HeatmapDto>>;
  distanceMeasurements: Array<Linked<DistanceMeasurementDto>>;
  retiredEquipment: Array<Linked<RetiredEquipmentDto>>;
}

export type VisitWithRecords = VisitItem & { records: VisitRecords };

export interface VisitsWithRecordsResult extends Omit<VisitsResult, 'items'> {
  items: VisitWithRecords[];
  recordsSummary: {
    /** Registros de la cuenta asociados a alguna visita. */
    linked: number;
    /** Registros de la cuenta que no caen en ninguna visita. */
    unlinked: number;
    windowGraceHours: number;
    windowLookbackHours: number;
  };
}

/** Registros de la cuenta, ya mapeados a DTO, listos para repartir. */
export interface AccountRecords {
  speedtests: SpeedtestDto[];
  pingTests: PingTestDto[];
  tracerouteTests: TracerouteDto[];
  wifiHeatmaps: HeatmapDto[];
  distanceMeasurements: DistanceMeasurementDto[];
  retiredEquipment: RetiredEquipmentDto[];
}

export interface VisitRecordsRepository {
  loadAccountRecords(accountNumbers: string[]): Promise<AccountRecords>;
}

export const prismaVisitRecordsRepository: VisitRecordsRepository = {
  async loadAccountRecords(accountNumbers) {
    const where = { accountNumber: { in: accountNumbers } };
    const [speedtests, pings, traceroutes, heatmaps, distance, retired] = await Promise.all([
      prisma.speedtest.findMany({ where, orderBy: { measuredAt: 'desc' }, take: MAX_RECORDS_PER_TYPE }),
      prisma.pingTest.findMany({ where, orderBy: { measuredAt: 'desc' }, take: MAX_RECORDS_PER_TYPE }),
      prisma.tracerouteTest.findMany({
        where,
        orderBy: { measuredAt: 'desc' },
        take: MAX_RECORDS_PER_TYPE,
        include: { hops: true },
      }),
      prisma.wifiHeatmap.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: MAX_RECORDS_PER_TYPE,
        include: { rooms: { include: { measurements: true } } },
      }),
      prisma.distanceMeasurement.findMany({ where, orderBy: { measuredAt: 'desc' }, take: MAX_RECORDS_PER_TYPE }),
      prisma.retiredEquipment.findMany({
        where,
        orderBy: { retiredAt: 'desc' },
        take: MAX_RECORDS_PER_TYPE,
        include: { barcodePhoto: true },
      }),
    ]);
    return {
      speedtests: speedtests.map(toSpeedtestDto),
      pingTests: pings.map(toPingDto),
      tracerouteTests: traceroutes.map(toTracerouteDto),
      wifiHeatmaps: heatmaps.map(toHeatmapDto),
      distanceMeasurements: distance.map(toDistanceDto),
      retiredEquipment: retired.map(toRetiredEquipmentDto),
    };
  },
};

let repository: VisitRecordsRepository = prismaVisitRecordsRepository;

/** Solo para tests. `null` restaura Prisma. */
export function setVisitRecordsRepository(repo: VisitRecordsRepository | null): void {
  repository = repo ?? prismaVisitRecordsRepository;
}

// ---------------------------------------------------------------------------
// Asociación (pura)
// ---------------------------------------------------------------------------

function normKey(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase();
  return v ? v : null;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Ventana de tiempo de una visita; `null` si no aplica (cancelada o sin fechas). */
export function visitWindow(visit: VisitItem, now: Date): { from: number; until: number } | null {
  if (visit.result === 'CANCELADA') return null;
  const end =
    visit.result === 'PENDIENTE'
      ? now.getTime()
      : (parseMs(visit.endedAt) ?? parseMs(visit.occurredAt));
  if (end === null) return null;
  const created = parseMs(visit.createdAt);
  const from = Math.max(created ?? end - VISIT_WINDOW_LOOKBACK_MS, end - VISIT_WINDOW_LOOKBACK_MS);
  return { from, until: end + VISIT_WINDOW_GRACE_MS };
}

interface Assignable {
  taskId?: string;
  /** Instante del registro (ISO). */
  at: string;
}

/**
 * Índice de la visita a la que pertenece un registro, o `null`. Ver la
 * cabecera del módulo para las reglas.
 */
export function assignToVisit(
  record: Assignable,
  visits: VisitItem[],
  windows: Array<{ from: number; until: number } | null>,
): { index: number; linkedBy: LinkedBy } | null {
  const key = normKey(record.taskId);
  if (key) {
    const index = visits.findIndex(
      (v) => normKey(v.workOrder) === key || normKey(v.fsmTaskId) === key,
    );
    if (index !== -1) return { index, linkedBy: 'TASK_ID' };
  }
  const at = parseMs(record.at);
  if (at === null) return null;
  let best: { index: number; distance: number } | null = null;
  windows.forEach((w, index) => {
    if (!w || at < w.from || at > w.until) return;
    // Fin "real" de la ventana (sin el margen): gana el más próximo al registro.
    const distance = Math.abs(w.until - VISIT_WINDOW_GRACE_MS - at);
    if (!best || distance < best.distance) best = { index, distance };
  });
  return best === null ? null : { index: (best as { index: number }).index, linkedBy: 'TIME_WINDOW' };
}

function emptyRecords(window: { from: number; until: number } | null): VisitRecords {
  return {
    linkedBy: null,
    window: window
      ? { from: new Date(window.from).toISOString(), until: new Date(window.until).toISOString() }
      : null,
    checklist: [],
    speedtests: [],
    pingTests: [],
    tracerouteTests: [],
    wifiHeatmaps: [],
    distanceMeasurements: [],
    retiredEquipment: [],
  };
}

function finalize(records: VisitRecords): VisitRecords {
  const count = (type: RecordType): number => {
    switch (type) {
      case 'speedtest':
        return records.speedtests.filter((s) => s.source !== 'external-device').length;
      case 'externalSpeedtest':
        return records.speedtests.filter((s) => s.source === 'external-device').length;
      case 'ping':
        return records.pingTests.length;
      case 'traceroute':
        return records.tracerouteTests.length;
      case 'wifiSignal':
        return records.wifiHeatmaps.length;
      case 'distance':
        return records.distanceMeasurements.length;
      case 'retiredEquipment':
        return records.retiredEquipment.length;
    }
  };
  const types = Object.keys(RECORD_LABELS) as RecordType[];
  records.checklist = types.map((type) => {
    const n = count(type);
    return { type, label: RECORD_LABELS[type], done: n > 0, count: n };
  });
  const all: LinkedBy[] = [
    ...records.speedtests,
    ...records.pingTests,
    ...records.tracerouteTests,
    ...records.wifiHeatmaps,
    ...records.distanceMeasurements,
    ...records.retiredEquipment,
  ].map((r) => r.linkedBy);
  const kinds = new Set(all);
  records.linkedBy = kinds.size === 0 ? null : kinds.size === 1 ? (all[0] as LinkedBy) : 'MIXED';
  return records;
}

/** Reparte los registros de la cuenta entre sus visitas. Pura. */
export function attachRecords(
  visits: VisitsResult,
  records: AccountRecords,
  now: Date = new Date(),
): VisitsWithRecordsResult {
  const windows = visits.items.map((v) => visitWindow(v, now));
  const buckets = windows.map(emptyRecords);
  let linked = 0;
  let unlinked = 0;

  function place<T extends { taskId?: string }>(
    list: T[],
    at: (r: T) => string,
    pick: (b: VisitRecords) => Array<Linked<T>>,
  ): void {
    for (const r of list) {
      const hit = assignToVisit({ ...(r.taskId ? { taskId: r.taskId } : {}), at: at(r) }, visits.items, windows);
      if (!hit) {
        unlinked += 1;
        continue;
      }
      linked += 1;
      pick(buckets[hit.index] as VisitRecords).push({ ...r, linkedBy: hit.linkedBy });
    }
  }

  place(records.speedtests, (r) => r.measuredAt, (b) => b.speedtests);
  place(records.pingTests, (r) => r.measuredAt, (b) => b.pingTests);
  place(records.tracerouteTests, (r) => r.measuredAt, (b) => b.tracerouteTests);
  place(records.wifiHeatmaps, (r) => r.createdAt, (b) => b.wifiHeatmaps);
  place(records.distanceMeasurements, (r) => r.measuredAt, (b) => b.distanceMeasurements);
  place(records.retiredEquipment, (r) => r.retiredAt, (b) => b.retiredEquipment);

  return {
    ...visits,
    items: visits.items.map((v, i) => ({ ...v, records: finalize(buckets[i] as VisitRecords) })),
    recordsSummary: {
      linked,
      unlinked,
      windowGraceHours: VISIT_WINDOW_GRACE_MS / 3600_000,
      windowLookbackHours: VISIT_WINDOW_LOOKBACK_MS / 3600_000,
    },
  };
}

/**
 * Registros de la cuenta tal como se tecleó y normalizada (`035070291` y
 * `35070291` son la misma cuenta).
 */
export async function withVisitRecords(
  accountNumber: string,
  visits: VisitsResult,
): Promise<VisitsWithRecordsResult> {
  const keys = new Set([accountNumber.trim()]);
  const normalized = normalizeAccountNumber(accountNumber);
  if (normalized) keys.add(normalized);
  const records = await repository.loadAccountRecords([...keys]);
  return attachRecords(visits, records);
}
