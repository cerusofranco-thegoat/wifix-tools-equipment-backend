// Conector hacia el sistema de ticketing de la operadora (plegado de Proxy Xtrim — ADR-0005).
// Operaciones: generaTicket, obtieneTicket, backOfficeOps, retiroAnticipado.

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

// ---------------------------------------------------------------------------
// Tipos de contrato
// ---------------------------------------------------------------------------

export type TicketStatus =
  | 'ABIERTO'
  | 'EN_PROCESO'
  | 'RESUELTO'
  | 'CERRADO'
  | 'CANCELADO';

export type TicketPriority = 'BAJA' | 'MEDIA' | 'ALTA' | 'CRITICA';

export interface GenerarTicketParams {
  accountNumber: string;
  description: string;
  /** Categoría / área de soporte (ej. "CONECTIVIDAD", "EQUIPAMIENTO"). */
  category?: string;
  priority?: TicketPriority;
}

export interface TicketResult {
  ticketId: string;
  accountNumber: string;
  status: TicketStatus;
  priority: TicketPriority;
  description: string;
  category: string;
  createdAt: string;
  estimatedResolutionAt: string | null;
}

export interface BackOfficeAction {
  actionId: string;
  type: string;
  executedAt: string;
  result: string;
}

export interface RetiroAnticipadoParams {
  accountNumber: string;
  ticketId: string;
  reason: string;
}

export interface RetiroAnticipadoResult {
  success: boolean;
  withdrawalId: string;
  scheduledAt: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Interfaz del conector
// ---------------------------------------------------------------------------

export interface TicketingConnector {
  generaTicket(params: GenerarTicketParams): Promise<TicketResult>;
  obtieneTicket(ticketId: string): Promise<TicketResult>;
  backOfficeOps(
    ticketId: string,
    action: string,
    params?: Record<string, unknown>,
  ): Promise<BackOfficeAction>;
  retiroAnticipado(params: RetiroAnticipadoParams): Promise<RetiroAnticipadoResult>;
}

// ---------------------------------------------------------------------------
// Mock determinista (seededRng — sin Date.now() en datos comparados)
// ---------------------------------------------------------------------------

const CATEGORIES = ['CONECTIVIDAD', 'EQUIPAMIENTO', 'FACTURACION', 'VELOCIDAD', 'INSTALACION'];
const PRIORITIES: TicketPriority[] = ['BAJA', 'MEDIA', 'ALTA', 'CRITICA'];
const STATUSES: TicketStatus[] = ['ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CERRADO', 'CANCELADO'];
const BO_RESULTS = [
  'Acción ejecutada correctamente.',
  'Reinicio de plataforma iniciado.',
  'Parámetros actualizados en sistema BackOffice.',
  'Escalado a nivel 2 completado.',
];

export const ticketingMock: TicketingConnector = {
  async generaTicket(params) {
    const rng = seededRng(`ticketing:genera:${params.accountNumber}:${params.description.length}`);
    const ticketId = `TKT-${rng.intBetween(100000, 999999)}`;
    const priority = params.priority ?? rng.pick(PRIORITIES);
    const category = params.category ?? rng.pick(CATEGORIES);
    // Fecha determinista: offset en horas desde epoch dividido en bloques de 24h
    const hoursOffset = rng.intBetween(24, 120);
    const estimatedMs = hoursOffset * 3_600_000;
    // Usamos una fecha base fija (2026-01-01T00:00:00Z) para no depender de Date.now()
    const BASE_EPOCH_MS = 1_735_689_600_000; // 2026-01-01T00:00:00Z
    const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    const estimatedResolutionAt = new Date(
      BASE_EPOCH_MS + rng.intBetween(0, 86_400_000) + estimatedMs,
    ).toISOString();
    return {
      ticketId,
      accountNumber: params.accountNumber,
      status: 'ABIERTO',
      priority,
      description: params.description,
      category,
      createdAt,
      estimatedResolutionAt,
    };
  },

  async obtieneTicket(ticketId) {
    const rng = seededRng(`ticketing:obtiene:${ticketId}`);
    const accountNumber = `WX-${rng.intBetween(10000, 99999)}`;
    const status = rng.pick(STATUSES);
    const priority = rng.pick(PRIORITIES);
    const category = rng.pick(CATEGORIES);
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const createdAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 2_592_000_000)).toISOString();
    return {
      ticketId,
      accountNumber,
      status,
      priority,
      description: 'Incidencia registrada desde Wifix Asistencia.',
      category,
      createdAt,
      estimatedResolutionAt: status === 'RESUELTO' || status === 'CERRADO'
        ? new Date(BASE_EPOCH_MS + rng.intBetween(2_592_000_000, 5_184_000_000)).toISOString()
        : null,
    };
  },

  async backOfficeOps(ticketId, action, _params) {
    const rng = seededRng(`ticketing:bo:${ticketId}:${action}`);
    const actionId = `BO-${rng.intBetween(10000, 99999)}`;
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const executedAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    return {
      actionId,
      type: action,
      executedAt,
      result: rng.pick(BO_RESULTS),
    };
  },

  async retiroAnticipado(params) {
    const rng = seededRng(`ticketing:retiro:${params.accountNumber}:${params.ticketId}`);
    const withdrawalId = `WD-${rng.intBetween(10000, 99999)}`;
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const scheduledAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 172_800_000)).toISOString();
    return {
      success: true,
      withdrawalId,
      scheduledAt,
      message: 'Retiro anticipado programado correctamente.',
    };
  },
};

// ---------------------------------------------------------------------------
// Esqueleto real (notImplemented hasta recibir credenciales)
// ---------------------------------------------------------------------------

export const ticketingReal: TicketingConnector = {
  async generaTicket(_params) {
    notImplemented('ticketing.generaTicket');
  },
  async obtieneTicket(_ticketId) {
    notImplemented('ticketing.obtieneTicket');
  },
  async backOfficeOps(_ticketId, _action, _params) {
    notImplemented('ticketing.backOfficeOps');
  },
  async retiroAnticipado(_params) {
    notImplemented('ticketing.retiroAnticipado');
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getTicketingConnector(): TicketingConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return ticketingMock;
    case 'real':
      return ticketingReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
