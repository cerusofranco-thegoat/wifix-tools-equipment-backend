// GET /accounts/{n}/current-nap — NAP y puerto actuales por búsqueda inversa.
//
// Reglas que estos tests protegen:
//   1. Presupuesto upstream: [1 process] + 1 nearest + ≤3 accounts + [1 status],
//      con corte temprano en cuanto aparece la cuenta.
//   2. El resultado se cachea 10 min (clave `FSM:{brand}:currentNap:{cuenta}`).
//   3. Fuente TEC → NOT_SUPPORTED sin gastar una sola llamada.
//   4. Un fallo de token es 503 UPSTREAM_AUTH_ERROR, NUNCA 401.
//   5. En mock hay cuentas que se encuentran y cuentas que no.
//   6. NAP ASIGNADA SIEMPRE: si no se identifica o FSM falla, NAP simulada
//      determinística por cuenta (`simulated:true`, `source:'SIMULATED'`) sin
//      llamadas extra. `?fallback=none` conserva el comportamiento estricto.
//
// No se usa base de datos y NUNCA se sale a la red: `fetch` está reemplazado.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  buildFsmTestApp,
  futureJwt,
  installFetchSpy,
  type FetchCall,
  type FakeResponse,
  type FetchSpy,
} from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import { resetFsmTokenCache } from '../../src/connectors/http/fsm-token.js';
import { resetFsmLimiter } from '../../src/connectors/http/fsm-api.js';
import { resetNapRegistry } from '../../src/connectors/fsm/index.js';
import {
  currentNapCacheKey,
  normalizeAccount,
  simulatedCurrentNap,
} from '../../src/modules/network-diagnostics/current-nap.service.js';

const PREFIX = '/herramientas/v1';
const ACCOUNT = '35070291';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
let spy: FetchSpy | null = null;

const originalEnv = {
  CONNECTOR_MODE_FSM: env.CONNECTOR_MODE_FSM,
  CONNECTOR_MODE_TEC: env.CONNECTOR_MODE_TEC,
  NAPS_PRIMARY_SOURCE: env.NAPS_PRIMARY_SOURCE,
  FSM_BRANDS: env.FSM_BRANDS,
};

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
  Object.assign(env, originalEnv);
});

beforeEach(() => {
  Object.assign(env, {
    CONNECTOR_MODE_FSM: 'mock',
    CONNECTOR_MODE_TEC: 'mock',
    NAPS_PRIMARY_SOURCE: 'fsm',
    FSM_BRANDS: originalEnv.FSM_BRANDS,
  });
  delete process.env.FSM_API_TOKEN_TELENEWS;
  delete process.env.FSM_API_TOKEN_SETEINFO;
  resetHttpCache();
  resetFsmTokenCache();
  resetFsmLimiter();
  resetNapRegistry();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  spy?.restore();
  spy = null;
  vi.restoreAllMocks();
});

function useRealFsm(responder: (call: FetchCall) => FakeResponse): FetchSpy {
  process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
  Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
  resetFsmTokenCache();
  spy = installFetchSpy(responder);
  return spy;
}

function get(path: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: { ...authHeaders, ...headers } });
}

// --- Respuestas simuladas de la operadora ----------------------------------

const PROCESS = {
  data: [
    {
      names: 'María Cevallos Andrade',
      phoneNumber: '0991234567',
      email: 'maria@example.com',
      address: 'Av. Amazonas N1234, Guayaquil',
      latitude: -2.076135,
      longitude: -79.854035,
      workOrder: 'ORDER/424900/2026',
      task: 'INSTALACION',
      state: 'Realizado',
      creationDate: '2026-08-14 14:02:00',
      endDate: '2026-08-14 16:41:00',
    },
  ],
};

const PROCESS_NO_COORDS = {
  data: [{ ...PROCESS.data[0], latitude: null, longitude: null }],
};

/** Tres NAPs, desordenadas a propósito: la búsqueda va por cercanía. */
const NEAREST = {
  data: [
    { id: 35876, name: 'AR7S2', network: 'AR7S', lat: -2.0768, lng: -79.8538, distance: 78, ports: 8, used: 8 },
    { id: 35874, name: 'AR7S1', network: 'AR7S', lat: -2.0761, lng: -79.854, distance: 28, ports: 8, used: 4 },
    { id: 35873, name: 'AR7S3', network: 'AR7S', lat: -2.0758, lng: -79.8545, distance: 90, ports: 8, used: 6 },
  ],
};

