/**
 * Tests del Pendiente #3 (CORS multi-origen) y Pendiente #5 (stores del broker).
 *
 * Estructura:
 *   1. CORS: parseo de CORS_ORIGIN como lista; retrocompatibilidad con un solo origen.
 *   2. InMemoryTokenStore: reserve/uso-único/invalidación/purga.
 *   3. InMemoryProxyCookieStore: issue/lookup/invalidateBySession/purga.
 *   4. RedisTokenStore (adaptador con mock/fake de ioredis): atomicidad SET NX.
 *   5. RedisProxyCookieStore (adaptador con mock/fake de ioredis): invalidateBySession via índice.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. CORS — parseo de lista de orígenes
// ---------------------------------------------------------------------------

/**
 * El parseo de CORS_ORIGIN se realiza en env.ts mediante una transformación Zod.
 * Aquí replicamos la misma lógica para verificar retrocompatibilidad y multi-origen.
 */
function parseCorsOrigin(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('CORS — parseo de CORS_ORIGIN (lógica de env.ts)', () => {
  it('un solo origen → array de un elemento', () => {
    const result = parseCorsOrigin('http://localhost:5173');
    expect(result).toEqual(['http://localhost:5173']);
  });

  it('dos orígenes separados por coma → array de dos elementos', () => {
    const result = parseCorsOrigin('http://localhost:5173,https://callcenter.wifix.app');
    expect(result).toEqual(['http://localhost:5173', 'https://callcenter.wifix.app']);
  });

  it('orígenes con espacios alrededor de la coma → se recortan', () => {
    const result = parseCorsOrigin('http://localhost:5173 , https://callcenter.wifix.app , https://app.wifix.com');
    expect(result).toEqual([
      'http://localhost:5173',
      'https://callcenter.wifix.app',
      'https://app.wifix.com',
    ]);
  });

  it('coma al final → no genera elemento vacío', () => {
    const result = parseCorsOrigin('http://localhost:5173,');
    expect(result).toEqual(['http://localhost:5173']);
  });

  it('valor especial "*" → array con "*" (comportamiento wildcard)', () => {
    const result = parseCorsOrigin('*');
    expect(result).toEqual(['*']);
  });

  it('lista con tres orígenes de producción → array correcto', () => {
    const raw = 'https://app.wifix.com,https://callcenter.wifix.app,https://portal.wifix.internal';
    const result = parseCorsOrigin(raw);
    expect(result).toHaveLength(3);
    expect(result).toContain('https://callcenter.wifix.app');
  });
});

// ---------------------------------------------------------------------------
// 2. InMemoryTokenStore — reserva/uso-único/invalidación/purga
// ---------------------------------------------------------------------------

import { inMemoryTokenStore } from '../../src/modules/assistance/broker/broker.token-store.inmemory.js';
import type { BrokerTokenEntry } from '../../src/modules/assistance/broker/broker.token-store.interface.js';

function makeEntry(overrides: Partial<BrokerTokenEntry> = {}): BrokerTokenEntry {
  return {
    jti: `jti-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    remoteSessionId: 'rs-store-test',
    sessionId: 'sess-store-test',
    targetHost: '192.168.1.1',
    agentId: 'agent-store-test',
    expiresAt: Date.now() + 600_000,
    used: false,
    ...overrides,
  };
}

describe('InMemoryTokenStore — reserva atómica y uso único', () => {
  beforeEach(async () => {
    await inMemoryTokenStore.clear();
  });

  afterEach(async () => {
    await inMemoryTokenStore.clear();
  });

  it('register + peek devuelve la entrada', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    const peeked = await inMemoryTokenStore.peek(entry.jti);
    expect(peeked).toBeDefined();
    expect(peeked?.jti).toBe(entry.jti);
  });

  it('reserve: primer llamador obtiene true', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    expect(await inMemoryTokenStore.reserve(entry.jti)).toBe(true);
  });

  it('reserve: segundo llamador obtiene false (ya reservado — uso único)', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    await inMemoryTokenStore.reserve(entry.jti);
    expect(await inMemoryTokenStore.reserve(entry.jti)).toBe(false);
  });

  it('reserve: jti inexistente → false', async () => {
    expect(await inMemoryTokenStore.reserve('no-existe')).toBe(false);
  });

  it('release: libera la reserva (permite una nueva reserva)', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    await inMemoryTokenStore.reserve(entry.jti);
    await inMemoryTokenStore.release(entry.jti);
    expect(await inMemoryTokenStore.reserve(entry.jti)).toBe(true);
  });

  it('consume: primer consumo exitoso', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    const result = await inMemoryTokenStore.consume(entry.jti);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.jti).toBe(entry.jti);
    }
  });

  it('consume: segundo consumo → ALREADY_USED', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    await inMemoryTokenStore.consume(entry.jti);
    const second = await inMemoryTokenStore.consume(entry.jti);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('ALREADY_USED');
    }
  });

  it('consume: token expirado → EXPIRED', async () => {
    const entry = makeEntry({ expiresAt: Date.now() - 1000 });
    await inMemoryTokenStore.register(entry);
    const result = await inMemoryTokenStore.consume(entry.jti);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('EXPIRED');
    }
  });

  it('consume: jti inexistente → NOT_FOUND', async () => {
    const result = await inMemoryTokenStore.consume('jti-ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('NOT_FOUND');
    }
  });

  it('revoke: elimina el token', async () => {
    const entry = makeEntry();
    await inMemoryTokenStore.register(entry);
    await inMemoryTokenStore.revoke(entry.jti);
    expect(await inMemoryTokenStore.peek(entry.jti)).toBeUndefined();
  });

  it('purge: elimina expirados y usados, deja válidos', async () => {
    const expired = makeEntry({ jti: 'jti-exp-p', expiresAt: Date.now() - 1000 });
    const used = makeEntry({ jti: 'jti-used-p', used: true });
    const valid = makeEntry({ jti: 'jti-valid-p' });
    await inMemoryTokenStore.register(expired);
    await inMemoryTokenStore.register(used);
    await inMemoryTokenStore.register(valid);

    const purged = await inMemoryTokenStore.purge();
    expect(purged).toBe(2);
    expect(await inMemoryTokenStore.peek(valid.jti)).toBeDefined();
    expect(await inMemoryTokenStore.peek(expired.jti)).toBeUndefined();
    expect(await inMemoryTokenStore.peek(used.jti)).toBeUndefined();
  });

  it('size: refleja el número de entradas actuales', async () => {
    expect(await inMemoryTokenStore.size()).toBe(0);
    await inMemoryTokenStore.register(makeEntry({ jti: 'a' }));
    await inMemoryTokenStore.register(makeEntry({ jti: 'b' }));
    expect(await inMemoryTokenStore.size()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. InMemoryProxyCookieStore — issue/lookup/invalidateBySession/purga
// ---------------------------------------------------------------------------

import { inMemoryProxyCookieStore } from '../../src/modules/assistance/broker/broker.proxy-cookie-store.inmemory.js';
import type { ProxyCookieEntry } from '../../src/modules/assistance/broker/broker.proxy-cookie-store.interface.js';

function makeCookieEntry(overrides: Partial<Omit<ProxyCookieEntry, 'cookieValue'>> = {}): Omit<ProxyCookieEntry, 'cookieValue'> {
  return {
    remoteSessionId: 'rs-cookie-test',
    sessionId: 'sess-cookie-test',
    agentId: 'agent-cookie-test',
    targetHost: '192.168.1.1',
    expiresAt: Date.now() + 600_000,
    ...overrides,
  };
}

describe('InMemoryProxyCookieStore — ciclo completo', () => {
  beforeEach(async () => {
    await inMemoryProxyCookieStore.clear();
  });

  afterEach(async () => {
    await inMemoryProxyCookieStore.clear();
  });

  it('issue: devuelve un UUID único', async () => {
    const v1 = await inMemoryProxyCookieStore.issue(makeCookieEntry());
    const v2 = await inMemoryProxyCookieStore.issue(makeCookieEntry({ remoteSessionId: 'rs-2' }));
    expect(typeof v1).toBe('string');
    expect(v1).toMatch(/^[0-9a-f-]{36}$/i);
    expect(v1).not.toBe(v2);
  });

  it('lookup: devuelve la entrada para cookie válida', async () => {
    const entry = makeCookieEntry({ targetHost: '10.0.0.99' });
    const cookieValue = await inMemoryProxyCookieStore.issue(entry);
    const found = await inMemoryProxyCookieStore.lookup(cookieValue);
    expect(found).toBeDefined();
    expect(found?.targetHost).toBe('10.0.0.99');
    expect(found?.cookieValue).toBe(cookieValue);
  });

  it('lookup: devuelve undefined para cookie inexistente', async () => {
    expect(await inMemoryProxyCookieStore.lookup('no-existe')).toBeUndefined();
  });

  it('lookup: devuelve undefined y purga la cookie expirada', async () => {
    const cookieValue = await inMemoryProxyCookieStore.issue(makeCookieEntry({ expiresAt: Date.now() - 1 }));
    expect(await inMemoryProxyCookieStore.size()).toBe(1);
    expect(await inMemoryProxyCookieStore.lookup(cookieValue)).toBeUndefined();
    expect(await inMemoryProxyCookieStore.size()).toBe(0);
  });

  it('invalidate: elimina una cookie por su valor', async () => {
    const cookieValue = await inMemoryProxyCookieStore.issue(makeCookieEntry());
    await inMemoryProxyCookieStore.invalidate(cookieValue);
    expect(await inMemoryProxyCookieStore.peek(cookieValue)).toBeUndefined();
  });

  it('invalidateBySession: elimina todas las cookies de esa RemoteSession', async () => {
    const v1 = await inMemoryProxyCookieStore.issue(makeCookieEntry({ remoteSessionId: 'rs-target' }));
    const v2 = await inMemoryProxyCookieStore.issue(makeCookieEntry({ remoteSessionId: 'rs-other' }));
    await inMemoryProxyCookieStore.invalidateBySession('rs-target');
    expect(await inMemoryProxyCookieStore.peek(v1)).toBeUndefined();
    expect(await inMemoryProxyCookieStore.peek(v2)).toBeDefined(); // no afectada
  });

  it('purge: elimina solo las expiradas', async () => {
    await inMemoryProxyCookieStore.issue(makeCookieEntry({ remoteSessionId: 'rs-fresh' }));
    await inMemoryProxyCookieStore.issue(makeCookieEntry({ remoteSessionId: 'rs-stale', expiresAt: Date.now() - 1 }));
    expect(await inMemoryProxyCookieStore.size()).toBe(2);
    const purged = await inMemoryProxyCookieStore.purge();
    expect(purged).toBe(1);
    expect(await inMemoryProxyCookieStore.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. RedisTokenStore — atomicidad SET NX (fake de ioredis)
//
// Usamos un fake en memoria que simula exactamente la semántica de
// Redis SET NX EX: la clave solo se escribe si no existe.
// ---------------------------------------------------------------------------

import { createRedisTokenStore } from '../../src/modules/assistance/broker/broker.token-store.redis.js';
import type Redis from 'ioredis';

/**
 * Fake de ioredis mínimo para probar la atomicidad SET NX EX.
 * Implementa solo los comandos que usa createRedisTokenStore.
 */
function createFakeRedis(): Redis {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const hashes = new Map<string, Map<string, string>>();

  function isExpired(key: string): boolean {
    const entry = store.get(key);
    if (!entry) return false;
    return Date.now() > entry.expiresAt;
  }

  function safeGet(key: string): string | null {
    const entry = store.get(key);
    if (!entry) return null;
    if (isExpired(key)) {
      store.delete(key);
      return null;
    }
    return entry.value;
  }

  const fake = {
    // SET key value EX seconds NX
    set: async (key: string, value: string, ...args: (string | number)[]): Promise<'OK' | null> => {
      const exIdx = (args as string[]).indexOf('EX');
      const nxIdx = (args as string[]).indexOf('NX');
      const ttl = exIdx !== -1 ? Number(args[exIdx + 1]) : 0;
      const nx = nxIdx !== -1;
      const expiresAt = ttl > 0 ? Date.now() + ttl * 1000 : Date.now() + 86400_000;

      if (nx) {
        // SET NX: solo escribe si no existe (o si ya expiró)
        if (safeGet(key) !== null) return null; // ya existe
      }
      store.set(key, { value: String(value), expiresAt });
      return 'OK';
    },
    // HSET key field value [field value ...]
    hset: async (key: string, ...args: (string | number)[]): Promise<number> => {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      // args puede ser un objeto o pares field/value
      if (typeof args[0] === 'object' && args[0] !== null && !Array.isArray(args[0])) {
        // hset(key, { field: value, ... })
        const obj = args[0] as Record<string, string>;
        for (const [f, v] of Object.entries(obj)) {
          hash.set(f, String(v));
        }
        return Object.keys(obj).length;
      }
      let count = 0;
      for (let i = 0; i < args.length; i += 2) {
        hash.set(String(args[i]), String(args[i + 1]));
        count++;
      }
      return count;
    },
    // HGETALL key
    hgetall: async (key: string): Promise<Record<string, string>> => {
      const hash = hashes.get(key);
      if (!hash) return {};
      const result: Record<string, string> = {};
      for (const [k, v] of hash.entries()) {
        result[k] = v;
      }
      return result;
    },
    // EXPIRE key seconds
    expire: async (_key: string, _seconds: number): Promise<number> => 1,
    // EXISTS key
    exists: async (key: string): Promise<number> => {
      return safeGet(key) !== null ? 1 : 0;
    },
    // DEL key [key ...]
    del: async (...keys: string[]): Promise<number> => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key) || hashes.delete(key)) deleted++;
      }
      return deleted;
    },
    // SCAN cursor MATCH pattern COUNT count
    scan: async (_cursor: string, ..._args: string[]): Promise<[string, string[]]> => {
      return ['0', []];
    },
    // pipeline (stub — no usado en los tests de atomicidad)
    pipeline: () => {
      const ops: Array<() => Promise<unknown>> = [];
      const pipe = {
        hset: (...args: Parameters<typeof fake.hset>) => { ops.push(() => fake.hset(...args)); return pipe; },
        expire: (...args: Parameters<typeof fake.expire>) => { ops.push(() => fake.expire(...args)); return pipe; },
        set: (...args: Parameters<typeof fake.set>) => { ops.push(() => fake.set(...args)); return pipe; },
        exec: async () => {
          const results = [];
          for (const op of ops) {
            results.push([null, await op()]);
          }
          return results;
        },
      };
      return pipe;
    },
  } as unknown as Redis;

  return fake;
}

describe('RedisTokenStore — atomicidad SET NX EX (fake ioredis)', () => {
  it('reserve: primer llamador → true; segundo → false (SET NX atómico)', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    const entry = makeEntry();
    await store.register(entry);

    const first = await store.reserve(entry.jti);
    const second = await store.reserve(entry.jti);

    expect(first).toBe(true);
    expect(second).toBe(false); // SET NX devuelve null la segunda vez
  });

  it('reserve: jti no registrado → false', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    expect(await store.reserve('jti-fantasma')).toBe(false);
  });

  it('reserve: token expirado (expiresAt en el pasado) → false', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    const entry = makeEntry({ expiresAt: Date.now() - 1000 });
    await store.register(entry);
    expect(await store.reserve(entry.jti)).toBe(false);
  });

  it('consume: primer consumo → ok=true; segundo → ALREADY_USED', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    const entry = makeEntry();
    await store.register(entry);

    const first = await store.consume(entry.jti);
    expect(first.ok).toBe(true);

    const second = await store.consume(entry.jti);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('ALREADY_USED');
    }
  });

  it('revoke: elimina el token', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    const entry = makeEntry();
    await store.register(entry);
    await store.revoke(entry.jti);
    expect(await store.peek(entry.jti)).toBeUndefined();
  });

  it('release: es un no-op en Redis (no lanza, no libera la reserva)', async () => {
    const redis = createFakeRedis();
    const store = createRedisTokenStore(redis);
    const entry = makeEntry();
    await store.register(entry);
    await store.reserve(entry.jti);
    // release es no-op en Redis — la reserva sigue activa
    await store.release(entry.jti);
    // El token sigue reservado (SET NX persiste en Redis)
    const secondReserve = await store.reserve(entry.jti);
    expect(secondReserve).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. RedisProxyCookieStore — invalidateBySession via índice (fake ioredis)
// ---------------------------------------------------------------------------

import { createRedisProxyCookieStore } from '../../src/modules/assistance/broker/broker.proxy-cookie-store.redis.js';

function createFakeRedisForCookies(): Redis {
  const strings = new Map<string, { value: string; expiresAt: number }>();
  const sets = new Map<string, Set<string>>();
  const setExpiry = new Map<string, number>();

  function strGet(key: string): string | null {
    const entry = strings.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      strings.delete(key);
      return null;
    }
    return entry.value;
  }

  const fake = {
    set: async (key: string, value: string, _exToken: string, ttl: number): Promise<'OK'> => {
      strings.set(key, { value: String(value), expiresAt: Date.now() + Number(ttl) * 1000 });
      return 'OK';
    },
    get: async (key: string): Promise<string | null> => strGet(key),
    del: async (...keys: string[]): Promise<number> => {
      let n = 0;
      for (const k of keys.flat()) {
        if (strings.delete(k) || sets.delete(k)) n++;
      }
      return n;
    },
    sadd: async (key: string, ...members: string[]): Promise<number> => {
      if (!sets.has(key)) sets.set(key, new Set());
      const s = sets.get(key)!;
      let added = 0;
      for (const m of members) {
        if (!s.has(m)) { s.add(m); added++; }
      }
      return added;
    },
    smembers: async (key: string): Promise<string[]> => {
      const expiry = setExpiry.get(key);
      if (expiry && Date.now() > expiry) {
        sets.delete(key);
        return [];
      }
      return Array.from(sets.get(key) ?? []);
    },
    expire: async (key: string, seconds: number): Promise<number> => {
      setExpiry.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    scan: async (_cursor: string, ..._args: string[]): Promise<[string, string[]]> => ['0', []],
    pipeline: () => {
      const ops: Array<() => Promise<unknown>> = [];
      const pipe = {
        set: (...args: Parameters<typeof fake.set>) => { ops.push(() => (fake.set as (...a: Parameters<typeof fake.set>) => Promise<'OK'>)(...args)); return pipe; },
        sadd: (...args: Parameters<typeof fake.sadd>) => { ops.push(() => fake.sadd(...args)); return pipe; },
        expire: (...args: Parameters<typeof fake.expire>) => { ops.push(() => fake.expire(...args)); return pipe; },
        exec: async () => {
          const results = [];
          for (const op of ops) {
            results.push([null, await op()]);
          }
          return results;
        },
      };
      return pipe;
    },
  } as unknown as Redis;

  return fake;
}

describe('RedisProxyCookieStore — invalidateBySession via índice (fake ioredis)', () => {
  it('issue: devuelve un UUID y almacena en el índice por sesión', async () => {
    const redis = createFakeRedisForCookies();
    const store = createRedisProxyCookieStore(redis);
    const cookieValue = await store.issue(makeCookieEntry({ remoteSessionId: 'rs-redis-1' }));
    expect(typeof cookieValue).toBe('string');
    expect(cookieValue).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('lookup: devuelve la entrada para cookie válida', async () => {
    const redis = createFakeRedisForCookies();
    const store = createRedisProxyCookieStore(redis);
    const entry = makeCookieEntry({ targetHost: '10.0.0.1', remoteSessionId: 'rs-r2' });
    const cookieValue = await store.issue(entry);
    const found = await store.lookup(cookieValue);
    expect(found?.targetHost).toBe('10.0.0.1');
    expect(found?.remoteSessionId).toBe('rs-r2');
  });

  it('lookup: devuelve undefined para cookie inexistente', async () => {
    const redis = createFakeRedisForCookies();
    const store = createRedisProxyCookieStore(redis);
    expect(await store.lookup('no-existe')).toBeUndefined();
  });

  it('invalidateBySession: elimina cookie y limpia el índice', async () => {
    const redis = createFakeRedisForCookies();
    const store = createRedisProxyCookieStore(redis);
    const v1 = await store.issue(makeCookieEntry({ remoteSessionId: 'rs-inv-r' }));
    const v2 = await store.issue(makeCookieEntry({ remoteSessionId: 'rs-other-r' }));
    await store.invalidateBySession('rs-inv-r');
    expect(await store.lookup(v1)).toBeUndefined();
    expect(await store.lookup(v2)).toBeDefined(); // no afectada
  });

  it('invalidate: elimina una cookie por su valor', async () => {
    const redis = createFakeRedisForCookies();
    const store = createRedisProxyCookieStore(redis);
    const cookieValue = await store.issue(makeCookieEntry({ remoteSessionId: 'rs-inv-single' }));
    await store.invalidate(cookieValue);
    expect(await store.lookup(cookieValue)).toBeUndefined();
  });
});
