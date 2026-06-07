/**
 * Protocolo de trama del broker de sesión remota.
 *
 * Ver docs/asistencia-broker-protocolo.md para la especificación completa.
 *
 * Resumen:
 *   Cada mensaje entre el agente y el técnico (a través del broker) es un objeto
 *   JSON con los campos: { type, streamId, ...payload }.
 *
 *   Tipos de trama:
 *     OPEN_STREAM  — agente → broker → técnico: abrir un "stream" HTTP
 *     DATA         — bidireccional: fragmento de datos (body de request o response)
 *     END_STREAM   — bidireccional: fin de datos del stream
 *     RESPONSE     — técnico → broker → agente: cabeceras + status de la respuesta HTTP
 *     ERROR        — cualquier dirección: error de stream o de protocolo
 *     PING / PONG  — control de keep-alive del túnel (independiente del heartbeat WS)
 *
 *   streamId: número entero positivo, único por conexión del agente.
 *   Un streamId puede reutilizarse solo cuando el stream anterior ha terminado (END_STREAM).
 *
 * Módulo sin I/O → testeable sin BD.
 */

// ---------------------------------------------------------------------------
// Tipos de trama
// ---------------------------------------------------------------------------

export type BrokerFrameType =
  | 'OPEN_STREAM'
  | 'DATA'
  | 'END_STREAM'
  | 'RESPONSE'
  | 'ERROR'
  | 'PING'
  | 'PONG';

// ---------------------------------------------------------------------------
// Estructuras de trama (agente → técnico)
// ---------------------------------------------------------------------------

/** Agente abre un stream HTTP hacia el targetHost. */
export interface OpenStreamFrame {
  type: 'OPEN_STREAM';
  streamId: number;
  method: string;      // GET | POST | PUT | DELETE | HEAD | OPTIONS
  path: string;        // Ruta en el panel del router (ej. "/login")
  headers: Record<string, string>; // Cabeceras HTTP a enviar al router
  // targetHost NO se incluye aquí: lo determina el broker desde el token registrado
  // para evitar que el agente cambie el destino a mitad de sesión.
}

/** Fragmento de body (request o response). base64 para binario. */
export interface DataFrame {
  type: 'DATA';
  streamId: number;
  data: string;        // base64-encoded chunk
}

/** Fin de datos en un stream (request enviado o response finalizada). */
export interface EndStreamFrame {
  type: 'END_STREAM';
  streamId: number;
}

/** Técnico responde con el status y headers HTTP del router. */
export interface ResponseFrame {
  type: 'RESPONSE';
  streamId: number;
  status: number;      // HTTP status code (ej. 200)
  headers: Record<string, string>;
}

/** Error en un stream o en el protocolo. */
export interface ErrorFrame {
  type: 'ERROR';
  streamId: number | null; // null = error de protocolo (no de stream específico)
  code: string;
  message: string;
}

/** Keep-alive del túnel (broker → técnico). */
export interface PingFrame {
  type: 'PING';
  at: number; // epoch ms
}

/** Respuesta a PING (técnico → broker). */
export interface PongFrame {
  type: 'PONG';
  at: number;
}

export type BrokerFrame =
  | OpenStreamFrame
  | DataFrame
  | EndStreamFrame
  | ResponseFrame
  | ErrorFrame
  | PingFrame
  | PongFrame;

// ---------------------------------------------------------------------------
// Serialización / deserialización
// ---------------------------------------------------------------------------

/** Serializa una trama a string JSON para enviar por WebSocket. */
export function serializeFrame(frame: BrokerFrame): string {
  return JSON.stringify(frame);
}

/** Tipo de error de parseo de trama. */
export interface FrameParseError {
  ok: false;
  reason: string;
}

export type ParseFrameResult = { ok: true; frame: BrokerFrame } | FrameParseError;

/**
 * Parsea una trama recibida por WebSocket.
 * Valida que tenga al menos los campos obligatorios según su tipo.
 * No lanza; devuelve ok=false con reason si hay error.
 */
