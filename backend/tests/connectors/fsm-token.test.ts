// Resolución del Bearer de FSM: prioridad de modos, chequeo previo sin red,
// single-flight y ausencia total de tokens en los logs.
//
// Ningún test sale a la red: `fetch` está reemplazado por un doble.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decodeJwtExp,
  decodeJwtClaims,
  fsmTokenStatus,
  getFsmAccessToken,
  invalidateFsmToken,
  markFsmTokenRejected,
  parseGeneratedToken,
  resetFsmTokenCache,
  resolveBrand,
} from '../../src/connectors/http/fsm-token.js';
import { env } from '../../src/config/env.js';
import { ApiError } from '../../src/middleware/error-handler.js';
import { expiredJwt, futureJwt, installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';

const TOKEN_VARS = [
  'FSM_API_TOKEN_TELENEWS',
  'FSM_API_TOKEN_SETEINFO',
  'FSM_TOKEN_URL_TELENEWS',
  'FSM_TOKEN_KEY_TELENEWS',
  'FSM_TOKEN_URL_SETEINFO',
  'FSM_TOKEN_KEY_SETEINFO',
];

/** URL real del emisor (solo como literal: ningún test sale a la red). */
const GENERATE_URL = 'https://apix.grupotvcable.com/rest/token-api/v1.0/generate';

let spy: FetchSpy | null = null;

function clearFsmEnv(): void {
  for (const key of TOKEN_VARS) delete process.env[key];
}

/** Configura la renovación automática de una marca con una key de mentira. */
function useGeneratedToken(key = 'a2V5LWRlLXBydWViYQ=='): void {
  process.env.FSM_TOKEN_URL_TELENEWS = GENERATE_URL;
  process.env.FSM_TOKEN_KEY_TELENEWS = key;
}

beforeEach(() => {
  clearFsmEnv();
  resetFsmTokenCache();
});

afterEach(() => {
  spy?.restore();
  spy = null;
  clearFsmEnv();
  resetFsmTokenCache();
  vi.restoreAllMocks();
});

describe('decodeJwtExp / decodeJwtClaims', () => {
  it('lee el exp del payload sin verificar la firma', () => {
    const token = futureJwt(24);
    const exp = decodeJwtExp(token);
    expect(exp).toBeInstanceOf(Date);
    expect(exp!.getTime()).toBeGreaterThan(Date.now());
    expect(decodeJwtClaims(token)?.azp).toBe('apim_callcenter_telenews');
  });

  it('devuelve null ante basura', () => {
    expect(decodeJwtExp('no-es-un-jwt')).toBeNull();
    expect(decodeJwtExp('')).toBeNull();
  });
});

describe('resolveBrand', () => {
  it('usa la marca por defecto cuando no viene nada', () => {
    expect(resolveBrand(null)).toBe('telenews');
    expect(resolveBrand('')).toBe('telenews');
    expect(resolveBrand(undefined)).toBe('telenews');
  });

  it('acepta las marcas configuradas, sin importar mayúsculas', () => {
    expect(resolveBrand(' TELENEWS ')).toBe('telenews');
  });

  it('rechaza una marca desconocida con VALIDATION_ERROR', () => {
    try {
      resolveBrand('otra-marca');
      throw new Error('debió lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
      expect((err as ApiError).statusCode).toBe(400);
    }
  });

  // La operadora deshabilitó seteinfo el 2026-09-09, pero la plomería
  // multi-marca sigue viva: reactivarla es solo listarla en FSM_BRANDS.
  it('seteinfo está fuera por defecto y vuelve con solo listarla en FSM_BRANDS', () => {
    expect(() => resolveBrand('seteinfo')).toThrow(ApiError);

    const original = env.FSM_BRANDS;
    Object.assign(env, { FSM_BRANDS: ['telenews', 'seteinfo'] });
    try {
      expect(resolveBrand('SETEINFO')).toBe('seteinfo');
    } finally {
      Object.assign(env, { FSM_BRANDS: original });
    }
  });
});

describe('parseGeneratedToken — respuesta de token-api/generate', () => {
  it('lee token y expiryTime en la raíz', () => {
    expect(parseGeneratedToken({ token: 'jwt-1', expiryTime: 86400 })).toEqual({
      token: 'jwt-1',
      expiry: 86400,
    });
  });

  it('los lee también un nivel adentro (data / result)', () => {
    expect(parseGeneratedToken({ data: { token: 'jwt-2', expiryTime: '86400' } })).toEqual({
      token: 'jwt-2',
      expiry: 86400,
    });
    expect(parseGeneratedToken({ result: { token: 'jwt-3' } })).toEqual({
      token: 'jwt-3',
      expiry: null,
    });
  });

  it('devuelve null si no hay token', () => {
    expect(parseGeneratedToken({ expiryTime: 86400 })).toBeNull();
    expect(parseGeneratedToken(null)).toBeNull();
    expect(parseGeneratedToken('boom')).toBeNull();
  });
});

describe('getFsmAccessToken — prioridad de modos', () => {
  it('sin nada configurado lanza MISSING y NO toca la red', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: {} }));
    await expect(getFsmAccessToken('telenews')).rejects.toMatchObject({
      code: 'UPSTREAM_AUTH_ERROR',
      statusCode: 503,
    });
    expect(spy.calls).toHaveLength(0);
  });

  it('con token estático vigente lo devuelve con source STATIC', async () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(10);
    spy = installFetchSpy(() => ({ status: 200, body: {} }));
    const token = await getFsmAccessToken('telenews');
    expect(token.source).toBe('STATIC');
    expect(token.expiresAt).toBeInstanceOf(Date);
    expect(spy.calls).toHaveLength(0);
  });

  it('con token estático VENCIDO lanza EXPIRED sin hacer ninguna llamada de red', async () => {
    process.env.FSM_API_TOKEN_TELENEWS = expiredJwt(3);
    spy = installFetchSpy(() => ({ status: 200, body: {} }));

    const err = await getFsmAccessToken('telenews').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UPSTREAM_AUTH_ERROR');
    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).meta).toMatchObject({
      integration: 'FSM',
      brand: 'telenews',
      reason: 'EXPIRED',
      retryable: false,
    });
    expect((err as ApiError).message).toContain('venció el');
    // El criterio de aceptación: CERO llamadas de red.
    expect(spy.calls).toHaveLength(0);
  });

  it('el token generado tiene prioridad sobre el estático y usa el contrato de la operadora', async () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(10, { azp: 'estatico' });
    useGeneratedToken('a2V5LXF1ZS1uby1kZWJlLWxvZ3VlYXJzZQ==');

    const negotiated = futureJwt(24, { azp: 'negociado' });
    spy = installFetchSpy(() => ({
      status: 200,
      body: { token: negotiated, expiryTime: 86400 },
    }));

    const token = await getFsmAccessToken('telenews');
    expect(token.source).toBe('GENERATED');
    expect(token.token).toBe(negotiated);
    expect(spy.calls).toHaveLength(1);

    const call = spy.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(GENERATE_URL);
    expect(call.headers['content-type']).toBe('application/json');
    // Contrato exacto confirmado por la operadora el 2026-09-09.
    expect(call.body).toEqual({
      channel: 'telenews',
      key: 'a2V5LXF1ZS1uby1kZWJlLWxvZ3VlYXJzZQ==',
      realm: 'realm-ecommerce-callcenter-telenews',
      type: 'Basic',
    });
  });

  it('expiryTime (segundos) manda sobre el exp del JWT', async () => {
    useGeneratedToken();
    // JWT que dice durar 24 h, pero la operadora concede 3600 s.
    spy = installFetchSpy(() => ({
      status: 200,
      body: { token: futureJwt(24), expiryTime: 3600 },
    }));

    const token = await getFsmAccessToken('telenews');
    const seconds = Math.round((token.expiresAt!.getTime() - Date.now()) / 1000);
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThanOrEqual(3600);
  });

  it('sin expiryTime cae al exp del propio JWT', async () => {
    useGeneratedToken();
    spy = installFetchSpy(() => ({ status: 200, body: { data: { token: futureJwt(24) } } }));

    const token = await getFsmAccessToken('telenews');
    const seconds = Math.round((token.expiresAt!.getTime() - Date.now()) / 1000);
    expect(seconds).toBeGreaterThan(86_000);
  });

  it('una respuesta sin "token" degrada a REJECTED', async () => {
    useGeneratedToken();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    spy = installFetchSpy(() => ({ status: 200, body: { mensaje: 'sin token' } }));

    const err = await getFsmAccessToken('telenews').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('UPSTREAM_AUTH_ERROR');
    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).meta).toMatchObject({ reason: 'REJECTED' });
  });

  it('cachea el token negociado: la segunda llamada no vuelve a negociar', async () => {
    useGeneratedToken();
    spy = installFetchSpy(() => ({
      status: 200,
      body: { token: futureJwt(24), expiryTime: 86400 },
    }));

    await getFsmAccessToken('telenews');
    await getFsmAccessToken('telenews');
    expect(spy.calls).toHaveLength(1);

    invalidateFsmToken('telenews');
    await getFsmAccessToken('telenews');
    expect(spy.calls).toHaveLength(2);
  });

  it('single-flight: dos llamadas concurrentes disparan UNA sola negociación', async () => {
    useGeneratedToken();
    spy = installFetchSpy(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, body: { token: futureJwt(24), expiryTime: 86400 } };
    });

    const [a, b, c] = await Promise.all([
      getFsmAccessToken('telenews'),
      getFsmAccessToken('telenews'),
      getFsmAccessToken('telenews'),
    ]);
    expect(spy.calls).toHaveLength(1);
    expect(a.token).toBe(b.token);
    expect(b.token).toBe(c.token);
  });

  it('un emisor inalcanzable degrada a REJECTED (no tumba el proceso)', async () => {
    useGeneratedToken();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    spy = installFetchSpy(() => {
      throw new Error('ECONNREFUSED');
    });

    const err = await getFsmAccessToken('telenews').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('UPSTREAM_AUTH_ERROR');
    expect((err as ApiError).meta).toMatchObject({ reason: 'REJECTED' });
  });
});

