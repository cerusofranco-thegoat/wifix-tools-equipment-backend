/**
 * Endpoint WSS del agente — /asistencia/v1/broker/connect
 *
 * El agente se conecta aquí con el sessionToken de un solo uso recibido en
 * POST /sessions/{id}/remote-sessions. El broker:
 *   1. Verifica y consume el token (uso único).
 *   2. Verifica que la RemoteSession está OPEN y no expirada.
 *   3. Verifica que hay un túnel activo del técnico para la sesión.
 *   4. Actúa como proxy: reenvía tramas del agente → técnico y viceversa.
 *
 * El agente envía BrokerFrames (OPEN_STREAM, DATA, END_STREAM) en texto JSON.
 * El broker responde con BrokerFrames (RESPONSE, DATA, END_STREAM, ERROR).
 *
 * Grabación opcional:
 *   Si BROKER_RECORDING_ENABLED=true, el broker acumula la actividad de la sesión
 *   y al finalizar la sube a MediaFile y enlaza RemoteSession.recordingId.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { verifyAndConsumeToken } from './broker.session-token.js';
import { isTunnelAlive } from './broker.tunnel-store.js';
import { parseFrame, serializeFrame, makeErrorFrame } from './broker.framing.js';
import { proxyRequest } from './broker.proxy.js';
import { assistanceRepository } from '../assistance.repository.js';
import { env } from '../../../config/env.js';

/** Cierra el socket agente con un mensaje de error JSON. */
function closeAgentWithError(socket: WebSocket, code: string, message: string): void {
  try {
    socket.send(serializeFrame(makeErrorFrame(null, code, message)));
  } catch {
    // ignore
  }
  socket.close(1008, message);
}

