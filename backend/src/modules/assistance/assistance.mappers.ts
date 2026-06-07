/**
 * Mappers del módulo Asistencia Técnica.
 * Fase 0: DTOs e interfaces de contrato.
 * La lógica de mapeo real se implementa en la Fase B.
 */

import type { UserRole } from '../../auth/jwt.js';

// ---------------------------------------------------------------------------
// DTOs de contrato (alineados con docs/api/asistencia-tecnica.md)
// ---------------------------------------------------------------------------

export type AssistanceStatus =
  | 'REQUESTED'
  | 'QUEUED'
  | 'ASSIGNED'
  | 'ACTIVE'
  | 'ON_HOLD'
  | 'RESOLVED'
  | 'UNRESOLVED'
  | 'CANCELLED'
  | 'EXPIRED';

export type AssistanceEventType =
  | 'STATE_CHANGE'
  | 'NOTE'
  | 'ACTION'
  | 'REMOTE_SESSION'
  | 'CHAT'
  | 'CONSENT';

export type RemoteActionType =
  | 'REBOOT'
  | 'SET_WIFI'
  | 'SET_CHANNEL'
  | 'FACTORY_RESET'
  | 'REPROVISION'
  | 'RUN_DIAGNOSTIC';

export type RemoteActionStatus = 'PENDING' | 'SUCCESS' | 'FAILED';
export type RemoteSessionChannel = 'BROKER_TUNNEL' | 'COBROWSE';
export type RemoteSessionStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';

export interface AssistanceSessionDto {
  id: string;
  accountNumber: string;
  visitId: string | null;
  technicianId: string | null;
  agentId: string | null;
  status: AssistanceStatus;
  reason: string | null;
  consentAt: string | null;
  requestedAt: string;
  closedAt: string | null;
  resolutionNote: string | null;
}

export interface AssistanceEventDto {
  id: string;
  sessionId: string;
  type: AssistanceEventType;
  payload: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: string;
}

export interface RemoteActionDto {
  id: string;
  sessionId: string;
  accountNumber: string;
  action: RemoteActionType;
  status: RemoteActionStatus;
  request: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  performedBy: string | null;
  createdAt: string;
}

export interface RemoteSessionDto {
  id: string;
  sessionId: string;
  channel: RemoteSessionChannel;
  status: RemoteSessionStatus;
  expiresAt: string;
  recordingId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PaginatedDto<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Respuesta de GET /sessions/{id}
 */
export interface SessionDetailDto {
  session: AssistanceSessionDto;
  activeRemoteSession: RemoteSessionDto | null;
  videoRoom: { roomName: string; domain: string } | null;
  recentActions: RemoteActionDto[];
}

/**
 * Respuesta de GET /sessions/{id}/study
 */
export interface StudyOverviewDto {
  accountNumber: string;
  latestHeatmapId: string | null;
  latestSpeedtest: { downloadMbps: number; uploadMbps: number; measuredAt: string } | null;
  pings: Array<{
    target: string;
    avgLatencyMs: number | null;
    packetLossPercent: number | null;
  }>;
  lanDeviceCount: number | null;
  wifiDeviceCount: number | null;
  plant: { onuRxPower?: number; snr?: number; source: string } | null;
}

// Re-export para uso en otros módulos
export type { UserRole };
