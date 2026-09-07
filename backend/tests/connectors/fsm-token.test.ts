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
  resetFsmTokenCache,
  resolveBrand,
} from '../../src/connectors/http/fsm-token.js';
import { ApiError } from '../../src/middleware/error-handler.js';
import { expiredJwt, futureJwt, installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';

const TOKEN_VARS = [
  'FSM_API_TOKEN_TELENEWS',
  'FSM_API_TOKEN_SETEINFO',
  'FSM_TOKEN_URL_TELENEWS',
  'FSM_CLIENT_ID_TELENEWS',
  'FSM_CLIENT_SECRET_TELENEWS',
];

let spy: FetchSpy | null = null;

function clearFsmEnv(): void {
  for (const key of TOKEN_VARS) delete process.env[key];
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
    expect(resolveBrand('SETEINFO')).toBe('seteinfo');
    expect(resolveBrand(' telenews ')).toBe('telenews');
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

  it('client_credentials tiene prioridad sobre el token estático', async () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(10, { azp: 'estatico' });
    process.env.FSM_TOKEN_URL_TELENEWS = 'http://keycloak.local/token';
    process.env.FSM_CLIENT_ID_TELENEWS = 'apim_callcenter_telenews';
    process.env.FSM_CLIENT_SECRET_TELENEWS = 'secreto-que-no-debe-loguearse';

    const negotiated = futureJwt(24, { azp: 'negociado' });
    spy = installFetchSpy(() => ({
      status: 200,
      body: { access_token: negotiated, expires_in: 86400 },
    }));

    const token = await getFsmAccessToken('telenews');
    expect(token.source).toBe('CLIENT_CREDENTIALS');
    expect(token.token).toBe(negotiated);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.method).toBe('POST');
    expect(spy.calls[0]!.url).toBe('http://keycloak.local/token');
  });

  it('cachea el token negociado: la segunda llamada no vuelve a negociar', async () => {
    process.env.FSM_TOKEN_URL_TELENEWS = 'http://keycloak.local/token';
    process.env.FSM_CLIENT_ID_TELENEWS = 'id';
    process.env.FSM_CLIENT_SECRET_TELENEWS = 'secreto';
    spy = installFetchSpy(() => ({
      status: 200,
      body: { access_token: futureJwt(24), expires_in: 86400 },
    }));

    await getFsmAccessToken('telenews');
    await getFsmAccessToken('telenews');
    expect(spy.calls).toHaveLength(1);

    invalidateFsmToken('telenews');
    await getFsmAccessToken('telenews');
    expect(spy.calls).toHaveLength(2);
  });

  it('single-flight: dos llamadas concurrentes disparan UNA sola negociación', async () => {
    process.env.FSM_TOKEN_URL_TELENEWS = 'http://keycloak.local/token';
    process.env.FSM_CLIENT_ID_TELENEWS = 'id';
    process.env.FSM_CLIENT_SECRET_TELENEWS = 'secreto';
    spy = installFetchSpy(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { status: 200, body: { access_token: futureJwt(24), expires_in: 86400 } };
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
    process.env.FSM_TOKEN_URL_TELENEWS = 'http://192.168.59.181:8080/token';
    process.env.FSM_CLIENT_ID_TELENEWS = 'id';
    process.env.FSM_CLIENT_SECRET_TELENEWS = 'secreto';
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
  it('ni el access_token ni el client_secret salen por consola', async () => {
    const secret = 'secreto-super-confidencial-123';
    const negotiated = futureJwt(24, { azp: 'apim_callcenter_telenews' });
    process.env.FSM_TOKEN_URL_TELENEWS = 'http://keycloak.local/token';
    process.env.FSM_CLIENT_ID_TELENEWS = 'apim_callcenter_telenews';
    process.env.FSM_CLIENT_SECRET_TELENEWS = secret;

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
      body: { access_token: negotiated, expires_in: 86400 },
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
    expect(status.map((s) => s.brand)).toEqual(['telenews', 'seteinfo']);
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
