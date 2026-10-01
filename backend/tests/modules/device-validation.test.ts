// Validación de equipo vs plan contratado: GET /device-catalog,
// POST/GET /accounts/{n}/device-validations, GET /device-validations y su
// registro en /visits?include=records. Requiere Postgres con la migración
// 20261001120000 aplicada (siembra el catálogo).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';
import { env } from '../../src/config/env.js';
import { comarchMock } from '../../src/connectors/comarch/index.js';
import { attachRecords } from '../../src/modules/tasks-visits/visit-records.service.js';
import type { DeviceValidationDto } from '../../src/modules/device-validation/device-validation.mappers.js';
import type { VisitsResult } from '../../src/connectors/index.js';

const PREFIX = '/herramientas/v1';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
/** Cuenta con plan simulado de 1000 Mbps y otra con plan < 500. */
let ACC_1000 = '';
let ACC_LOW = '';
let LOW_PLAN = 0;
const accounts: string[] = [];

const originalEnv = { CONNECTOR_MODE_COMARCH: env.CONNECTOR_MODE_COMARCH };

/** Busca cuentas del rango reservado 93000000+ con el plan del mock pedido. */
async function findAccount(match: (mbps: number) => boolean): Promise<{ account: string; mbps: number }> {
  for (let i = 1; i < 500; i++) {
    const account = String(93000000 + i);
    const { contractedDownloadMbps } = await comarchMock.getClientProfile(account);
    if (match(contractedDownloadMbps)) return { account, mbps: contractedDownloadMbps };
  }
  throw new Error('no se encontró cuenta con ese plan en el mock');
}

async function cleanup(): Promise<void> {
  if (accounts.length) await prisma.deviceValidation.deleteMany({ where: { accountNumber: { in: accounts } } });
}

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
  ACC_1000 = (await findAccount((m) => m === 1000)).account;
  const low = await findAccount((m) => m <= 400);
  ACC_LOW = low.account;
  LOW_PLAN = low.mbps;
  accounts.push(ACC_1000, ACC_LOW);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  Object.assign(env, originalEnv);
  await app.close();
  await prisma.$disconnect();
});

afterEach(() => {
  Object.assign(env, originalEnv);
});

function post(account: string, payload: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `${PREFIX}/accounts/${account}/device-validations`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: authHeaders });
}

