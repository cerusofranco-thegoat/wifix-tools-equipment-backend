// ---------------------------------------------------------------------------
// Conector hacia FSM (`fsm-data-ms`) — campos 1-3, 6, 7, 8, 15 y 16.
//
// Capas:  routes → este módulo (modelo interno, mock|real)
//                → http/fsm-api.ts (HTTP + caudal)
//                → http/fsm-token.ts (Bearer por marca)
// Ninguna ruta importa `http/fsm-api.ts` directamente.
//
// El mock NO se borra: es lo que permite al frontend trabajar sin token, y
// devuelve exactamente los mismos shapes que el modo real.
// ---------------------------------------------------------------------------

import { connectorMode, env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, type Degraded } from '../_shared.js';
import {
  fetchAccountProcess,
  fetchAccountStatus,
  fetchNapAccounts,
  fetchNapsNearest,
  fetchWorkOrderTasks,
} from '../http/fsm-api.js';
import type { FsmBrand } from '../http/fsm-token.js';
import { createLimiter } from '../http/throttle.js';
import type { Coordinates, NapPort, NapPorts, NearbyNap } from '../tec/index.js';
import {
  classifyTaskResult,
  inferNapTotalPorts,
  mapAccountProcess,
  mapAccountStatus,
  mapNapAccounts,
  mapNapNearest,
  mapStatusCode,
  mapWorkOrderTasks,
  NAP_MAX_PORTS,
  type AccountStatusName,
  type FsmClient,
  type FsmNote,
  type FsmOrder,
  type FsmStatusCode,
  type TaskResult,
} from './normalize.js';

export type { TaskResult, FsmStatusCode, AccountStatusName };

// --- Modelo público del conector -------------------------------------------

export interface ClosedTask {
  taskId: string;
  /** Orden de trabajo a la que pertenece (`ORDER/424900/2026`). */
  workOrder: string | null;
  occurredAt: string;
  reason: string;
  closingNotes: string;
  /**
   * Técnico que cerró la tarea (`lastModifyUser` de `/workorder/tasks`,
   * expuesto por la operadora el 2026-09-09). Sigue siendo `null` en las
   * visitas de `/account/process`, que no abren las tareas: ese dato aparece al
   * expandir la visita (`notesLoaded: true`).
   */
  technician: string | null;
  result: TaskResult;
  /** false mientras no se hayan cargado las notas de la orden (§9 del contrato). */
  notesLoaded: boolean;
}

export interface PreviousVisitsResult {
  items: ClosedTask[];
  totalOrders: number;
  brand: FsmBrand;
  degraded?: Degraded;
}

export interface UnsatisfactoryTasksResult {
  items: ClosedTask[];
  scanned: number;
  totalOrders: number;
  truncated: boolean;
  brand: FsmBrand;
  degraded?: Degraded;
}

