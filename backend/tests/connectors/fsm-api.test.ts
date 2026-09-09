// Cliente HTTP de FSM: forma del body, aislamiento del cache por marca,
// traducción de códigos upstream y la clave `account_id` de /account/status.
//
// Ningún test sale a la red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchAccountProcess,
  fetchAccountStatus,
  fetchNapsNearest,
  fsmCacheKey,
  fsmGet,
  fsmPost,
  resetFsmLimiter,
} from '../../src/connectors/http/fsm-api.js';
import { resetFsmTokenCache } from '../../src/connectors/http/fsm-token.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import type { ApiError } from '../../src/middleware/error-handler.js';
import { futureJwt, installFetchSpy } from '../helpers/fsm-app.js';
import type { FetchSpy } from '../helpers/fsm-app.js';

let spy: FetchSpy | null = null;

beforeEach(() => {
  process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12, { azp: 'apim_callcenter_telenews' });
  process.env.FSM_API_TOKEN_SETEINFO = futureJwt(12, { azp: 'apim_callcenter_seteinfo' });
  resetFsmTokenCache();
  resetHttpCache();
  resetFsmLimiter();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  spy?.restore();
  spy = null;
  delete process.env.FSM_API_TOKEN_TELENEWS;
  delete process.env.FSM_API_TOKEN_SETEINFO;
  resetFsmTokenCache();
  resetHttpCache();
  vi.restoreAllMocks();
});

describe('fsmCacheKey — prefijo obligatorio', () => {
  it('todas las claves empiezan por FSM:{brand}:', () => {
    expect(fsmCacheKey('telenews', 'POST', '/account/process', { account_id: '1' })).toMatch(
      /^FSM:telenews:POST \/account\/process:/,
    );
    expect(fsmCacheKey('seteinfo', 'GET', '/naps/nearest', { lat: 1 })).toMatch(
      /^FSM:seteinfo:GET \/naps\/nearest:/,
    );
  });

  it('el orden de las claves del payload no cambia la firma', () => {
    const a = fsmCacheKey('telenews', 'POST', '/x', { b: 2, a: 1 });
    const b = fsmCacheKey('telenews', 'POST', '/x', { a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('marcas distintas producen claves distintas para la misma consulta', () => {
    const a = fsmCacheKey('telenews', 'POST', '/account/status', { account_id: 35070291 });
    const b = fsmCacheKey('seteinfo', 'POST', '/account/status', { account_id: 35070291 });
    expect(a).not.toBe(b);
  });
});

describe('Aislamiento del cache entre marcas', () => {
  it('la misma cuenta en telenews y seteinfo hace DOS llamadas y da DOS resultados', async () => {
    spy = installFetchSpy((call) => {
      const brand = String(call.headers.authorization ?? '').includes(
        process.env.FSM_API_TOKEN_SETEINFO ?? 'x',
      )
        ? 'seteinfo'
        : 'telenews';
      return { status: 200, body: { data: [{ marca: brand }] } };
    });

    const uno = await fetchAccountProcess('telenews', '35070291', 'Todas');
    const dos = await fetchAccountProcess('seteinfo', '35070291', 'Todas');

    expect(spy.calls).toHaveLength(2);
    expect(uno).toEqual({ data: [{ marca: 'telenews' }] });
    expect(dos).toEqual({ data: [{ marca: 'seteinfo' }] });

    // Y repetir la consulta dentro de la ventana no vuelve a salir a la red.
    await fetchAccountProcess('telenews', '35070291', 'Todas');
    expect(spy.calls).toHaveLength(2);
  });
});

describe('Forma de la petición', () => {
  it('el POST viaja con channel, data y externalTransactionId nuevo por petición', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: { data: [] } }));

    await fsmPost('telenews', '/account/process', { account_id: 'A' });
    await fsmPost('telenews', '/account/process', { account_id: 'B' });

    expect(spy.calls).toHaveLength(2);
    const first = spy.calls[0]!.body as Record<string, unknown>;
    const second = spy.calls[1]!.body as Record<string, unknown>;
    expect(first).toMatchObject({ channel: 'FSM', data: { account_id: 'A' } });
    expect(typeof first.externalTransactionId).toBe('string');
    // UUID distinto por petición saliente, pero fuera de la clave de cache.
    expect(first.externalTransactionId).not.toBe(second.externalTransactionId);
    expect(spy.calls[0]!.headers.authorization).toMatch(/^Bearer /);
    expect(spy.calls[0]!.headers.accept).toBe('application/json');
    expect(spy.calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('el GET arma la query y no manda cuerpo', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: { data: [] } }));
    await fetchNapsNearest('telenews', -2.247946, -79.904161, 150, 7);
    const call = spy.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toContain('/naps/nearest?');
    expect(call.url).toContain('lat=-2.247946');
    expect(call.url).toContain('lng=-79.904161');
    expect(call.url).toContain('meters=150');
    expect(call.url).toContain('maxRows=7');
    expect(call.body).toBeNull();
  });
});

