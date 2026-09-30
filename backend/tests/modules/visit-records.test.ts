// Visitas con sus registros (GET /accounts/{n}/visits?include=records) y
// speedtest de dispositivo externo. Requiere Postgres; FSM en mock.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';
import { env } from '../../src/config/env.js';
import { getFsmConnector, type VisitItem, type VisitsResult } from '../../src/connectors/index.js';
import {
  assignToVisit,
  attachRecords,
  visitWindow,
  VISIT_WINDOW_GRACE_MS,
  type VisitsWithRecordsResult,
} from '../../src/modules/tasks-visits/visit-records.service.js';

const PREFIX = '/herramientas/v1';
/** Cuenta fija del mock de FSM, reservada para este archivo. */
const ACCOUNT = '98765431';

let app: FastifyInstance;
let authHeaders: Record<string, string>;

async function cleanup(): Promise<void> {
  const where = { accountNumber: ACCOUNT };
  await Promise.all([
    prisma.speedtest.deleteMany({ where }),
    prisma.pingTest.deleteMany({ where }),
    prisma.tracerouteTest.deleteMany({ where }),
    prisma.distanceMeasurement.deleteMany({ where }),
  ]);
}

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  Object.assign(env, { CONNECTOR_MODE_FSM: 'mock' });
});

