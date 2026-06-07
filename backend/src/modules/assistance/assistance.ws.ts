/**
 * WebSocket de señalización — /asistencia/v1/ws
 *
 * Fase 0: autentica el JWT (header Authorization o query ?token=) y acepta la
 * conexión. Sin lógica de negocio todavía (la máquina de mensajes va en Fase B).
 *
 * Autenticación (en orden de prioridad):
 *   1. Header: Authorization: Bearer <jwt>
 *   2. Query string: ?token=<jwt>
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { verifyAuthToken } from '../../auth/jwt.js';
import { ApiError } from '../../middleware/error-handler.js';

/** Envía un mensaje de error JSON al cliente y cierra la conexión. */
function closeWithError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({ type: 'ERROR', code, message }));
  } catch {
    // Si el socket ya está cerrado, ignoramos el error de escritura.
  }
  socket.close(1008, message); // 1008 = Policy Violation
}

export async function registerAssistanceWs(app: FastifyInstance): Promise<void> {
  app.get(
    '/ws',
    { websocket: true },
    async (socket: WebSocket, request) => {
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
        const message =
          err instanceof ApiError ? err.message : 'Token inválido o expirado.';
        closeWithError(socket, 'UNAUTHORIZED', message);
        return;
      }

      // -----------------------------------------------------------------------
      // 3. Conexión aceptada — log de bienvenida (Fase B conectará salas/colas)
      // -----------------------------------------------------------------------
      request.log.info(
        { userId: authUser.sub, role: authUser.role },
        'WS assistance: cliente conectado',
      );

      // Fase B: aquí se procesarán los mensajes REGISTER_TECHNICIAN,
      // SUBSCRIBE_QUEUE, JOIN_SESSION, CHAT_MESSAGE y HEARTBEAT.
      socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
        request.log.debug({ userId: authUser.sub, raw: raw.toString() }, 'WS mensaje recibido (stub Fase 0)');
        // Fase B implementará el dispatch de mensajes.
      });

      socket.on('close', () => {
        request.log.info({ userId: authUser.sub }, 'WS assistance: cliente desconectado');
      });

      socket.on('error', (err: Error) => {
        request.log.error({ err, userId: authUser.sub }, 'WS assistance: error de socket');
      });
    },
  );
}
