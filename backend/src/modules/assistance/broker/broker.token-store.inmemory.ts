/**
 * Implementación en memoria del TokenStore (instancia única).
 *
 * ADVERTENCIA DE DESPLIEGUE:
 *   Este store reside en memoria de proceso. Es válido ÚNICAMENTE para despliegues
 *   de instancia única (un solo proceso Node.js). En un despliegue multi-instancia
 *   (balanceo de carga, varias réplicas), la reserva de jti no es atómica entre
 *   procesos y el mecanismo de uso único deja de ser fiable.
 *   Activar REDIS_URL para obtener atomicidad cross-instancia via RedisTokenStore.
 *
 * La reserva síncrona dentro de la misma promesa elimina la ventana TOCTOU
 * en proceso único: no hay await entre el check y el set, por lo que dos
 * llamadas concurrentes (event-loop turn) llegan serializada.
 */

import type { TokenStore, BrokerTokenEntry, ConsumeResult } from './broker.token-store.interface.js';

const store = new Map<string, BrokerTokenEntry>();

export const inMemoryTokenStore: TokenStore = {
  async register(entry: BrokerTokenEntry): Promise<void> {
    store.set(entry.jti, entry);
  },

  async reserve(jti: string): Promise<boolean> {
    const entry = store.get(jti);
    if (!entry) return false;
    if (entry.used) return false;
    // Check-and-set atómico (síncrono — sin await entre comprobación y escritura)
    entry.used = true;
    return true;
  },

  async release(jti: string): Promise<void> {
    const entry = store.get(jti);
    if (entry) {
      entry.used = false;
    }
  },

  async consume(jti: string): Promise<ConsumeResult> {
    const entry = store.get(jti);
    if (!entry) return { ok: false, reason: 'NOT_FOUND' };
    if (entry.used) return { ok: false, reason: 'ALREADY_USED' };
    if (Date.now() > entry.expiresAt) return { ok: false, reason: 'EXPIRED' };
    entry.used = true;
    return { ok: true, entry };
  },

  async peek(jti: string): Promise<BrokerTokenEntry | undefined> {
    return store.get(jti);
  },

  async revoke(jti: string): Promise<void> {
    store.delete(jti);
  },

  async purge(): Promise<number> {
    const now = Date.now();
    let purged = 0;
    for (const [jti, entry] of store.entries()) {
      if (entry.used || now > entry.expiresAt) {
        store.delete(jti);
        purged++;
      }
    }
    return purged;
  },

  async clear(): Promise<void> {
    store.clear();
  },

  async size(): Promise<number> {
    return store.size;
  },
};
