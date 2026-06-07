import { apiGet, apiPost } from './client';
import type {
  AssistanceSession,
  AssistanceEvent,
  RemoteAction,
  Paginated,
  SessionDetail,
  StudyOverview,
  VideoRoom,
  OpenRemoteSessionResult,
  RemoteSession,
  RemoteSessionChannel,
  RemoteActionType,
  AssistanceStatus,
  OperatorTicketResult,
  CreateOperatorTicketBody,
} from '../../types/assistance';

const BASE = '/asistencia/v1';

// ── Sesiones ──────────────────────────────────────────────────────────────────

export type GetQueueParams = {
  status?: AssistanceStatus;
  accountNumber?: string;
  page?: number;
  pageSize?: number;
};

export const getQueue = (params?: GetQueueParams) =>
  apiGet<Paginated<AssistanceSession>>(`${BASE}/sessions`, params);

export const getSession = (id: string) => apiGet<SessionDetail>(`${BASE}/sessions/${id}`);

export const assignSession = (id: string) =>
  apiPost<{ session: AssistanceSession }>(`${BASE}/sessions/${id}/assign`);

export type ChangeStatusBody = {
  status: 'ACTIVE' | 'ON_HOLD' | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED';
  note?: string;
};

export const changeStatus = (id: string, body: ChangeStatusBody) =>
  apiPost<{ session: AssistanceSession }>(`${BASE}/sessions/${id}/status`, body);

export const addNote = (id: string, note: string) =>
  apiPost<{ event: AssistanceEvent }>(`${BASE}/sessions/${id}/notes`, { note });

export const getEvents = (id: string, params?: { page?: number; pageSize?: number }) =>
  apiGet<Paginated<AssistanceEvent>>(`${BASE}/sessions/${id}/events`, params);

// ── Estudio (solo lectura, no reimplementar diagnóstico) ──────────────────────

export const getStudy = (id: string) => apiGet<StudyOverview>(`${BASE}/sessions/${id}/study`);

// ── Acciones ACS ──────────────────────────────────────────────────────────────

export type RequestActionBody = {
  action: RemoteActionType;
  params?:
    | { ssid?: string; password?: string; band?: '2.4GHz' | '5GHz' }
    | { band: '2.4GHz' | '5GHz'; channel: number }
    | { target: string; kind: 'ping' | 'traceroute' }
    | Record<string, never>;
};

export const requestAction = (id: string, body: RequestActionBody) =>
  apiPost<{ action: RemoteAction }>(`${BASE}/sessions/${id}/actions`, body);

export const getActions = (id: string, params?: { page?: number; pageSize?: number }) =>
  apiGet<Paginated<RemoteAction>>(`${BASE}/sessions/${id}/actions`, params);

// ── Video ─────────────────────────────────────────────────────────────────────

export const provisionVideo = (id: string) =>
  apiPost<VideoRoom>(`${BASE}/sessions/${id}/video`);

// ── Sesión remota ─────────────────────────────────────────────────────────────

export type OpenRemoteSessionBody = {
  channel: RemoteSessionChannel;
  targetHost?: string;
  ttlSeconds?: number;
};

export const openRemoteSession = (id: string, body: OpenRemoteSessionBody) =>
  apiPost<OpenRemoteSessionResult>(`${BASE}/sessions/${id}/remote-sessions`, body);

export const closeRemoteSession = (rsId: string) =>
  apiPost<{ remoteSession: RemoteSession }>(`${BASE}/remote-sessions/${rsId}/close`);

// ── Ticket operadora ──────────────────────────────────────────────────────────

export const createTicket = (id: string, body: CreateOperatorTicketBody) =>
  apiPost<OperatorTicketResult>(`${BASE}/sessions/${id}/tickets`, body);
