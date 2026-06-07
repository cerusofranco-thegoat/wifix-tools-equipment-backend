/**
 * Endpoint WSS del broker — /asistencia/v1/broker/tunnel
 *
 * Lado técnico del broker: la app del técnico abre una conexión WSS saliente aquí
 * para registrar el túnel de una sesión. El técnico se autentica con su JWT normal
 * y envía un mensaje REGISTER_TUNNEL con el sessionId.
 *
 * Una vez registrado, el broker puede recibir tramas del agente y reenviarlas
 * a través de este socket al técnico (quien tiene acceso LAN al router del cliente).
 *
 * Protocolo de trama: ver docs/asistencia-broker-protocolo.md y broker.framing.ts.
 *
 * Mensajes válidos del técnico → broker:
 *   { type: 'REGISTER_TUNNEL', sessionId: string }
 *   { type: 'PONG', at: number }
 *   BrokerFrame (RESPONSE, DATA, END_STREAM, ERROR — datos del router hacia el agente)
 *
 * Mensajes del broker → técnico:
 *   BrokerFrame (OPEN_STREAM, DATA, END_STREAM, PING — requests del agente al router)
 *   { type: 'ERROR', ... }
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { verifyAuthToken } from '../../../auth/jwt.js';
import { ApiError } from '../../../middleware/error-handler.js';
import { assistanceRepository } from '../assistance.repository.js';
import { registerTunnel, removeTunnel } from './broker.tunnel-store.js';
import { parseFrame, serializeFrame, makePingFrame } from './broker.framing.js';
import { wsRateLimitConfig } from './broker.rate-limit.js';

// Keep-alive del túnel: enviar PING cada 30s
const TUNNEL_PING_INTERVAL_MS = 30_000;

/** Cierra el socket con un error JSON antes de cerrar la conexión WS. */
function closeWithError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'ERROR', streamId: null, code, message }));
  } catch {
    // Si ya está cerrado, ignorar
  }
  socket.close(1008, message);
}

export async function registerBrokerTunnelWs(app: FastifyInstance): Promise<void> {
  app.get('/broker/tunnel', { websocket: true, config: { rateLimit: wsRateLimitConfig } }, async (socket: WebSocket, request) => {
    // -------------------------------------------------------------------
    // 1. Extraer JWT (header o query string)
    // -------------------------------------------------------------------
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
      if (typeof query['token'] === 'string') token = query['token'];
    }

    if (!token) {
      closeWithError(socket, 'UNAUTHORIZED', 'Se requiere JWT del técnico.');
      return;
    }

    // -------------------------------------------------------------------
    // 2. Verificar JWT de autenticación (el mismo del módulo auth)
    // -------------------------------------------------------------------
    let authUser: Awaited<ReturnType<typeof verifyAuthToken>>;
    try {
      authUser = await verifyAuthToken(token);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Token inválido.';
      closeWithError(socket, 'UNAUTHORIZED', message);
      return;
    }

    // Solo técnicos pueden abrir túneles
    if (authUser.role !== 'TECHNICIAN') {
      closeWithError(socket, 'FORBIDDEN', 'Solo los técnicos pueden registrar túneles.');
      return;
    }

    // -------------------------------------------------------------------
    // 3. Esperar mensaje REGISTER_TUNNEL (primer mensaje obligatorio)
    // -------------------------------------------------------------------
    let sessionId: string | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const onFirstMessage = async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const rawStr = raw.toString();
      let msg: unknown;
      try {
        msg = JSON.parse(rawStr);
      } catch {
        closeWithError(socket, 'VALIDATION_ERROR', 'Primer mensaje debe ser JSON.');
        return;
      }

      if (
        typeof msg !== 'object' ||
        msg === null ||
        (msg as Record<string, unknown>)['type'] !== 'REGISTER_TUNNEL' ||
        typeof (msg as Record<string, unknown>)['sessionId'] !== 'string'
      ) {
        closeWithError(
          socket,
          'VALIDATION_ERROR',
          'El primer mensaje debe ser { type: "REGISTER_TUNNEL", sessionId: string }.',
        );
        return;
      }

      sessionId = (msg as Record<string, unknown>)['sessionId'] as string;

      // Verificar que la sesión existe y el técnico pertenece a ella
      const assistanceSession = await assistanceRepository.findSessionById(sessionId);
      if (!assistanceSession) {
        closeWithError(socket, 'NOT_FOUND', 'Sesión de asistencia no encontrada.');
        return;
      }
      if (assistanceSession.technicianId !== authUser.sub) {
        closeWithError(socket, 'FORBIDDEN', 'No eres el técnico de esta sesión.');
        return;
      }
      if (assistanceSession.status !== 'ACTIVE') {
        closeWithError(socket, 'CONFLICT', 'La sesión no está en estado ACTIVE.');
        return;
      }

      // Registrar el túnel
      registerTunnel({
        sessionId,
        technicianId: authUser.sub,
        socket,
        registeredAt: Date.now(),
      });

      request.log.info(
        { technicianId: authUser.sub, sessionId },
        'Broker: túnel registrado',
      );

      // Confirmar al técnico que el túnel está activo
      try {
        socket.send(
          JSON.stringify({ type: 'TUNNEL_READY', sessionId }),
        );
      } catch {
        // ignore
      }

      // Iniciar keep-alive del túnel
      pingTimer = setInterval(() => {
        try {
          if (socket.readyState === 1) {
            socket.send(serializeFrame(makePingFrame()));
          }
        } catch {
          // ignore
        }
      }, TUNNEL_PING_INTERVAL_MS);
      if (typeof pingTimer.unref === 'function') pingTimer.unref();

      // Cambiar listener al modo operación normal (tramas del router → agente)
      socket.off('message', onFirstMessage as Parameters<typeof socket.on>[1]);
      socket.on('message', onTunnelMessage as Parameters<typeof socket.on>[1]);
    };

    const onTunnelMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
      // Las tramas recibidas del técnico (RESPONSE, DATA, END_STREAM, PONG) las
      // gestiona la lógica del proxy en broker.proxy.ts cuando hay un stream activo.
      // Aquí solo se parsea para validar el formato; el enrutamiento al agente
      // es responsabilidad del proxy que mantiene el estado por streamId.
      const rawStr = raw.toString();
      const result = parseFrame(rawStr);
      if (!result.ok) {
        try {
          socket.send(
            JSON.stringify({ type: 'ERROR', streamId: null, code: 'FRAME_ERROR', message: result.reason }),
          );
        } catch {
          // ignore
        }
      }
      // Las tramas válidas llegan al proxy que las está esperando (promesa/EventEmitter
      // por streamId). Los datos ya están en el socket; el proxy los lee con un listener
      // por streamId registrado directamente en el socket del técnico cuando abre un stream.
    };

    socket.on('message', onFirstMessage as Parameters<typeof socket.on>[1]);

    socket.on('close', () => {
      if (pingTimer) clearInterval(pingTimer);
      if (sessionId) {
        removeTunnel(sessionId);
        request.log.info(
          { technicianId: authUser.sub, sessionId },
          'Broker: túnel cerrado (técnico desconectado)',
        );
      }
    });

    socket.on('error', (err: Error) => {
      if (pingTimer) clearInterval(pingTimer);
      if (sessionId) removeTunnel(sessionId);
      request.log.error({ err, technicianId: authUser.sub, sessionId }, 'Broker: error en túnel');
    });
  });
}
