// ---------------------------------------------------------------------------
// Conector hacia FSM (`fsm-data-ms`) — campos 1-3, 6, 7, 8, 15 y 16.
//
// Capas:  routes → este módulo (modelo interno, mock|real|fixture)
//                → http/fsm-api.ts (HTTP + caudal)
//                → http/fsm-token.ts (Bearer por marca)
// Ninguna ruta importa `http/fsm-api.ts` directamente.
//
// El modelo público y los helpers puros viven en `./shared.ts`; el modo
// `fixture` (respuestas reales grabadas, sin red) en `./fixture.ts`.
//
// El mock NO se borra: es lo que permite al frontend trabajar sin token, y
// devuelve exactamente los mismos shapes que el modo real.
// ---------------------------------------------------------------------------

import { connectorMode, env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng } from '../_shared.js';
import {
  fetchAccountProcess,
  fetchAccountStatus,
  fetchNapAccounts,
  fetchNapsNearest,
  fetchWorkOrderTasks,
} from '../http/fsm-api.js';
import { createLimiter } from '../http/throttle.js';
import type { Coordinates, NearbyNap } from '../tec/index.js';
import { createFsmFixtureConnector } from './fixture.js';
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
import {
  applyStatuses,
  buildPortGrid,
  buildVisits,
  CURRENT_NAP_SEARCH,
  dedupe,
  finishedOrdersDesc,
  isUpstreamAuthError,
  orderToVisit,
  recallNap,
  rememberNap,
  statusFanOut,
  taskToClosedTask,
  truncatedDegraded,
  visitsDesc,
  type AccountOrder,
  type AccountOrdersClient,
  type ClosedTask,
  type FsmConnector,
  type StatusBatchItem,
  type WorkOrderTask,
  type WorkOrderTaskNote,
} from './shared.js';

export type { TaskResult, FsmStatusCode, AccountStatusName };

// El modelo público del conector se declara en `./shared.ts` y se re-exporta
// desde acá: `connectors/index.ts` y las rutas siguen importando de este módulo.
export type {
  AccountOrder,
  AccountOrders,
  AccountOrdersClient,
  AccountStatusResult,
  BrandOptions,
  ClosedTask,
  FsmConnector,
  NapPortsOptions,
  NearbyNapsOptions,
  OrdersOptions,
  PreviousVisitsResult,
  StatusBatchItem,
  StatusBatchResult,
  UnsatisfactoryOptions,
  UnsatisfactoryTasksResult,
  VisitItem,
  VisitResult,
  VisitsResult,
  WorkOrderTask,
  WorkOrderTaskNote,
  WorkOrderTasks,
} from './shared.js';
export { CURRENT_NAP_SEARCH, resetNapRegistry } from './shared.js';

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

/**
 * Órdenes simuladas de una cuenta, estables entre llamadas.
 *
 * Respeta la regla de FSM: una cuenta tiene como mucho UNA orden sin terminar,
 * y si la tiene es la más reciente (la próxima visita). Algunas cuentas salen
 * sin pendiente y otras con una. El resto está finalizado ("Realizado") o
 * cancelado ("Cancelado"), con los mismos `state` que devuelve la operadora.
 */
