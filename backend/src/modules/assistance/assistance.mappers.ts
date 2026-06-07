/**
 * Mappers del módulo Asistencia Técnica.
 * Fase B: conversión de modelos Prisma a DTOs del contrato.
 */

import type { UserRole } from '../../auth/jwt.js';
import type {
  AssistanceSession,
  AssistanceEvent,
  RemoteAction,
  RemoteSession,
} from '@prisma/client';

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

// ---------------------------------------------------------------------------
// Funciones de mapeo Prisma → DTO
// ---------------------------------------------------------------------------

export function mapSession(s: AssistanceSession): AssistanceSessionDto {
  return {
    id: s.id,
    accountNumber: s.accountNumber,
    visitId: s.visitId,
    technicianId: s.technicianId,
    agentId: s.agentId,
    status: s.status as AssistanceStatus,
    reason: s.reason,
    consentAt: s.consentAt ? s.consentAt.toISOString() : null,
    requestedAt: s.requestedAt.toISOString(),
    closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    resolutionNote: s.resolutionNote,
  };
}

export function mapEvent(e: AssistanceEvent): AssistanceEventDto {
  let payload: Record<string, unknown> | null = null;
  if (e.payload !== null && typeof e.payload === 'object' && !Array.isArray(e.payload)) {
    payload = e.payload as Record<string, unknown>;
  }
  return {
    id: e.id,
    sessionId: e.sessionId,
    type: e.type as AssistanceEventType,
    payload,
    actorId: e.actorId,
    createdAt: e.createdAt.toISOString(),
  };
}

export function mapRemoteAction(a: RemoteAction): RemoteActionDto {
  let request: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;
  if (a.request !== null && typeof a.request === 'object' && !Array.isArray(a.request)) {
    request = a.request as Record<string, unknown>;
  }
  if (a.result !== null && typeof a.result === 'object' && !Array.isArray(a.result)) {
    result = a.result as Record<string, unknown>;
  }
  return {
    id: a.id,
    sessionId: a.sessionId,
    accountNumber: a.accountNumber,
    action: a.action as RemoteActionType,
    status: a.status as RemoteActionStatus,
    request,
    result,
    performedBy: a.performedBy,
    createdAt: a.createdAt.toISOString(),
  };
}

export function mapRemoteSession(rs: RemoteSession): RemoteSessionDto {
  return {
    id: rs.id,
    sessionId: rs.sessionId,
    channel: rs.channel as RemoteSessionChannel,
    status: rs.status as RemoteSessionStatus,
    expiresAt: rs.expiresAt.toISOString(),
    recordingId: rs.recordingId,
    startedAt: rs.startedAt.toISOString(),
    endedAt: rs.endedAt ? rs.endedAt.toISOString() : null,
  };
}

export function toPaginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedDto<T> {
  return { items, page, pageSize, total };
}
