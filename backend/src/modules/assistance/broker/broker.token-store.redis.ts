/**
 * Implementación Redis del TokenStore — atómica cross-instancia.
 *
 * Esquema de claves:
 *   token:meta:<jti>   → Hash con los metadatos del token (BrokerTokenEntry).
 *                         TTL = ceil((expiresAt - now) / 1000) segundos.
 *   token:used:<jti>   → String "1". Creada SOLO con SET NX EX para garantizar
 *                         atomicidad (reserva de uso único). Si existe → ya reservado.
 *
 * Flujo de reserve (atómico):
 *   SET token:used:<jti> "1" NX EX <ttl>
 *     → "OK"  : reserva exitosa (primera vez).
 *     → null  : ya existía → ALREADY_USED o el token no fue registrado.
 *
 * El ttl de token:used se calcula desde expiresAt para que Redis expire la clave
 * automáticamente cuando el token ya no sea válido.
 *
 * release():
 *   En Redis no se puede "liberar" un SET NX de forma segura sin arriesgar una
 *   condición de carrera (otro proceso pudo haberlo seteado entre tanto). Por
 *   diseño, release() es un no-op en Redis: si un JWT con firma inválida llegó
 *   al broker, quemó la ventana atómica (SET NX), pero dado que la firma es
 *   inválida el token es inutilizable de todas formas. El token legítimo con ese
 *   jti nunca podrá conectar, lo cual es el comportamiento correcto.
 */

import type Redis from 'ioredis';
import type { TokenStore, BrokerTokenEntry, ConsumeResult } from './broker.token-store.interface.js';

const KEY_META = (jti: string): string => `token:meta:${jti}`;
const KEY_USED = (jti: string): string => `token:used:${jti}`;

function ttlSeconds(expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
}

function entryFromHash(hash: Record<string, string>): BrokerTokenEntry {
  return {
    jti: hash['jti'] ?? '',
    remoteSessionId: hash['remoteSessionId'] ?? '',
    sessionId: hash['sessionId'] ?? '',
    targetHost: hash['targetHost'] === '' ? null : (hash['targetHost'] ?? null),
    agentId: hash['agentId'] ?? '',
    expiresAt: Number(hash['expiresAt'] ?? 0),
    used: hash['used'] === '1',
  };
}

function entryToHash(entry: BrokerTokenEntry): Record<string, string> {
  return {
    jti: entry.jti,
    remoteSessionId: entry.remoteSessionId,
    sessionId: entry.sessionId,
    targetHost: entry.targetHost ?? '',
    agentId: entry.agentId,
    expiresAt: String(entry.expiresAt),
    used: entry.used ? '1' : '0',
  };
}

export function createRedisTokenStore(redis: Redis): TokenStore {
  return {
    async register(entry: BrokerTokenEntry): Promise<void> {
      const ttl = ttlSeconds(entry.expiresAt);
      const pipeline = redis.pipeline();
      pipeline.hset(KEY_META(entry.jti), entryToHash(entry));
      pipeline.expire(KEY_META(entry.jti), ttl);
      await pipeline.exec();
    },

    async reserve(jti: string): Promise<boolean> {
      // Verificar que los metadatos existen y que el token no ha expirado
      const meta = await redis.hgetall(KEY_META(jti));
      if (!meta || !meta['jti']) return false; // no registrado

      const expiresAt = Number(meta['expiresAt'] ?? 0);
      if (Date.now() > expiresAt) return false; // expirado

      const ttl = ttlSeconds(expiresAt);
      // SET EX <ttl> NX: atómico — solo el primer SET con NX tiene éxito (ioredis: EX antes de NX)
      const result = await redis.set(KEY_USED(jti), '1', 'EX', ttl, 'NX');
      if (result !== 'OK') return false; // ya reservado

      // Actualizar el flag used en los metadatos (best-effort, no crítico para atomicidad)
      await redis.hset(KEY_META(jti), 'used', '1');
      return true;
    },

    async release(_jti: string): Promise<void> {
      // No-op en Redis: ver comentario del módulo. El SET NX ya está persistido.
      // No se puede revertir de forma segura sin nueva ventana de carrera.
    },

    async consume(jti: string): Promise<ConsumeResult> {
      const meta = await redis.hgetall(KEY_META(jti));
      if (!meta || !meta['jti']) return { ok: false, reason: 'NOT_FOUND' };

      const entry = entryFromHash(meta);
      if (Date.now() > entry.expiresAt) return { ok: false, reason: 'EXPIRED' };

      const usedExists = await redis.exists(KEY_USED(jti));
      if (usedExists) return { ok: false, reason: 'ALREADY_USED' };

      const ttl = ttlSeconds(entry.expiresAt);
      const result = await redis.set(KEY_USED(jti), '1', 'EX', ttl, 'NX');
      if (result !== 'OK') return { ok: false, reason: 'ALREADY_USED' };

      await redis.hset(KEY_META(jti), 'used', '1');
      return { ok: true, entry: { ...entry, used: true } };
    },

    async peek(jti: string): Promise<BrokerTokenEntry | undefined> {
      const meta = await redis.hgetall(KEY_META(jti));
      if (!meta || !meta['jti']) return undefined;
      return entryFromHash(meta);
    },

    async revoke(jti: string): Promise<void> {
      await redis.del(KEY_META(jti), KEY_USED(jti));
    },

    async purge(): Promise<number> {
      // En Redis los TTL expiran automáticamente; purge es un no-op.
      return 0;
    },

    async clear(): Promise<void> {
      // Usar scan en lugar de KEYS para no bloquear Redis en producción.
      const patterns = ['token:meta:*', 'token:used:*'];
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
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'token:meta:*', 'COUNT', 100);
        cursor = nextCursor;
        count += keys.length;
      } while (cursor !== '0');
      return count;
    },
  };
}