function napAccounts(napId: number, withTarget: boolean): unknown {
  const rows = [
    { id: napId, number: 1, accountId: 17412837, equipmentId: 'STGU3C3B1A18' },
    { id: napId, number: 2, accountId: 33928054, equipmentId: 'HWTCCB48FAAA' },
  ];
  // La cuenta llega como NÚMERO (así la manda FSM): la comparación es normalizada como string.
  if (withTarget) rows.push({ id: napId, number: 5, accountId: Number(ACCOUNT), equipmentId: 'ZTEGD52E1A9B' });
  return { data: rows };
}

interface Plan {
  process?: unknown;
  /** NAP (id) en la que está la cuenta; `null` = en ninguna. */
  targetNap?: number | null;
  statusFails?: boolean;
}

function responder(plan: Plan = {}): (call: FetchCall) => FakeResponse {
  return (call) => {
    if (call.url.includes('/account/process')) return { status: 200, body: plan.process ?? PROCESS };
    if (call.url.includes('/naps/nearest')) return { status: 200, body: NEAREST };
    if (call.url.includes('/naps/accounts')) {
      const id = Number(new URL(call.url).searchParams.get('id'));
      return { status: 200, body: napAccounts(id, id === (plan.targetNap ?? null)) };
    }
    if (call.url.includes('/account/status')) {
      if (plan.statusFails) return { status: 500, raw: 'boom' };
      return { status: 200, body: { data: { accountId: Number(ACCOUNT), status: 'S', description: 'Suspendido' } } };
    }
    return { status: 404, raw: 'no simulado' };
  };
}

function paths(fetchSpy: FetchSpy): string[] {
  return fetchSpy.calls.map((c) => {
    const url = new URL(c.url);
    return `${url.pathname.replace(/^.*?(\/(account|naps)\/)/, '$1')}${url.search}`;
  });
}

// ---------------------------------------------------------------------------