export interface AccountOrder {
  workOrder: string;
  task: string | null;
  state: string | null;
  externalProcess: string | null;
  cpartyId: string | null;
  createdAt: string | null;
  endedAt: string | null;
  finished: boolean;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

export interface AccountOrdersClient {
  names: string | null;
  phoneNumber: string | null;
  email: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface AccountOrders {
  accountNumber: string;
  brand: FsmBrand;
  client: AccountOrdersClient | null;
  orders: AccountOrder[];
}

export interface AccountStatusResult {
  accountNumber: string;
  brand: FsmBrand;
  status: AccountStatusName | null;
  statusCode: FsmStatusCode | null;
  statusDescription: string | null;
}

export interface StatusBatchItem {
  accountNumber: string;
  status: AccountStatusName | null;
  statusCode: FsmStatusCode | null;
  statusDescription: string | null;
  error: string | null;
}

export interface StatusBatchResult {
  brand: FsmBrand;
  items: StatusBatchItem[];
  requested: number;
  resolved: number;
  failed: number;
}

export interface WorkOrderTaskNote {
  createdAt: string | null;
  content: string;
}

export interface WorkOrderTask {
  taskId: string;
  status: string | null;
  businessKey: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  result: TaskResult;
  /** Técnico que cerró la tarea (`lastModifyUser`). */
  closedBy: string | null;
  notes: WorkOrderTaskNote[];
}

export interface WorkOrderTasks {
  workOrder: string;
  brand: FsmBrand;
  tasks: WorkOrderTask[];
}

export interface BrandOptions {
  brand: FsmBrand;
}

export interface UnsatisfactoryOptions extends BrandOptions {
  /** Órdenes finalizadas más recientes que se abren para leer sus notas. */
  limit: number;
}

export interface OrdersOptions extends BrandOptions {
  estado: 'Todas' | 'Pendientes';
}

export interface NearbyNapsOptions extends BrandOptions {
  meters: number;
  maxRows: number;
}

export interface NapPortsOptions extends BrandOptions {
  /**
   * Resuelve además el estado de las cuentas del NAP. Existe SOLO para
   * `probe-fsm-api.ts` y soporte: la webapp tiene prohibido enviarlo, porque
   * dispara hasta `FSM_STATUS_BATCH_LIMIT` llamadas extra a producción.
   */
  withStatus: boolean;
}

export interface FsmConnector {
  getUnsatisfactoryTasks(
    accountNumber: string,
    opts: UnsatisfactoryOptions,
  ): Promise<UnsatisfactoryTasksResult>;
  getPreviousVisits(accountNumber: string, opts: BrandOptions): Promise<PreviousVisitsResult>;
  getAccountOrders(accountNumber: string, opts: OrdersOptions): Promise<AccountOrders>;
  getAccountStatus(accountNumber: string, opts: BrandOptions): Promise<AccountStatusResult>;
  getAccountsStatusBatch(accounts: string[], opts: BrandOptions): Promise<StatusBatchResult>;
  getNearbyNaps(coords: Coordinates, opts: NearbyNapsOptions): Promise<NearbyNap[]>;
  getNapPorts(napId: number, opts: NapPortsOptions): Promise<NapPorts>;
  getWorkOrderTasks(workOrder: string, opts: BrandOptions): Promise<WorkOrderTasks>;
}

// --- Helpers compartidos por mock y real ------------------------------------

/** Notas de una tarea concatenadas, listas para mostrar como cierre. */
function joinNotes(notes: Array<{ content: string }>): string {
  return notes
    .map((n) => n.content.trim())
    .filter((c) => c.length > 0)
    .join(' · ');
}

/** Una orden de `/account/process` vista como visita (campo 16, sin notas). */
function orderToVisit(order: AccountOrder): ClosedTask {
  return {
    taskId: order.workOrder,
    workOrder: order.workOrder,
    occurredAt: order.endedAt ?? order.createdAt ?? '',
    reason: order.task ?? '',
    closingNotes: '',
    technician: null,
    result: order.finished ? 'SATISFACTORIA' : 'PENDIENTE',
    notesLoaded: false,
  };
}

/** Una tarea de `/workorder/tasks` vista como visita cerrada (campo 15). */
function taskToClosedTask(workOrder: string, task: WorkOrderTask): ClosedTask {
  return {
    taskId: task.taskId,
    workOrder,
    occurredAt: task.finishedAt ?? task.createdAt ?? '',
    reason: task.status ?? '',
    closingNotes: joinNotes(task.notes),
    // `lastModifyUser`: quién cerró la tarea. Solo se conoce con las tareas
    // abiertas, no con la orden desnuda de `/account/process`.
    technician: task.closedBy,
    result: task.result,
    notesLoaded: true,
  };
}

/** Visitas ordenadas de la más reciente a la más antigua. */
function visitsDesc(items: ClosedTask[]): ClosedTask[] {
  return [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** Órdenes finalizadas, de la más reciente a la más antigua. */
function finishedOrdersDesc(orders: AccountOrder[]): AccountOrder[] {
  return orders
    .filter((o) => o.finished)
    .sort((a, b) =>
      String(b.endedAt ?? b.createdAt ?? '').localeCompare(String(a.endedAt ?? a.createdAt ?? '')),
    );
}

function truncatedDegraded(scanned: number, totalOrders: number): Degraded {
  return {
    reason: 'TRUNCATED',
    message:
      `Se revisaron las ${scanned} órdenes más recientes de ${totalOrders}. ` +
      `Abre una visita concreta para ver sus notas.`,
  };
}

/** Elimina duplicados conservando el orden de entrada. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function isUpstreamAuthError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'UPSTREAM_AUTH_ERROR';
}

/**
 * Rejilla de puertos 1..totalPorts a partir de los registros de `/naps/accounts`.
 * Los puertos que no aparecen en la respuesta se consideran libres.
 *
 * `/naps/accounts` solo devuelve los puertos OCUPADOS. Cuando no se conoce el
 * total (porque no se pasó por `/naps/nearest`), se aplica la regla oficial de
 * la operadora (2026-09-09): 8 puertos base, 16 si hay más de 8 ocupados, con
 * 16 como máximo absoluto. La rejilla sale **siempre completa**: nunca se
 * devuelven solo los ocupados.
 */
function buildPortGrid(
  rows: Array<{ portNumber: number | null; accountNumber: string | null; equipmentId: string | null }>,
  totalPorts: number | null,
): { ports: NapPort[]; occupied: number; total: number } {
  const byPort = new Map<number, { accountNumber: string | null; equipmentId: string | null }>();
  let maxPort = 0;
  for (const row of rows) {
    if (row.portNumber === null || !Number.isFinite(row.portNumber)) continue;
    const port = Math.trunc(row.portNumber);
    if (port <= 0) continue;
    maxPort = Math.max(maxPort, port);
    byPort.set(port, { accountNumber: row.accountNumber, equipmentId: row.equipmentId });
  }

  // El número de puerto más alto también delata la ampliación: una NAP con el
  // puerto 12 ocupado es de 16 aunque solo tenga 3 cuentas conectadas.
  const evidence = Math.max(byPort.size, maxPort);
  const declared = totalPorts && totalPorts > 0 ? totalPorts : 0;
  const total = Math.min(
    NAP_MAX_PORTS,
    Math.max(declared, evidence, inferNapTotalPorts(evidence)),
  );

  const ports: NapPort[] = [];
  for (let i = 1; i <= total; i++) {
    const hit = byPort.get(i);
    ports.push({
      portNumber: i,
      occupied: Boolean(hit),
      clientAccountNumber: hit?.accountNumber ?? null,
      equipmentId: hit?.equipmentId ?? null,
      clientStatus: null,
      statusPending: Boolean(hit?.accountNumber),
    });
  }

  return { ports, occupied: byPort.size, total };
}

// ---------------------------------------------------------------------------
// Mock — datos deterministas por cuenta. Mismos shapes que el modo real.
// ---------------------------------------------------------------------------

const REASONS = [
  'INSTALACION',
  'MANTENIMIENTO',
  'SIN SERVICIO',
  'LENTITUD',
  'CAMBIO DE EQUIPO',
  'RECONFIGURACION DE RED',
];

const NOTES_OK = [
  'Cliente reporta intermitencia, se reinició ONT.',
  'Se cambió cable de patch y mejoró señal.',
  'Configuración de SSID y contraseña aplicada.',
  'Sin novedades, servicio operando con normalidad.',
];

/** Usuarios que cierran tareas (`lastModifyUser`) en el mock. */
const TECHNICIAN_USERS = ['jcevallos', 'mmendoza', 'asalazar', 'dyepez'];

const NOTES_BAD = [
  'Cliente no se encontraba en sitio, se reprogramada la visita.',
  'Instalación rechazada por falta de permisos del edificio.',
  'Reincidencia: el mismo daño se reportó la semana pasada.',
];

/** Órdenes simuladas de una cuenta, estables entre llamadas. */
function mockOrders(accountNumber: string): AccountOrder[] {
  const rng = seededRng(`fsm:orders:${accountNumber}`);
  const n = rng.intBetween(1, 12);
  const orders: AccountOrder[] = [];
  for (let i = 0; i < n; i++) {
    const created = new Date();
    created.setDate(created.getDate() - rng.intBetween(1, 300));
    created.setHours(rng.intBetween(8, 17), rng.intBetween(0, 59), 0, 0);
    const finished = rng.bool(0.8);
    const ended = new Date(created.getTime() + rng.intBetween(40, 240) * 60_000);
    orders.push({
      workOrder: `ORDER/${rng.intBetween(100000, 999999)}/${created.getFullYear()}`,
      task: rng.pick(REASONS),
      state: finished ? 'FINALIZADA' : 'EN PROCESO',
      externalProcess: `PROC-${rng.intBetween(1000, 9999)}`,
      cpartyId: `CP-${rng.intBetween(10000, 99999)}`,
      createdAt: created.toISOString(),
      endedAt: finished ? ended.toISOString() : null,
      finished,
      note: rng.pick(NOTES_OK),
      latitude: -2.247946 + rng.floatBetween(-0.01, 0.01, 6),
      longitude: -79.904161 + rng.floatBetween(-0.01, 0.01, 6),
      address: `Av. Amazonas N${rng.intBetween(100, 9999)}, Guayaquil`,
    });
  }
  return orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function mockClient(accountNumber: string): AccountOrdersClient {
  const rng = seededRng(`fsm:client:${accountNumber}`);
  const first = rng.pick(['María', 'Juan', 'Andrea', 'Carlos', 'Lucía', 'Diego']);
  const last = rng.pick(['Cevallos', 'Mendoza', 'Suárez', 'Andrade', 'Yépez', 'Salazar']);
  const second = rng.pick(['Andrade', 'Vega', 'Ortega', 'Tapia', 'Reyes']);
  const orders = mockOrders(accountNumber);
  const recent = orders[0];
  return {
    names: `${first} ${last} ${second}`,
    phoneNumber: `09${rng.intBetween(80000000, 99999999)}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
    address: recent?.address ?? `Av. Amazonas N${rng.intBetween(100, 9999)}, Guayaquil`,
    latitude: recent?.latitude ?? -2.247946,
    longitude: recent?.longitude ?? -79.904161,
  };
}

/** Tareas simuladas de una orden, con notas satisfactorias o no. */
function mockTasks(workOrder: string): WorkOrderTask[] {
  const rng = seededRng(`fsm:tasks:${workOrder}`);
  const n = rng.intBetween(1, 3);
  const tasks: WorkOrderTask[] = [];
  for (let i = 0; i < n; i++) {
    const created = new Date();
    created.setDate(created.getDate() - rng.intBetween(1, 300));
    const finished = rng.bool(0.85);
    const finishedAt = finished
      ? new Date(created.getTime() + rng.intBetween(30, 200) * 60_000).toISOString()
      : null;
    const bad = rng.bool(0.35);
    const notes: WorkOrderTaskNote[] = [
      {
        createdAt: created.toISOString(),
        content: bad ? rng.pick(NOTES_BAD) : rng.pick(NOTES_OK),
      },
    ];
    const status = finished ? 'CERRADA' : 'ABIERTA';
    tasks.push({
      taskId: `TASK/${rng.intBetween(100000, 999999)}/${created.getFullYear()}`,
      status,
      businessKey: `BK-${rng.intBetween(10000, 99999)}`,
      createdAt: created.toISOString(),
      finishedAt,
      result: classifyTaskResult({ status, finishedAt, notes }),
      // `lastModifyUser` en FSM: el usuario que cerró la tarea. Los usuarios
      // reales tienen pinta de login de la operadora, no de nombre y apellido.
      closedBy: finished ? rng.pick(TECHNICIAN_USERS) : null,
      notes,
    });
  }
  return tasks;
}

const MOCK_STATUS_CODES: FsmStatusCode[] = ['A', 'A', 'A', 'S', 'T', 'O', 'P'];

function mockStatus(accountNumber: string): {
  statusCode: FsmStatusCode;
  status: AccountStatusName;
  statusDescription: string;
} {
  const rng = seededRng(`fsm:status:${accountNumber}`);
  const code = rng.pick(MOCK_STATUS_CODES);
  const { status } = mapStatusCode(code);
  const descriptions: Record<FsmStatusCode, string> = {
    A: 'Activo',
    S: 'Suspendido',
    T: 'Terminado',
    O: 'Ordenado',
    P: 'Pendiente',
  };
  return { statusCode: code, status, statusDescription: descriptions[code] };
}

export const fsmMock: FsmConnector = {
  async getAccountOrders(accountNumber, opts) {
    const orders = mockOrders(accountNumber);
    const filtered =
      opts.estado === 'Pendientes' ? orders.filter((o) => !o.finished) : orders;
    return {
      accountNumber,
      brand: opts.brand,
      client: filtered.length > 0 || orders.length > 0 ? mockClient(accountNumber) : null,
      orders: filtered,
    };
  },

  async getPreviousVisits(accountNumber, opts) {
    const orders = mockOrders(accountNumber);
    return {
      items: visitsDesc(orders.map(orderToVisit)),
      totalOrders: orders.length,
      brand: opts.brand,
    };
  },

  async getUnsatisfactoryTasks(accountNumber, opts) {
    const orders = mockOrders(accountNumber);
    const finished = finishedOrdersDesc(orders);
    const slice = finished.slice(0, opts.limit);
    const items: ClosedTask[] = [];
    for (const order of slice) {
      for (const task of mockTasks(order.workOrder)) {
        if (task.result === 'INSATISFACTORIA') {
          items.push(taskToClosedTask(order.workOrder, task));
        }
      }
    }
    items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    const scanned = slice.length;
    const truncated = orders.length > scanned;
    return {
      items,
      scanned,
      totalOrders: orders.length,
      truncated,
      brand: opts.brand,
      ...(truncated ? { degraded: truncatedDegraded(scanned, orders.length) } : {}),
    };
  },

  async getWorkOrderTasks(workOrder, opts) {
    return { workOrder, brand: opts.brand, tasks: mockTasks(workOrder) };
  },

  async getAccountStatus(accountNumber, opts) {
    const { statusCode, status, statusDescription } = mockStatus(accountNumber);
    return { accountNumber, brand: opts.brand, status, statusCode, statusDescription };
  },

  async getAccountsStatusBatch(accounts, opts) {
    const unique = dedupe(accounts);
    const items: StatusBatchItem[] = unique.map((accountNumber) => {
      const { statusCode, status, statusDescription } = mockStatus(accountNumber);
      return { accountNumber, status, statusCode, statusDescription, error: null };
    });
    return {
      brand: opts.brand,
      items,
      requested: unique.length,
      resolved: items.filter((i) => i.status !== null).length,
      failed: items.filter((i) => i.status === null).length,
    };
  },

  async getNearbyNaps(coords, opts) {
    const seed = `fsm:naps:${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}`;
    const rng = seededRng(seed);
    const n = Math.min(opts.maxRows, rng.intBetween(2, 8));
    const naps: NearbyNap[] = [];
    for (let i = 0; i < n; i++) {
      // Misma regla que en real: se sortean los ocupados y el total sale de
      // ellos (8, o 16 si hay más de 8 ocupados).
      const occupied = rng.intBetween(0, NAP_MAX_PORTS);
      const total = inferNapTotalPorts(occupied);
      const distance = rng.floatBetween(10, Math.max(20, opts.meters), 1);
      const napId = rng.intBetween(10000, 19999);
      const nap: NearbyNap = {
        napId,
        napCode: `PL${rng.intBetween(10, 99)}${rng.pick(['KD', 'AB', 'XR', 'MN'])}${rng.intBetween(1, 9)}`,
        networkName: `OLT-GYE-${String(rng.intBetween(1, 9)).padStart(2, '0')}/1/${rng.intBetween(1, 8)}`,
        latitude: coords.latitude + rng.floatBetween(-0.002, 0.002, 6),
        longitude: coords.longitude + rng.floatBetween(-0.002, 0.002, 6),
        distanceMeters: distance,
        occupiedPorts: occupied,
        totalPorts: total,
        freePorts: Math.max(0, total - occupied),
        source: 'FSM',
      };
      naps.push(nap);
      rememberNap(napId, nap.napCode, total);
    }
    return naps.sort((a, b) => a.distanceMeters - b.distanceMeters);
  },

  async getNapPorts(napId, opts) {
    const rng = seededRng(`fsm:napports:${napId}`);
    const remembered = napRegistry.get(napId);
    const total = remembered?.totalPorts ?? NAP_MAX_PORTS;
    const rows: Array<{ portNumber: number; accountNumber: string; equipmentId: string }> = [];
    for (let i = 1; i <= total; i++) {
      if (!rng.bool(0.7)) continue;
      rows.push({
        portNumber: i,
        accountNumber: String(rng.intBetween(30000000, 79999999)),
        equipmentId: `ZTEGD${rng.intBetween(100000, 999999)}`,
      });
    }
    const grid = buildPortGrid(rows, total);
    const pending = grid.ports.filter((p) => p.statusPending);

    if (opts.withStatus && pending.length > 0) {
      const accounts = pending
        .slice(0, env.FSM_STATUS_BATCH_LIMIT)
        .map((p) => p.clientAccountNumber as string);
      const batch = await this.getAccountsStatusBatch(accounts, { brand: opts.brand });
      applyStatuses(grid.ports, batch);
    }

    return {
      napRef: String(napId),
      napId,
      napCode: remembered?.napCode ?? null,
      ports: grid.ports,
      detailAvailable: true,
      occupiedPorts: grid.occupied,
      totalPorts: grid.total,
      statusFanOut: {
        supported: true,
        pendingAccounts: grid.ports.filter((p) => p.statusPending).length,
        batchLimit: env.FSM_STATUS_BATCH_LIMIT,
      },
      source: 'FSM',
    };
  },
};

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

/**
 * Cuántos puertos tiene cada NAP y con qué código, memorizado de la última
 * `/naps/nearest`. `/naps/accounts` solo devuelve los puertos OCUPADOS, así que
 * sin este dato no se puede dibujar la rejilla completa.
 */
const napRegistry = new Map<number, { napCode: string; totalPorts: number }>();
const NAP_REGISTRY_MAX = 500;

function rememberNap(napId: number | null, napCode: string, totalPorts: number): void {
  if (napId === null || !Number.isFinite(napId) || totalPorts <= 0) return;
  if (napRegistry.size >= NAP_REGISTRY_MAX) {
    const oldest = napRegistry.keys().next();
    if (!oldest.done) napRegistry.delete(oldest.value);
  }
  napRegistry.set(napId, { napCode, totalPorts });
}

/** Solo para pruebas: olvida las NAPs memorizadas. */
export function resetNapRegistry(): void {
  napRegistry.clear();
}

/** Vuelca los estados de un lote sobre la rejilla de puertos. */
function applyStatuses(ports: NapPort[], batch: StatusBatchResult): void {
  const byAccount = new Map(batch.items.map((i) => [i.accountNumber, i]));
  for (const port of ports) {
    if (!port.clientAccountNumber) continue;
    const hit = byAccount.get(port.clientAccountNumber);
    if (!hit || hit.status === null) continue;
    port.clientStatus = hit.statusCode;
    port.statusPending = false;
  }
}

function toAccountOrder(order: FsmOrder): AccountOrder {
  return { ...order };
}

function toClient(client: FsmClient | null): AccountOrdersClient | null {
  return client === null ? null : { ...client };
}

function toWorkOrderNote(note: FsmNote): WorkOrderTaskNote {
  return { createdAt: note.createdAt, content: note.content };
}

export const fsmReal: FsmConnector = {
  async getAccountOrders(accountNumber, opts) {
    const raw = await fetchAccountProcess(opts.brand, accountNumber, opts.estado);
    const parsed = mapAccountProcess(raw);
    return {
      accountNumber,
      brand: opts.brand,
      client: toClient(parsed.client),
      orders: parsed.orders.map(toAccountOrder),
    };
  },

  async getPreviousVisits(accountNumber, opts) {
    // Una sola llamada: las notas se cargan bajo demanda al expandir la visita.
    const { orders } = await this.getAccountOrders(accountNumber, {
      brand: opts.brand,
      estado: 'Todas',
    });
    return {
      items: visitsDesc(orders.map(orderToVisit)),
      totalOrders: orders.length,
      brand: opts.brand,
    };
  },

  async getUnsatisfactoryTasks(accountNumber, opts) {
    const { orders } = await this.getAccountOrders(accountNumber, {
      brand: opts.brand,
      estado: 'Todas',
    });
    const slice = finishedOrdersDesc(orders).slice(0, opts.limit);

    // Fan-out acotado y con el mismo semáforo: como mucho `limit` llamadas más.
    const limiter = createLimiter(env.FSM_API_MAX_CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map((order) =>
        limiter(() => this.getWorkOrderTasks(order.workOrder, { brand: opts.brand })),
      ),
    );

    const items: ClosedTask[] = [];
    for (const result of settled) {
      if (result.status === 'rejected') {
        // Un fallo de token afecta a toda la consulta; el resto se ignora para
        // no dejar al técnico sin las órdenes que sí se pudieron leer.
        if (isUpstreamAuthError(result.reason)) throw result.reason;
        continue;
      }
      for (const task of result.value.tasks) {
        if (task.result === 'INSATISFACTORIA') {
          items.push(taskToClosedTask(result.value.workOrder, task));
        }
      }
    }
    items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    const scanned = slice.length;
    const truncated = orders.length > scanned;
    return {
      items,
      scanned,
      totalOrders: orders.length,
      truncated,
      brand: opts.brand,
      ...(truncated ? { degraded: truncatedDegraded(scanned, orders.length) } : {}),
    };
  },

  async getWorkOrderTasks(workOrder, opts) {
    const raw = await fetchWorkOrderTasks(opts.brand, workOrder);
    if (raw === null) {
      throw ApiError.notFound(`FSM no encontró la orden de trabajo ${workOrder}.`);
    }
    const tasks = mapWorkOrderTasks(raw).map((task) => ({
      taskId: task.taskId,
      status: task.status,
      businessKey: task.businessKey,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      result: task.result,
      closedBy: task.closedBy,
      notes: task.notes.map(toWorkOrderNote),
    }));
    return { workOrder, brand: opts.brand, tasks };
  },

  async getAccountStatus(accountNumber, opts) {
    const raw = await fetchAccountStatus(opts.brand, accountNumber);
    const parsed = raw === null ? null : mapAccountStatus(raw);
    if (parsed === null) {
      return {
        accountNumber,
        brand: opts.brand,
        status: null,
        statusCode: null,
        statusDescription: null,
      };
    }
    const { status } = mapStatusCode(parsed.statusCode);
    return {
      accountNumber,
      brand: opts.brand,
      status: parsed.statusCode === null ? null : status,
      statusCode: parsed.statusCode,
      statusDescription: parsed.statusDescription,
    };
  },

  async getAccountsStatusBatch(accounts, opts) {
    // "Lote" es interno: la operadora confirmó (2026-09-09) que NO hay endpoint
    // de estado en lote, así que esto es una llamada por cuenta única, con el
    // semáforo de FSM y el cache de 5 min por delante.
    const unique = dedupe(accounts);
    const limiter = createLimiter(env.FSM_API_MAX_CONCURRENCY);

    const settled = await Promise.allSettled(
      unique.map((accountNumber) =>
        limiter(() => this.getAccountStatus(accountNumber, { brand: opts.brand })),
      ),
    );

    const items: StatusBatchItem[] = [];
    for (let i = 0; i < unique.length; i++) {
      const accountNumber = unique[i] as string;
      const result = settled[i];
      if (result && result.status === 'fulfilled') {
        const value = result.value;
        items.push({
          accountNumber,
          status: value.status,
          statusCode: value.statusCode,
          statusDescription: value.statusDescription,
          error:
            value.status === null ? 'FSM no devolvió estado para esta cuenta.' : null,
        });
        continue;
      }
      // Un fallo de token no es aislable: afecta a todo el lote.
      if (result && isUpstreamAuthError(result.reason)) throw result.reason;
      items.push({
        accountNumber,
        status: null,
        statusCode: null,
        statusDescription: null,
        error:
          result && result.reason instanceof Error
            ? result.reason.message
            : 'FSM no devolvió estado para esta cuenta.',
      });
    }

    const resolved = items.filter((i) => i.status !== null).length;
    const failed = items.length - resolved;
    if (items.length > 0 && resolved === 0) {
      throw ApiError.connectorError(
        `FSM no devolvió el estado de ninguna de las ${items.length} cuentas consultadas.`,
      );
    }

    return { brand: opts.brand, items, requested: items.length, resolved, failed };
  },

  async getNearbyNaps(coords, opts) {
    const raw = await fetchNapsNearest(
      opts.brand,
      coords.latitude,
      coords.longitude,
      opts.meters,
      opts.maxRows,
    );
    if (raw === null) return [];
    return mapNapNearest(raw).map((row) => {
      rememberNap(row.napId, row.napCode, row.totalPorts);
      return {
        napId: row.napId,
        napCode: row.napCode,
        networkName: row.networkName,
        latitude: row.latitude,
        longitude: row.longitude,
        distanceMeters: row.distanceMeters,
        occupiedPorts: row.occupiedPorts,
        totalPorts: row.totalPorts,
        freePorts: Math.max(0, row.totalPorts - row.occupiedPorts),
        source: 'FSM' as const,
      };
    });
  },

  async getNapPorts(napId, opts) {
    // UNA sola llamada. Los estados A/S/T/O/P son el paso 2 y los pide el
    // técnico explícitamente vía POST /accounts/status-batch.
    //
    // La operadora CONFIRMÓ el 2026-09-09 que NO existe un endpoint de estado
    // en lote: hay que preguntar cuenta por cuenta. Por eso el lote es interno,
    // está topado en `FSM_STATUS_BATCH_LIMIT` (12), se cachea 5 minutos y solo
    // se dispara por un tap explícito del técnico — nunca en automático.
    const raw = await fetchNapAccounts(opts.brand, napId);
    if (raw === null) {
      throw ApiError.notFound(`FSM no encontró la NAP ${napId}.`);
    }

    const rows = mapNapAccounts(raw);
    const remembered = napRegistry.get(napId);
    const grid = buildPortGrid(rows, remembered?.totalPorts ?? null);
    const pending = grid.ports.filter((p) => p.statusPending);

    if (opts.withStatus && pending.length > 0) {
      const accounts = pending
        .slice(0, env.FSM_STATUS_BATCH_LIMIT)
        .map((p) => p.clientAccountNumber as string);
      const batch = await this.getAccountsStatusBatch(accounts, { brand: opts.brand });
      applyStatuses(grid.ports, batch);
    }

    // La rejilla sale completa siempre: si no se pasó por `/naps/nearest`, el
    // total lo da la regla 8/16 de la operadora (ver `buildPortGrid`). Ya no
    // hay respuesta degradada por "no sé cuántos puertos tiene esta NAP".
    return {
      napRef: String(napId),
      napId,
      napCode: remembered?.napCode ?? null,
      ports: grid.ports,
      detailAvailable: true,
      occupiedPorts: grid.occupied,
      totalPorts: grid.total,
      statusFanOut: {
        supported: true,
        pendingAccounts: grid.ports.filter((p) => p.statusPending).length,
        batchLimit: env.FSM_STATUS_BATCH_LIMIT,
      },
      source: 'FSM',
    };
  },
};

export function getFsmConnector(): FsmConnector {
  const mode = connectorMode('fsm');
  switch (mode) {
    case 'mock':
      return fsmMock;
    case 'real':
      return fsmReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${mode}`);
  }
}