describe('GET /device-catalog', () => {
  it('19 modelos activos con la forma del contrato', async () => {
    const res = await get('/device-catalog');
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: Array<Record<string, unknown>> };
    expect(items).toHaveLength(19);
    const f660 = items.find((i) => i.model === 'ZXHN F660');
    expect(f660).toEqual({
      model: 'ZXHN F660',
      displayName: 'ZXHN F660',
      brand: 'ZTE',
      deviceType: 'ONT',
      category: 'ONT / ONU (GPON)',
      wifiTech: 'WIFI 4',
      ethernetMaxMbps: 1000,
      wifiMaxMbps: 300,
      wifiStatus: 'disabled',
      serialPrefixes: ['ZTEG'],
    });
  });

  it('sin token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/device-catalog` });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /accounts/{n}/device-validations', () => {
  it('plan 1000 con F670L → 201 blocked (wifi), plan simulado, técnico del JWT', async () => {
    const res = await post(ACC_1000, {
      serial: 'ZTEGD4B47E30',
      model: 'ZXHN F670L',
      category: 'instalaciones',
      serialSource: 'barcode',
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as DeviceValidationDto;
    expect(body).toMatchObject({
      result: 'blocked',
      planMbps: 1000,
      planSource: 'simulated',
      reasons: [{ kind: 'wifi', deviceMbps: 500, planMbps: 1000 }],
      accountNumber: ACC_1000,
      category: 'instalaciones',
      serial: 'ZTEGD4B47E30',
      serialSource: 'barcode',
      taskId: null,
      technician: { email: 'tester@wifix.test' },
    });
    expect(body.device?.model).toBe('ZXHN F670L');
    expect(body.message).toContain('plan contratado (1000 Mbps)');
    expect(typeof body.id).toBe('string');
    expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
  });

  it('plan 1000 con F6600 → ok, con taskId', async () => {
    const res = await post(ACC_1000, {
      serial: 'ZTEGAAAA0001',
      model: 'ont zte zxhn f6600 wifi 6',
      category: 'migraciones',
      taskId: 'TASK/123456/2026',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ result: 'ok', reasons: [], taskId: 'TASK/123456/2026' });
  });

  it('plan bajo con F660 → ok', async () => {
    const res = await post(ACC_LOW, { serial: 'ZTEG00000001', model: 'ZXHN F660', category: 'visitas' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ result: 'ok', planMbps: LOW_PLAN });
  });

  it('modelo obsoleto → blocked not_in_catalog, device null (se guarda igual)', async () => {
    const res = await post(ACC_1000, {
      serial: 'X1',
      model: 'ROUTER LINKSYS E2500 WIFI 300 MBPS',
      category: 'instalaciones',
      serialSource: 'manual',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      result: 'blocked',
      device: null,
      reasons: [{ kind: 'not_in_catalog', planMbps: 1000 }],
    });
  });

  it('fuente del plan caída → unknown_plan, planSource real', async () => {
    Object.assign(env, { CONNECTOR_MODE_COMARCH: 'real' });
    const res = await post(ACC_LOW, { serial: 'ZTEG00000002', model: 'ZXHN F670L', category: 'visitas' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ result: 'unknown_plan', planMbps: null, planSource: 'real', reasons: [] });
  });

  it('body inválido → 400 VALIDATION_ERROR con detalles', async () => {
    const res = await post(ACC_1000, { serial: '', model: 'ZXHN F670L', category: 'otra', serialSource: 'x' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { code: string; details: Array<{ field: string }> };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.map((d) => d.field).sort()).toEqual(['category', 'serial', 'serialSource']);
  });

  it('planMbps del cliente se ignora (no viene del body)', async () => {
    const res = await post(ACC_LOW, {
      serial: 'ZTEG00000003',
      model: 'ZXHN F670L',
      category: 'visitas',
      planMbps: 50,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ planMbps: LOW_PLAN });
  });
});

describe('GET de validaciones', () => {
  it('historial por cuenta (más reciente primero; acepta ceros a la izquierda)', async () => {
    const res = await get(`/accounts/0${ACC_1000}/device-validations`);
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: DeviceValidationDto[] };
    expect(items.length).toBe(3);
    expect(items.every((i) => i.accountNumber === ACC_1000)).toBe(true);
    const times = items.map((i) => Date.parse(i.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('lista de gerente filtrada por result=blocked y fechas', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const res = await get(
      `/device-validations?result=blocked&from=${encodeURIComponent(from)}&accountNumber=${ACC_1000}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: DeviceValidationDto[]; page: { totalItems: number } };
    expect(body.items.length).toBe(2);
    expect(body.page.totalItems).toBe(2);
    expect(body.items.every((i) => i.result === 'blocked' && i.technician.email === 'tester@wifix.test')).toBe(true);
  });

  it('result inválido o from > to → 400', async () => {
    expect((await get('/device-validations?result=nope')).statusCode).toBe(400);
    expect(
      (await get('/device-validations?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z')).statusCode,
    ).toBe(400);
  });
});

describe('visits?include=records', () => {
  it('las validaciones se reparten por taskId como los demás registros', () => {
    const visits = {
      items: [
        {
          workOrder: 'ORDER/1/2026',
          fsmTaskId: 'TASK/123456/2026',
          result: 'EXITOSA',
          createdAt: '2026-09-01T10:00:00Z',
          endedAt: '2026-09-01T12:00:00Z',
          occurredAt: '2026-09-01T12:00:00Z',
        },
      ],
    } as unknown as VisitsResult;
    const validation = {
      id: 'v1',
      taskId: 'TASK/123456/2026',
      createdAt: '2026-10-01T00:00:00Z',
    } as unknown as DeviceValidationDto;
    const out = attachRecords(
      visits,
      {
        speedtests: [],
        pingTests: [],
        tracerouteTests: [],
        wifiHeatmaps: [],
        distanceMeasurements: [],
        retiredEquipment: [],
        deviceValidations: [validation],
      },
      new Date('2026-10-01T00:00:00Z'),
    );
    const records = out.items[0]?.records;
    expect(records?.deviceValidations).toHaveLength(1);
    expect(records?.deviceValidations[0]?.linkedBy).toBe('TASK_ID');
    expect(records?.checklist.find((c) => c.type === 'deviceValidation')).toMatchObject({ done: true, count: 1 });
  });
});
