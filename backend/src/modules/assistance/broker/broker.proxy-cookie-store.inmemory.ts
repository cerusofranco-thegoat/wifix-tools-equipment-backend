/**
 * Implementación en memoria del ProxyCookieStore (instancia única).
 *
 * ADVERTENCIA DE DESPLIEGUE:
 *   Store en memoria de proceso. Solo válido para instancia única.
 *   En multi-instancia activar REDIS_URL para usar RedisProxyCookieStore.
 */

import { randomUUID } from 'node:crypto';
import type { ProxyCookieStore, ProxyCookieEntry } from './broker.proxy-cookie-store.interface.js';

const store = new Map<string, ProxyCookieEntry>();

export const inMemoryProxyCookieStore: ProxyCookieStore = {
  async issue(entry: Omit<ProxyCookieEntry, 'cookieValue'>): Promise<string> {
    const cookieValue = randomUUID();
    store.set(cookieValue, { ...entry, cookieValue });
    return cookieValue;
  },

  async lookup(cookieValue: string): Promise<ProxyCookieEntry | undefined> {
    const entry = store.get(cookieValue);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      store.delete(cookieValue);
      return undefined;
    }
    return entry;
  },

  async invalidate(cookieValue: string): Promise<void> {
    store.delete(cookieValue);
  },

  async invalidateBySession(remoteSessionId: string): Promise<void> {
    for (const [value, entry] of store.entries()) {
      if (entry.remoteSessionId === remoteSessionId) {
        store.delete(value);
      }
    }
  },

  async purge(): Promise<number> {
    const now = Date.now();
    let purged = 0;
    for (const [value, entry] of store.entries()) {
      if (now > entry.expiresAt) {
        store.delete(value);
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

  async peek(cookieValue: string): Promise<ProxyCookieEntry | undefined> {
    return store.get(cookieValue);
  },
};
