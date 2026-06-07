/**
 * Auditoría de requests del agente por el túnel del broker.
 *
 * Registra cada request HTTP proxeado como un AssistanceEvent de tipo REMOTE_SESSION.
 * No registra cookies ni credenciales en claro (se redactan antes de persistir).
 *
 * El módulo no tiene I/O propio; recibe la función de persistencia como argumento
 * para poder ser testeado sin BD.
 */

import pino from 'pino';

const moduleLogger = pino({ name: 'broker.audit' });

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

export interface TunnelRequestAuditData {
  sessionId: string;
  remoteSessionId: string;
  agentId: string;
  method: string;
  path: string;
  /** Solo host:puerto, sin IP completa si está bloqueada. */
  targetHostLabel: string;
  responseStatus: number | null;
  durationMs: number;
  errorCode: string | null;
}

// ---------------------------------------------------------------------------
// Cabeceras que NUNCA se deben registrar (datos sensibles del router)
// ---------------------------------------------------------------------------

const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-auth-token',
  'www-authenticate',
  'proxy-authorization',
]);

/**
 * Redacta cabeceras sensibles de un mapa de cabeceras.
 * Devuelve un nuevo objeto con "[REDACTED]" en los campos sensibles.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistencia de auditoría
// ---------------------------------------------------------------------------

export type AuditPersistFn = (data: TunnelRequestAuditData) => Promise<void>;

/**
 * Construye el payload de auditoría sin datos sensibles y lo pasa a la función
 * de persistencia proporcionada. Si la persistencia falla, el error se suprime
 * (la auditoría no debe bloquear el proxy).
 */
export async function auditTunnelRequest(
  data: TunnelRequestAuditData,
  persist: AuditPersistFn,
): Promise<void> {
  try {
    await persist(data);
  } catch (err) {
    // [BAJO-3] Loguear el error de auditoría en vez de suprimirlo silenciosamente.
    // La auditoría no debe interrumpir el flujo del proxy, pero el error no debe
    // desaparecer sin rastro — puede indicar problemas de BD o de configuración.
    moduleLogger.warn({ err }, 'Error al persistir evento de auditoría del proxy');
  }
}

/**
 * Construye el payload de evento para AssistanceEvent (tipo REMOTE_SESSION).
 * No incluye body ni cookies.
 */
export function buildAuditPayload(
  data: TunnelRequestAuditData,
): Record<string, unknown> {
  return {
    kind: 'tunnel_request',
    remoteSessionId: data.remoteSessionId,
    method: data.method,
    path: data.path,
    targetHostLabel: data.targetHostLabel,
    responseStatus: data.responseStatus,
    durationMs: data.durationMs,
    errorCode: data.errorCode,
  };
}
