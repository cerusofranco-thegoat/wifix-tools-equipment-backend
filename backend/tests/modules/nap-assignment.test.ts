// NAP elegida en Instalación (POST/GET /accounts/{n}/nap-assignment y
// GET /nap-assignments) + su registro en /visits?include=records.
// Requiere Postgres; FSM en mock (cero red).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';
import { env } from '../../src/config/env.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import { getFsmConnector } from '../../src/connectors/index.js';
import type { VisitsWithRecordsResult } from '../../src/modules/tasks-visits/visit-records.service.js';

const PREFIX = '/herramientas/v1';
/** Cuentas reservadas para este archivo. */
const ACCOUNT = '92000001';
const OTHER = '92000002';
const VISITS_ACCOUNT = '92000003';
const ACCOUNTS = [ACCOUNT, `0${ACCOUNT}`, OTHER, VISITS_ACCOUNT];

let app: FastifyInstance;
let authHeaders: Record<string, string>;
let testUserId: string;

const originalEnv = { CONNECTOR_MODE_FSM: env.CONNECTOR_MODE_FSM };

async function cleanup(): Promise<void> {
  await prisma.napAssignment.deleteMany({ where: { accountNumber: { in: ACCOUNTS } } });
}

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'tester@wifix.test' }, select: { id: true } });
  testUserId = user.id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  Object.assign(env, originalEnv);
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  Object.assign(env, { CONNECTOR_MODE_FSM: 'mock' });
  resetHttpCache();
});

function post(account: string, payload: unknown, headers = authHeaders): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${PREFIX}/accounts/${account}/nap-assignment`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: authHeaders });
}

const NAP = {
  napId: '12345',
  napCode: 'QQ4JC1',
  napName: 'NAP QQ4JC1 - ABDON CALDERON',
  port: 3,
  latitude: -2.1980433,
  longitude: -79.881607,
  distanceMeters: 120,
  source: 'FSM',
  taskId: 'TASK/549487/2026',
  workOrder: 'ORDER/463158/2026',
};

describe('POST /accounts/{n}/nap-assignment', () => {
  it('exige autenticación', async () => {
    const res = await post(ACCOUNT, NAP, {});
    expect(res.statusCode).toBe(401);
  });

  it('201 con la fila guardada y el técnico del JWT', async () => {
    const res = await post(ACCOUNT, NAP);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      id: expect.any(String),
      accountNumber: ACCOUNT,
      ...NAP,
      technicianId: testUserId,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });

  it('opcionales en null/ausentes; napId numérico se guarda como texto; cuenta normalizada', async () => {
    const res = await post(`0${ACCOUNT}`, {
      napId: null,
      napCode: ' AR7S1 ',
      latitude: -2.0761,
      longitude: -79.854,
      source: 'TEC',
      port: null,
      taskId: null,
      workOrder: null,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      accountNumber: ACCOUNT,
      napId: null,
      napCode: 'AR7S1',
      napName: null,
      port: null,
      distanceMeters: null,
      source: 'TEC',
      taskId: null,
      workOrder: null,
    });
    const numeric = await post(OTHER, { ...NAP, napId: 11548, source: 'MOCK' });
    expect(numeric.statusCode).toBe(201);
    expect(numeric.json()).toMatchObject({ napId: '11548', source: 'MOCK' });
  });

  it('validación: coordenadas, (0,0), source, napCode, port y distancia → 400', async () => {
    const bad: Array<Record<string, unknown>> = [
      { ...NAP, latitude: 91 },
      { ...NAP, longitude: -181 },
      { ...NAP, latitude: 0, longitude: 0 },
      { ...NAP, latitude: '-2.19' },
      { ...NAP, source: 'GPS' },
      { ...NAP, napCode: '' },
      { ...NAP, napCode: undefined },
      { ...NAP, port: 2.5 },
      { ...NAP, port: -1 },
      { ...NAP, distanceMeters: -5 },
      { ...NAP, latitude: undefined },
    ];
    for (const payload of bad) {
      const res = await post(ACCOUNT, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    }
    // Cuenta demasiado larga (mismo límite que client-location).
    expect((await post('9'.repeat(51), NAP)).statusCode).toBe(400);
  });
});

describe('GET /accounts/{n}/nap-assignment', () => {
  it('append-only: más reciente primero, latest = la primera; variantes de cuenta juntas', async () => {
    const a = (await post(ACCOUNT, { ...NAP, port: 1 })).json();
    const b = (await post(`0${ACCOUNT}`, { ...NAP, port: 2 })).json();
    const res = await get(`/accounts/${ACCOUNT}/nap-assignment`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const ids = body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(a.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(body.latest).toEqual(body.items[0]);
    expect(body.latest.id).toBe(b.id);
    const times = body.items.map((i: { createdAt: string }) => Date.parse(i.createdAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    // La lectura con el cero inicial devuelve lo mismo.
    const padded = (await get(`/accounts/0${ACCOUNT}/nap-assignment`)).json();
    expect(padded.items.map((i: { id: string }) => i.id)).toEqual(ids);
  });

  it('cuenta sin elecciones: latest null, items vacío', async () => {
    const res = await get('/accounts/92999999/nap-assignment');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ latest: null, items: [] });
  });
});

describe('GET /nap-assignments (gerente)', () => {
  it('pagina por cursor sin repetir ni saltar filas', async () => {
    for (let i = 0; i < 5; i++) await post(OTHER, { ...NAP, port: i });
    const total = await prisma.napAssignment.count({ where: { accountNumber: OTHER } });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/nap-assignments?accountNumber=${OTHER}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await get(q);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Array<{ id: string; accountNumber: string }>; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.items.every((i) => i.accountNumber === OTHER)).toBe(true);
      seen.push(...body.items.map((i) => i.id));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(total);
  });

  it('sin filtro lista todas las cuentas; limit y cursor inválidos → 400', async () => {
    const res = await get('/nap-assignments?limit=1');
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(typeof res.json().nextCursor).toBe('string');
    expect((await get('/nap-assignments?limit=500')).statusCode).toBe(400);
    expect((await get('/nap-assignments?limit=0')).statusCode).toBe(400);
    expect((await get('/nap-assignments?cursor=no-es-uuid')).statusCode).toBe(400);
  });
});

describe('GET /accounts/{n}/visits?include=records — napAssignment', () => {
  it('la NAP elegida con taskId aparece en su visita como "NAP elegida (instalación)"', async () => {
    const visits = await getFsmConnector().getVisits(VISITS_ACCOUNT, {
      brand: 'telenews',
      limit: env.FSM_ORDERS_MAX_FANOUT,
    });
    const visit = visits.items[0]!;
    const created = (await post(VISITS_ACCOUNT, { ...NAP, taskId: visit.workOrder })).json();

    const res = await get(`/accounts/${VISITS_ACCOUNT}/visits?include=records`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitsWithRecordsResult;
    const target = body.items.find((v) => v.workOrder === visit.workOrder)!;
    expect(target.records.napAssignments).toEqual([
      expect.objectContaining({ id: created.id, napCode: 'QQ4JC1', linkedBy: 'TASK_ID' }),
    ]);
    expect(target.records.checklist).toContainEqual({
      type: 'napAssignment',
      label: 'NAP elegida (instalación)',
      done: true,
      count: 1,
    });
    for (const v of body.items.filter((x) => x.workOrder !== visit.workOrder)) {
      expect(v.records.napAssignments).toEqual([]);
      expect(v.records.checklist.find((c) => c.type === 'napAssignment')).toMatchObject({ done: false });
    }
  });
});
