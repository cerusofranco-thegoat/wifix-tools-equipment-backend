/**
 * API pública del store de cookies de proxy HTTP.
 *
 * Delega al store activo según la configuración de entorno:
 *   - Sin REDIS_URL: InMemoryProxyCookieStore (instancia única).
 *   - Con REDIS_URL: RedisProxyCookieStore (multi-instancia, TTL nativo de Redis).
 *
 * La cookie contiene un valor opaco (UUID aleatorio); NUNCA contiene el
 * sessionToken del broker. El agente no necesita ver el sessionToken para
 * navegar el panel del router a través del proxy HTTP.
 *
 * Módulo sin I/O propio → testeable sin BD.
 */

import { env } from '../../../config/env.js';
import { getProxyCookieStore } from './broker.proxy-cookie-store.factory.js';

export type { ProxyCookieEntry } from './broker.proxy-cookie-store.interface.js';

// ---------------------------------------------------------------------------
// Constantes de cookie (compartidas entre el store y el route handler)
// ---------------------------------------------------------------------------

/** Nombre de la cookie de sesión de proxy. */
export const PROXY_COOKIE_NAME = 'wifix_proxy_session';

/** Prefijo del path base del proxy en la API (sin remoteSessionId). */
export const PROXY_BASE_PATH = '/asistencia/v1/broker/proxy';

// ---------------------------------------------------------------------------
// Emisión
// ---------------------------------------------------------------------------

/**
 * Emite un valor de cookie opaco y lo registra en el store.
 * Devuelve el valor opaco para incluirlo en el Set-Cookie header.
 */
export async function issueProxyCookie(
  entry: Omit<import('./broker.proxy-cookie-store.interface.js').ProxyCookieEntry, 'cookieValue'>,
): Promise<string> {
  return getProxyCookieStore().issue(entry);
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * Busca la entrada de cookie de proxy por valor opaco.
 * Devuelve undefined si no existe o si ya expiró.
 */
export async function lookupProxyCookie(
  cookieValue: string,
): Promise<import('./broker.proxy-cookie-store.interface.js').ProxyCookieEntry | undefined> {
  return getProxyCookieStore().lookup(cookieValue);
}

// ---------------------------------------------------------------------------
// Invalidación
// ---------------------------------------------------------------------------

/**
 * Invalida la cookie de proxy asociada a una RemoteSession (por remoteSessionId).
 * Se llama al cerrar o expirar la RemoteSession.
 */
export async function invalidateProxyCookieBySession(remoteSessionId: string): Promise<void> {
  return getProxyCookieStore().invalidateBySession(remoteSessionId);
}

// ---------------------------------------------------------------------------
// Purga de entradas expiradas (safety net)
// ---------------------------------------------------------------------------

export async function purgeExpiredProxyCookies(): Promise<number> {
  return getProxyCookieStore().purge();
}

// ---------------------------------------------------------------------------
// Inspección (solo para tests)
// ---------------------------------------------------------------------------

export async function proxyCookieStoreSize(): Promise<number> {
  return getProxyCookieStore().size();
}

export async function clearProxyCookieStore(): Promise<void> {
  return getProxyCookieStore().clear();
}

export async function peekProxyCookie(
  cookieValue: string,
): Promise<import('./broker.proxy-cookie-store.interface.js').ProxyCookieEntry | undefined> {
  return getProxyCookieStore().peek(cookieValue);
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