describe('GET /accounts/{n}/current-nap — real', () => {
  it('encontrada en la NAP más cercana: corta ahí (no consulta la 2ª ni la 3ª) y trae el estado', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      accountNumber: ACCOUNT,
      found: true,
      nap: expect.objectContaining({ napId: 35874, napCode: 'AR7S1', distanceMeters: 28, source: 'FSM' }),
      portNumber: 5,
      equipmentId: 'ZTEGD52E1A9B',
      clientStatus: { code: 'S', name: 'SUSPENDIDA', description: 'Suspendido' },
      searchedNaps: 1,
      brand: 'telenews',
      source: 'FSM',
      simulated: false,
      assignment: 'CONTRACTED',
    });
    expect(body.reason).toBeUndefined();
    expect(body.degraded).toBeUndefined();
    expect(body.simulationReason).toBeUndefined();

    // process + nearest + accounts(35874) + status. Ni 35876 ni 35873.
    const called = paths(fetchSpy);
    expect(called).toHaveLength(4);
    expect(called.filter((p) => p.includes('/naps/accounts'))).toEqual(['/naps/accounts?id=35874']);
    expect(fetchSpy.calls.find((c) => c.url.includes('/naps/nearest'))!.url).toMatch(/meters=150/);
    expect(fetchSpy.calls.find((c) => c.url.includes('/naps/nearest'))!.url).toMatch(/maxRows=3/);
  });

  it('recorre en orden de cercanía y corta en la NAP donde aparece', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35876 }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);

    expect(res.json()).toMatchObject({ found: true, searchedNaps: 2, nap: { napId: 35876 } });
    expect(paths(fetchSpy).filter((p) => p.includes('/naps/accounts'))).toEqual([
      '/naps/accounts?id=35874',
      '/naps/accounts?id=35876',
    ]);
  });

  it('no encontrada (fallback=none): 1 + 1 + 3 llamadas, reason NOT_FOUND y sin consultar estado', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: null }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=none`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accountNumber: ACCOUNT,
      found: false,
      nap: null,
      portNumber: null,
      equipmentId: null,
      clientStatus: null,
      searchedNaps: 3,
      reason: 'NOT_FOUND',
      brand: 'telenews',
      source: null,
      simulated: false,
      assignment: null,
    });
    expect(fetchSpy.calls).toHaveLength(5);
    expect(fetchSpy.calls.some((c) => c.url.includes('/account/status'))).toBe(false);
  });

  it('sin coordenadas del cliente (fallback=none): NO_COORDS tras UNA sola llamada', async () => {
    const fetchSpy = useRealFsm(responder({ process: PROCESS_NO_COORDS }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=none`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: false, reason: 'NO_COORDS', searchedNaps: 0, nap: null });
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0]!.url).toContain('/account/process');
  });

  it('con lat/lng de override no consulta /account/process y usa esa coordenada', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=-2.1&lng=-79.9`);

    expect(res.json()).toMatchObject({ found: true, searchedNaps: 1 });
    expect(fetchSpy.calls.some((c) => c.url.includes('/account/process'))).toBe(false);
    const nearest = new URL(fetchSpy.calls[0]!.url);
    expect(nearest.pathname).toContain('/naps/nearest');
    expect(nearest.searchParams.get('lat')).toBe('-2.1');
    expect(nearest.searchParams.get('lng')).toBe('-79.9');
  });

  it('cache 10 min: la 2ª llamada no toca FSM; otro override de coordenada sí', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const first = await get(`/accounts/${ACCOUNT}/current-nap`);
    const callsAfterFirst = fetchSpy.calls.length;
    expect(callsAfterFirst).toBe(4);

    const second = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(second.json()).toEqual(first.json());
    expect(fetchSpy.calls).toHaveLength(callsAfterFirst);

    // Un override de coordenada es otra entrada del cache.
    await get(`/accounts/${ACCOUNT}/current-nap?lat=-2.2&lng=-79.8`);
    expect(fetchSpy.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('la clave de cache lleva el prefijo FSM:{brand}: y la coordenada redondeada', () => {
    // Solo trim: la clave es el mismo valor que viaja a FSM (sin quitar ceros).
    expect(currentNapCacheKey('telenews', ' 35070291 ')).toBe('FSM:telenews:currentNap:35070291');
    expect(currentNapCacheKey('telenews', '0035070291')).toBe('FSM:telenews:currentNap:0035070291');
    expect(
      currentNapCacheKey('telenews', ACCOUNT, { latitude: -2.0761349, longitude: -79.8540351 }),
    ).toBe('FSM:telenews:currentNap:35070291:-2.07613,-79.85404');
    expect(normalizeAccount('0035070291')).toBe('35070291');
    expect(normalizeAccount(35070291)).toBe('35070291');
  });

  it('0035070291 y 35070291 NO comparten cache: cada una consulta FSM con su propio valor', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const a = await get(`/accounts/${ACCOUNT}/current-nap`);
    const callsA = fetchSpy.calls.length;
    const b = await get(`/accounts/00${ACCOUNT}/current-nap`);

    expect(a.json().accountNumber).toBe(ACCOUNT);
    expect(b.json().accountNumber).toBe(`00${ACCOUNT}`);
    // La segunda salió a FSM (process) con SU valor, no con el cacheado de la primera.
    const processB = fetchSpy.calls
      .slice(callsA)
      .find((c) => c.url.includes('/account/process'));
    expect(processB).toBeDefined();
    expect((processB!.body as { data: { account_id: string } }).data.account_id).toBe(`00${ACCOUNT}`);
    // La comparación contra /naps/accounts sí es normalizada: también la encuentra.
    expect(b.json()).toMatchObject({ found: true, portNumber: 5 });
  });

  it('si falla el estado: found:true con clientStatus null, aviso y SIN cachear', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: 35874, statusFails: true }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ found: true, portNumber: 5, clientStatus: null });
    expect(body.degraded).toMatchObject({ reason: 'FSM_UNAVAILABLE' });
    expect(typeof res.headers['x-wifix-degraded']).toBe('string');

    // No se fijó 10 min: la repetición vuelve a intentar el estado.
    const before = fetchSpy.calls.filter((c) => c.url.includes('/account/status')).length;
    await get(`/accounts/${ACCOUNT}/current-nap`);
    const after = fetchSpy.calls.filter((c) => c.url.includes('/account/status')).length;
    expect(after).toBeGreaterThan(before);
  });

  it('token rechazado (fallback=none): 503 UPSTREAM_AUTH_ERROR, nunca 401 (con y sin override)', async () => {
    useRealFsm(() => ({ status: 401, raw: 'Unauthorized' }));
    for (const url of [
      `/accounts/${ACCOUNT}/current-nap?fallback=none`,
      `/accounts/${ACCOUNT}/current-nap?lat=-2.1&lng=-79.9&fallback=none`,
    ]) {
      resetHttpCache();
      resetFsmTokenCache();
      process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
      const res = await get(url);
      expect(res.statusCode, url).toBe(503);
      expect(res.json().code, url).toBe('UPSTREAM_AUTH_ERROR');
      expect(res.json().meta.reason, url).toBe('REJECTED');
    }
  });

  it('sin token configurado (fallback=none): 503 MISSING y CERO llamadas', async () => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
    resetFsmTokenCache();
    spy = installFetchSpy(() => ({ status: 200, body: { data: [] } }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=none`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'UPSTREAM_AUTH_ERROR', meta: { reason: 'MISSING' } });
    expect(spy.calls).toHaveLength(0);
  });
});

