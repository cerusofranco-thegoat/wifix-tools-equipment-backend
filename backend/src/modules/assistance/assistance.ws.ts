/**
 * WebSocket de señalización — /asistencia/v1/ws
 *
 * Fase B: autentica JWT y procesa mensajes del cliente:
 *   REGISTER_TECHNICIAN, SUBSCRIBE_QUEUE, JOIN_SESSION, CHAT_MESSAGE, HEARTBEAT.
 *
 * Heartbeat: si no se recibe dentro de WS_HEARTBEAT_TIMEOUT_MS, se cierra la
 * conexión y se emite PEER_PRESENCE online:false a los compañeros de sala.
 *
 * Autenticación (en orden de prioridad):
 *   1. Header: Authorization: Bearer <jwt>
 *   2. Query string: ?token=<jwt>
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { verifyAuthToken } from '../../auth/jwt.js';
import { ApiError } from '../../middleware/error-handler.js';
import { assistanceRepository } from './assistance.repository.js';
import {
  registerConnection,
  removeConnection,
  updateHeartbeat,
  joinSession,
  subscribeToQueue,
  broadcastChat,
  broadcastPeerPresence,
  sendError,
  getStaleConnections,
  getConnection,
} from './assistance.hub.js';

// Intervalo de heartbeat: 60 segundos (configurable vía env en el futuro)
const WS_HEARTBEAT_TIMEOUT_MS = 60_000;

// Intervalo de chequeo de conexiones stale
const STALE_CHECK_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Tipos de mensajes cliente → servidor
// ---------------------------------------------------------------------------

interface RegisterTechnicianMsg {
  type: 'REGISTER_TECHNICIAN';
  sessionId: string;
}

interface SubscribeQueueMsg {
  type: 'SUBSCRIBE_QUEUE';
}

interface JoinSessionMsg {
  type: 'JOIN_SESSION';
  sessionId: string;
}

interface ChatMessageMsg {
  type: 'CHAT_MESSAGE';
  sessionId: string;
  text: string;
}

interface HeartbeatMsg {
  type: 'HEARTBEAT';
}

type ClientMessage =
  | RegisterTechnicianMsg
  | SubscribeQueueMsg
  | JoinSessionMsg
  | ChatMessageMsg
  | HeartbeatMsg;

/** Envía un mensaje de error JSON al cliente y cierra la conexión. */
function closeWithError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'ERROR', code, message }));
  } catch {
    // Si el socket ya está cerrado, ignoramos el error de escritura.
  }
  socket.close(1008, message); // 1008 = Policy Violation
}

/** Parsea un mensaje crudo; devuelve null si no es JSON o no tiene `type`. */
function parseMessage(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      typeof (parsed as Record<string, unknown>).type === 'string'
    ) {
      return parsed as ClientMessage;
    }
    return null;
  } catch {
    return null;
  }
}

