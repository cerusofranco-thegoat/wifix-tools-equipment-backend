// FUENTE: docs/api/asistencia-tecnica.md §1
// NO modificar sin actualizar primero el contrato de API.

export type Role = 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR';

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

export type AssistanceEventType =
  | 'STATE_CHANGE'
  | 'NOTE'
  | 'ACTION'
  | 'REMOTE_SESSION'
  | 'CHAT'
  | 'CONSENT';

export interface AssistanceSession {
  id: string;
  accountNumber: string;
  visitId: string | null;
  technicianId: string | null;
  agentId: string | null;
  status: AssistanceStatus;
  reason: string | null;
  consentAt: string | null; // ISO 8601
  requestedAt: string; // ISO 8601
  closedAt: string | null;
  resolutionNote: string | null;
}

export interface AssistanceEvent {
  id: string;
  sessionId: string;
  type: AssistanceEventType;
  payload: Record<string, unknown> | null;
  actorId: string | null;
  createdAt: string;
}

export interface RemoteAction {
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

export interface RemoteSession {
  id: string;
  sessionId: string;
  channel: RemoteSessionChannel;
  status: RemoteSessionStatus;
  expiresAt: string;
  recordingId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface StudyOverview {
  accountNumber: string;
  latestHeatmapId: string | null;
  latestSpeedtest: {
    downloadMbps: number;
    uploadMbps: number;
    measuredAt: string;
  } | null;
  pings: Array<{
    target: string;
    avgLatencyMs: number | null;
    packetLossPercent: number | null;
  }>;
  lanDeviceCount: number | null;
  wifiDeviceCount: number | null;
  plant: { onuRxPower?: number; snr?: number; source: string } | null;
}

export interface VideoRoom {
  roomName: string;
  domain: string;
  jwt: string;
}

export interface SessionDetail {
  session: AssistanceSession;
  activeRemoteSession: RemoteSession | null;
  videoRoom: { roomName: string; domain: string } | null;
  recentActions: RemoteAction[];
}

export interface BrokerConnect {
  wsUrl: string;
  sessionToken: string;
  expiresAt: string;
}

export interface OpenRemoteSessionResult {
  remoteSession: RemoteSession;
  connect: BrokerConnect;
}

export interface CreateOperatorTicketBody {
  kind: 'TICKET' | 'FSM_ORDER';
  description: string;
  scheduleTurno?: boolean;
}

export interface OperatorTicketResult {
  externalId: string;
  kind: 'TICKET' | 'FSM_ORDER';
  status: string;
}

// Mensajes WS — Contrato §7
export type ClientMessage =
  | { type: 'REGISTER_TECHNICIAN'; sessionId: string }
  | { type: 'SUBSCRIBE_QUEUE' }
  | { type: 'JOIN_SESSION'; sessionId: string }
  | { type: 'CHAT_MESSAGE'; sessionId: string; text: string }
  | { type: 'HEARTBEAT' };

export type ServerEvent =
  | { type: 'QUEUE_UPDATED'; session: AssistanceSession }
  | { type: 'SESSION_STATE_CHANGED'; session: AssistanceSession }
  | { type: 'ACTION_RESULT'; action: RemoteAction }
  | {
      type: 'REMOTE_SESSION_READY';
      remoteSession: RemoteSession;
      connect?: BrokerConnect;
    }
  | { type: 'CHAT_MESSAGE'; sessionId: string; from: string; text: string; at: string }
  | { type: 'PEER_PRESENCE'; sessionId: string; role: Role; online: boolean }
  | { type: 'ERROR'; code: string; message: string };
