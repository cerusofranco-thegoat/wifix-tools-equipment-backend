/**
 * Store en memoria para tokens de sesión remota de un solo uso.
 *
 * Cada token se consume exactamente una vez al conectar el agente al broker.
 * Tras el primer uso queda invalidado; las entradas expiradas se purgan periódicamente.
 *
 * Diseño:
 *   - Un Map<jti, BrokerTokenEntry> indexado por el JWT ID (jti), que es un UUID único
 *     generado al emitir el token.
 *   - El JWT firmado con jose (HS256, BROKER_TOKEN_SECRET) lleva el jti en su payload;
 *     el broker lo extrae tras verificar la firma y lo consume aquí.
 *   - "Consumir" = marcar used=true. Solo el primer consumo tiene éxito; los siguientes
 *     reciben false (token ya usado).
 *   - Las entradas expiradas se purgan pasado el TTL para evitar memory leaks.
 *
 * Módulo sin I/O → testeable sin BD.
 *
 * ADVERTENCIA DE DESPLIEGUE:
 *   Este store reside en memoria de proceso. Es válido ÚNICAMENTE para despliegues
 *   de instancia única (un solo proceso Node.js). En un despliegue multi-instancia
 *   (balanceo de carga, varios réplicas), la reserva de jti no es atómica entre
 *   procesos y el mecanismo de uso único deja de ser fiable.
 *   Para multi-instancia se requiere un store atómico externo, por ejemplo:
 *     Redis SET NX EX (SET jti "used" NX EX <ttlSegundos>)
 *   que garantiza la atomicidad a nivel de clúster.
 */

export interface BrokerTokenEntry {
  jti: string;
  remoteSessionId: string;
  sessionId: string;
  targetHost: string | null;
  agentId: string;
  expiresAt: number; // epoch ms
  used: boolean;
}

// Estado en memoria del store
const tokenStore = new Map<string, BrokerTokenEntry>();

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Registra un token recién emitido. Debe llamarse al crear la sesión remota. */
export function registerToken(entry: BrokerTokenEntry): void {
  tokenStore.set(entry.jti, entry);
}

// ---------------------------------------------------------------------------
// Consumo (uso único) — libre de condición TOCTOU
// ---------------------------------------------------------------------------

export type ConsumeResult =
  | { ok: true; entry: BrokerTokenEntry }
  | { ok: false; reason: 'NOT_FOUND' | 'ALREADY_USED' | 'EXPIRED' };

/**
 * Reserva el jti de forma síncrona y atómica (check-and-set en el Map).
 * Si la reserva tiene éxito devuelve true; si el token ya fue reservado o no
 * existe devuelve false. Debe llamarse ANTES de cualquier await en el flujo de
 * consumo para eliminar la ventana TOCTOU entre el check y el set.
 *
 * Uso interno: llamado por verifyAndConsumeToken en broker.session-token.ts.
 */
export function reserveToken(jti: string): boolean {
  const entry = tokenStore.get(jti);
  if (!entry) return false;
  if (entry.used) return false;
  // Check-and-set atómico (síncrono — sin await entre la comprobación y la escritura)
  entry.used = true;
  return true;
}

/**
 * Libera una reserva realizada por reserveToken en caso de que la verificación
 * posterior (firma JWT, expiración) haya fallado. Permite reintentar con un
 * token válido en lugar de dejarlo marcado como "usado" por error.
 */
export function releaseToken(jti: string): void {
  const entry = tokenStore.get(jti);
  if (entry) {
    entry.used = false;
  }
}

/**
 * Consume el token identificado por `jti`.
 * Si tiene éxito (ok=true), marca used=true y devuelve la entrada.
 * Solo el primer consumo tiene éxito; los siguientes devuelven ok=false.
 *
 * Para el flujo del broker que necesita eliminar la ventana TOCTOU frente a
 * conexiones concurrentes con el mismo token, usar reserveToken() antes del
 * await jwtVerify y releaseToken() si la verificación posterior falla.
 */
export function consumeToken(jti: string): ConsumeResult {
  const entry = tokenStore.get(jti);
  if (!entry) return { ok: false, reason: 'NOT_FOUND' };
  if (entry.used) return { ok: false, reason: 'ALREADY_USED' };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'EXPIRED' };
  entry.used = true;
  return { ok: true, entry };
}

// ---------------------------------------------------------------------------
// Inspección (para tests)
// ---------------------------------------------------------------------------

/** Devuelve la entrada sin consumirla (solo para tests/internos). */
export function peekToken(jti: string): BrokerTokenEntry | undefined {
  return tokenStore.get(jti);
}

/** Elimina un token del store (para limpiar tras cerrar la sesión remota). */
export function revokeToken(jti: string): void {
  tokenStore.delete(jti);
}

/** Tamaño actual del store (para tests). */
export function tokenStoreSize(): number {
  return tokenStore.size;
}

// ---------------------------------------------------------------------------
// Purga de entradas expiradas
// ---------------------------------------------------------------------------

/**
 * Elimina todas las entradas expiradas o ya usadas.
 * Llamar periódicamente para evitar memory leaks.
 */
export function purgeExpiredTokens(): number {
  const now = Date.now();
  let purged = 0;
  for (const [jti, entry] of tokenStore.entries()) {
    if (entry.used || now > entry.expiresAt) {
      tokenStore.delete(jti);
      purged++;
    }
  }
  return purged;
}

/** Limpia todo el store (solo para tests). */
export function clearTokenStore(): void {
  tokenStore.clear();
}