describe('GET /accounts/{n}/current-nap — fuente TEC', () => {
  it('NAPS_PRIMARY_SOURCE=tec (fallback=none): NOT_SUPPORTED sin una sola llamada', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'tec' });
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=none`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accountNumber: ACCOUNT,
      found: false,
      nap: null,
      portNumber: null,
      equipmentId: null,
      clientStatus: null,
      searchedNaps: 0,
      reason: 'NOT_SUPPORTED',
      brand: 'telenews',
      source: null,
      simulated: false,
      assignment: null,
    });
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it('NAPS_PRIMARY_SOURCE=tec (default): NAP simulada NOT_SUPPORTED, sin una sola llamada', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'tec' });
    const fetchSpy = useRealFsm(responder({ targetNap: 35874 }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      found: true,
      simulated: true,
      source: 'SIMULATED',
      simulationReason: 'NOT_SUPPORTED',
    });
    expect(fetchSpy.calls).toHaveLength(0);
  });
});

describe('GET /accounts/{n}/current-nap — mock', () => {
  it('35070291 se encuentra en la 2ª NAP más cercana, con estado', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ accountNumber: ACCOUNT, found: true, searchedNaps: 2, brand: 'telenews' });
    expect(body.nap).toMatchObject({ source: 'FSM' });
    expect(typeof body.nap.napId).toBe('number');
    expect(body.portNumber).toBeGreaterThanOrEqual(1);
    expect(body.portNumber).toBeLessThanOrEqual(8);
    expect(body.equipmentId).toMatch(/^ZTEGD\d{6}$/);
    expect(body.clientStatus).toHaveProperty('name');
    expect(body.reason).toBeUndefined();

    // Coherente con la rejilla: el puerto de esa NAP lleva la cuenta.
    const ports = await get(`/naps/${body.nap.napId}/ports`);
    const port = ports.json().ports.find((p: { portNumber: number }) => p.portNumber === body.portNumber);
    expect(port).toMatchObject({ clientAccountNumber: ACCOUNT, equipmentId: body.equipmentId });
  });

  it('40123456 se encuentra en la NAP más cercana', async () => {
    const res = await get('/accounts/40123456/current-nap');
    expect(res.json()).toMatchObject({ found: true, searchedNaps: 1 });
  });

  it('otra cuenta no se encuentra (fallback=none): NOT_FOUND tras revisar las NAPs cercanas', async () => {
    const res = await get('/accounts/12345678/current-nap?fallback=none');
    const body = res.json();
    expect(body).toMatchObject({ found: false, reason: 'NOT_FOUND', nap: null, clientStatus: null });
    expect(body.searchedNaps).toBeGreaterThanOrEqual(2);
    expect(body.searchedNaps).toBeLessThanOrEqual(3);
  });

  it('lat sin lng es 400', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=-2.1`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('lat/lng vacíos cuentan como ausentes (no como 0,0): usa el domicilio', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=&lng=`);
    expect(res.statusCode).toBe(200);
    // Mismo resultado que sin override: 35070291 se encuentra en la 2ª NAP.
    expect(res.json()).toMatchObject({ found: true, searchedNaps: 2 });
  });

  it('solo uno de los dos vacío es 400', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=&lng=-79.9`);
    expect(res.statusCode).toBe(400);
  });

  it('override (0,0) es 400', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=0&lng=0`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /accounts/{n}/current-nap — fixture', () => {
  it('35070291 no está en chain-nap-accounts.json (fallback=none): NOT_FOUND, sin red', async () => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'fixture' });
    spy = installFetchSpy(() => ({ status: 500, raw: 'el modo fixture no puede usar la red' }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=none`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: false, reason: 'NOT_FOUND', searchedNaps: 3 });
    expect(spy.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NAP asignada SIEMPRE: simulada determinística cuando no hay real
// ---------------------------------------------------------------------------

function haversine(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

describe('GET /accounts/{n}/current-nap — NAP asignada simulada', () => {
  it('real NOT_FOUND: NAP simulada cerca del domicilio, SIN llamadas extra', async () => {
    const fetchSpy = useRealFsm(responder({ targetNap: null }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      accountNumber: ACCOUNT,
      found: true,
      simulated: true,
      source: 'SIMULATED',
      assignment: 'CONTRACTED',
      simulationReason: 'NOT_FOUND',
      equipmentId: null,
      searchedNaps: 0,
      brand: 'telenews',
      clientStatus: { code: 'A', name: 'ACTIVA' },
      nap: { napId: null, source: 'SIMULATED' },
    });
    expect(body.reason).toBeUndefined();
    expect(body.degraded).toBeUndefined();
    expect(body.nap.napCode).toMatch(/^PL\d{2}(KD|AB|XR|MN)\d$/);
    expect(body.portNumber).toBeGreaterThanOrEqual(1);
    expect(body.portNumber).toBeLessThanOrEqual(body.nap.occupiedPorts);
    expect(body.nap.totalPorts).toBe(body.nap.occupiedPorts > 8 ? 16 : 8);
    expect(body.nap.freePorts).toBe(body.nap.totalPorts - body.nap.occupiedPorts);
    // Cerca del domicilio que devolvió FSM (15-120 m).
    const d = haversine(
      { latitude: PROCESS.data[0]!.latitude, longitude: PROCESS.data[0]!.longitude },
      { latitude: body.nap.latitude, longitude: body.nap.longitude },
    );
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(125);
    // Mismo presupuesto que la búsqueda real: process + nearest + 3 accounts.
    expect(fetchSpy.calls).toHaveLength(5);
  });

  it('determinística: misma cuenta → misma NAP (y 0035070291 == 35070291)', async () => {
    const a = await get('/accounts/12345678/current-nap');
    resetHttpCache();
    const b = await get('/accounts/12345678/current-nap');
    expect(a.json()).toEqual(b.json());
    expect(a.json()).toMatchObject({ simulated: true, simulationReason: 'NOT_FOUND' });

    const x = simulatedCurrentNap('35070291', 'telenews', null, 'NO_COORDS');
    const y = simulatedCurrentNap('0035070291', 'telenews', null, 'NO_COORDS');
    expect(y.nap).toEqual(x.nap);
    expect(y.portNumber).toBe(x.portNumber);
    const other = simulatedCurrentNap('99887766', 'telenews', null, 'NO_COORDS');
    expect(other.nap).not.toEqual(x.nap);
  });

  it('el código y los puertos no dependen de si se conoce el domicilio', () => {
    const near = simulatedCurrentNap(ACCOUNT, 'telenews', { latitude: -2.1, longitude: -79.9 }, 'NOT_FOUND');
    const far = simulatedCurrentNap(ACCOUNT, 'telenews', null, 'NO_COORDS');
    expect(near.nap?.napCode).toBe(far.nap?.napCode);
    expect(near.portNumber).toBe(far.portNumber);
    expect(near.nap?.latitude).not.toBe(far.nap?.latitude);
  });

  it('sin coordenadas: NAP simulada en el clúster de los mocks', async () => {
    useRealFsm(responder({ process: PROCESS_NO_COORDS }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    const body = res.json();
    expect(body).toMatchObject({ found: true, simulated: true, simulationReason: 'NO_COORDS' });
    const d = haversine({ latitude: -2.247946, longitude: -79.904161 }, body.nap);
    expect(d).toBeLessThan(1_800);
  });

  it('token rechazado: 200 con NAP simulada y aviso FSM_AUTH (nunca 401/503)', async () => {
    useRealFsm(() => ({ status: 401, raw: 'Unauthorized' }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      found: true,
      simulated: true,
      simulationReason: 'UPSTREAM_AUTH_ERROR',
      degraded: { reason: 'FSM_AUTH' },
    });
    expect(typeof res.headers['x-wifix-degraded']).toBe('string');
  });

  it('FSM caído (5xx): 200 con NAP simulada y aviso FSM_UNAVAILABLE', async () => {
    useRealFsm(() => ({ status: 500, raw: 'boom' }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      simulated: true,
      simulationReason: 'UPSTREAM_UNAVAILABLE',
      degraded: { reason: 'FSM_UNAVAILABLE' },
    });
  });

  it('con override de coordenada y FSM caído: la NAP simulada queda cerca del override', async () => {
    useRealFsm(() => ({ status: 500, raw: 'boom' }));
    const res = await get(`/accounts/${ACCOUNT}/current-nap?lat=-2.1&lng=-79.9`);
    const body = res.json();
    expect(body.simulated).toBe(true);
    expect(haversine({ latitude: -2.1, longitude: -79.9 }, body.nap)).toBeLessThan(125);
  });

  it('fallback inválido es 400', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap?fallback=otro`);
    expect(res.statusCode).toBe(400);
  });

  it('mock 35070291 sigue siendo real (source FSM, simulated false)', async () => {
    const res = await get(`/accounts/${ACCOUNT}/current-nap`);
    expect(res.json()).toMatchObject({ found: true, simulated: false, source: 'FSM', assignment: 'CONTRACTED' });
  });
});
