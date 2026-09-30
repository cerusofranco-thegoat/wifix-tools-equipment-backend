// Ubicación "Casa cliente" (POST/GET /accounts/{n}/client-location y
// GET /client-locations) + su registro en /visits?include=records.
// Requiere Postgres; FSM en mock (salvo el caso "FSM caído", sin red).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';
import { prisma } from '../../src/db/prisma.js';
import { env } from '../../src/config/env.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import { resetFsmTokenCache } from '../../src/connectors/http/fsm-token.js';
import { getFsmConnector } from '../../src/connectors/index.js';
import { haversineMeters } from '../../src/lib/geo-distance.js';
import { linkNap } from '../../src/modules/client-location/client-location.service.js';
import type { CurrentNapResult } from '../../src/modules/network-diagnostics/current-nap.service.js';
import type { VisitsWithRecordsResult } from '../../src/modules/tasks-visits/visit-records.service.js';

const PREFIX = '/herramientas/v1';
/** Cuenta del mock con NAP real encontrada (2ª más cercana). */
const FOUND = '35070291';
/** Cuentas reservadas para este archivo. */
const OTHER = '91000001';
const VISITS_ACCOUNT = '91000002';
const DOWN_ACCOUNT = '91000003';
const ACCOUNTS = [FOUND, `0${FOUND}`, OTHER, VISITS_ACCOUNT, DOWN_ACCOUNT];

let app: FastifyInstance;
let authHeaders: Record<string, string>;
let spy: FetchSpy | null = null;

const originalEnv = {
  CONNECTOR_MODE_FSM: env.CONNECTOR_MODE_FSM,
  NAPS_PRIMARY_SOURCE: env.NAPS_PRIMARY_SOURCE,
};

async function cleanup(): Promise<void> {
  await prisma.clientLocation.deleteMany({ where: { accountNumber: { in: ACCOUNTS } } });
}

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  Object.assign(env, originalEnv);
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  Object.assign(env, { CONNECTOR_MODE_FSM: 'mock', NAPS_PRIMARY_SOURCE: 'fsm' });
  resetHttpCache();
});

afterEach(() => {
  spy?.restore();
  spy = null;
  vi.restoreAllMocks();
});

