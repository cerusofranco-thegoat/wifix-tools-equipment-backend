/**
 * Motor de expiración de sesiones remotas del broker.
 *
 * Registra timers individuales por remoteSession. Cuando dispara:
 *   1. Marca la RemoteSession como EXPIRED en BD (vía callback).
 *   2. Cierra el socket del túnel del técnico asociado a la sesión.
 *   3. Purga el token del store.
 *   4. Emite un evento de auditoría.
 *
 * Se separan los callbacks para mantener el módulo testeable sin BD ni WS real.
 */

import { revokeToken } from './broker.token-store.js';
import { removeTunnel, getTunnel } from './broker.tunnel-store.js';
import { purgeExpiredTokens } from './broker.token-store.js';

// ---------------------------------------------------------------------------
// Tipos de callback
// ---------------------------------------------------------------------------

export interface ExpiryCallbacks {
  /** Cierra la sesión remota en BD con status=EXPIRED. */
  onExpire: (remoteSessionId: string, sessionId: string) => Promise<void>;
  /** Se llama justo antes de destruir el entry (para logs/auditoría). */
  onBeforeExpire?: (remoteSessionId: string, sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Registro de timers
// ---------------------------------------------------------------------------

interface ExpiryEntry {
  remoteSessionId: string;
  sessionId: string;
  jti: string;
  timer: ReturnType<typeof setTimeout>;
}

const expiryMap = new Map<string, ExpiryEntry>();

/**
 * Registra un timer de expiración para una sesión remota.
 * Si ya existía un timer para el mismo remoteSessionId, lo cancela primero.
 *
 * @param remoteSessionId  ID de la RemoteSession en BD.
 * @param sessionId        ID de la AssistanceSession padre.
 * @param jti              JTI del token emitido (para revocarlo al expirar).
 * @param expiresAt        Fecha de expiración (ms epoch).
 * @param callbacks        Funciones a llamar al expirar.
 */
export function scheduleExpiry(
  remoteSessionId: string,
  sessionId: string,
  jti: string,
  expiresAt: number,
  callbacks: ExpiryCallbacks,
): void {
  // Cancelar timer previo si existía
  cancelExpiry(remoteSessionId);

  const delay = Math.max(0, expiresAt - Date.now());

  const timer = setTimeout(() => {
    void runExpiry(remoteSessionId, sessionId, jti, callbacks);
  }, delay);

  // Permite que el proceso cierre sin esperar el timer
  if (typeof timer.unref === 'function') timer.unref();

  expiryMap.set(remoteSessionId, { remoteSessionId, sessionId, jti, timer });
}

/**
 * Cancela el timer de expiración de una sesión remota.
 * Llamar cuando la sesión se cierra manualmente antes de expirar.
 */
export function cancelExpiry(remoteSessionId: string): void {
  const entry = expiryMap.get(remoteSessionId);
  if (entry) {
    clearTimeout(entry.timer);
    expiryMap.delete(remoteSessionId);
  }
}

/**
 * Dispara manualmente la expiración de una sesión remota (para tests o cierre forzado).
 */
export async function triggerExpiry(
  remoteSessionId: string,
  callbacks: ExpiryCallbacks,
): Promise<void> {
  const entry = expiryMap.get(remoteSessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  expiryMap.delete(remoteSessionId);
  await runExpiry(entry.remoteSessionId, entry.sessionId, entry.jti, callbacks);
}

// ---------------------------------------------------------------------------
// Lógica de expiración
// ---------------------------------------------------------------------------

async function runExpiry(
  remoteSessionId: string,
  sessionId: string,
  jti: string,
  callbacks: ExpiryCallbacks,
): Promise<void> {
  expiryMap.delete(remoteSessionId);

  callbacks.onBeforeExpire?.(remoteSessionId, sessionId);

  // 1. Cerrar el túnel del técnico (si está activo)
  const tunnel = getTunnel(sessionId);
  if (tunnel) {
    try {
      tunnel.socket.close(1001, 'Sesión remota expirada.');
    } catch {
      // ignore
    }
    removeTunnel(sessionId);
  }

  // 2. Revocar el token
  await revokeToken(jti);

  // 3. Marcar como EXPIRED en BD (vía callback)
  try {
    await callbacks.onExpire(remoteSessionId, sessionId);
  } catch {
    // Si la BD falla, ya cerró el túnel — no bloquear
  }

  // 4. Purgar tokens expirados de paso
  await purgeExpiredTokens();
}

// ---------------------------------------------------------------------------
// Barrido global periódico (para tokens sin timer individual — safety net)
// ---------------------------------------------------------------------------

let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startExpirySweep(intervalMs = 60_000): void {
  if (sweepTimer) return; // ya iniciado
  sweepTimer = setInterval(() => {
    void purgeExpiredTokens();
  }, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

export function stopExpirySweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Inspección (para tests)
// ---------------------------------------------------------------------------

export function pendingExpiryCount(): number {
  return expiryMap.size;
}

export function clearAllExpiries(): void {
  for (const entry of expiryMap.values()) {
    clearTimeout(entry.timer);
  }
  expiryMap.clear();
}