describe('Traducción de las respuestas upstream', () => {
  it('204 y 404 se traducen a null (no son errores)', async () => {
    spy = installFetchSpy(() => ({ status: 204 }));
    expect(await fsmGet('telenews', '/naps/accounts', { id: 1 })).toBeNull();

    resetHttpCache();
    spy.restore();
    spy = installFetchSpy(() => ({ status: 404, body: { message: 'no existe' } }));
    expect(await fsmGet('telenews', '/naps/accounts', { id: 2 })).toBeNull();
  });

  it('un 200 con cuerpo vacío también es null', async () => {
    spy = installFetchSpy(() => ({ status: 200, raw: '' }));
    expect(await fsmGet('telenews', '/naps/accounts', { id: 3 })).toBeNull();
  });

  it('400 se traduce a VALIDATION_ERROR con el mensaje de la operadora', async () => {
    spy = installFetchSpy(() => ({ status: 400, body: { message: 'account_id inválido' } }));
    const err = await fsmPost('telenews', '/account/process', { account_id: 'X' }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).statusCode).toBe(400);
    expect((err as ApiError).message).toContain('account_id inválido');
  });

  it('500 se traduce a CONNECTOR_ERROR (502), nunca a 401', async () => {
    spy = installFetchSpy(() => ({ status: 500, raw: 'boom' }));
    const err = await fsmPost('telenews', '/account/process', { account_id: 'X' }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe('CONNECTOR_ERROR');
    expect((err as ApiError).statusCode).toBe(502);
  });

  it('un cuerpo no-JSON se traduce a CONNECTOR_ERROR', async () => {
    spy = installFetchSpy(() => ({ status: 200, raw: '<html>error</html>' }));
    const err = await fsmPost('telenews', '/account/process', { account_id: 'X' }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe('CONNECTOR_ERROR');
  });

  it('401 con token estático NO reintenta y devuelve UPSTREAM_AUTH_ERROR (503)', async () => {
    spy = installFetchSpy(() => ({ status: 401, raw: 'Unauthorized' }));
    const err = await fsmPost('telenews', '/account/process', { account_id: 'X' }).catch(
      (e: unknown) => e,
    );
    expect((err as ApiError).code).toBe('UPSTREAM_AUTH_ERROR');
    expect((err as ApiError).statusCode).toBe(503);
    expect((err as ApiError).meta).toMatchObject({ reason: 'REJECTED', brand: 'telenews' });
    // Sin credenciales para renovar no hay reintento: una sola llamada.
    expect(spy.calls).toHaveLength(1);
  });

  it('401 con token renovable reintenta UNA vez con un token nuevo', async () => {
    // Protocolo real de la operadora: token-api/v1.0/generate (no OAuth).
    process.env.FSM_TOKEN_URL_TELENEWS = 'https://apix.local/rest/token-api/v1.0/generate';
    process.env.FSM_TOKEN_KEY_TELENEWS = 'a2V5LWRlLXBydWViYQ==';
    resetFsmTokenCache();

    let dataCalls = 0;
    spy = installFetchSpy((call) => {
      if (call.url.includes('token-api')) {
        return { status: 200, body: { token: futureJwt(24), expiryTime: 86400 } };
      }
      dataCalls += 1;
      return dataCalls === 1
        ? { status: 401, raw: 'Unauthorized' }
        : { status: 200, body: { data: [{ ok: true }] } };
    });

    const result = await fsmPost('telenews', '/account/process', { account_id: 'X' });
    expect(result).toEqual({ data: [{ ok: true }] });
    expect(dataCalls).toBe(2);

    process.env.FSM_TOKEN_URL_TELENEWS = '';
    process.env.FSM_TOKEN_KEY_TELENEWS = '';
  });
});

describe('/account/status — la clave es account_id', () => {
  // Confirmado por la operadora el 2026-09-09: `data.account_id`, numérico.
  // El doble intento account_id → accountId se eliminó: era una llamada de más
  // contra producción.
  it('manda data.account_id como entero, en UNA sola llamada', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: { data: { accountId: 1, status: 'A' } } }));
    await fetchAccountStatus('telenews', '35070291');
    const body = spy.calls[0]!.body as { data: Record<string, unknown> };
    expect(body.data).toEqual({ account_id: 35070291 });
    expect(spy.calls).toHaveLength(1);
  });

  it('una cuenta no numérica viaja tal cual, sin convertir', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: { data: { status: 'A' } } }));
    await fetchAccountStatus('telenews', 'CTA-99');
    const body = spy.calls[0]!.body as { data: Record<string, unknown> };
    expect(body.data).toEqual({ account_id: 'CTA-99' });
  });

  it('un 400 se propaga: ya no hay reintento con accountId', async () => {
    spy = installFetchSpy(() => ({ status: 400, body: { message: 'campo inválido' } }));
    const err = await fetchAccountStatus('telenews', '71398253').catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect(spy.calls).toHaveLength(1);
  });
});
