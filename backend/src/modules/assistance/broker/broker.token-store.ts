/**
 * API pública del store de tokens de sesión remota de un solo uso.
 *
 * Delega al store activo según la configuración de entorno:
 *   - Sin REDIS_URL: InMemoryTokenStore (instancia única, reserva síncrona en Map).
 *   - Con REDIS_URL: RedisTokenStore (multi-instancia, reserva atómica via SET NX EX).
 *
 * Diseño del store:
 *   - El jti (JWT ID, UUID único) identifica cada token de un solo uso.
 *   - "Reservar" = marcar como usado atómicamente; solo el primer reservador tiene éxito.
 *   - Los callers async deben await cada operación; InMemory resuelve inmediatamente.
 *
 * ADVERTENCIA — túnel WebSocket:
 *   Este store (tokens + cookies) puede ir a Redis para atomicidad cross-instancia.
 *   El store del TÚNEL WS (broker.tunnel-store.ts) NO puede ir a Redis: los sockets
 *   viven en el proceso. En multi-instancia se requiere sticky routing en el balanceador.
 *   Ver ADR-0008 y el header de broker.tunnel-store.ts para la limitación detallada.
 *
 * Módulo sin I/O propio → testeable sin BD.
 */

export type { BrokerTokenEntry, ConsumeResult } from './broker.token-store.interface.js';
import { getTokenStore } from './broker.token-store.factory.js';

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Registra un token recién emitido. Debe llamarse al crear la sesión remota. */
export async function registerToken(
  entry: import('./broker.token-store.interface.js').BrokerTokenEntry,
): Promise<void> {
  return getTokenStore().register(entry);
}

// ---------------------------------------------------------------------------
// Consumo (uso único)
// ---------------------------------------------------------------------------

/**
 * Reserva el jti de forma atómica (uso único).
 * - InMemory: check-and-set síncrono (sin ventana TOCTOU en proceso único).
 * - Redis: SET NX EX — atómico cross-instancia.
 *
 * Devuelve true si la reserva tuvo éxito (primer uso).
 * Llamar ANTES de cualquier await en el flujo de consumo para eliminar TOCTOU.
 */
export async function reserveToken(jti: string): Promise<boolean> {
  return getTokenStore().reserve(jti);
}

/**
 * Libera una reserva realizada por reserveToken en caso de que la verificación
 * posterior (firma JWT) haya fallado.
 * En Redis es un no-op (ver broker.token-store.redis.ts).
 */
export async function releaseToken(jti: string): Promise<void> {
  return getTokenStore().release(jti);
}

/**
 * Consume el token identificado por `jti`.
 * Si tiene éxito (ok=true), marca used=true y devuelve la entrada.
 * Solo el primer consumo tiene éxito.
 */
export async function consumeToken(
  jti: string,
): Promise<import('./broker.token-store.interface.js').ConsumeResult> {
  return getTokenStore().consume(jti);
}

// ---------------------------------------------------------------------------
// Inspección (para tests)
// ---------------------------------------------------------------------------

/** Devuelve la entrada sin consumirla (solo para tests/internos). */
export async function peekToken(
  jti: string,
): Promise<import('./broker.token-store.interface.js').BrokerTokenEntry | undefined> {
  return getTokenStore().peek(jti);
}

/** Elimina un token del store (para limpiar tras cerrar la sesión remota). */
export async function revokeToken(jti: string): Promise<void> {
  return getTokenStore().revoke(jti);
}

/** Tamaño actual del store (para tests). */
export async function tokenStoreSize(): Promise<number> {
  return getTokenStore().size();
}

// ---------------------------------------------------------------------------
// Purga de entradas expiradas
// ---------------------------------------------------------------------------

/**
 * Elimina todas las entradas expiradas o ya usadas.
 * En Redis la expiración es automática (EX); purge es un no-op.
 */
export async function purgeExpiredTokens(): Promise<number> {
  return getTokenStore().purge();
}

/** Limpia todo el store (solo para tests). */
export async function clearTokenStore(): Promise<void> {
  return getTokenStore().clear();
}
