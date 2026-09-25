// ---------------------------------------------------------------------------
// Modelo público del conector FSM y helpers compartidos por sus tres
// implementaciones: `mock` (datos sembrados), `real` (API de la operadora) y
// `fixture` (respuestas reales grabadas, ver `./fixture.ts`).
//
// Acá NO hay red ni env de credenciales: solo tipos y funciones puras (más el
// registro en memoria de NAPs, que las tres implementaciones comparten). Se
// extrajo de `index.ts` para que `fixture.ts` no tenga que importar el módulo
// que lo instancia (evita un ciclo de imports).
// ---------------------------------------------------------------------------

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import type { Degraded } from '../_shared.js';
import type { FsmBrand } from '../http/fsm-token.js';
import type { Coordinates, NapPort, NapPorts, NearbyNap } from '../tec/index.js';
import {
  inferNapTotalPorts,
  NAP_MAX_PORTS,
  type AccountStatusName,
  type FsmStatusCode,
  type TaskResult,
} from './normalize.js';

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

/**
 * Resultado de una visita en la lista unificada (`GET /accounts/{n}/visits`).
 *
 * - `PENDIENTE`: la orden no ha terminado (la próxima visita; FSM admite una sola).
 * - `CANCELADA`: `state` de la orden es "Cancelado".
 * - `SATISFACTORIA` / `INSATISFACTORIA`: verificado abriendo las tareas.
 * - `REALIZADA`: finalizada pero sin verificar (fuera del fan-out o su lectura
 *   falló); el técnico puede pedir las notas bajo demanda.
 */
export type VisitResult =
  | 'PENDIENTE'
  | 'SATISFACTORIA'
  | 'INSATISFACTORIA'
  | 'CANCELADA'
  | 'REALIZADA';

/** Una ORDEN de la cuenta vista como visita (una entrada por orden). */
export interface VisitItem {
  /** Igual a `workOrder`: la lista es por orden, no por tarea. */
  taskId: string;
  workOrder: string;
  occurredAt: string;
  reason: string;
  closingNotes: string;
  technician: string | null;
  result: VisitResult;
  notesLoaded: boolean;
}

export interface VisitsResult {
  /** Pendientes primero (fecha desc), luego el resto por `occurredAt` desc. */
  items: VisitItem[];
  /** Órdenes sin terminar recibidas (lo esperado es 0 o 1). */
  pendingCount: number;
  totalOrders: number;
  /** Órdenes cerradas cuyas tareas se abrieron (fan-out). */
  scanned: number;
  /** Hay órdenes finalizadas que quedaron fuera del fan-out (`REALIZADA`). */
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
  /** Lista unificada de visitas (reemplaza a previous-visits + unsatisfactory-tasks). */
  getVisits(accountNumber: string, opts: UnsatisfactoryOptions): Promise<VisitsResult>;
  getAccountOrders(accountNumber: string, opts: OrdersOptions): Promise<AccountOrders>;
  getAccountStatus(accountNumber: string, opts: BrandOptions): Promise<AccountStatusResult>;
  getAccountsStatusBatch(accounts: string[], opts: BrandOptions): Promise<StatusBatchResult>;
  getNearbyNaps(coords: Coordinates, opts: NearbyNapsOptions): Promise<NearbyNap[]>;
  getNapPorts(napId: number, opts: NapPortsOptions): Promise<NapPorts>;
  getWorkOrderTasks(workOrder: string, opts: BrandOptions): Promise<WorkOrderTasks>;
}

// --- Helpers compartidos ----------------------------------------------------

/** Notas de una tarea concatenadas, listas para mostrar como cierre. */
export function joinNotes(notes: Array<{ content: string }>): string {
  return notes
    .map((n) => n.content.trim())
    .filter((c) => c.length > 0)
    .join(' · ');
}