export async function registerAssistanceWs(app: FastifyInstance): Promise<void> {
  // Iniciar el chequeo periódico de conexiones sin heartbeat
  const staleTimer = setInterval(() => {
    const stale = getStaleConnections(WS_HEARTBEAT_TIMEOUT_MS);
    for (const connId of stale) {
      const conn = getConnection(connId);
      if (conn) {
        // Notificar presencia offline a los compañeros de sala
        if (conn.sessionId) {
          broadcastPeerPresence(conn.sessionId, conn.role, false, connId);
        }
        try {
          conn.socket.close(1001, 'Heartbeat timeout.');
        } catch {
          // ignore
        }
        removeConnection(connId);
      }
    }
  }, STALE_CHECK_INTERVAL_MS);

  // Limpiar el timer cuando el servidor se cierra
  app.addHook('onClose', () => {
    clearInterval(staleTimer);
  });

  app.get('/ws', { websocket: true }, async (socket: WebSocket, request) => {
    // -----------------------------------------------------------------------
    // 1. Extraer el JWT del header o del query string
    // -----------------------------------------------------------------------
    let token: string | null = null;

    const authHeader = request.headers.authorization;
    if (authHeader) {
      const [scheme, headerToken] = authHeader.split(' ');
      if (scheme?.toLowerCase() === 'bearer' && headerToken) {
        token = headerToken.trim();
      }
    }

    if (!token) {
      const query = request.query as Record<string, string | undefined>;
      if (typeof query.token === 'string' && query.token.length > 0) {
        token = query.token;
      }
    }

    if (!token) {
      closeWithError(socket, 'UNAUTHORIZED', 'Se requiere token JWT para conectarse.');
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Verificar el JWT
    // -----------------------------------------------------------------------
    let authUser: Awaited<ReturnType<typeof verifyAuthToken>>;
    try {
      authUser = await verifyAuthToken(token);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Token inválido o expirado.';
      closeWithError(socket, 'UNAUTHORIZED', message);
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Registrar la conexión en el hub
    // -----------------------------------------------------------------------
    const connId = registerConnection(socket, authUser.sub, authUser.role);

    request.log.info(
      { userId: authUser.sub, role: authUser.role, connId },
      'WS assistance: cliente conectado',
    );

    // -----------------------------------------------------------------------
    // 4. Dispatch de mensajes
    // -----------------------------------------------------------------------
    socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const rawStr = raw.toString();
      const msg = parseMessage(rawStr);

      if (!msg) {
        sendError(
          connId,
          'VALIDATION_ERROR',
          'Mensaje inválido: se esperaba JSON con campo "type".',
        );
        return;
      }

      updateHeartbeat(connId);

      try {
        switch (msg.type) {
          case 'HEARTBEAT': {
            // Solo actualizar heartbeat (ya hecho arriba)
            break;
          }

          case 'REGISTER_TECHNICIAN': {
            // Solo permitido a técnicos
            if (authUser.role !== 'TECHNICIAN') {
              sendError(connId, 'FORBIDDEN', 'Solo los técnicos pueden usar REGISTER_TECHNICIAN.');
              return;
            }
            const session = await assistanceRepository.findSessionById(msg.sessionId);
            if (!session) {
              sendError(connId, 'NOT_FOUND', 'Sesión no encontrada.');
              return;
            }
            // Verificar que el técnico pertenece a la sesión
            if (session.technicianId !== authUser.sub) {
              sendError(connId, 'FORBIDDEN', 'No perteneces a esta sesión.');
              return;
            }
            joinSession(connId, msg.sessionId);
            // Notificar presencia online a compañeros de sala
            broadcastPeerPresence(msg.sessionId, authUser.role, true, connId);
            request.log.info(
              { userId: authUser.sub, sessionId: msg.sessionId },
              'WS: técnico registrado en sesión',
            );
            break;
          }

          case 'SUBSCRIBE_QUEUE': {
            // Solo permitido a agentes y supervisores
            if (authUser.role !== 'AGENT' && authUser.role !== 'SUPERVISOR') {
              sendError(
                connId,
                'FORBIDDEN',
                'Solo agentes y supervisores pueden suscribirse a la cola.',
              );
              return;
            }
            subscribeToQueue(connId);
            request.log.info(
              { userId: authUser.sub, role: authUser.role },
              'WS: cliente suscrito a la cola',
            );
            break;
          }

          case 'JOIN_SESSION': {
            // Permitido a agentes y supervisores; verificar pertenencia
            if (authUser.role !== 'AGENT' && authUser.role !== 'SUPERVISOR') {
              sendError(
                connId,
                'FORBIDDEN',
                'Solo agentes y supervisores pueden unirse a sesiones.',
              );
              return;
            }
            const session = await assistanceRepository.findSessionById(msg.sessionId);
            if (!session) {
              sendError(connId, 'NOT_FOUND', 'Sesión no encontrada.');
              return;
            }
            // Supervisor puede unirse a cualquier sesión; agente solo a la suya
            if (authUser.role === 'AGENT' && session.agentId !== authUser.sub) {
              sendError(connId, 'FORBIDDEN', 'No eres el agente asignado a esta sesión.');
              return;
            }
            joinSession(connId, msg.sessionId);
            broadcastPeerPresence(msg.sessionId, authUser.role, true, connId);
            request.log.info(
              { userId: authUser.sub, sessionId: msg.sessionId },
              'WS: agente/supervisor unido a sesión',
            );
            break;
          }

          case 'CHAT_MESSAGE': {
            // Verificar que el usuario está en la sesión
            const conn = getConnection(connId);
            if (!conn || conn.sessionId !== msg.sessionId) {
              sendError(connId, 'FORBIDDEN', 'No estás unido a esta sesión.');
              return;
            }
            // Verificar pertenencia a la sesión
            const session = await assistanceRepository.findSessionById(msg.sessionId);
            if (!session) {
              sendError(connId, 'NOT_FOUND', 'Sesión no encontrada.');
              return;
            }
            const isParticipant =
              session.technicianId === authUser.sub ||
              session.agentId === authUser.sub ||
              authUser.role === 'SUPERVISOR';
            if (!isParticipant) {
              sendError(connId, 'FORBIDDEN', 'No tienes acceso a esta sesión.');
              return;
            }
            // Persistir como evento CHAT y hacer broadcast
            await assistanceRepository.createEvent({
              sessionId: msg.sessionId,
              type: 'CHAT',
              payload: { text: msg.text, from: authUser.sub },
              actorId: authUser.sub,
            });
            broadcastChat(msg.sessionId, authUser.sub, msg.text);
            break;
          }

          default: {
            sendError(connId, 'VALIDATION_ERROR', `Tipo de mensaje desconocido.`);
          }
        }
      } catch (err) {
        request.log.error({ err, userId: authUser.sub, connId }, 'WS: error procesando mensaje');
        sendError(connId, 'INTERNAL_ERROR', 'Error interno procesando el mensaje.');
      }
    });

    socket.on('close', () => {
      const conn = getConnection(connId);
      if (conn?.sessionId) {
        broadcastPeerPresence(conn.sessionId, authUser.role, false, connId);
      }
      removeConnection(connId);
      request.log.info({ userId: authUser.sub, connId }, 'WS assistance: cliente desconectado');
    });

    socket.on('error', (err: Error) => {
      request.log.error({ err, userId: authUser.sub, connId }, 'WS assistance: error de socket');
      removeConnection(connId);
    });
  });
}
