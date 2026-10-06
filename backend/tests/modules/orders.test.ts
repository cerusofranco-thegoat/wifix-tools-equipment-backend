// GET /orders/context y GET /orders/task-check — TYTAN SIMULADO.
// Sin base de datos: la whitelist se reemplaza por un doble en memoria.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';
import {
  resetOrderCandidateCache,
  setAccountLookupRepository,
  type AccountLookupRepository,
  type LookupAccount,
} from '../../src/modules/account-lookup/account-lookup.service.js';
import { buildOrderContext, type OrderContext } from '../../src/modules/orders/orders.generator.js';

const PREFIX = '/herramientas/v1';
const IMPORTED_AT = new Date('2026-09-26T22:07:00.000Z');
const ORDER = 'ORDER/463158/2026';

let app: FastifyInstance;
let authHeaders: Record<string, string>;

function account(n: number, extra: Partial<LookupAccount> = {}): LookupAccount & { documentId: string } {
  return {
    accountNumber: String(8400000 + n),
    documentId: `09${String(n).padStart(8, '0')}`,
    status: 'ACTIVO',
    city: n % 2 === 0 ? 'GUAYAQUIL' : 'QUITO',
    node: 'QQ4B',
    businessType: n % 3 === 0 ? 'Internet HFC' : 'Internet GPON',
    accountType: 'Residencial',
    accessType: null,
    fullName: n % 4 === 0 ? null : `CLIENTE SINTETICO ${n}`,
    ...extra,
  };
}

const ROWS = Array.from({ length: 25 }, (_, i) => account(i));

const fakeRepo: AccountLookupRepository = {
  async findByDocument() {
    return [];
  },
  async latestImportAt() {
    return IMPORTED_AT;
  },
  async countOrderCandidates() {
    return ROWS.length;
  },
  async findOrderCandidateAt(index) {
    return ROWS[index] ?? null;
  },
};

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  setAccountLookupRepository(null);
  resetOrderCandidateCache();
  await app.close();
});

beforeEach(() => {
  resetOrderCandidateCache();
  setAccountLookupRepository(fakeRepo);
});

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: authHeaders });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

const enc = encodeURIComponent;
const isIso = (v: unknown): boolean => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v);