/** Una orden de `/account/process` vista como visita (campo 16, sin notas). */
export function orderToVisit(order: AccountOrder): ClosedTask {
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
export function taskToClosedTask(workOrder: string, task: WorkOrderTask): ClosedTask {
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
export function visitsDesc(items: ClosedTask[]): ClosedTask[] {
  return [...items].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** Órdenes finalizadas, de la más reciente a la más antigua. */
export function finishedOrdersDesc(orders: AccountOrder[]): AccountOrder[] {
  return orders
    .filter((o) => o.finished)
    .sort((a, b) =>
      String(b.endedAt ?? b.createdAt ?? '').localeCompare(String(a.endedAt ?? a.createdAt ?? '')),
    );
}

export function truncatedDegraded(scanned: number, totalOrders: number): Degraded {
  return {
    reason: 'TRUNCATED',
    message:
      `Se revisaron las ${scanned} órdenes más recientes de ${totalOrders}. ` +
      `Abre una visita concreta para ver sus notas.`,
  };
}

// --- Lista unificada de visitas (GET /accounts/{n}/visits) -------------------

/** `state` de la orden es "Cancelado" (sin distinguir mayúsculas ni tildes). */
export function isCancelledOrder(order: Pick<AccountOrder, 'state'>): boolean {
  if (!order.state) return false;
  const normalized = order.state
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  return /\bcancelad[oa]s?\b/.test(normalized);
}

/** Fecha de una orden cerrada: fin si lo hay, si no creación. */
function closedOrderDate(order: AccountOrder): string {
  return order.endedAt ?? order.createdAt ?? '';
}

function byDateDesc<T>(date: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => date(b).localeCompare(date(a));
}

function orderVisit(
  order: AccountOrder,
  result: VisitResult,
  occurredAt: string,
  extra: Partial<Pick<VisitItem, 'closingNotes' | 'technician' | 'notesLoaded'>> = {},
): VisitItem {
  return {
    taskId: order.workOrder,
    workOrder: order.workOrder,
    occurredAt,
    reason: order.task ?? '',
    closingNotes: extra.closingNotes ?? '',
    technician: extra.technician ?? null,
    result,
    notesLoaded: extra.notesLoaded ?? false,
  };
}

/** La tarea más reciente (por cierre, o por creación si no cerró). */
function latestTask(tasks: WorkOrderTask[]): WorkOrderTask | undefined {
  return [...tasks].sort(byDateDesc((t) => t.finishedAt ?? t.createdAt ?? ''))[0];
}

/**
 * Visita verificada a partir de las tareas de su orden: `INSATISFACTORIA` si
 * alguna tarea lo es (notas = las de esas tareas), si no `SATISFACTORIA`
 * (notas = las de la última tarea cerrada).
 */
export function verifiedVisit(order: AccountOrder, tasks: WorkOrderTask[]): VisitItem {
  const occurredAt = closedOrderDate(order);
  const bad = tasks.filter((t) => t.result === 'INSATISFACTORIA');
  if (bad.length > 0) {
    return orderVisit(order, 'INSATISFACTORIA', occurredAt, {
      closingNotes: bad
        .map((t) => joinNotes(t.notes))
        .filter((n) => n.length > 0)
        .join(' · '),
      technician: latestTask(bad)?.closedBy ?? null,
      notesLoaded: true,
    });
  }
  const closed = tasks.filter((t) => t.finishedAt !== null);
  const last = latestTask(closed.length > 0 ? closed : tasks);
  return orderVisit(order, 'SATISFACTORIA', occurredAt, {
    closingNotes: last ? joinNotes(last.notes) : '',
    technician: last?.closedBy ?? null,
    notesLoaded: true,
  });
}

/** Ejecuta una tarea asíncrona (el modo real le pasa el semáforo de FSM). */
export type TaskScheduler = <T>(task: () => Promise<T>) => Promise<T>;

const runNow: TaskScheduler = (task) => task();

/**
 * Construye la lista unificada de visitas de una cuenta. Compartido por los
 * modos real, mock y fixture: cada uno aporta solo cómo leer las tareas de una
 * orden (`fetchTasks`) y, opcionalmente, el semáforo (`schedule`).
 *
 * Reglas (una entrada por ORDEN):
 *   - Cancelada (`state` ~ "Cancelado") → `CANCELADA`, sin abrir tareas.
 *   - Sin terminar → `PENDIENTE`, arriba de todo. FSM admite UNA sola; si
 *     llegan más se conservan todas y se deja un aviso en el log.
 *   - Las `limit` finalizadas más recientes → se abren sus tareas:
 *     `INSATISFACTORIA` / `SATISFACTORIA`. Si la lectura de UNA orden falla
 *     (salvo error de token, que tumba la consulta) → `REALIZADA`.
 *   - El resto de finalizadas → `REALIZADA` (`notesLoaded: false`).
 */
export async function buildVisits(
  accountNumber: string,
  orders: AccountOrder[],
  opts: UnsatisfactoryOptions,
  fetchTasks: (workOrder: string) => Promise<WorkOrderTasks>,
  schedule: TaskScheduler = runNow,
): Promise<VisitsResult> {
  const cancelled = orders.filter((o) => isCancelledOrder(o));
  const pending = orders
    .filter((o) => !o.finished && !isCancelledOrder(o))
    .sort(byDateDesc((o) => o.createdAt ?? ''));
  const done = orders
    .filter((o) => o.finished && !isCancelledOrder(o))
    .sort(byDateDesc(closedOrderDate));

  if (pending.length > 1) {
    console.warn(
      `[FSM] La cuenta ${accountNumber} tiene ${pending.length} órdenes sin terminar; ` +
        `FSM debería admitir una sola. Se muestran todas.`,
    );
  }

  const slice = done.slice(0, Math.max(0, opts.limit));
  const beyond = done.slice(slice.length);

  // Fan-out acotado: como mucho `limit` lecturas de tareas.
  const settled = await Promise.allSettled(
    slice.map((order) => schedule(() => fetchTasks(order.workOrder))),
  );

  const closedItems: VisitItem[] = [];
  slice.forEach((order, i) => {
    const result = settled[i];
    if (result && result.status === 'fulfilled') {
      closedItems.push(verifiedVisit(order, result.value.tasks));
      return;
    }
    // Un fallo de token afecta a toda la consulta; cualquier otro fallo deja
    // esa orden sin verificar, igual que las que quedan fuera del fan-out.
    if (result && isUpstreamAuthError(result.reason)) throw result.reason;
    closedItems.push(orderVisit(order, 'REALIZADA', closedOrderDate(order)));
  });
  for (const order of beyond) {
    closedItems.push(orderVisit(order, 'REALIZADA', closedOrderDate(order)));
  }
  for (const order of cancelled) {
    closedItems.push(orderVisit(order, 'CANCELADA', closedOrderDate(order)));
  }
  closedItems.sort(byDateDesc((v) => v.occurredAt));

  const pendingItems = pending.map((o) => orderVisit(o, 'PENDIENTE', o.createdAt ?? ''));

  const scanned = slice.length;
  const truncated = done.length > scanned;
  return {
    items: [...pendingItems, ...closedItems],
    pendingCount: pending.length,
    totalOrders: orders.length,
    scanned,
    truncated,
    brand: opts.brand,
    ...(truncated ? { degraded: truncatedDegraded(scanned, orders.length) } : {}),
  };
}

/** Elimina duplicados conservando el orden de entrada. */
export function dedupe(values: string[]): string[] {
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

export function isUpstreamAuthError(err: unknown): err is ApiError {
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
export function buildPortGrid(
  rows: Array<{
    portNumber: number | null;
    accountNumber: string | null;
    equipmentId: string | null;
  }>,
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

/** Vuelca los estados de un lote sobre la rejilla de puertos. */
export function applyStatuses(ports: NapPort[], batch: StatusBatchResult): void {
  const byAccount = new Map(batch.items.map((i) => [i.accountNumber, i]));
  for (const port of ports) {
    if (!port.clientAccountNumber) continue;
    const hit = byAccount.get(port.clientAccountNumber);
    if (!hit || hit.status === null) continue;
    port.clientStatus = hit.statusCode;
    port.statusPending = false;
  }
}

/** Resumen del fan-out de estados que acompaña a la rejilla de puertos. */
export function statusFanOut(ports: NapPort[]): {
  supported: boolean;
  pendingAccounts: number;
  batchLimit: number;
} {
  return {
    supported: true,
    pendingAccounts: ports.filter((p) => p.statusPending).length,
    batchLimit: env.FSM_STATUS_BATCH_LIMIT,
  };
}

/**
 * Cuántos puertos tiene cada NAP y con qué código, memorizado de la última
 * `/naps/nearest`. `/naps/accounts` solo devuelve los puertos OCUPADOS, así que
 * sin este dato no se puede dibujar la rejilla completa.
 */
const napRegistry = new Map<number, { napCode: string; totalPorts: number }>();
const NAP_REGISTRY_MAX = 500;

export function rememberNap(napId: number | null, napCode: string, totalPorts: number): void {
  if (napId === null || !Number.isFinite(napId) || totalPorts <= 0) return;
  if (napRegistry.size >= NAP_REGISTRY_MAX) {
    const oldest = napRegistry.keys().next();
    if (!oldest.done) napRegistry.delete(oldest.value);
  }
  napRegistry.set(napId, { napCode, totalPorts });
}

/** Lo memorizado de una NAP, si se pasó antes por `/naps/nearest`. */
export function recallNap(napId: number): { napCode: string; totalPorts: number } | undefined {
  return napRegistry.get(napId);
}

/** Solo para pruebas: olvida las NAPs memorizadas. */
export function resetNapRegistry(): void {
  napRegistry.clear();
}
