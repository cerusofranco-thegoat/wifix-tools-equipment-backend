/**
 * Hub de WebSocket en memoria para el módulo Asistencia Técnica.
 *
 * Registra conexiones por sesión y por suscripción de cola.
 * Permite hacer broadcast de eventos a las salas y a los observadores de cola.
 *
 * Intencionalmente simple y testeable: el estado vive en dos Maps, sin I/O.
 */

import type { WebSocket } from '@fastify/websocket';
import type {
  AssistanceSessionDto,
  RemoteActionDto,
  RemoteSessionDto,
} from './assistance.mappers.js';

// ---------------------------------------------------------------------------
// Tipos de mensajes servidor → cliente (alineados con el contrato §4 WS)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: 'QUEUE_UPDATED'; session: AssistanceSessionDto }
  | { type: 'SESSION_STATE_CHANGED'; session: AssistanceSessionDto }
  | { type: 'ACTION_RESULT'; action: RemoteActionDto }
  | {
      type: 'REMOTE_SESSION_READY';
      remoteSession: RemoteSessionDto;
      connect?: { wsUrl: string; sessionToken: string; expiresAt: string };
    }
  | { type: 'CHAT_MESSAGE'; sessionId: string; from: string; text: string; at: string }
  | { type: 'PEER_PRESENCE'; sessionId: string; role: string; online: boolean }
  | { type: 'ERROR'; code: string; message: string };

// ---------------------------------------------------------------------------
// Metadatos de cada conexión WS activa
// ---------------------------------------------------------------------------

export interface WsConnection {
  socket: WebSocket;
  userId: string;
  role: string;
  /** null si no está unido a ninguna sesión */
  sessionId: string | null;
  /** true si está suscrito a actualizaciones de la cola */
  subscribedToQueue: boolean;
  lastHeartbeat: number;
}

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

/** Todas las conexiones activas, indexadas por un ID interno (userId + timestamp) */
const connections = new Map<string, WsConnection>();

let _connectionCounter = 0;
function nextConnectionId(): string {
  return `conn-${++_connectionCounter}`;
}

// ---------------------------------------------------------------------------
// Registro y baja de conexiones
// ---------------------------------------------------------------------------

export function registerConnection(socket: WebSocket, userId: string, role: string): string {
  const id = nextConnectionId();
  connections.set(id, {
    socket,
    userId,
    role,
    sessionId: null,
    subscribedToQueue: false,
    lastHeartbeat: Date.now(),
  });
  return id;
}

export function removeConnection(connId: string): void {
  connections.delete(connId);
}

export function getConnection(connId: string): WsConnection | undefined {
  return connections.get(connId);
}

export function updateHeartbeat(connId: string): void {
  const conn = connections.get(connId);
  if (conn) conn.lastHeartbeat = Date.now();
}

// ---------------------------------------------------------------------------
// Acciones sobre la conexión
// ---------------------------------------------------------------------------

export function joinSession(connId: string, sessionId: string): void {
  const conn = connections.get(connId);
  if (conn) conn.sessionId = sessionId;
}

export function subscribeToQueue(connId: string): void {
  const conn = connections.get(connId);
  if (conn) conn.subscribedToQueue = true;
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

function send(socket: WebSocket, event: ServerEvent): void {
  try {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  } catch {
    // Si el socket está cerrado/roto, ignoramos silenciosamente.
  }
}

/** Emite a todos los que observan la cola (AGENT / SUPERVISOR con SUBSCRIBE_QUEUE). */
export function broadcastQueueUpdated(session: AssistanceSessionDto): void {
  const event: ServerEvent = { type: 'QUEUE_UPDATED', session };
  for (const conn of connections.values()) {
    if (conn.subscribedToQueue) {
      send(conn.socket, event);
    }
  }
}

/** Emite a todos los participantes de una sesión (y supervisores unidos a la sala). */
export function broadcastSessionStateChanged(session: AssistanceSessionDto): void {
  const event: ServerEvent = { type: 'SESSION_STATE_CHANGED', session };
  for (const conn of connections.values()) {
    if (conn.sessionId === session.id) {
      send(conn.socket, event);
    }
  }
}

/** Emite ACTION_RESULT a los participantes de la sesión. */
export function broadcastActionResult(sessionId: string, action: RemoteActionDto): void {
  const event: ServerEvent = { type: 'ACTION_RESULT', action };
  for (const conn of connections.values()) {
    if (conn.sessionId === sessionId) {
      send(conn.socket, event);
    }
  }
}

/** Emite REMOTE_SESSION_READY a los participantes de la sesión. */
export function broadcastRemoteSessionReady(
  sessionId: string,
  remoteSession: RemoteSessionDto,
  connect?: { wsUrl: string; sessionToken: string; expiresAt: string },
): void {
  const event: ServerEvent = { type: 'REMOTE_SESSION_READY', remoteSession, connect };
  for (const conn of connections.values()) {
    if (conn.sessionId === sessionId) {
      send(conn.socket, event);
    }
  }
}

/** Emite CHAT_MESSAGE a todos los participantes de la sesión. */
export function broadcastChat(sessionId: string, from: string, text: string): void {
  const event: ServerEvent = {
    type: 'CHAT_MESSAGE',
    sessionId,
    from,
    text,
    at: new Date().toISOString(),
  };
  for (const conn of connections.values()) {
    if (conn.sessionId === sessionId) {
      send(conn.socket, event);
    }
  }
}

/** Emite PEER_PRESENCE a los participantes de la sesión (excluye al emisor). */
export function broadcastPeerPresence(
  sessionId: string,
  role: string,
  online: boolean,
  excludeConnId?: string,
): void {
  const event: ServerEvent = { type: 'PEER_PRESENCE', sessionId, role, online };
  for (const [id, conn] of connections.entries()) {
    if (conn.sessionId === sessionId && id !== excludeConnId) {
      send(conn.socket, event);
    }
  }
}

/** Envía un ERROR a una conexión específica. */
export function sendError(connId: string, code: string, message: string): void {
  const conn = connections.get(connId);
  if (conn) send(conn.socket, { type: 'ERROR', code, message });
}

// ---------------------------------------------------------------------------
// Heartbeat: cierre de conexiones sin latido
// ---------------------------------------------------------------------------

/**
 * Devuelve los connIds de conexiones que superaron el timeout sin HEARTBEAT.
 * El llamador decide si cerrar la conexión WS; de este módulo se elimina la
 * entrada del registro.
 */
export function getStaleConnections(timeoutMs: number): string[] {
  const now = Date.now();
  const stale: string[] = [];
  for (const [id, conn] of connections.entries()) {
    if (now - conn.lastHeartbeat > timeoutMs) {
      stale.push(id);
    }
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Exportación del estado (para tests)
// ---------------------------------------------------------------------------

export function getConnectionCount(): number {
  return connections.size;
}

export function getAllConnections(): ReadonlyMap<string, WsConnection> {
  return connections;
}