function post(account: string, payload: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${PREFIX}/accounts/${account}/client-location`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: authHeaders });
}

const GPS = { latitude: -2.24801, longitude: -79.90422, accuracyMeters: 6.5, source: 'GPS' };

describe('haversineMeters', () => {
  it('distancias conocidas', () => {
    expect(haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    // 0,001° de latitud ≈ 111,2 m.
    const d = haversineMeters({ latitude: -2.1, longitude: -79.9 }, { latitude: -2.101, longitude: -79.9 });
    expect(d).toBeGreaterThan(110.5);
    expect(d).toBeLessThan(111.8);
  });
});

describe('linkNap', () => {
  const current = {
    found: true,
    simulated: false,
    portNumber: 5,
    nap: { napCode: 'AR7S1', latitude: -2.0761, longitude: -79.854 },
  } as unknown as CurrentNapResult;

  it('sin napCode en el body: toma la NAP y el puerto de current-nap, con coordenadas', () => {
    expect(linkNap({}, current)).toEqual({
      napCode: 'AR7S1',
      napPort: '5',
      napLatitude: -2.0761,
      napLongitude: -79.854,
      napSimulated: false,
    });
  });

  it('mismo código (sin distinguir mayúsculas): usa sus coordenadas y respeta el puerto enviado', () => {
    expect(linkNap({ napCode: 'ar7s1', napPort: 3 }, current)).toMatchObject({
      napCode: 'ar7s1',
      napPort: '3',
      napLatitude: -2.0761,
    });
  });

  it('otro código: se guarda tal cual, SIN coordenadas (no se mezcla con otra NAP)', () => {
    expect(linkNap({ napCode: 'XX999', napPort: '2' }, current)).toEqual({
      napCode: 'XX999',
      napPort: '2',
      napLatitude: null,
      napLongitude: null,
      napSimulated: null,
    });
  });

  it('sin current-nap: solo lo enviado', () => {
    expect(linkNap({}, null)).toEqual({
      napCode: null,
      napPort: null,
      napLatitude: null,
      napLongitude: null,
      napSimulated: null,
    });
  });
});

describe('POST /accounts/{n}/client-location', () => {
  it('201: guarda la captura con técnico, ubicación registrada, NAP y distancias', async () => {
    const res = await post(FOUND, { ...GPS, taskId: 'ORDER/424900/2026', notes: 'Portón verde' });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    const nap = (await get(`/accounts/${FOUND}/current-nap`)).json();
    const profile = await getFsmConnector().getAccountOrders(FOUND, { brand: 'telenews', estado: 'Todas' });

    expect(body).toMatchObject({
      accountNumber: FOUND,
      label: 'CASA_CLIENTE',
      latitude: GPS.latitude,
      longitude: GPS.longitude,
      accuracyMeters: 6.5,
      source: 'GPS',
      napCode: nap.nap.napCode,
      napPort: nap.portNumber,
      taskId: 'ORDER/424900/2026',
      capturedBy: { email: 'tester@wifix.test' },
      registeredLocation: { source: 'MOCK' },
      napLocation: { simulated: false },
      notes: 'Portón verde',
    });
    expect(body.registeredLocation.latitude).toBeCloseTo(profile.client!.latitude!, 6);
    expect(body.registeredLocation.longitude).toBeCloseTo(profile.client!.longitude!, 6);
    expect(body.napLocation.latitude).toBeCloseTo(nap.nap.latitude, 6);
    expect(body.napLocation.longitude).toBeCloseTo(nap.nap.longitude, 6);
    expect(typeof body.id).toBe('string');
    expect(typeof body.capturedBy.id).toBe('string');
    expect(Date.parse(body.capturedAt)).toBeLessThanOrEqual(Date.now());
    expect(body.distanceToRegisteredMeters).toBeCloseTo(
      haversineMeters(GPS, { latitude: profile.client!.latitude!, longitude: profile.client!.longitude! }),
      0,
    );
    expect(body.distanceToNapMeters).toBeCloseTo(haversineMeters(GPS, nap.nap), 0);
  });

  it('cuenta sin NAP real: se vincula a la NAP asignada SIMULADA y lo marca', async () => {
    const res = await post(OTHER, { latitude: -2.2, longitude: -79.9, source: 'MANUAL', napPort: '4' });
    expect(res.statusCode).toBe(201);
    const nap = (await get(`/accounts/${OTHER}/current-nap`)).json();
    expect(nap.simulated).toBe(true);
    expect(res.json()).toMatchObject({
      source: 'MANUAL',
      accuracyMeters: null,
      taskId: null,
      napCode: nap.nap.napCode,
      napPort: 4,
      napLocation: { simulated: true },
    });
    expect(res.json().distanceToNapMeters).toBeGreaterThan(0);
  });

  it('napCode distinto al de current-nap: distanceToNapMeters null; napPort texto se conserva', async () => {
    const res = await post(OTHER, { ...GPS, napCode: 'ZZ00X', napPort: 'P-3' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      napCode: 'ZZ00X',
      napPort: 'P-3',
      distanceToNapMeters: null,
      napLocation: null,
    });
  });

  it('validación: rangos, (0,0), source, notes > 500, label y capturedAt futuro son 400', async () => {
    const bad: unknown[] = [
      { ...GPS, latitude: 91 },
      { ...GPS, longitude: -181 },
      { ...GPS, latitude: 0, longitude: 0 },
      { latitude: -2.2, longitude: -79.9 },
      { ...GPS, source: 'WIFI' },
      { ...GPS, accuracyMeters: -1 },
      { ...GPS, notes: 'x'.repeat(501) },
      { ...GPS, label: 'OFICINA' },
      { ...GPS, capturedAt: new Date(Date.now() + 3_600_000).toISOString() },
    ];
    for (const payload of bad) {
      const res = await post(OTHER, payload);
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    }
  });

  it('sin token es 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/${OTHER}/client-location`,
      headers: { 'content-type': 'application/json' },
      payload: GPS,
    });
    expect(res.statusCode).toBe(401);
  });

  it('FSM caído (real sin token): igual guarda, registrada null y NAP simulada; sin red', async () => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
    delete process.env.FSM_API_TOKEN_TELENEWS;
    resetFsmTokenCache();
    spy = installFetchSpy(() => ({ status: 500, raw: 'no debería llamarse' }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post(DOWN_ACCOUNT, GPS);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      registeredLocation: null,
      distanceToRegisteredMeters: null,
      napLocation: { simulated: true },
    });
    expect(res.json().napCode).toMatch(/^PL/);
    expect(spy.calls).toHaveLength(0);

    // La lectura tampoco falla: registrada null (la foto guardada también lo es).
    const list = await get(`/accounts/${DOWN_ACCOUNT}/client-location`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ registeredLocation: null, items: [{ id: res.json().id }] });
  });
});

