/**
 * Implementación Redis del ProxyCookieStore — atómica cross-instancia.
 *
 * Esquema de claves:
 *   proxycookie:<cookieValue>          → String JSON con ProxyCookieEntry.
 *                                        TTL = ceil((expiresAt - now) / 1000).
 *   proxysession:<remoteSessionId>     → Set de cookieValues asociados.
 *                                        Permite invalidateBySession eficiente.
 *                                        TTL refresca con cada issue (mismo TTL que la cookie).
 *
 * invalidateBySession:
 *   1. SMEMBERS proxysession:<remoteSessionId>
 *   2. DEL proxycookie:<cookieValue> para cada miembro
 *   3. DEL proxysession:<remoteSessionId>
 *
 * Las claves expiran automáticamente (EX), así que el índice
 * proxysession puede tener miembros "fantasma" si la cookie expiró antes de
 * que se llamara invalidateBySession — eso es correcto: si la cookie ya expiró,
 * el DEL sobre ella simplemente no afecta nada.
 */

import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { ProxyCookieStore, ProxyCookieEntry } from './broker.proxy-cookie-store.interface.js';

const KEY_COOKIE = (cookieValue: string): string => `proxycookie:${cookieValue}`;
const KEY_SESSION = (remoteSessionId: string): string => `proxysession:${remoteSessionId}`;

function ttlSeconds(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

export function createRedisProxyCookieStore(redis: Redis): ProxyCookieStore {
  return {
    async issue(entry: Omit<ProxyCookieEntry, 'cookieValue'>): Promise<string> {
      const cookieValue = randomUUID();
      const full: ProxyCookieEntry = { ...entry, cookieValue };
      const ttl = ttlSeconds(entry.expiresAt);

      const pipeline = redis.pipeline();
      pipeline.set(KEY_COOKIE(cookieValue), JSON.stringify(full), 'EX', ttl);
      // Índice remoteSessionId → cookieValues (para invalidateBySession)
      pipeline.sadd(KEY_SESSION(entry.remoteSessionId), cookieValue);
      pipeline.expire(KEY_SESSION(entry.remoteSessionId), ttl);
      await pipeline.exec();

      return cookieValue;
    },

    async lookup(cookieValue: string): Promise<ProxyCookieEntry | undefined> {
      const raw = await redis.get(KEY_COOKIE(cookieValue));
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as ProxyCookieEntry;
      // Comprobación extra aunque Redis ya debería haber expirado la clave
      if (Date.now() > entry.expiresAt) {
        await redis.del(KEY_COOKIE(cookieValue));
        return undefined;
      }
      return entry;
    },

    async invalidate(cookieValue: string): Promise<void> {
      await redis.del(KEY_COOKIE(cookieValue));
    },

    async invalidateBySession(remoteSessionId: string): Promise<void> {
      const sessionKey = KEY_SESSION(remoteSessionId);
      const cookieValues = await redis.smembers(sessionKey);
      if (cookieValues.length > 0) {
        const cookieKeys = cookieValues.map(KEY_COOKIE);
        await redis.del(...cookieKeys, sessionKey);
      } else {
        await redis.del(sessionKey);
      }
    },

    async purge(): Promise<number> {
      // En Redis los TTL expiran automáticamente; purge es un no-op.
      return 0;
    },

    async clear(): Promise<void> {
      const patterns = ['proxycookie:*', 'proxysession:*'];
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            await redis.del(...keys);
          }
        } while (cursor !== '0');
      }
    },

    async size(): Promise<number> {
      let count = 0;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'proxycookie:*', 'COUNT', 100);
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      return count;
    },

    async peek(cookieValue: string): Promise<ProxyCookieEntry | undefined> {
      const raw = await redis.get(KEY_COOKIE(cookieValue));
      if (!raw) return undefined;
      return JSON.parse(raw) as ProxyCookieEntry;
    },
  };
}