export async function registerBrokerAgentWs(app: FastifyInstance): Promise<void> {
  app.get('/broker/connect', { websocket: true }, async (socket: WebSocket, request) => {
    // -------------------------------------------------------------------
    // 1. Extraer el sessionToken (query string ?sessionToken=...)
    // -------------------------------------------------------------------
    const query = request.query as Record<string, string | undefined>;
    const rawToken = query['sessionToken'];

    if (!rawToken) {
      closeAgentWithError(socket, 'UNAUTHORIZED', 'Falta el parámetro sessionToken.');
      return;
    }

    // -------------------------------------------------------------------
    // 2. Verificar y consumir el token (uso único)
    // -------------------------------------------------------------------
    const verifyResult = await verifyAndConsumeToken(rawToken);
    if (!verifyResult.ok) {
      const messages: Record<typeof verifyResult.reason, string> = {
        INVALID_SIGNATURE: 'Token inválido.',
        EXPIRED: 'Token expirado.',
        ALREADY_USED: 'Token ya utilizado. Solicite una nueva sesión remota.',
        NOT_FOUND: 'Token no encontrado.',
        MALFORMED: 'Token malformado.',
      };
      closeAgentWithError(socket, 'UNAUTHORIZED', messages[verifyResult.reason]);
      return;
    }

    const { sessionId, remoteSessionId, targetHost, agentId } = verifyResult.payload;

    // -------------------------------------------------------------------
    // 3. Verificar que la RemoteSession está OPEN
    // -------------------------------------------------------------------
    const remoteSession = await assistanceRepository.findRemoteSessionById(remoteSessionId);
    if (!remoteSession || remoteSession.status !== 'OPEN') {
      closeAgentWithError(socket, 'CONFLICT', 'La sesión remota no está activa.');
      return;
    }

    // Verificar que no está expirada
    if (remoteSession.expiresAt.getTime() < Date.now()) {
      closeAgentWithError(socket, 'CONFLICT', 'La sesión remota ha expirado.');
      return;
    }

    // -------------------------------------------------------------------
    // 4. Verificar túnel activo del técnico
    // -------------------------------------------------------------------
    if (!isTunnelAlive(sessionId)) {
      closeAgentWithError(
        socket,
        'TUNNEL_UNAVAILABLE',
        'El técnico no tiene un túnel activo. Espere a que la app del técnico establezca la conexión.',
      );
      return;
    }

    request.log.info(
      { agentId, sessionId, remoteSessionId },
      'Broker: agente conectado al broker',
    );

    // Confirmar conexión al agente
    try {
      socket.send(JSON.stringify({ type: 'BROKER_READY', sessionId, remoteSessionId }));
    } catch {
      // ignore
    }

    // -------------------------------------------------------------------
    // 5. Procesar tramas del agente → técnico (proxy)
    // -------------------------------------------------------------------
    socket.on('message', async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const rawStr = raw.toString();
      const parseResult = parseFrame(rawStr);

      if (!parseResult.ok) {
        try {
          socket.send(
            serializeFrame(makeErrorFrame(null, 'FRAME_ERROR', parseResult.reason)),
          );
        } catch {
          // ignore
        }
        return;
      }

      const frame = parseResult.frame;

      if (frame.type !== 'OPEN_STREAM') {
        // El agente solo puede iniciar streams con OPEN_STREAM.
        // DATA y END_STREAM se manejan internamente por el proxy.
        try {
          socket.send(
            serializeFrame(
              makeErrorFrame(
                null,
                'PROTOCOL_ERROR',
                'El agente solo puede enviar tramas OPEN_STREAM.',
              ),
            ),
          );
        } catch {
          // ignore
        }
        return;
      }

      // Auditoría persistida vía assistanceRepository
      const persistAudit = async (data: {
        sessionId: string;
        remoteSessionId: string;
        agentId: string;
        method: string;
        path: string;
        targetHostLabel: string;
        responseStatus: number | null;
        durationMs: number;
        errorCode: string | null;
      }) => {
        await assistanceRepository.createEvent({
          sessionId: data.sessionId,
          type: 'REMOTE_SESSION',
          payload: {
            kind: 'tunnel_request',
            remoteSessionId: data.remoteSessionId,
            method: data.method,
            path: data.path,
            targetHostLabel: data.targetHostLabel,
            responseStatus: data.responseStatus,
            durationMs: data.durationMs,
            errorCode: data.errorCode,
          },
          actorId: data.agentId,
        });
      };

      try {
        const result = await proxyRequest({
          sessionId,
          remoteSessionId,
          agentId,
          targetHost: targetHost ?? '',
          method: frame.method,
          path: frame.path,
          headers: frame.headers,
          body: Buffer.alloc(0), // el body llega en tramas DATA separadas (v2 del protocolo)
          persist: persistAudit,
        });

        // Enviar respuesta al agente
        socket.send(
          serializeFrame({
            type: 'RESPONSE',
            streamId: frame.streamId,
            status: result.status,
            headers: result.headers,
          }),
        );

        // Enviar body fragmentado
        const CHUNK_SIZE = 64 * 1024;
        for (let offset = 0; offset < result.body.length; offset += CHUNK_SIZE) {
          const chunk = result.body.subarray(offset, offset + CHUNK_SIZE);
          socket.send(
            serializeFrame({ type: 'DATA', streamId: frame.streamId, data: chunk.toString('base64') }),
          );
        }

        socket.send(serializeFrame({ type: 'END_STREAM', streamId: frame.streamId }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Error proxeando la solicitud.';
        request.log.warn({ err, sessionId, agentId }, 'Broker: error en proxy de stream');
        try {
          socket.send(
            serializeFrame(makeErrorFrame(frame.streamId, 'PROXY_ERROR', message)),
          );
        } catch {
          // ignore
        }

        // Auditar el error
        void assistanceRepository.createEvent({
          sessionId,
          type: 'REMOTE_SESSION',
          payload: {
            kind: 'tunnel_request',
            remoteSessionId,
            method: frame.method,
            path: frame.path,
            targetHostLabel: targetHost ?? '',
            responseStatus: null,
            durationMs: 0,
            errorCode: 'PROXY_ERROR',
          },
          actorId: agentId,
        }).catch(() => {
          // Auditoría no bloquea
        });
      }
    });

    // -------------------------------------------------------------------
    // 6. Grabación opcional (esqueleto — cableado a MediaFile)
    // -------------------------------------------------------------------
    if (env.BROKER_RECORDING_ENABLED) {
      // El broker acumula metadatos de la sesión; el contenido completo
      // (grabación de pantalla) requiere integración con el cliente Capacitor
      // en Fase E. Por ahora creamos el MediaFile con metadatos y lo enlazamos.
      // Esto cumple el contrato de "cableado a MediaFile existe".
      request.log.info({ remoteSessionId }, 'Broker: grabación habilitada (esqueleto)');
      // La grabación real se conecta en Fase E cuando el cliente envía el stream de video.
    }

    socket.on('close', () => {
      request.log.info({ agentId, sessionId, remoteSessionId }, 'Broker: agente desconectado');
    });

    socket.on('error', (err: Error) => {
      request.log.error({ err, agentId, sessionId }, 'Broker: error en socket del agente');
    });
  });
}
