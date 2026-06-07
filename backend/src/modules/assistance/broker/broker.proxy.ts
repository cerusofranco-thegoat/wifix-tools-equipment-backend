/**
 * Proxy HTTP sobre el túnel WSS del broker.
 *
 * Cuando el agente hace una petición HTTP al broker, este módulo:
 *   1. Verifica que hay un túnel activo del técnico para la sesión.
 *   2. Construye una trama OPEN_STREAM y la envía al técnico por el túnel.
 *   3. Envía el body de la request como tramas DATA + END_STREAM.
 *   4. Espera la respuesta (RESPONSE + DATA* + END_STREAM) del técnico.
 *   5. Devuelve status, headers y body al agente.
 *
 * Backpressure / timeouts:
 *   - Cada stream tiene un timeout de STREAM_TIMEOUT_MS (20 seg.) para recibir
 *     la RESPONSE del técnico.
 *   - Si el túnel se cierra durante un stream activo, se rechaza el stream con
 *     ERROR TUNNEL_CLOSED.
 *
 * Multiplexación:
 *   - Múltiples streams pueden estar en vuelo simultáneamente sobre el mismo túnel.
 *   - Cada stream tiene un streamId único (número incremental por conexión del agente).
 *   - El broker enruta tramas del técnico al agente correcto por streamId.
 *
 * Módulo sin dependencias de BD → testeable aislado.
 */

import { EventEmitter } from 'node:events';
import type { WebSocket } from '@fastify/websocket';
import {
  serializeFrame,
  parseFrame,
  isAllowedMethod,
  makeErrorFrame,
  type ResponseFrame,
  type BrokerFrame,
} from './broker.framing.js';
import { getTunnel } from './broker.tunnel-store.js';
import { buildAuditPayload, auditTunnelRequest } from './broker.audit.js';
import type { AuditPersistFn } from './broker.audit.js';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const STREAM_TIMEOUT_MS = 20_000;
const MAX_BODY_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Resultado del proxy
// ---------------------------------------------------------------------------

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// ---------------------------------------------------------------------------
// Estado de streams activos (por túnel/sesión)
// ---------------------------------------------------------------------------

/**
 * Por cada túnel activo, mantenemos un EventEmitter que recibe tramas del técnico.
 * El emitter está keyed por sessionId y escucha mensajes del socket del técnico.
 */
const tunnelEmitters = new Map<string, EventEmitter>();

/**
 * Registra un EventEmitter para un túnel activo.
 * El emitter recibe tramas del técnico (RESPONSE, DATA, END_STREAM, ERROR).
 * Debe llamarse justo antes de enviar OPEN_STREAM.
 */
function getOrCreateEmitter(sessionId: string, tunnelSocket: WebSocket): EventEmitter {
  const existing = tunnelEmitters.get(sessionId);
  if (existing) return existing;

  const emitter = new EventEmitter();
  emitter.setMaxListeners(50); // múltiples streams simultáneos

  // Escuchar mensajes del técnico y emitirlos como eventos por streamId
  const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const result = parseFrame(raw.toString());
    if (!result.ok) return;
    const frame = result.frame;
    if (
      frame.type === 'RESPONSE' ||
      frame.type === 'DATA' ||
      frame.type === 'END_STREAM' ||
      frame.type === 'ERROR'
    ) {
      // Emitir por streamId para que el stream esperando lo reciba
      emitter.emit(`stream:${frame.streamId}`, frame);
    }
  };

  const onClose = () => {
    emitter.emit('tunnel:closed');
    tunnelEmitters.delete(sessionId);
    tunnelSocket.off('message', onMessage as Parameters<typeof tunnelSocket.on>[1]);
  };

  tunnelSocket.on('message', onMessage as Parameters<typeof tunnelSocket.on>[1]);
  tunnelSocket.once('close', onClose);
  tunnelEmitters.set(sessionId, emitter);

  return emitter;
}

/**
 * Contador de streamId por sesión (keyed por sessionId).
 * Reemplaza el contador global que colisionaba entre sesiones paralelas.
 * Cada sesión tiene su propio contador, garantizando unicidad dentro del mismo túnel.
 */
const _sessionStreamCounters = new Map<string, number>();

function nextStreamId(sessionId: string): number {
  const current = _sessionStreamCounters.get(sessionId) ?? 0;
  const next = current + 1;
  _sessionStreamCounters.set(sessionId, next);
  return next;
}

