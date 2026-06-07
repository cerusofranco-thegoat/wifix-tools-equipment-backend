/**
 * Factory del TokenStore.
 *
 * Si env.REDIS_URL está definida → RedisTokenStore (atómico, multi-instancia).
 * Si no está definida            → InMemoryTokenStore (default, instancia única).
 *
 * El store se inicializa una sola vez (singleton por proceso) al llamar
 * `getTokenStore()` por primera vez.
 */

import IORedis from 'ioredis';
import { env } from '../../../config/env.js';
import type { TokenStore } from './broker.token-store.interface.js';
import { inMemoryTokenStore } from './broker.token-store.inmemory.js';
import { createRedisTokenStore } from './broker.token-store.redis.js';

let _store: TokenStore | null = null;
let _redis: InstanceType<typeof IORedis> | null = null;

/**
 * Devuelve el store activo para este proceso.
 * - Sin REDIS_URL: InMemoryTokenStore (instancia única, síncrono).
 * - Con REDIS_URL: RedisTokenStore (multi-instancia, reserva atómica via SET NX EX).
 */
export function getTokenStore(): TokenStore {
  if (_store) return _store;

  if (env.REDIS_URL) {
    if (!_redis) {
      _redis = new IORedis(env.REDIS_URL);
    }
    _store = createRedisTokenStore(_redis);
  } else {
    _store = inMemoryTokenStore;
  }

  return _store;
}

/**
 * Reemplaza el store activo (solo para tests).
 * Permite inyectar un store mock o reiniciar el singleton entre tests.
 */
export function _overrideTokenStore(store: TokenStore): void {
  _store = store;
}

/** Reinicia el singleton (solo para tests). */
export function _resetTokenStore(): void {
  _store = null;
  _redis = null;
}