/** Invariantes del contrato §3 sobre un contexto cualquiera. */
function assertContextShape(ctx: OrderContext, now: Date): void {
  expect(ctx.simulated).toBe(true);
  expect(ctx.source).toBe('TYTAN');
  expect(Object.keys(ctx).sort()).toEqual(
    ['client', 'equipment', 'observations', 'order', 'registeredAddress', 'simulated', 'source', 'tasks'],
  );

  const o = ctx.order;
  expect(['Visita Técnica', 'Instalación', 'Migración']).toContain(o.orderType);
  expect(['HFC', 'GPON']).toContain(o.technology);
  expect(['Realizado', 'Cancelado', 'Pendiente', 'En curso']).toContain(o.status);
  expect(isIso(o.createdAt) && isIso(o.slaAt)).toBe(true);
  expect(o.closedAt === null || isIso(o.closedAt)).toBe(true);
  expect(o.externalSystem).toBe('TYTAN');
  expect(o.externalId).toMatch(/^\d{8}$/);
  expect(o.signatureProcess).toMatch(/^FSM_(VISTEC|INST|MIGRA)\/\d{6}\/\d{4}$/);

  const c = ctx.client;
  expect(c.phones.length).toBeGreaterThan(0);
  expect(c.phones[0]).toMatch(/^09\d{8}$/);
  for (const p of c.phones) expect(p).toMatch(/^(09\d{8}|0[24]\d{7})$/);
  expect(c.address).toMatch(/^(Guayaquil|Quito), /);
  expect(c.latitude).toBeGreaterThan(-2.3);
  expect(c.latitude).toBeLessThan(0);
  expect(c.longitude).toBeGreaterThan(-80);
  expect(c.longitude).toBeLessThan(-78.4);
  expect(c.napCode).toMatch(/^[A-Z]{2}\d[A-Z]{2}\d$/);
  expect(c.zoneCode).toMatch(/^[A-Z]{2}\d[A-Z]{2}$/);
  expect(c.napCode.slice(0, 3)).toBe(c.zoneCode.slice(0, 3));

  // 2–5 tareas, la más reciente primero; a lo sumo una Pendiente y es la de hoy.
  expect(ctx.tasks.length).toBeGreaterThanOrEqual(2);
  expect(ctx.tasks.length).toBeLessThanOrEqual(5);
  const ids = new Set(ctx.tasks.map((t) => t.taskId));
  expect(ids.size).toBe(ctx.tasks.length);
  const pending = ctx.tasks.filter((t) => t.status === 'Pendiente');
  expect(pending.length).toBeLessThanOrEqual(1);
  if (pending.length === 1) {
    expect(ctx.tasks[0]?.status).toBe('Pendiente');
    expect(['Pendiente', 'En curso']).toContain(o.status);
    expect(o.closedAt).toBeNull();
    const ecuadorToday = new Date(now.getTime() - 5 * 3600_000).toISOString().slice(0, 10);
    const scheduled = new Date(Date.parse(pending[0]?.scheduledFrom as string) - 5 * 3600_000);
    expect(scheduled.toISOString().slice(0, 10)).toBe(ecuadorToday);
  } else {
    expect(o.status).toBe(ctx.tasks[0]?.status);
    expect(o.closedAt).not.toBeNull();
  }
  const finished = ctx.tasks.filter((t) => t.status !== 'Pendiente').map((t) => t.status);
  if (ctx.tasks.length >= 3 || pending.length === 0) {
    expect(new Set(finished)).toEqual(new Set(['Realizado', 'Cancelado']));
  }
  for (let i = 1; i < ctx.tasks.length; i++) {
    expect(Date.parse(ctx.tasks[i - 1]?.scheduledFrom as string)).toBeGreaterThan(
      Date.parse(ctx.tasks[i]?.scheduledFrom as string),
    );
  }

  for (const t of ctx.tasks) {
    expect(t.taskId).toMatch(/^TASK\/\d{6,7}\/\d{4}$/);
    expect(t.taskType).toMatch(/^(Visita Técnica|Instalación) (HFC|GPON)$|^Migración HFC a GPON$/);
    expect(t.assignedTo).toMatch(/^CONN-\d{3} (GYE|UIO) (VT|INST|MIGRA) \| [A-ZÑ ]+$/);
    expect(t.priority).toBeGreaterThanOrEqual(1);
    if (t.status === 'Pendiente') {
      expect(t.closure).toBeNull();
      expect(t.doneFrom).toBeNull();
    } else if (t.status === 'Realizado') {
      expect(isIso(t.doneFrom) && isIso(t.doneTo)).toBe(true);
      expect(t.closure?.result).toBe('Satisfactoria');
      expect(t.closure?.notes).toMatch(
        /^CTO: \S+ DIRECCIÓN: .+ COORDENADAS: -?\d+\.\d+,-?\d+\.\d+ NIVELES EN EL PUNTO: -?\d+ NIVELES EN LA NAP -?\d+ NUMERACION DE LA NAP: [A-Z0-9]{6} METRAJE DE CABLEADO/,
      );
      expect(t.closure?.notes).toContain(`CTO: ${c.accountNumber} `);
      expect(t.closure?.notes).toContain(`NUMERACION DE LA NAP: ${c.napCode} `);
      expect(t.closure?.materials.length).toBeGreaterThan(0);
      for (const m of t.closure?.materials ?? []) {
        expect(m.type).toBe('Material');
        expect(m.name).toMatch(/\[[A-Z0-9-]+\]$/);
        expect(m.quantity).toBeGreaterThan(0);
      }
    } else {
      expect(t.doneFrom).toBeNull();
      expect(t.closure?.result).toBe('Insatisfactoria');
      expect(t.closure?.materials).toEqual([]);
    }
  }

  // 2–4 equipos: módem/ONT e Internet (sin serial) siempre.
  expect(ctx.equipment.length).toBeGreaterThanOrEqual(2);
  expect(ctx.equipment.length).toBeLessThanOrEqual(4);
  const modem = ctx.equipment.find((e) => e.shortName === 'Modem');
  expect(modem).toBeDefined();
  if (o.technology === 'GPON') {
    expect(modem).toMatchObject({ model: 'ONT ZTE ZXHN F6600 WIFI 6', type: 'SERVICE CALL+GPON' });
    expect(modem?.serial).toMatch(/^ZTEG[0-9A-F]{8}$/);
  }
  expect(modem?.mac).toMatch(/^[0-9A-F]{12}$/);
  const internet = ctx.equipment.find((e) => e.shortName === 'Internet');
  expect(internet).toMatchObject({ model: null, serial: null, mac: null });
  const ext = ctx.equipment.find((e) => e.shortName === 'Extensor WiFi');
  if (ext) {
    expect(ext.model).toBe('AX3 DUAL CORE WIFI 6 WiFi N Plus Ultra');
    expect(ext.serial).toMatch(/^BWH\d+$/);
  }
  expect(new Set(ctx.equipment.map((e) => e.serviceId)).size).toBe(ctx.equipment.length);
  for (const e of ctx.equipment) {
    expect(e.serviceId).toMatch(/^\d{9}$/);
    expect(e.status).toBe('Aprovisionado');
  }

  expect(ctx.registeredAddress.length).toBeGreaterThan(10);
  expect(ctx.observations.length).toBeGreaterThan(10);
}