function mockOrders(accountNumber: string): AccountOrder[] {
  const rng = seededRng(`fsm:orders:${accountNumber}`);
  const n = rng.intBetween(1, 12);
  const orders: AccountOrder[] = [];
  for (let i = 0; i < n; i++) {
    const created = new Date();
    created.setDate(created.getDate() - rng.intBetween(1, 300));
    created.setHours(rng.intBetween(8, 17), rng.intBetween(0, 59), 0, 0);
    const cancelled = rng.bool(0.15);
    const ended = new Date(created.getTime() + rng.intBetween(40, 240) * 60_000);
    orders.push({
      workOrder: `ORDER/${rng.intBetween(100000, 999999)}/${created.getFullYear()}`,
      task: rng.pick(REASONS),
      state: cancelled ? 'Cancelado' : 'Realizado',
      externalProcess: `PROC-${rng.intBetween(1000, 9999)}`,
      cpartyId: `CP-${rng.intBetween(10000, 99999)}`,
      createdAt: created.toISOString(),
      endedAt: ended.toISOString(),
      finished: true,
      note: rng.pick(NOTES_OK),
      latitude: -2.247946 + rng.floatBetween(-0.01, 0.01, 6),
      longitude: -79.904161 + rng.floatBetween(-0.01, 0.01, 6),
      address: `Av. Amazonas N${rng.intBetween(100, 9999)}, Guayaquil`,
    });
  }
  orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  // Solo la más reciente puede quedar pendiente (semilla aparte para no mover
  // el resto de los datos sembrados).
  const newest = orders[0];
  if (newest && seededRng(`fsm:orders:pending:${accountNumber}`).bool(0.4)) {
    newest.state = 'Pendiente';
    newest.endedAt = null;
    newest.finished = false;
  }
  return orders;
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

/**
 * NAPs simuladas alrededor de una coordenada. Pura (no memoriza nada): la usan
 * `getNearbyNaps` del mock y el sembrado de `MOCK_CONNECTED_ACCOUNTS`.
 */
function mockNearbyNaps(
  coords: Coordinates,
  opts: { meters: number; maxRows: number },
): NearbyNap[] {
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
    naps.push({
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
    });
  }
  return naps.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/**
 * Cuentas del mock que SÍ aparecen conectadas a una NAP cercana a su domicilio,
 * para que el frontend pueda probar `GET /accounts/{n}/current-nap` con
 * resultado encontrado. Cualquier otra cuenta sale `NOT_FOUND` (los puertos
 * del mock tienen cuentas aleatorias).
 *
 * - `35070291` → en la SEGUNDA NAP más cercana (`searchedNaps: 2`).
 * - `40123456` → en la NAP más cercana (`searchedNaps: 1`).
 *
 * Solo aplica si la búsqueda parte del domicilio mock de la cuenta (sin
 * `lat`/`lng` de override) y con `CURRENT_NAP_SEARCH`.
 */
export const MOCK_CONNECTED_ACCOUNTS: ReadonlyArray<{ accountNumber: string; napIndex: number }> = [
  { accountNumber: '35070291', napIndex: 1 },
  { accountNumber: '40123456', napIndex: 0 },
];

interface PlantedPort {
  portNumber: number;
  accountNumber: string;
  equipmentId: string;
}

let plantedPorts: Map<number, PlantedPort[]> | null = null;

/**
 * napId → puertos sembrados. Determinista y sin depender del orden de las
 * llamadas: cuenta → domicilio mock → NAPs mock de ese domicilio → NAP elegida.
 */
function mockPlantedPorts(): Map<number, PlantedPort[]> {
  if (plantedPorts) return plantedPorts;
  const map = new Map<number, PlantedPort[]>();
  for (const { accountNumber, napIndex } of MOCK_CONNECTED_ACCOUNTS) {
    const client = mockClient(accountNumber);
    if (client.latitude === null || client.longitude === null) continue;
    const naps = mockNearbyNaps(
      { latitude: client.latitude, longitude: client.longitude },
      CURRENT_NAP_SEARCH,
    );
    const target = naps[Math.min(napIndex, naps.length - 1)];
    if (!target || target.napId === null) continue;
    const rng = seededRng(`fsm:planted:${accountNumber}`);
    const list = map.get(target.napId) ?? [];
    list.push({
      // Puertos 1-8: válidos tanto en NAPs de 8 como de 16.
      portNumber: rng.intBetween(1, 8),
      accountNumber,
      equipmentId: `ZTEGD${rng.intBetween(100000, 999999)}`,
    });
    map.set(target.napId, list);
  }
  plantedPorts = map;
  return map;
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

  async getVisits(accountNumber, opts) {
    return buildVisits(accountNumber, mockOrders(accountNumber), opts, async (workOrder) => ({
      workOrder,
      brand: opts.brand,
      tasks: mockTasks(workOrder),
    }));
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
    const naps = mockNearbyNaps(coords, opts);
    for (const nap of naps) rememberNap(nap.napId, nap.napCode, nap.totalPorts);
    return naps;
  },

  async getNapPorts(napId, opts) {
    const rng = seededRng(`fsm:napports:${napId}`);
    const remembered = recallNap(napId);
    const total = remembered?.totalPorts ?? NAP_MAX_PORTS;
    let rows: Array<{ portNumber: number; accountNumber: string; equipmentId: string }> = [];
    for (let i = 1; i <= total; i++) {
      if (!rng.bool(0.7)) continue;
      rows.push({
        portNumber: i,
        accountNumber: String(rng.intBetween(30000000, 79999999)),
        equipmentId: `ZTEGD${rng.intBetween(100000, 999999)}`,
      });
    }
    // Cuentas sembradas (`MOCK_CONNECTED_ACCOUNTS`): reemplazan lo que hubiera
    // en su puerto, así `current-nap` las encuentra de forma determinista.
    const planted = mockPlantedPorts().get(napId) ?? [];
    if (planted.length > 0) {
      const taken = new Set(planted.map((p) => p.portNumber));
      rows = [...rows.filter((r) => !taken.has(r.portNumber)), ...planted].sort(
        (a, b) => a.portNumber - b.portNumber,
      );
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
      statusFanOut: statusFanOut(grid.ports),
      source: 'FSM',
    };
  },
};

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

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

  async getVisits(accountNumber, opts) {
    // 1 llamada a /account/process + como mucho `limit` a /workorder/tasks,
    // con el mismo semáforo que el resto de FSM.
    const { orders } = await this.getAccountOrders(accountNumber, {
      brand: opts.brand,
      estado: 'Todas',
    });
    const limiter = createLimiter(env.FSM_API_MAX_CONCURRENCY);
    return buildVisits(
      accountNumber,
      orders,
      opts,
      (workOrder) => this.getWorkOrderTasks(workOrder, { brand: opts.brand }),
      limiter,
    );
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
    // UNA sola llamada. Los estados A/S/T/O/P son el paso 2 y van aparte por
    // POST /accounts/status-batch.
    //
    // La operadora CONFIRMÓ el 2026-09-09 que NO existe un endpoint de estado
    // en lote: hay que preguntar cuenta por cuenta. Por eso el lote es interno,
    // está topado en `FSM_STATUS_BATCH_LIMIT` (12) y se cachea 5 minutos por
    // cuenta. Desde el 2026-10-06 (decisión de Franco, CEO) la app lo dispara
    // AUTOMÁTICAMENTE, pero solo para las 2 NAPs más cercanas y en lotes ≤ 12;
    // el cache hace que reabrir/refrescar no vuelva a golpear producción.
    // `withStatus` sigue siendo solo para soporte/probe (la app no lo envía).
    const raw = await fetchNapAccounts(opts.brand, napId);
    if (raw === null) {
      throw ApiError.notFound(`FSM no encontró la NAP ${napId}.`);
    }

    const rows = mapNapAccounts(raw);
    const remembered = recallNap(napId);
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
      statusFanOut: statusFanOut(grid.ports),
      source: 'FSM',
    };
  },
};

// ---------------------------------------------------------------------------
// Fixture — respuestas reales grabadas (cuenta 35070291), cero red.
// Se construye una sola vez y usa el MOCK como respaldo para cualquier otra
// cuenta / NAP / orden que no esté en los fixtures. Ver `./fixture.ts`.
// ---------------------------------------------------------------------------

let fsmFixture: FsmConnector | null = null;

function getFsmFixture(): FsmConnector {
  fsmFixture ??= createFsmFixtureConnector(fsmMock);
  return fsmFixture;
}

export function getFsmConnector(): FsmConnector {
  const mode = connectorMode('fsm');
  switch (mode) {
    case 'mock':
      return fsmMock;
    case 'real':
      return fsmReal;
    case 'fixture':
      return getFsmFixture();
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${String(mode)}`);
  }
}