describe('GET /accounts/{n}/client-location', () => {
  it('append-only: cada captura es una fila; más reciente primero; latest = la primera', async () => {
    const t1 = new Date(Date.now() - 20 * 60_000).toISOString();
    const t2 = new Date(Date.now() - 10 * 60_000).toISOString();
    const a = (await post(FOUND, { ...GPS, capturedAt: t1 })).json();
    const b = (await post(`0${FOUND}`, { ...GPS, latitude: -2.2481, capturedAt: t2 })).json();

    const res = await get(`/accounts/${FOUND}/client-location`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.items.map((i: { id: string }) => i.id);
    // 035070291 y 35070291 son la misma cuenta: se guarda normalizada.
    expect(b.accountNumber).toBe(FOUND);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(body.latest.id).toBe(body.items[0].id);
    expect(body.items.length).toBeLessThanOrEqual(50);
    expect(body.registeredLocation).toMatchObject({ source: 'MOCK' });
    const times = body.items.map((i: { capturedAt: string }) => Date.parse(i.capturedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it('cuenta sin capturas: latest null, items vacío', async () => {
    const res = await get('/accounts/91999999/client-location');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ latest: null, items: [] });
  });
});

describe('GET /client-locations (gerente)', () => {
  it('filtra por cuenta y rango, pagina con limit/page', async () => {
    const all = await get(`/client-locations?accountNumber=${OTHER}&limit=2&page=1`);
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.page).toMatchObject({ page: 1, pageSize: 2 });
    expect(body.page.totalItems).toBeGreaterThanOrEqual(2);
    expect(body.items.length).toBeLessThanOrEqual(2);
    expect(body.items.every((i: { accountNumber: string }) => i.accountNumber === OTHER)).toBe(true);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await get(`/client-locations?accountNumber=${OTHER}&from=${encodeURIComponent(future)}`);
    expect(none.json()).toMatchObject({ items: [], page: { totalItems: 0, totalPages: 0 } });
  });

  it('from > to y limit fuera de rango son 400', async () => {
    expect((await get('/client-locations?from=2026-09-30&to=2026-09-01')).statusCode).toBe(400);
    expect((await get('/client-locations?limit=500')).statusCode).toBe(400);
  });
});

describe('GET /accounts/{n}/visits?include=records — clientLocation', () => {
  it('la captura con taskId aparece en su visita como "Ubicación casa cliente"', async () => {
    const visits = await getFsmConnector().getVisits(VISITS_ACCOUNT, {
      brand: 'telenews',
      limit: env.FSM_ORDERS_MAX_FANOUT,
    });
    const visit = visits.items[0]!;
    const created = (await post(VISITS_ACCOUNT, { ...GPS, taskId: visit.workOrder })).json();

    const res = await get(`/accounts/${VISITS_ACCOUNT}/visits?include=records`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitsWithRecordsResult;
    const target = body.items.find((v) => v.workOrder === visit.workOrder)!;
    expect(target.records.clientLocations).toEqual([
      expect.objectContaining({ id: created.id, linkedBy: 'TASK_ID' }),
    ]);
    expect(target.records.checklist).toContainEqual({
      type: 'clientLocation',
      label: 'Ubicación casa cliente',
      done: true,
      count: 1,
    });
    // Las demás visitas lo tienen en el checklist, sin hacer.
    const others = body.items.filter((v) => v.workOrder !== visit.workOrder);
    for (const v of others) {
      expect(v.records.checklist.find((c) => c.type === 'clientLocation')).toMatchObject({ done: false });
    }
  });
});
