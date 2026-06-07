// Conector hacia FSM — campos 15 (tareas insatisfactorias) y 16 (visitas).
// Fase F: extensión con creaFsmVistec, fsmOrdenes, cancelarOrden (ADR-0005).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export type TaskResult = 'SATISFACTORIA' | 'INSATISFACTORIA' | 'PENDIENTE';

export interface ClosedTask {
  taskId: string;
  occurredAt: string;
  reason: string;
  closingNotes: string;
  technician: string;
  result: TaskResult;
}

// ---------------------------------------------------------------------------
// Nuevos tipos para órdenes FSM Vistec (Fase F)
// ---------------------------------------------------------------------------

export type FsmOrdenStatus = 'CREADA' | 'ASIGNADA' | 'EN_RUTA' | 'COMPLETADA' | 'CANCELADA';
export type FsmOrdenType = 'VISTEC' | 'AVERIAS' | 'INSTALACION' | 'RETIRO';

export interface FsmVistecParams {
  accountNumber: string;
  description: string;
  ticketId?: string;
  type?: FsmOrdenType;
  scheduledDate?: string; // ISO 8601 date
}

export interface FsmOrden {
  ordenId: string;
  accountNumber: string;
  type: FsmOrdenType;
  status: FsmOrdenStatus;
  description: string;
  ticketId: string | null;
  technicianName: string | null;
  scheduledDate: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface CancelarOrdenParams {
  ordenId: string;
  reason?: string;
}

export interface CancelarOrdenResult {
  success: boolean;
  ordenId: string;
  cancelledAt: string;
}

// ---------------------------------------------------------------------------
// Interfaz completa del conector
// ---------------------------------------------------------------------------

export interface FsmConnector {
  getUnsatisfactoryTasks(accountNumber: string): Promise<ClosedTask[]>;
  getPreviousVisits(accountNumber: string): Promise<ClosedTask[]>;
  // Fase F — órdenes Vistec
  creaFsmVistec(params: FsmVistecParams): Promise<FsmOrden>;
  fsmOrdenes(accountNumber: string): Promise<FsmOrden[]>;
  cancelarOrden(params: CancelarOrdenParams): Promise<CancelarOrdenResult>;
}

// ---------------------------------------------------------------------------
// Datos base mock
// ---------------------------------------------------------------------------

const REASONS = [
  'Sin servicio',
  'Lentitud de navegación',
  'No carga el plan contratado',
  'WiFi débil en habitaciones',
  'Cambio de equipo solicitado',
  'Reconfiguración de red',
  'Instalación inicial',
  'Mantenimiento preventivo',
];

const CLOSING_NOTES = [
  'Cliente reporta intermitencia, se reinició ONT.',
  'Se cambió cable de patch y mejoró señal.',
  'Configuración de SSID y contraseña aplicada.',
  'Equipo retirado por daño físico.',
  'Cliente no se encontraba en sitio, se reprogramó.',
  'Sin novedades, servicio operando con normalidad.',
  'Se elevó a soporte nivel 2 — pendiente seguimiento.',
];

const TECHNICIANS = [
  'Andrés Cevallos',
  'Pamela Yépez',
  'Marco Pinto',
  'Lorena Castillo',
  'Iván Ramírez',
];

const ORDER_TYPES: FsmOrdenType[] = ['VISTEC', 'AVERIAS', 'INSTALACION', 'RETIRO'];
const ORDER_STATUSES: FsmOrdenStatus[] = ['CREADA', 'ASIGNADA', 'EN_RUTA', 'COMPLETADA', 'CANCELADA'];

// Fecha base fija
const BASE_EPOCH_MS = 1_735_689_600_000; // 2026-01-01T00:00:00Z

function buildTask(seedKey: string, alwaysUnsatisfactory: boolean): ClosedTask {
  const rng = seededRng(seedKey);
  const monthsAgo = rng.intBetween(0, 8);
  const daysOffset = rng.intBetween(0, 27);
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(d.getDate() - daysOffset);
  d.setHours(rng.intBetween(8, 18), rng.intBetween(0, 59), 0, 0);
  const result: TaskResult = alwaysUnsatisfactory
    ? 'INSATISFACTORIA'
    : rng.pick(['SATISFACTORIA', 'SATISFACTORIA', 'PENDIENTE'] as const);
  return {
    taskId: `TASK/${rng.intBetween(100000, 999999)}/${d.getFullYear()}`,
    occurredAt: d.toISOString(),
    reason: rng.pick(REASONS),
    closingNotes: rng.pick(CLOSING_NOTES),
    technician: rng.pick(TECHNICIANS),
    result,
  };
}

function buildOrden(seedKey: string, overrides: Partial<FsmOrden> = {}): FsmOrden {
  const rng = seededRng(seedKey);
  const ordenId = `FSM-${rng.intBetween(100000, 999999)}`;
  const type = rng.pick(ORDER_TYPES);
  const status = rng.pick(ORDER_STATUSES);
  const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 5_184_000_000)).toISOString();
  const isActive = status !== 'COMPLETADA' && status !== 'CANCELADA';
  const technicianName = status === 'ASIGNADA' || status === 'EN_RUTA' || status === 'COMPLETADA'
    ? rng.pick(TECHNICIANS)
    : null;
  return {
    ordenId,
    accountNumber: overrides.accountNumber ?? `WX-${rng.intBetween(10000, 99999)}`,
    type,
    status,
    description: 'Orden de visita técnica registrada.',
    ticketId: rng.bool(0.6) ? `TKT-${rng.intBetween(100000, 999999)}` : null,
    technicianName,
    scheduledDate: rng.bool(0.7) ? new Date(BASE_EPOCH_MS + rng.intBetween(0, 2_592_000_000)).toISOString().slice(0, 10) : null,
    createdAt,
    closedAt: isActive ? null : new Date(BASE_EPOCH_MS + rng.intBetween(2_592_000_000, 5_184_000_000)).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock determinista
// ---------------------------------------------------------------------------

export const fsmMock: FsmConnector = {
  async getUnsatisfactoryTasks(accountNumber) {
    const rng = seededRng(`fsm:unsat:${accountNumber}`);
    const n = rng.intBetween(0, 3);
    const tasks: ClosedTask[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(buildTask(`fsm:unsat:${accountNumber}:${i}`, true));
    }
    return tasks.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },

  async getPreviousVisits(accountNumber) {
    const rng = seededRng(`fsm:visits:${accountNumber}`);
    const n = rng.intBetween(1, 5);
    const tasks: ClosedTask[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(buildTask(`fsm:visits:${accountNumber}:${i}`, false));
    }
    return tasks.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },

  async creaFsmVistec(params) {
    const seed = `fsm:vistec:${params.accountNumber}:${params.description.length}`;
    const rng = seededRng(seed);
    const ordenId = `FSM-${rng.intBetween(100000, 999999)}`;
    const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      ordenId,
      accountNumber: params.accountNumber,
      type: params.type ?? 'VISTEC',
      status: 'CREADA',
      description: params.description,
      ticketId: params.ticketId ?? null,
      technicianName: null,
      scheduledDate: params.scheduledDate ?? null,
      createdAt,
      closedAt: null,
    };
  },

  async fsmOrdenes(accountNumber) {
    const rng = seededRng(`fsm:ordenes:${accountNumber}`);
    const n = rng.intBetween(0, 4);
    const ordenes: FsmOrden[] = [];
    for (let i = 0; i < n; i++) {
      ordenes.push(buildOrden(`fsm:ordenes:${accountNumber}:${i}`, { accountNumber }));
    }
    return ordenes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },

  async cancelarOrden(params) {
    const rng = seededRng(`fsm:cancelar:${params.ordenId}`);
    const cancelledAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      success: true,
      ordenId: params.ordenId,
      cancelledAt,
    };
  },
};

// ---------------------------------------------------------------------------
// Esqueleto real
// ---------------------------------------------------------------------------

export const fsmReal: FsmConnector = {
  async getUnsatisfactoryTasks(_accountNumber) {
    notImplemented('fsm.getUnsatisfactoryTasks');
  },
  async getPreviousVisits(_accountNumber) {
    notImplemented('fsm.getPreviousVisits');
  },
  async creaFsmVistec(_params) {
    notImplemented('fsm.creaFsmVistec');
  },
  async fsmOrdenes(_accountNumber) {
    notImplemented('fsm.fsmOrdenes');
  },
  async cancelarOrden(_params) {
    notImplemented('fsm.cancelarOrden');
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getFsmConnector(): FsmConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return fsmMock;
    case 'real':
      return fsmReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