async function post(url: string, payload: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${PREFIX}${url}`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

const EXTERNAL = {
  accountNumber: ACCOUNT,
  source: 'external-device',
  downloadMbps: 9412.5,
  uploadMbps: 8120.3,
  latencyMs: 3.2,
  jitterMs: 0.4,
  deviceName: 'Tester 10G #1',
  deviceId: 'AND-10G-0001',
  simulated: true,
};

describe('POST /speedtests — dispositivo externo', () => {
  it('acepta source=external-device con timestamp como alias de measuredAt', async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const res = await post('/speedtests', { ...EXTERNAL, taskId: 'TASK/123456/2026', timestamp: at });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      source: 'external-device',
      deviceName: 'Tester 10G #1',
      deviceId: 'AND-10G-0001',
      simulated: true,
      taskId: 'TASK/123456/2026',
      downloadMbps: 9412.5,
      measuredAt: at,
    });
  });

  it('un speedtest de la app sigue funcionando igual (source=app, simulated=false)', async () => {
    const res = await post('/speedtests', {
      accountNumber: ACCOUNT,
      downloadMbps: 300,
      uploadMbps: 100,
      measuredAt: new Date(Date.now() - 3 * 365 * 86400_000).toISOString(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'app', simulated: false });
    expect(res.json()).not.toHaveProperty('taskId');
  });

  it('externo sin deviceName/deviceId → 400', async () => {
    const res = await post('/speedtests', {
      ...EXTERNAL,
      deviceName: undefined,
      deviceId: undefined,
      measuredAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toContain('deviceId');
  });

  it('externo por encima de 10 Gb/s → 400', async () => {
    const res = await post('/speedtests', { ...EXTERNAL, downloadMbps: 10_500, measuredAt: new Date().toISOString() });
    expect(res.statusCode).toBe(400);
  });

  it('sin measuredAt ni timestamp → 400', async () => {
    const res = await post('/speedtests', EXTERNAL);
    expect(res.statusCode).toBe(400);
  });
});

/** Visita cerrada (no cancelada) cuya ventana no se cruza con ninguna otra. */
function isolatedClosedVisit(visits: VisitsResult): { visit: VisitItem; index: number } {
  const now = new Date();
  const windows = visits.items.map((v) => visitWindow(v, now));
  const index = visits.items.findIndex((v, i) => {
    const w = windows[i];
    if (!w || v.result === 'PENDIENTE' || v.result === 'CANCELADA') return false;
    return windows.every((o, j) => j === i || !o || o.until < w.from || o.from > w.until);
  });
  if (index === -1) throw new Error(`El mock de ${ACCOUNT} no tiene una visita cerrada aislada.`);
  return { visit: visits.items[index] as VisitItem, index };
}

describe('GET /accounts/{n}/visits?include=records', () => {
  it('asocia por taskId y por ventana de tiempo; lo demás queda sin vincular', async () => {
    await cleanup();
    const visits = await getFsmConnector().getVisits(ACCOUNT, {
      brand: 'telenews',
      limit: env.FSM_ORDERS_MAX_FANOUT,
    });
    const { visit } = isolatedClosedVisit(visits);
    const end = Date.parse((visit.endedAt ?? visit.occurredAt) as string);

    // 1) Por taskId: medido HOY (fuera de la ventana) pero con el workOrder.
    expect((await post('/speedtests', { ...EXTERNAL, taskId: visit.workOrder, measuredAt: new Date().toISOString() })).statusCode).toBe(201);
    // 2) Por ventana: sin taskId, 10 min antes del cierre.
    expect(
      (
        await post('/ping-tests', {
          accountNumber: ACCOUNT,
          target: '8.8.8.8',
          packetsSent: 10,
          packetsReceived: 10,
          avgLatencyMs: 12.3,
          measuredAt: new Date(end - 10 * 60_000).toISOString(),
        })
      ).statusCode,
    ).toBe(201);
    // 3) Sin vínculo: hace 3 años, sin taskId.
    expect(
      (
        await post('/speedtests', {
          accountNumber: ACCOUNT,
          downloadMbps: 50,
          uploadMbps: 10,
          measuredAt: new Date(Date.now() - 3 * 365 * 86400_000).toISOString(),
        })
      ).statusCode,
    ).toBe(201);

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${ACCOUNT}/visits?include=records`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitsWithRecordsResult;
    expect(body.items).toHaveLength(visits.items.length);
    expect(body.recordsSummary).toMatchObject({ linked: 2, unlinked: 1, windowGraceHours: 2, windowLookbackHours: 72 });

    const target = body.items.find((v) => v.workOrder === visit.workOrder)!;
    expect(target.records.linkedBy).toBe('MIXED');
    expect(target.records.speedtests).toHaveLength(1);
    expect(target.records.speedtests[0]).toMatchObject({
      source: 'external-device',
      downloadMbps: 9412.5,
      latencyMs: 3.2,
      jitterMs: 0.4,
      simulated: true,
      linkedBy: 'TASK_ID',
    });
    expect(target.records.pingTests[0]).toMatchObject({ avgLatencyMs: 12.3, linkedBy: 'TIME_WINDOW' });
    const check = Object.fromEntries(target.records.checklist.map((c) => [c.type, c]));
    expect(check.externalSpeedtest).toMatchObject({ done: true, count: 1 });
    expect(check.ping).toMatchObject({ done: true, count: 1 });
    expect(check.speedtest).toMatchObject({ done: false, count: 0 });
    expect(check.traceroute).toMatchObject({ done: false, count: 0 });

    // El resto de visitas: sin registros pero con checklist completo en "no".
    for (const other of body.items.filter((v) => v.workOrder !== visit.workOrder)) {
      expect(other.records.linkedBy).toBeNull();
      expect(other.records.checklist.every((c) => !c.done)).toBe(true);
      if (other.result === 'CANCELADA') expect(other.records.window).toBeNull();
    }
  });

  it('sin include la respuesta no cambia (contrato histórico)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${ACCOUNT}/visits`,
      headers: authHeaders,
    });
    const body = res.json() as Record<string, unknown> & { items: Array<Record<string, unknown>> };
    expect(body).not.toHaveProperty('recordsSummary');
    expect(body.items[0]).not.toHaveProperty('records');
    expect(body.items[0]).toHaveProperty('createdAt');
  });

  it('include inválido → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${ACCOUNT}/visits?include=todo`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('asociación (pura)', () => {
  const now = new Date('2026-09-30T18:00:00.000Z');
  const visit = (over: Partial<VisitItem>): VisitItem => ({
    taskId: 'ORDER/1/2026',
    workOrder: 'ORDER/1/2026',
    occurredAt: '2026-09-20T15:00:00.000Z',
    reason: '',
    closingNotes: '',
    technician: null,
    result: 'SATISFACTORIA',
    notesLoaded: true,
    createdAt: '2026-09-20T10:00:00.000Z',
    endedAt: '2026-09-20T15:00:00.000Z',
    fsmTaskId: 'TASK/11/2026',
    ...over,
  });

  it('ventana: creación → fin + 2 h; la pendiente llega hasta ahora + 2 h; cancelada sin ventana', () => {
    expect(visitWindow(visit({}), now)).toEqual({
      from: Date.parse('2026-09-20T10:00:00.000Z'),
      until: Date.parse('2026-09-20T15:00:00.000Z') + VISIT_WINDOW_GRACE_MS,
    });
    expect(visitWindow(visit({ result: 'PENDIENTE', endedAt: null }), now)?.until).toBe(
      now.getTime() + VISIT_WINDOW_GRACE_MS,
    );
    expect(visitWindow(visit({ result: 'CANCELADA' }), now)).toBeNull();
  });

  it('la ventana no mira más de 72 h antes del fin', () => {
    const w = visitWindow(visit({ createdAt: '2026-08-01T00:00:00.000Z' }), now);
    expect(w?.from).toBe(Date.parse('2026-09-17T15:00:00.000Z'));
  });

  it('taskId acepta el ORDER/… o el TASK/… de la visita, sin distinguir mayúsculas', () => {
    const visits = [visit({})];
    const windows = [null];
    expect(assignToVisit({ taskId: 'order/1/2026', at: '2020-01-01T00:00:00Z' }, visits, windows)).toEqual({ index: 0, linkedBy: 'TASK_ID' });
    expect(assignToVisit({ taskId: 'TASK/11/2026', at: '2020-01-01T00:00:00Z' }, visits, windows)).toEqual({ index: 0, linkedBy: 'TASK_ID' });
    expect(assignToVisit({ taskId: 'TASK/99/2026', at: '2020-01-01T00:00:00Z' }, visits, windows)).toBeNull();
  });

  it('cancelada: solo por taskId', () => {
    const visits = [visit({ result: 'CANCELADA' })];
    const windows = visits.map((v) => visitWindow(v, now));
    expect(assignToVisit({ at: '2026-09-20T14:00:00.000Z' }, visits, windows)).toBeNull();
    expect(assignToVisit({ taskId: 'ORDER/1/2026', at: '2026-09-20T14:00:00.000Z' }, visits, windows)).toEqual({ index: 0, linkedBy: 'TASK_ID' });
  });

  it('en ventanas solapadas gana la visita de cierre más próximo', () => {
    const a = visit({ workOrder: 'ORDER/A', endedAt: '2026-09-20T15:00:00.000Z', createdAt: '2026-09-20T08:00:00.000Z' });
    const b = visit({ workOrder: 'ORDER/B', fsmTaskId: null, endedAt: '2026-09-20T12:00:00.000Z', createdAt: '2026-09-20T08:00:00.000Z' });
    const windows = [a, b].map((v) => visitWindow(v, now));
    expect(assignToVisit({ at: '2026-09-20T11:30:00.000Z' }, [a, b], windows)?.index).toBe(1);
    expect(assignToVisit({ at: '2026-09-20T14:30:00.000Z' }, [a, b], windows)?.index).toBe(0);
  });

  it('sin visitas → items vacíos y todo sin vincular', () => {
    const empty: VisitsResult = { items: [], pendingCount: 0, totalOrders: 0, scanned: 0, truncated: false, brand: 'telenews' };
    const out = attachRecords(
      empty,
      {
        speedtests: [{ id: 'x', accountNumber: '1', createdAt: '', downloadMbps: 1, uploadMbps: 1, measuredAt: '2026-09-20T11:30:00.000Z', source: 'app', simulated: false }],
        pingTests: [],
        tracerouteTests: [],
        wifiHeatmaps: [],
        distanceMeasurements: [],
        retiredEquipment: [],
      },
      now,
    );
    expect(out.items).toEqual([]);
    expect(out.recordsSummary).toMatchObject({ linked: 0, unlinked: 1 });
  });
});
