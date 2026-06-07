/**
 * Store en memoria de sesiones de cookie de proxy HTTP.
 *
 * Cuando el agente abre una sesión remota (POST /sessions/{id}/remote-sessions),
 * el servicio emite una cookie de sesión de proxy httpOnly acotada al path del
 * endpoint de proxy. Este store relaciona el valor opaco de la cookie con los
 * datos de la sesión (remoteSessionId, agentId, targetHost, expiresAt).
 *
 * La cookie contiene un valor opaco (UUID aleatorio); NUNCA contiene el
 * sessionToken del broker. El agente no necesita ver el sessionToken para
 * navegar el panel del router a través del proxy HTTP.
 *
 * Diseño en memoria (instancia única):
 *   - Map<cookieValue, ProxyCookieEntry> indexado por UUID opaco.
 *   - Las entradas se invalidan al cerrar o expirar la RemoteSession (activo)
 *     y en el barrido periódico por TTL (safety net).
 *   - No es apto para despliegues multi-instancia (mismo límite que broker.token-store.ts).
 *
 * Módulo sin I/O → testeable sin BD.
 *
 * ADVERTENCIA DE DESPLIEGUE:
 *   Store en memoria de proceso. Solo válido para instancia única.
 *   En multi-instancia sustituir por Redis con TTL nativo.
 */

import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env.js';

// ---------------------------------------------------------------------------
// Constantes de cookie (compartidas entre el store y el route handler)
// ---------------------------------------------------------------------------

/** Nombre de la cookie de sesión de proxy. */
export const PROXY_COOKIE_NAME = 'wifix_proxy_session';

/** Prefijo del path base del proxy en la API (sin remoteSessionId). */
export const PROXY_BASE_PATH = '/asistencia/v1/broker/proxy';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ProxyCookieEntry {
  /** Valor opaco de la cookie (UUID v4 aleatorio). */
  cookieValue: string;
  /** ID de la RemoteSession en BD. */
  remoteSessionId: string;
  /** ID de la AssistanceSession padre. */
  sessionId: string;
  /** ID del agente propietario. */
  agentId: string;
  /**
   * targetHost del CPE — INMUTABLE desde la apertura de la RemoteSession.
   * El agente nunca puede cambiarlo por URL ni por header.
   */
  targetHost: string;
  /** Expiración como epoch ms (igual que RemoteSession.expiresAt). */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const cookieStore = new Map<string, ProxyCookieEntry>();

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------

/**
 * Emite un valor de cookie opaco y lo registra en el store.
 * Devuelve el valor opaco para incluirlo en el Set-Cookie header.
 *
 * El cookieValue es un UUID v4 aleatorio — criptográficamente suficientemente
 * imprevisible para este caso de uso (128 bits de entropía).
 */
export function issueProxyCookie(
  entry: Omit<ProxyCookieEntry, 'cookieValue'>,
): string {
  const cookieValue = randomUUID();
  cookieStore.set(cookieValue, { ...entry, cookieValue });
  return cookieValue;
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * Busca la entrada de cookie de proxy por valor opaco.
 * Devuelve undefined si no existe o si ya expiró.
 * Las entradas expiradas se purgan pasivamente al consultarlas.
 */
export function lookupProxyCookie(cookieValue: string): ProxyCookieEntry | undefined {
  const entry = cookieStore.get(cookieValue);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cookieStore.delete(cookieValue);
    return undefined;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Invalidación
// ---------------------------------------------------------------------------

/**
 * Invalida la cookie de proxy asociada a una RemoteSession (por remoteSessionId).
 * Se llama al cerrar o expirar la RemoteSession para garantizar que la cookie
 * queda inútil aunque el navegador todavía la tenga almacenada.
 */
export function invalidateProxyCookieBySession(remoteSessionId: string): void {
  for (const [value, entry] of cookieStore.entries()) {
    if (entry.remoteSessionId === remoteSessionId) {
      cookieStore.delete(value);
    }
  }
}

// ---------------------------------------------------------------------------
// Purga de entradas expiradas (safety net)
// ---------------------------------------------------------------------------

/**
 * Elimina entradas expiradas del store.
 * Se puede llamar periódicamente como safety net.
 */
export function purgeExpiredProxyCookies(): number {
  const now = Date.now();
  let purged = 0;
  for (const [value, entry] of cookieStore.entries()) {
    if (now > entry.expiresAt) {
      cookieStore.delete(value);
      purged++;
    }
  }
  return purged;
}

// ---------------------------------------------------------------------------
// Inspección (solo para tests)
// ---------------------------------------------------------------------------

export function proxyCookieStoreSize(): number {
  return cookieStore.size;
}

export function clearProxyCookieStore(): void {
  cookieStore.clear();
}

export function peekProxyCookie(cookieValue: string): ProxyCookieEntry | undefined {
  return cookieStore.get(cookieValue);
}

// ---------------------------------------------------------------------------
// Construcción del Set-Cookie header de la cookie de proxy
// ---------------------------------------------------------------------------

/**
 * Construye el valor del Set-Cookie header para la cookie de sesión de proxy.
 *
 * Atributos de seguridad:
 *   - HttpOnly: el JS del portal no puede leer la cookie.
 *   - Secure: controlado por env.COOKIE_SECURE (default true).
 *     Establecer COOKIE_SECURE=false SOLO en desarrollo local sobre HTTP.
 *   - SameSite=Strict: no se envía en requests cross-site.
 *   - Path acotado al remoteSessionId: no contamina otros paths.
 *   - Expires: igual a la expiración de la RemoteSession.
 */
export function buildProxyCookieSetHeader(
  cookieValue: string,
  remoteSessionId: string,
  expiresAt: Date,
): string {
  const path = `${PROXY_BASE_PATH}/${remoteSessionId}`;
  const expires = expiresAt.toUTCString();
  // [MEDIO-2] Usar COOKIE_SECURE en vez de NODE_ENV para controlar Secure
  // en staging (que puede ser non-production pero debe usar HTTPS igualmente).
  const secureAttr = env.COOKIE_SECURE ? '; Secure' : '';
  return (
    `${PROXY_COOKIE_NAME}=${cookieValue}` +
    `; HttpOnly` +
    `${secureAttr}` +
    `; SameSite=Strict` +
    `; Path=${path}` +
    `; Expires=${expires}`
  );
}
