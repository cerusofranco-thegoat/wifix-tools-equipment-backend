// Conector hacia el sistema de agendamiento/turnos de visita técnica (ADR-0005).
// Nuevo conector de Fase F.

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

// ---------------------------------------------------------------------------
// Tipos de contrato
// ---------------------------------------------------------------------------

export type TurnoStatus = 'PENDIENTE' | 'CONFIRMADO' | 'COMPLETADO' | 'CANCELADO';

export interface AgendarTurnoParams {
  accountNumber: string;
  ticketId?: string;
  /** Ventana preferida (ej. "MANANA", "TARDE"). */
  preferredWindow?: 'MANANA' | 'TARDE';
  notes?: string;
}

export interface TurnoResult {
  turnoId: string;
  accountNumber: string;
  status: TurnoStatus;
  scheduledDate: string;   // ISO 8601 date-only (YYYY-MM-DD)
  window: 'MANANA' | 'TARDE';
  technicianName: string | null;
  notes: string | null;
  createdAt: string;
}

export interface CancelarTurnoParams {
  turnoId: string;
  reason?: string;
}

export interface CancelarTurnoResult {
  success: boolean;
  turnoId: string;
  cancelledAt: string;
}

// ---------------------------------------------------------------------------
// Interfaz del conector
// ---------------------------------------------------------------------------

export interface SchedulingConnector {
  agendarTurno(params: AgendarTurnoParams): Promise<TurnoResult>;
  obtieneTurno(turnoId: string): Promise<TurnoResult>;
  cancelarTurno(params: CancelarTurnoParams): Promise<CancelarTurnoResult>;
}

// ---------------------------------------------------------------------------
// Mock determinista
// ---------------------------------------------------------------------------

const TECHNICIANS = [
  'Andrés Cevallos',
  'Pamela Yépez',
  'Marco Pinto',
  'Lorena Castillo',
  'Iván Ramírez',
  null, // sin asignar todavía
];

const WINDOWS: Array<'MANANA' | 'TARDE'> = ['MANANA', 'TARDE'];
const STATUSES: TurnoStatus[] = ['PENDIENTE', 'CONFIRMADO', 'COMPLETADO', 'CANCELADO'];

// Fecha base fija para no depender de Date.now() en datos comparados.
const BASE_DATE_STR = '2026-06-10'; // primera fecha posible de agendamiento

function addDays(isoDate: string, days: number): string {
  // Aritmética pura sobre la cadena para mantener determinismo
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const schedulingMock: SchedulingConnector = {
  async agendarTurno(params) {
    const seed = `scheduling:agendar:${params.accountNumber}:${params.ticketId ?? 'none'}`;
    const rng = seededRng(seed);
    const turnoId = `TRN-${rng.intBetween(10000, 99999)}`;
    const daysAhead = rng.intBetween(1, 7);
    const scheduledDate = addDays(BASE_DATE_STR, daysAhead);
    const window = params.preferredWindow ?? rng.pick(WINDOWS);
    // createdAt determinista (no Date.now())
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      turnoId,
      accountNumber: params.accountNumber,
      status: 'PENDIENTE',
      scheduledDate,
      window,
      technicianName: null,
      notes: params.notes ?? null,
      createdAt,
    };
  },

  async obtieneTurno(turnoId) {
    const rng = seededRng(`scheduling:obtiene:${turnoId}`);
    const accountNumber = `WX-${rng.intBetween(10000, 99999)}`;
    const daysAhead = rng.intBetween(0, 14);
    const scheduledDate = addDays(BASE_DATE_STR, daysAhead);
    const window = rng.pick(WINDOWS);
    const status = rng.pick(STATUSES);
    const technicianName = status === 'COMPLETADO' ? rng.pick(TECHNICIANS.filter(Boolean)) as string : null;
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      turnoId,
      accountNumber,
      status,
      scheduledDate,
      window,
      technicianName,
      notes: null,
      createdAt,
    };
  },

  async cancelarTurno(params) {
    const rng = seededRng(`scheduling:cancelar:${params.turnoId}`);
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const cancelledAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      success: true,
      turnoId: params.turnoId,
      cancelledAt,
    };
  },
};

// ---------------------------------------------------------------------------
// Esqueleto real
// ---------------------------------------------------------------------------

export const schedulingReal: SchedulingConnector = {
  async agendarTurno(_params) {
    notImplemented('scheduling.agendarTurno');
  },
  async obtieneTurno(_turnoId) {
    notImplemented('scheduling.obtieneTurno');
  },
  async cancelarTurno(_params) {
    notImplemented('scheduling.cancelarTurno');
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getSchedulingConnector(): SchedulingConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return schedulingMock;
    case 'real':
      return schedulingReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
