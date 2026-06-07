/**
 * Factory del ProxyCookieStore.
 *
 * Si env.REDIS_URL está definida → RedisProxyCookieStore (atómico, multi-instancia).
 * Si no está definida            → InMemoryProxyCookieStore (default, instancia única).
 *
 * Comparte el cliente Redis con el TokenStore factory si ambos están activos.
 * El store se inicializa como singleton por proceso.
 */

import IORedis from 'ioredis';
import { env } from '../../../config/env.js';
import type { ProxyCookieStore } from './broker.proxy-cookie-store.interface.js';
import { inMemoryProxyCookieStore } from './broker.proxy-cookie-store.inmemory.js';
import { createRedisProxyCookieStore } from './broker.proxy-cookie-store.redis.js';

let _store: ProxyCookieStore | null = null;
let _redis: InstanceType<typeof IORedis> | null = null;

/**
 * Devuelve el store activo para este proceso.
 * - Sin REDIS_URL: InMemoryProxyCookieStore (instancia única).
 * - Con REDIS_URL: RedisProxyCookieStore (multi-instancia, TTL nativo de Redis).
 */
export function getProxyCookieStore(): ProxyCookieStore {
  if (_store) return _store;

  if (env.REDIS_URL) {
    if (!_redis) {
      _redis = new IORedis(env.REDIS_URL);
    }
    _store = createRedisProxyCookieStore(_redis);
  } else {
    _store = inMemoryProxyCookieStore;
  }

  return _store;
}

/**
 * Reemplaza el store activo (solo para tests).
 */
export function _overrideProxyCookieStore(store: ProxyCookieStore): void {
  _store = store;
}

/** Reinicia el singleton (solo para tests). */
export function _resetProxyCookieStore(): void {
  _store = null;
  _redis = null;
}