describe('GET /orders/context', () => {
  it('exige autenticación', async () => {
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/orders/context?workOrder=${enc(ORDER)}` });
    expect(res.statusCode).toBe(401);
  });

  it('responde el contexto completo con el shape del contrato', async () => {
    const res = await get(`/orders/context?workOrder=${enc(ORDER)}`);
    expect(res.status).toBe(200);
    expect(res.body.order).toMatchObject({ workOrder: ORDER, externalSystem: 'TYTAN' });
    assertContextShape(res.body as unknown as OrderContext, new Date());
    // LOPDP: el documento de la whitelist no sale.
    expect(res.raw).not.toContain('documentId');
    for (const r of ROWS) expect(res.raw).not.toContain(r.documentId);
  });

  it('la cuenta del contexto es la MISMA que devuelve el lookup por esa orden', async () => {
    for (const n of [463158, 463159, 500001, 123456, 987654]) {
      const order = `ORDER/${n}/2026`;
      const lookup = await app.inject({
        method: 'POST',
        url: `${PREFIX}/accounts/lookup`,
        headers: authHeaders,
        payload: { order },
      });
      const match = (lookup.json() as { matches: LookupAccount[] }).matches[0] as LookupAccount;
      const ctx = (await get(`/orders/context?workOrder=${enc(order)}`)).body as unknown as OrderContext;
      expect(ctx.client.accountNumber).toBe(match.accountNumber);
      // Nombre de la planilla si lo hay; si no, uno generado.
      if (match.fullName) expect(ctx.client.fullName).toBe(match.fullName);
      else expect(ctx.client.fullName.length).toBeGreaterThan(5);
    }
  });

  it('determinístico: misma orden → misma respuesta; solo dígitos equivale a la orden completa', async () => {
    const year = new Date(Date.now() - 5 * 3600_000).getUTCFullYear();
    const a = await get(`/orders/context?workOrder=${enc(`ORDER/463158/${year}`)}`);
    const b = await get(`/orders/context?workOrder=${enc(`ORDER/463158/${year}`)}`);
    const c = await get('/orders/context?workOrder=463158');
    expect(b.raw).toBe(a.raw);
    expect(c.raw).toBe(a.raw);
  });

  it('órdenes distintas → datos distintos', async () => {
    const a = await get(`/orders/context?workOrder=${enc('ORDER/463158/2026')}`);
    const b = await get(`/orders/context?workOrder=${enc('ORDER/463159/2026')}`);
    expect(b.raw).not.toBe(a.raw);
  });

  it('formato inválido o ausente → 400 VALIDATION_ERROR', async () => {
    for (const q of ['', '?workOrder=', `?workOrder=${enc('TASK/549487/2026')}`, '?workOrder=12']) {
      const res = await get(`/orders/context${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('buildOrderContext (generador puro)', () => {
  const NOW = new Date('2026-10-06T15:00:00.000Z');

  it('idéntico para la misma orden y el mismo día; cumple el contrato en 300 órdenes', () => {
    const tech = new Set<string>();
    const types = new Set<string>();
    const counts = new Set<number>();
    const equipCounts = new Set<number>();
    let withPending = 0;
    for (let n = 0; n < 300; n++) {
      const order = `ORDER/${400000 + n * 37}/2026`;
      const acc = ROWS[n % ROWS.length] as LookupAccount;
      const ctx = buildOrderContext(order, acc, NOW);
      expect(buildOrderContext(order, acc, NOW)).toEqual(ctx);
      // Otro instante del MISMO día en Ecuador → idéntico.
      expect(buildOrderContext(order, acc, new Date('2026-10-07T04:59:00.000Z'))).toEqual(ctx);
      assertContextShape(ctx, NOW);
      tech.add(ctx.order.technology);
      types.add(ctx.order.orderType);
      counts.add(ctx.tasks.length);
      equipCounts.add(ctx.equipment.length);
      if (ctx.tasks[0]?.status === 'Pendiente') withPending += 1;
    }
    expect(tech).toEqual(new Set(['HFC', 'GPON']));
    expect(types).toEqual(new Set(['Visita Técnica', 'Instalación', 'Migración']));
    expect(counts).toEqual(new Set([2, 3, 4, 5]));
    expect(equipCounts).toEqual(new Set([2, 3, 4]));
    // La mayoría tiene la tarea de hoy pendiente.
    expect(withPending).toBeGreaterThan(200);
  });

  it('la ciudad y la tecnología siguen a la whitelist cuando la traen', () => {
    const quito = buildOrderContext(ORDER, account(1, { city: 'QUITO', businessType: 'Internet GPON' }), NOW);
    expect(quito.client.address.startsWith('Quito, ')).toBe(true);
    if (quito.order.orderType !== 'Migración') expect(quito.order.technology).toBe('GPON');
    const hfc = buildOrderContext(ORDER, account(2, { city: 'GUAYAQUIL', businessType: 'Internet HFC' }), NOW);
    expect(hfc.client.address.startsWith('Guayaquil, ')).toBe(true);
    if (hfc.order.orderType !== 'Migración') expect(hfc.order.technology).toBe('HFC');
  });
});

describe('GET /orders/task-check', () => {
  async function context(order = ORDER): Promise<OrderContext> {
    return (await get(`/orders/context?workOrder=${enc(order)}`)).body as unknown as OrderContext;
  }

  it('task de la orden → valid:true con la task del contexto', async () => {
    const ctx = await context();
    for (const task of ctx.tasks) {
      const res = await get(`/orders/task-check?workOrder=${enc(ORDER)}&taskId=${enc(task.taskId)}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ valid: true, taskId: task.taskId, workOrder: ORDER, task, simulated: true });
    }
  });

  it('acepta solo los dígitos de la task (año actual) y minúsculas', async () => {
    const year = new Date(Date.now() - 5 * 3600_000).getUTCFullYear();
    const order = `ORDER/463158/${year}`;
    const ctx = await context(order);
    const taskId = ctx.tasks[0]?.taskId as string;
    const digits = taskId.split('/')[1] as string;
    const res = await get(`/orders/task-check?workOrder=463158&taskId=${digits}`);
    expect(res.body).toMatchObject({ valid: true, taskId, workOrder: order });
    const lower = await get(`/orders/task-check?workOrder=${enc(order)}&taskId=${enc(taskId.toLowerCase())}`);
    expect(lower.body).toMatchObject({ valid: true, taskId });
  });

  it('task que no pertenece a la orden → 200 valid:false TASK_NOT_IN_ORDER', async () => {
    const other = await context('ORDER/777777/2026');
    const foreign = other.tasks[0]?.taskId as string;
    const own = new Set((await context()).tasks.map((t) => t.taskId));
    expect(own.has(foreign)).toBe(false);
    const res = await get(`/orders/task-check?workOrder=${enc(ORDER)}&taskId=${enc(foreign)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, reason: 'TASK_NOT_IN_ORDER' });
    expect(res.body).not.toHaveProperty('task');
  });

  it('formato inválido o faltante → 400 VALIDATION_ERROR', async () => {
    const cases = [
      `workOrder=${enc(ORDER)}&taskId=${enc('TASK/123/2026')}`,
      `workOrder=${enc(ORDER)}&taskId=${enc('ORDER/549487/2026')}`,
      `workOrder=${enc(ORDER)}&taskId=12345`,
      `workOrder=${enc(ORDER)}`,
      `taskId=${enc('TASK/549487/2026')}`,
      `workOrder=abc&taskId=${enc('TASK/549487/2026')}`,
    ];
    for (const q of cases) {
      const res = await get(`/orders/task-check?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });
});
