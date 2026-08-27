// Cuidado del upstream: la operadora no pone tope de peticiones, pero pidió no
// consultar de más y todo va contra producción. Estas pruebas cubren las tres
// piezas que lo garantizan: dedupe, cache corto y semáforo de concurrencia.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cachedFetch,
  createLimiter,
  resetHttpCache,
} from '../../src/connectors/http/throttle.js';
import { digestFetch, resetDigestCache } from '../../src/connectors/http/digest.js';

const CREDS = { username: 'u', password: 'p' };

function challengeHeader(nonce: string): Headers {
  return new Headers({
    'www-authenticate': `Digest realm="tec.grupotvcable.com", qop="auth", nonce="${nonce}"`,
  });
}

describe('cachedFetch', () => {
  beforeEach(() => resetHttpCache());

  it('dedupe: dos consultas simultáneas del mismo equipo son una sola llamada', async () => {
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };
    const [a, b] = await Promise.all([
      cachedFetch('k', 1000, loader),
      cachedFetch('k', 1000, loader),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it('cachea el resultado durante el TTL y lo suelta al vencer', async () => {
    let calls = 0;
    const loader = async (): Promise<number> => ++calls;

    await cachedFetch('k', 50, loader);
    await cachedFetch('k', 50, loader);
    expect(calls).toBe(1);

    await new Promise((r) => setTimeout(r, 60));
    await cachedFetch('k', 50, loader);
    expect(calls).toBe(2);
  });

  it('no cachea errores: un fallo puntual no deja al técnico sin datos', async () => {
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('timeout');
      return 'ok';
    };
    await expect(cachedFetch('k', 1000, loader)).rejects.toThrow('timeout');
    await expect(cachedFetch('k', 1000, loader)).resolves.toBe('ok');
  });

  it('con TTL 0 no cachea', async () => {
    let calls = 0;
    const loader = async (): Promise<number> => ++calls;
    await cachedFetch('k', 0, loader);
    await cachedFetch('k', 0, loader);
    expect(calls).toBe(2);
  });
});

describe('createLimiter', () => {
  it('nunca deja más de `max` tareas en vuelo', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all(Array.from({ length: 8 }, () => limit(task)));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('libera el turno aunque la tarea falle', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(limit(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('digestFetch — rotación diaria del nonce', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    resetDigestCache();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Cabecera Authorization enviada en la llamada `i` de fetch. */
  const authOf = (i: number): string => {
    const init = fetchMock.mock.calls[i]?.[1] as { headers: Record<string, string> };
    return init.headers.Authorization ?? '';
  };

  it('negocia una vez y reutiliza el challenge en la siguiente petición', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401, headers: challengeHeader('dia1') }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await digestFetch('https://tec.example/api/a', CREDS);
    await digestFetch('https://tec.example/api/b', CREDS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authOf(2)).toContain('nonce="dia1"');
    // El contador nc avanza con el mismo nonce, como pide el RFC.
    expect(authOf(1)).toContain('nc=00000001');
    expect(authOf(2)).toContain('nc=00000002');
  });

  it('cuando el nonce rota, re-firma con el challenge del propio 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401, headers: challengeHeader('dia1') }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await digestFetch('https://tec.example/api/a', CREDS);
    fetchMock.mockReset();

    // Día siguiente: el nonce cacheado ya no vale.
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 401, headers: challengeHeader('dia2') }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const res = await digestFetch('https://tec.example/api/a', CREDS);

    expect(res.status).toBe(200);
    // Dos vueltas, no tres: el 401 ya traía el challenge nuevo.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(0)).toContain('nonce="dia1"');
    expect(authOf(1)).toContain('nonce="dia2"');
  });

  it('varias peticiones en frío comparten una sola negociación', async () => {
    fetchMock.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
      if (!init.headers.Authorization) {
        await new Promise((r) => setTimeout(r, 5));
        return new Response('', { status: 401, headers: challengeHeader('dia1') });
      }
      return new Response('{}', { status: 200 });
    });

    await Promise.all([
      digestFetch('https://tec.example/api/a', CREDS),
      digestFetch('https://tec.example/api/b', CREDS),
      digestFetch('https://tec.example/api/c', CREDS),
    ]);

    // Un solo 401 de negociación + una petición firmada por cada consulta.
    const unauthenticated = fetchMock.mock.calls.filter(
      (c) => !(c[1] as { headers: Record<string, string> }).headers.Authorization,
    );
    expect(unauthenticated).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