describe('Los tokens nunca aparecen en los logs', () => {
  it('ni el JWT ni la key Basic salen por consola', async () => {
    const secret = 'a2V5LXN1cGVyLWNvbmZpZGVuY2lhbC0xMjM=';
    const negotiated = futureJwt(24, { azp: 'apim_callcenter_telenews' });
    useGeneratedToken(secret);

    const logged: string[] = [];
    const collect = (...args: unknown[]): void => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    vi.spyOn(console, 'info').mockImplementation(collect);
    vi.spyOn(console, 'warn').mockImplementation(collect);
    vi.spyOn(console, 'error').mockImplementation(collect);
    vi.spyOn(console, 'log').mockImplementation(collect);

    spy = installFetchSpy(() => ({
      status: 200,
      body: { token: negotiated, expiryTime: 86400 },
    }));
    await getFsmAccessToken('telenews');

    const all = logged.join('\n');
    expect(all).not.toContain(negotiated);
    expect(all).not.toContain(secret);
    // Sí se loguea lo que sirve para diagnosticar.
    expect(all).toContain('telenews');
    expect(all).toContain('apim_callcenter_telenews');
  });
});

describe('fsmTokenStatus — sin red', () => {
  it('informa MISSING cuando no hay nada configurado', () => {
    spy = installFetchSpy(() => ({ status: 200, body: {} }));
    const status = fsmTokenStatus();
    // Solo telenews: seteinfo quedó fuera por indicación de la operadora.
    expect(status.map((s) => s.brand)).toEqual(['telenews']);
    expect(status.every((s) => s.available === false && s.reason === 'MISSING')).toBe(true);
    expect(status.every((s) => s.tokenSource === null)).toBe(true);
    expect(spy.calls).toHaveLength(0);
  });

  it('informa EXPIRED con segundos negativos cuando el token estático venció', () => {
    process.env.FSM_API_TOKEN_TELENEWS = expiredJwt(2);
    const telenews = fsmTokenStatus().find((s) => s.brand === 'telenews')!;
    expect(telenews.available).toBe(false);
    expect(telenews.reason).toBe('EXPIRED');
    expect(telenews.tokenSource).toBe('STATIC');
    expect(telenews.expiresInSeconds).toBeLessThan(0);
  });

  it('informa disponible con los segundos restantes cuando el token está vigente', () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(24);
    const telenews = fsmTokenStatus().find((s) => s.brand === 'telenews')!;
    expect(telenews.available).toBe(true);
    expect(telenews.reason).toBeNull();
    expect(telenews.expiresInSeconds).toBeGreaterThan(80_000);
  });

  it('informa REJECTED cuando la operadora rechazó la credencial', () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(24);
    markFsmTokenRejected('telenews');
    const telenews = fsmTokenStatus().find((s) => s.brand === 'telenews')!;
    expect(telenews.available).toBe(false);
    expect(telenews.reason).toBe('REJECTED');
  });
});