/** Limpia el contador de una sesión al cerrar el túnel (llamado por broker.ws). */
export function clearStreamCounter(sessionId: string): void {
  _sessionStreamCounters.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Función principal del proxy
// ---------------------------------------------------------------------------

export interface ProxyRequestInput {
  sessionId: string;
  remoteSessionId: string;
  agentId: string;
  targetHost: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
  persist: AuditPersistFn;
}

/**
 * Proxea una petición HTTP del agente al router del cliente a través del túnel.
 *
 * El flujo completo:
 *   broker → [OPEN_STREAM] → túnel técnico → técnico → [request HTTP → router]
 *   router → [response HTTP → técnico] → [RESPONSE+DATA+END_STREAM] → broker → agente
 *
 * @throws Error si no hay túnel activo, el método no está permitido, o hay timeout.
 */
export async function proxyRequest(input: ProxyRequestInput): Promise<ProxyResult> {
  const startMs = Date.now();
  // [MEDIO-4] Contador por sesión — evita colisiones entre sesiones paralelas.
  const streamId = nextStreamId(input.sessionId);

  // Validar método
  if (!isAllowedMethod(input.method)) {
    throw new Error(`Método HTTP no permitido: ${input.method}`);
  }

  // Buscar túnel activo
  const tunnel = getTunnel(input.sessionId);
  if (!tunnel || tunnel.socket.readyState !== 1) {
    throw new Error('No hay túnel activo del técnico para esta sesión.');
  }

  const emitter = getOrCreateEmitter(input.sessionId, tunnel.socket);

  // [CRÍTICO-2] Enviar input.headers (ya saneados por filterAgentHeaders) sin redactar.
  // Redactar aquí rompería silenciosamente cabeceras legítimas (ej. Basic Auth del router).
  // La redacción solo se aplica en el payload de auditoría/log (abajo).
  tunnel.socket.send(
    serializeFrame({
      type: 'OPEN_STREAM',
      streamId,
      method: input.method.toUpperCase(),
      path: input.path,
      headers: input.headers,
    }),
  );

  // Enviar body si existe (fragmentado en chunks de 64KB)
  if (input.body.length > 0) {
    const CHUNK_SIZE = 64 * 1024;
    for (let offset = 0; offset < input.body.length; offset += CHUNK_SIZE) {
      const chunk = input.body.subarray(offset, offset + CHUNK_SIZE);
      tunnel.socket.send(
        serializeFrame({ type: 'DATA', streamId, data: chunk.toString('base64') }),
      );
    }
  }

  // Señalar fin de request
  tunnel.socket.send(serializeFrame({ type: 'END_STREAM', streamId }));

  // Esperar RESPONSE del técnico
  const result = await new Promise<ProxyResult>((resolve, reject) => {
    let responseReceived = false;
    let responseStatus = 0;
    let responseHeaders: Record<string, string> = {};
    const bodyChunks: Buffer[] = [];
    let bodySize = 0;

    const timeout = setTimeout(() => {
      reject(new Error('Timeout esperando respuesta del técnico.'));
      cleanup();
    }, STREAM_TIMEOUT_MS);

    const onTunnelClosed = () => {
      clearTimeout(timeout);
      reject(new Error('El túnel del técnico se cerró durante el stream.'));
    };

    const onFrame = (frame: BrokerFrame) => {
      switch (frame.type) {
        case 'RESPONSE': {
          if (responseReceived) break; // ignorar duplicados
          responseReceived = true;
          responseStatus = (frame as ResponseFrame).status;
          // [CRÍTICO-1] Almacenar los headers BRUTOS del router sin redactar.
          // El caller (broker.http-proxy) necesita los Set-Cookie reales para
          // reescribirlos (confinamiento al path del proxy). La redacción se aplica
          // SOLO en el payload de auditoría/log (ver auditTunnelRequest abajo).
          responseHeaders = (frame as ResponseFrame).headers;
          break;
        }
        case 'DATA': {
          const chunk = Buffer.from(frame.data, 'base64');
          bodySize += chunk.length;
          if (bodySize > MAX_BODY_SIZE_BYTES) {
            clearTimeout(timeout);
            reject(new Error('Respuesta del router excede el tamaño máximo permitido (4 MB).'));
            cleanup();
            return;
          }
          bodyChunks.push(chunk);
          break;
        }
        case 'END_STREAM': {
          clearTimeout(timeout);
          cleanup();
          resolve({
            status: responseReceived ? responseStatus : 502,
            headers: responseHeaders,
            body: Buffer.concat(bodyChunks),
          });
          break;
        }
        case 'ERROR': {
          clearTimeout(timeout);
          cleanup();
          reject(new Error(`Error del técnico en stream ${streamId}: ${frame.message}`));
          break;
        }
        default:
          break;
      }
    };

    function cleanup() {
      emitter.off(`stream:${streamId}`, onFrame);
      emitter.off('tunnel:closed', onTunnelClosed);
    }

    emitter.once('tunnel:closed', onTunnelClosed);
    emitter.on(`stream:${streamId}`, onFrame);
  });

  // Auditoría: registrar la request sin datos sensibles
  const durationMs = Date.now() - startMs;
  const auditData = buildAuditPayload({
    sessionId: input.sessionId,
    remoteSessionId: input.remoteSessionId,
    agentId: input.agentId,
    method: input.method,
    path: input.path,
    targetHostLabel: input.targetHost,
    responseStatus: result.status,
    durationMs,
    errorCode: null,
  });

  // Fire-and-forget: auditoría no bloquea la respuesta
  void auditTunnelRequest(
    {
      sessionId: input.sessionId,
      remoteSessionId: input.remoteSessionId,
      agentId: input.agentId,
      method: input.method,
      path: input.path,
      targetHostLabel: input.targetHost,
      responseStatus: result.status,
      durationMs,
      errorCode: null,
    },
    input.persist,
  );

  void auditData; // consumido arriba, silenciar unused warning

  return result;
}

/**
 * Envía una trama ERROR al técnico (p.ej. al cerrar la sesión) para que aborte streams activos.
 */
export function sendTunnelError(sessionId: string, code: string, message: string): void {
  const tunnel = getTunnel(sessionId);
  if (!tunnel || tunnel.socket.readyState !== 1) return;
  try {
    tunnel.socket.send(serializeFrame(makeErrorFrame(null, code, message)));
  } catch {
    // ignore
  }
}