export function parseFrame(raw: string): ParseFrameResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'JSON inválido.' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'La trama debe ser un objeto JSON.' };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['type'] !== 'string') {
    return { ok: false, reason: 'Falta el campo "type" en la trama.' };
  }

  const type = obj['type'] as string;

  switch (type) {
    case 'OPEN_STREAM': {
      if (typeof obj['streamId'] !== 'number') {
        return { ok: false, reason: 'OPEN_STREAM requiere streamId (number).' };
      }
      if (typeof obj['method'] !== 'string') {
        return { ok: false, reason: 'OPEN_STREAM requiere method (string).' };
      }
      if (typeof obj['path'] !== 'string') {
        return { ok: false, reason: 'OPEN_STREAM requiere path (string).' };
      }

      // Validar method contra la allowlist de verbos HTTP
      if (!isAllowedMethod(obj['method'] as string)) {
        return {
          ok: false,
          reason: `Método HTTP no permitido en OPEN_STREAM: "${obj['method'] as string}". Verbos permitidos: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS.`,
        };
      }

      // Validar path: debe empezar por '/', longitud máx. 2048, sin \r\n\0
      const pathError = validateStreamPath(obj['path'] as string);
      if (pathError !== null) {
        return { ok: false, reason: pathError };
      }

      const headers = typeof obj['headers'] === 'object' && obj['headers'] !== null
        ? (obj['headers'] as Record<string, string>)
        : {};
      return {
        ok: true,
        frame: {
          type: 'OPEN_STREAM',
          streamId: obj['streamId'] as number,
          method: (obj['method'] as string).toUpperCase(),
          path: obj['path'] as string,
          headers,
        },
      };
    }

    case 'DATA': {
      if (typeof obj['streamId'] !== 'number') {
        return { ok: false, reason: 'DATA requiere streamId (number).' };
      }
      if (typeof obj['data'] !== 'string') {
        return { ok: false, reason: 'DATA requiere data (string base64).' };
      }
      return {
        ok: true,
        frame: { type: 'DATA', streamId: obj['streamId'] as number, data: obj['data'] as string },
      };
    }

    case 'END_STREAM': {
      if (typeof obj['streamId'] !== 'number') {
        return { ok: false, reason: 'END_STREAM requiere streamId (number).' };
      }
      return { ok: true, frame: { type: 'END_STREAM', streamId: obj['streamId'] as number } };
    }

    case 'RESPONSE': {
      if (typeof obj['streamId'] !== 'number') {
        return { ok: false, reason: 'RESPONSE requiere streamId (number).' };
      }
      if (typeof obj['status'] !== 'number') {
        return { ok: false, reason: 'RESPONSE requiere status (number).' };
      }
      const headers = typeof obj['headers'] === 'object' && obj['headers'] !== null
        ? (obj['headers'] as Record<string, string>)
        : {};
      return {
        ok: true,
        frame: {
          type: 'RESPONSE',
          streamId: obj['streamId'] as number,
          status: obj['status'] as number,
          headers,
        },
      };
    }

    case 'ERROR': {
      const streamId =
        typeof obj['streamId'] === 'number' ? (obj['streamId'] as number) : null;
      return {
        ok: true,
        frame: {
          type: 'ERROR',
          streamId,
          code: typeof obj['code'] === 'string' ? (obj['code'] as string) : 'UNKNOWN',
          message: typeof obj['message'] === 'string' ? (obj['message'] as string) : '',
        },
      };
    }

    case 'PING': {
      return {
        ok: true,
        frame: {
          type: 'PING',
          at: typeof obj['at'] === 'number' ? (obj['at'] as number) : Date.now(),
        },
      };
    }

    case 'PONG': {
      return {
        ok: true,
        frame: {
          type: 'PONG',
          at: typeof obj['at'] === 'number' ? (obj['at'] as number) : Date.now(),
        },
      };
    }

    default:
      return { ok: false, reason: `Tipo de trama desconocido: ${type}.` };
  }
}

// ---------------------------------------------------------------------------
// Helpers de construcción de tramas
// ---------------------------------------------------------------------------

export function makeErrorFrame(streamId: number | null, code: string, message: string): ErrorFrame {
  return { type: 'ERROR', streamId, code, message };
}

export function makePingFrame(): PingFrame {
  return { type: 'PING', at: Date.now() };
}

export function makePongFrame(pingAt: number): PongFrame {
  return { type: 'PONG', at: pingAt };
}

// ---------------------------------------------------------------------------
// Validación de métodos HTTP permitidos
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH']);

export function isAllowedMethod(method: string): boolean {
  return ALLOWED_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------
// Validación de path del OPEN_STREAM (A-4)
// ---------------------------------------------------------------------------

const PATH_MAX_LENGTH = 2048;
// Caracteres de control que permiten inyección de cabeceras HTTP o log injection
const PATH_FORBIDDEN_RE = /[\r\n\0]/;

/**
 * Valida el campo `path` de una trama OPEN_STREAM.
 * Reglas:
 *   - Debe comenzar por '/'
 *   - Longitud máxima PATH_MAX_LENGTH (2048)
 *   - No debe contener CR (\r), LF (\n) ni NUL (\0)
 *
 * @returns null si es válido; string con el motivo del error si no.
 */
export function validateStreamPath(path: string): string | null {
  if (!path.startsWith('/')) {
    return 'El path del stream debe comenzar por "/".';
  }
  if (path.length > PATH_MAX_LENGTH) {
    return `El path del stream excede la longitud máxima de ${PATH_MAX_LENGTH} caracteres.`;
  }
  if (PATH_FORBIDDEN_RE.test(path)) {
    return 'El path del stream contiene caracteres de control no permitidos (\\r, \\n, \\0).';
  }
  return null;
}
