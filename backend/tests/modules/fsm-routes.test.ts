// Rutas de la integración FSM, contra el contrato `contrato-api.md`.
//
// Reglas que estos tests protegen:
//   1. NINGUNA ruta devuelve 401 por culpa de FSM (la webapp cierra sesión ante
//      cualquier 401: un token vencido de la operadora no puede sacar al
//      técnico al login en medio de una visita).
//   2. El conteo de llamadas upstream por ruta es exactamente el declarado en
//      §12 del contrato.
//   3. Con el conector en `mock` todas las rutas responden los shapes completos,
//      para que el frontend se pueda construir sin token.
//
// No se usa base de datos y NUNCA se sale a la red: `fetch` está reemplazado.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp, futureJwt, installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import {
  resetFsmTokenCache,
} from '../../src/connectors/http/fsm-token.js';
import { resetFsmLimiter } from '../../src/connectors/http/fsm-api.js';
import { getFsmConnector, resetNapRegistry } from '../../src/connectors/fsm/index.js';

const PREFIX = '/herramientas/v1';

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
  // Ningún test toca TEC real ni FSM real salvo que lo pida explícitamente.
  Object.assign(env, {
    CONNECTOR_MODE_FSM: 'mock',
    CONNECTOR_MODE_TEC: 'mock',
    NAPS_PRIMARY_SOURCE: 'tec',
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

/** Modo real con token válido y un doble de `fetch` controlado. */
function useRealFsm(responder: Parameters<typeof installFetchSpy>[0]): FetchSpy {
  process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
  process.env.FSM_API_TOKEN_SETEINFO = futureJwt(12);
  Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
  resetFsmTokenCache();
  spy = installFetchSpy(responder);
  return spy;
}

// ---------------------------------------------------------------------------
// Modo mock — shapes completos del contrato
// ---------------------------------------------------------------------------

describe('CONNECTOR_MODE_FSM=mock — el frontend puede trabajar sin token', () => {
  it('GET /integrations/fsm/health informa todas las marcas sin tocar la red', async () => {
    spy = installFetchSpy(() => ({ status: 200, body: {} }));
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/integrations/fsm/health`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('mock');
    expect(body.defaultBrand).toBe('telenews');
    expect(body.napsPrimarySource).toBe('tec');
    // En mock no hace falta token: el banner de "FSM no disponible" no aplica.
    expect(body.requiresToken).toBe(false);
    expect(body.fixtureAccount).toBeNull();
    // Solo telenews: la operadora deshabilitó seteinfo el 2026-09-09.
    expect(body.brands.map((b: { brand: string }) => b.brand)).toEqual(['telenews']);
    for (const brand of body.brands) {
      expect(brand).toHaveProperty('available');
      expect(brand).toHaveProperty('reason');
      expect(brand).toHaveProperty('tokenSource');
      expect(brand).toHaveProperty('expiresAt');
      expect(brand).toHaveProperty('expiresInSeconds');
    }
    expect(spy.calls).toHaveLength(0);
  });

  it('GET client-profile devuelve los campos 1-5 más email, coordenada y sources', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountNumber).toBe('35070291');
    expect(typeof body.fullName).toBe('string');
    expect(Array.isArray(body.phones)).toBe(true);
    expect(typeof body.planName).toBe('string');
    expect(typeof body.contractedDownloadMbps).toBe('number');
    expect(body).toHaveProperty('email');
    expect(body).toHaveProperty('latitude');
    expect(body).toHaveProperty('longitude');
    expect(body.sources.fullName).toBe('FSM');
    expect(body.sources.planName).toBe('MOCK');
    expect(body.sources.contractedDownloadMbps).toBe('MOCK');
  });

  it('client-profile sigue devolviendo 404 en mock cuando la cuenta no existe', async () => {
    // Con datos simulados, "sin órdenes" SÍ significa cuenta desconocida (el
    // mock inventa órdenes para cualquier cuenta con formato válido, así que hay
    // que forzar la respuesta vacía para llegar a esa rama).
    const spyOrders = vi.spyOn(getFsmConnector(), 'getAccountOrders').mockResolvedValue({
      accountNumber: '00000000',
      brand: 'telenews',
      client: null,
      orders: [],
    });
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/00000000/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
    spyOrders.mockRestore();
  });

  it('PUT client-profile manda sobre FSM y se marca MOCK en sources', async () => {
    const account = `35070${Date.now() % 1000}`;
    const put = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/client-profile`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { fullName: 'Cliente Editado', phones: ['0991234567'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().fullName).toBe('Cliente Editado');
    expect(put.json().sources.fullName).toBe('MOCK');

    const get = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${account}/client-profile`,
      headers: authHeaders,
    });
    expect(get.json().fullName).toBe('Cliente Editado');
    expect(get.json().phones).toEqual(['0991234567']);
    expect(get.json().sources.fullName).toBe('MOCK');
    // La dirección no se editó: sigue viniendo de FSM.
    expect(get.json().sources.address).toBe('FSM');
  });

  it('GET contract-status trae statusCode, statusDescription, lastWorkOrder y brand', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/contract-status`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.brand).toBe('telenews');
    expect(body.accounts).toHaveLength(1);
    const account = body.accounts[0];
    expect(account.accountNumber).toBe('35070291');
    expect(account.contractId).toBeNull();
    expect(['A', 'S', 'T', 'O', 'P', null]).toContain(account.statusCode);
    expect([
      'ACTIVA',
      'SUSPENDIDA',
      'TERMINADA',
      'ORDENADA',
      'PENDIENTE',
      'DESCONOCIDA',
    ]).toContain(account.status);
    expect(account).toHaveProperty('statusDescription');
    expect(account).toHaveProperty('lastWorkOrder');
  });

  it('GET previous-visits devuelve el objeto envolvente con items y totalOrders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.totalOrders).toBe('number');
    expect(body.brand).toBe('telenews');
    for (const item of body.items) {
      expect(item.technician).toBeNull();
      expect(item.notesLoaded).toBe(false);
      expect(item.closingNotes).toBe('');
      expect(typeof item.workOrder).toBe('string');
    }
  });

  it('GET unsatisfactory-tasks trae scanned/totalOrders/truncated y solo INSATISFACTORIA', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/unsatisfactory-tasks?limit=5`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.scanned).toBe('number');
    expect(typeof body.totalOrders).toBe('number');
    expect(typeof body.truncated).toBe('boolean');
    expect(body.items.every((t: { result: string }) => t.result === 'INSATISFACTORIA')).toBe(true);
    expect(body.items.every((t: { notesLoaded: boolean }) => t.notesLoaded === true)).toBe(true);
    if (body.truncated) {
      expect(body.degraded.reason).toBe('TRUNCATED');
    } else {
      expect(body.degraded).toBeUndefined();
    }
  });

  it('GET /accounts/{n}/orders devuelve cliente y órdenes descendentes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/orders`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountNumber).toBe('35070291');
    expect(body.brand).toBe('telenews');
    expect(body.client).not.toBeNull();
    const dates = body.orders.map((o: { createdAt: string }) => o.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const order of body.orders) {
      expect(order.finished).toBe(order.endedAt !== null);
    }
  });

  it('GET /workorders/tasks?workOrder= devuelve tareas con notas y resultado', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/workorders/tasks?workOrder=${encodeURIComponent('ORDER/424900/2026')}`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workOrder).toBe('ORDER/424900/2026');
    expect(body.brand).toBe('telenews');
    expect(Array.isArray(body.tasks)).toBe(true);
    for (const task of body.tasks) {
      expect(['SATISFACTORIA', 'INSATISFACTORIA', 'PENDIENTE']).toContain(task.result);
      expect(Array.isArray(task.notes)).toBe(true);
      // `lastModifyUser`: string en las cerradas, null en las abiertas.
      expect(task).toHaveProperty('closedBy');
      expect(task.finishedAt === null ? task.closedBy : typeof task.closedBy).toBe(
        task.finishedAt === null ? null : 'string',
      );
    }
  });

  it('GET /workorders/tasks sin workOrder es 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/workorders/tasks`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('POST /accounts/status-batch responde el lote completo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: ['35070291', '71398253'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.brand).toBe('telenews');
    expect(body.items).toHaveLength(2);
    expect(body.requested).toBe(2);
    expect(body.resolved + body.failed).toBe(2);
    expect(body.items[0].accountNumber).toBe('35070291');
  });

  it('GET /naps/{napId}/ports (numérico) devuelve la rejilla con statusFanOut', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/11547/ports`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.napRef).toBe('11547');
    expect(body.napId).toBe(11547);
    expect(body.source).toBe('FSM');
    expect(body.detailAvailable).toBe(true);
    expect(body.statusFanOut.supported).toBe(true);
    expect(body.statusFanOut.batchLimit).toBe(12);
    for (const port of body.ports) {
      expect(port).toHaveProperty('equipmentId');
      expect(port.clientStatus).toBeNull();
      expect(port.statusPending).toBe(port.occupied);
    }
  });

  it('GET /naps/nearby devuelve napId, networkName y source', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.247946&lng=-79.904161`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const naps = res.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(naps)).toBe(true);
    for (const nap of naps) {
      expect(nap).toHaveProperty('napId');
      expect(nap).toHaveProperty('networkName');
      expect(nap.source).toBe('FSM');
      expect(nap.freePorts).toBe(
        Math.max(0, (nap.totalPorts as number) - (nap.occupiedPorts as number)),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Lista unificada de visitas — GET /accounts/{n}/visits
// ---------------------------------------------------------------------------

const VISIT_RESULTS = ['PENDIENTE', 'SATISFACTORIA', 'INSATISFACTORIA', 'CANCELADA', 'REALIZADA'];

interface VisitBody {
  items: Array<{
    taskId: string;
    workOrder: string;
    occurredAt: string;
    reason: string;
    closingNotes: string;
    technician: string | null;
    result: string;
    notesLoaded: boolean;
  }>;
  pendingCount: number;
  totalOrders: number;
  scanned: number;
  truncated: boolean;
  brand: string;
  degraded?: { reason: string; message: string };
}

/** Pendientes arriba y el resto por `occurredAt` desc. */
function expectVisitOrdering(body: VisitBody): void {
  const pending = body.items.filter((i) => i.result === 'PENDIENTE');
  expect(body.items.slice(0, pending.length).every((i) => i.result === 'PENDIENTE')).toBe(true);
  const rest = body.items.slice(pending.length).map((i) => i.occurredAt);
  expect([...rest].sort((a, b) => b.localeCompare(a))).toEqual(rest);
}

describe('GET /accounts/{n}/visits — mock', () => {
  it('devuelve el shape completo, una entrada por orden y la pendiente primero', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitBody;
    expect(body.brand).toBe('telenews');
    expect(body.items).toHaveLength(body.totalOrders);
    expect(new Set(body.items.map((i) => i.workOrder)).size).toBe(body.totalOrders);
    expect(body.pendingCount).toBeLessThanOrEqual(1);
    expect(body.scanned).toBeLessThanOrEqual(env.FSM_ORDERS_MAX_FANOUT);
    expectVisitOrdering(body);
    for (const item of body.items) {
      expect(VISIT_RESULTS).toContain(item.result);
      expect(item.taskId).toBe(item.workOrder);
      expect(item.notesLoaded).toBe(
        item.result === 'SATISFACTORIA' || item.result === 'INSATISFACTORIA',
      );
    }
    if (body.truncated) expect(body.degraded?.reason).toBe('TRUNCATED');
    else expect(body.degraded).toBeUndefined();
  });

  it('el mock respeta la regla de FSM: ≤1 pendiente, y si la hay es la más reciente', async () => {
    const fsm = getFsmConnector();
    const counts = { zero: 0, one: 0 };
    for (let i = 0; i < 300; i++) {
      const account = String(35000000 + i * 7919);
      const { orders } = await fsm.getAccountOrders(account, { brand: 'telenews', estado: 'Todas' });
      const pending = orders.filter((o) => !o.finished);
      expect(pending.length, account).toBeLessThanOrEqual(1);
      if (pending.length === 1) {
        expect(orders[0]!.finished, account).toBe(false);
        counts.one++;
      } else {
        counts.zero++;
      }
      const visits = await fsm.getVisits(account, { brand: 'telenews', limit: 5 });
      expect(visits.pendingCount).toBe(pending.length);
      if (pending.length === 1) expect(visits.items[0]!.result).toBe('PENDIENTE');
    }
    // Hay cuentas de los dos tipos.
    expect(counts.zero).toBeGreaterThan(0);
    expect(counts.one).toBeGreaterThan(0);
  });

  it('el mock es determinista por cuenta', async () => {
    const fsm = getFsmConnector();
    const a = await fsm.getVisits('71398253', { brand: 'telenews', limit: 5 });
    const b = await fsm.getVisits('71398253', { brand: 'telenews', limit: 5 });
    expect(b.items.map((i) => [i.workOrder, i.result])).toEqual(
      a.items.map((i) => [i.workOrder, i.result]),
    );
  });

  it('una marca desconocida es 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits?brand=marca-inventada`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /accounts/{n}/visits — fixture (cuenta grabada 35070291)', () => {
  beforeEach(() => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'fixture' });
    spy = installFetchSpy(() => ({ status: 500, raw: 'el modo fixture no puede usar la red' }));
  });

  it('clasifica las 27 órdenes reales: 9 CANCELADA, 5 verificadas, resto REALIZADA', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitBody;
    const count = (r: string): number => body.items.filter((i) => i.result === r).length;

    expect(body.totalOrders).toBe(27);
    expect(body.items).toHaveLength(27);
    // La captura real no tiene ninguna orden sin terminar.
    expect(body.pendingCount).toBe(0);
    expect(count('PENDIENTE')).toBe(0);
    // 9 órdenes con state "Cancelado" en chain-process.json.
    expect(count('CANCELADA')).toBe(9);
    expect(body.scanned).toBe(5);
    expect(count('SATISFACTORIA') + count('INSATISFACTORIA')).toBe(5);
    expect(count('REALIZADA')).toBe(18 - 5);
    expect(body.truncated).toBe(true);
    expect(body.degraded?.reason).toBe('TRUNCATED');
    expectVisitOrdering(body);

    for (const item of body.items.filter((i) => i.result === 'CANCELADA')) {
      expect(item.notesLoaded).toBe(false);
      expect(item.closingNotes).toBe('');
      expect(item.technician).toBeNull();
    }
    // Una tarea insatisfactoria siempre está cerrada: siempre tiene técnico.
    for (const item of body.items.filter((i) => i.result === 'INSATISFACTORIA')) {
      expect(typeof item.technician).toBe('string');
    }
    expect(res.payload).not.toContain('REDACTADO');
    expect(spy!.calls).toHaveLength(0);
  });

  it('otra cuenta en modo fixture cae al mock', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/71398253/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitBody;
    Object.assign(env, { CONNECTOR_MODE_FSM: 'mock' });
    const viaMock = await getFsmConnector().getVisits('71398253', {
      brand: 'telenews',
      limit: env.FSM_ORDERS_MAX_FANOUT,
    });
    expect(body.items.map((i) => [i.workOrder, i.result])).toEqual(
      viaMock.items.map((i) => [i.workOrder, i.result]),
    );
  });
});

describe('GET /accounts/{n}/visits — real', () => {
  /** 12 órdenes finalizadas + 1 cancelada + 1 pendiente (la más reciente). */
  const ORDERS = {
    data: [
      ...Array.from({ length: 12 }, (_, i) => ({
        workOrder: `ORDER/${500100 + i}/2026`,
        task: `TASK/${900100 + i}/2026`,
        state: 'Realizado',
        creationDate: `2026-0${(i % 8) + 1}-${String(10 + i).padStart(2, '0')} 09:00:00`,
        endDate: `2026-0${(i % 8) + 1}-${String(10 + i).padStart(2, '0')} 11:00:00`,
      })),
      {
        workOrder: 'ORDER/500900/2026',
        task: 'TASK/900900/2026',
        // Acentos y mayúsculas: igual tiene que reconocerse.
        state: 'CANCELÁDO',
        creationDate: '2026-08-30 09:00:00',
        endDate: '2026-08-30 09:30:00',
      },
      {
        workOrder: 'ORDER/501000/2026',
        task: 'TASK/901000/2026',
        state: 'Pendiente',
        creationDate: '2026-09-20 08:00:00',
        endDate: null,
      },
    ],
  };

  /** Las 5 finalizadas más recientes (endDate desc): 500107, 500106, 500105, 500104, 500111. */
  const BAD_ORDER = 'ORDER/500107/2026';
  const FAILING_ORDER = 'ORDER/500105/2026';

  function tasksFor(workOrder: string): unknown {
    const bad = workOrder === BAD_ORDER;
    return {
      data: [
        {
          taskId: `${workOrder}-T1`,
          status: 'Realizado',
          createDate: '2026-08-14 09:00:00',
          finishDate: '2026-08-14 10:00:00',
          lastModifyUser: 'mmendoza',
          notes: [{ createDate: '2026-08-14 09:59:00', content: 'Primera tarea sin novedad.' }],
        },
        {
          taskId: `${workOrder}-T2`,
          status: 'Realizado',
          createDate: '2026-08-14 10:00:00',
          finishDate: '2026-08-14 11:00:00',
          lastModifyUser: 'jcevallos',
          notes: [
            {
              createDate: '2026-08-14 10:59:00',
              content: bad ? 'Visita reprogramada por el cliente.' : 'Servicio certificado.',
            },
          ],
        },
      ],
    };
  }

  function responder(call: { url: string; body: unknown }): { status: number; body?: unknown; raw?: string } {
    if (call.url.includes('/account/process')) return { status: 200, body: ORDERS };
    const workOrder = String((call.body as { data: { workOrder: string } }).data.workOrder);
    if (workOrder === FAILING_ORDER) return { status: 500, raw: 'boom' };
    return { status: 200, body: tasksFor(workOrder) };
  }

  it('pendiente primero, cancelada sin fan-out, 1+5 llamadas y el resto REALIZADA', async () => {
    const fetchSpy = useRealFsm(responder);
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitBody;
    const byOrder = new Map(body.items.map((i) => [i.workOrder, i]));

    expect(body.totalOrders).toBe(14);
    expect(body.items).toHaveLength(14);
    expect(body.pendingCount).toBe(1);
    expect(body.scanned).toBe(5);
    expect(body.truncated).toBe(true);
    expect(body.degraded?.reason).toBe('TRUNCATED');
    expectVisitOrdering(body);

    // PENDIENTE: primera, con la fecha de creación.
    expect(body.items[0]).toMatchObject({
      workOrder: 'ORDER/501000/2026',
      result: 'PENDIENTE',
      occurredAt: '2026-09-20T08:00:00.000Z',
      notesLoaded: false,
    });

    // CANCELADA: sin abrir sus tareas.
    expect(byOrder.get('ORDER/500900/2026')).toMatchObject({ result: 'CANCELADA', notesLoaded: false });

    // INSATISFACTORIA: notas de la tarea insatisfactoria y su técnico.
    expect(byOrder.get(BAD_ORDER)).toMatchObject({
      result: 'INSATISFACTORIA',
      closingNotes: 'Visita reprogramada por el cliente.',
      technician: 'jcevallos',
      notesLoaded: true,
    });

    // SATISFACTORIA: notas de la última tarea cerrada.
    expect(byOrder.get('ORDER/500106/2026')).toMatchObject({
      result: 'SATISFACTORIA',
      closingNotes: 'Servicio certificado.',
      technician: 'jcevallos',
      notesLoaded: true,
    });

    // Lectura fallida (no de token) → REALIZADA, sin tumbar la respuesta.
    expect(byOrder.get(FAILING_ORDER)).toMatchObject({ result: 'REALIZADA', notesLoaded: false });

    // Fuera del fan-out → REALIZADA.
    expect(byOrder.get('ORDER/500100/2026')).toMatchObject({
      result: 'REALIZADA',
      notesLoaded: false,
      closingNotes: '',
      technician: null,
    });
    expect(body.items.filter((i) => i.result === 'REALIZADA')).toHaveLength(12 - 5 + 1);

    // 1 /account/process + 5 /workorder/tasks; la cancelada y la pendiente no se abren.
    expect(fetchSpy.calls).toHaveLength(6);
    const opened = fetchSpy.calls
      .filter((c) => c.url.includes('/workorder/tasks'))
      .map((c) => (c.body as { data: { workOrder: string } }).data.workOrder);
    expect(opened).not.toContain('ORDER/500900/2026');
    expect(opened).not.toContain('ORDER/501000/2026');
  });

  it('más de una pendiente: se conservan todas arriba y se avisa en el log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useRealFsm((call) =>
      call.url.includes('/account/process')
        ? {
            status: 200,
            body: {
              data: [
                ...ORDERS.data,
                {
                  workOrder: 'ORDER/501001/2026',
                  task: 'TASK/901001/2026',
                  state: 'Pendiente',
                  creationDate: '2026-09-22 08:00:00',
                  endDate: null,
                },
              ],
            },
          }
        : responder(call),
    );
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as VisitBody;
    expect(body.pendingCount).toBe(2);
    expect(body.items.slice(0, 2).map((i) => [i.workOrder, i.result])).toEqual([
      ['ORDER/501001/2026', 'PENDIENTE'],
      ['ORDER/501000/2026', 'PENDIENTE'],
    ]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('órdenes sin terminar'))).toBe(true);
  });

  it('un 401 en el fan-out de tareas sale como 503 UPSTREAM_AUTH_ERROR', async () => {
    useRealFsm((call) =>
      call.url.includes('/account/process')
        ? { status: 200, body: ORDERS }
        : { status: 401, raw: 'Unauthorized' },
    );
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('UPSTREAM_AUTH_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Validación de parámetros
// ---------------------------------------------------------------------------

describe('Validación de parámetros', () => {
  it('/naps/nearby rechaza meters y maxRows fuera de rango', async () => {
    const malMeters = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.2&lng=-79.9&meters=5000`,
      headers: authHeaders,
    });
    expect(malMeters.statusCode).toBe(400);

    const malRows = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.2&lng=-79.9&maxRows=99`,
      headers: authHeaders,
    });
    expect(malRows.statusCode).toBe(400);
  });

  it('una marca desconocida es 400, no 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: { ...authHeaders, 'x-wifix-brand': 'marca-inventada' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('status-batch rechaza más de 12 cuentas, el array vacío y los no-string', async () => {
    const trece = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: Array.from({ length: 13 }, (_, i) => `4001234${i}`) },
    });
    expect(trece.statusCode).toBe(400);
    expect(trece.json().code).toBe('VALIDATION_ERROR');

    const vacio = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: [] },
    });
    expect(vacio.statusCode).toBe(400);

    const noString = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: [123] },
    });
    expect(noString.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Precedencia de rutas
// ---------------------------------------------------------------------------

describe('Precedencia de rutas (find-my-way)', () => {
  it('POST /accounts/status-batch no cae en /accounts/:accountNumber/...', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: ['35070291'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Si hubiera caído en la ruta paramétrica, no habría `items`/`requested`.
    expect(body.items[0].accountNumber).toBe('35070291');
    expect(body.requested).toBe(1);
  });

  it('GET /accounts/status-batch/... no existe (solo POST en esa ruta)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/status-batch`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Modo fixture — la demo del VPS: datos reales grabados, cero red
// ---------------------------------------------------------------------------

describe('CONNECTOR_MODE_FSM=fixture — las rutas sirven la captura real', () => {
  beforeEach(() => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'fixture' });
    spy = installFetchSpy(() => ({ status: 500, raw: 'el modo fixture no puede usar la red' }));
  });

  it('/integrations/fsm/health informa mode=fixture y que no hace falta token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/integrations/fsm/health`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('fixture');
    expect(body.requiresToken).toBe(false);
    expect(body.fixtureAccount).toBe('35070291');
  });

  it('client-profile de la cuenta grabada compone FSM + plan del mock, sin placeholders', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fullName).toBe('María F. Zambrano C.');
    expect(body.sources).toMatchObject({ fullName: 'FSM', address: 'FSM', planName: 'MOCK' });
    expect(body.degraded).toBeUndefined();
    expect(res.payload).not.toContain('REDACTADO');
    expect(spy!.calls).toHaveLength(0);
  });

  it('previous-visits devuelve las 27 órdenes reales de la cuenta grabada', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalOrders).toBeGreaterThan(10);
    expect(body.items.map((i: { workOrder: string }) => i.workOrder)).toContain('ORDER/73198/2019');
    expect(res.payload).not.toContain('REDACTADO');
  });

  it('contract-status de la cuenta grabada sale ACTIVA (estado real A)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/contract-status`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accounts[0]).toMatchObject({ status: 'ACTIVA', statusCode: 'A' });
  });

  it('otra cuenta sigue respondiendo con los datos del mock', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/71398253/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fullName).not.toBe('María F. Zambrano C.');
    expect(spy!.calls).toHaveLength(0);
  });

  it('/naps/nearby con NAPS_PRIMARY_SOURCE=fsm sirve las NAPs grabadas', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.0761&lng=-79.8537`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const naps = res.json() as Array<{ napId: number; source: string; napCode: string }>;
    expect(naps.map((n) => n.napId)).toContain(35874);
    expect(naps.every((n) => n.source === 'FSM')).toBe(true);
    expect(res.payload).not.toContain('REDACTADO');
    expect(spy!.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Modo real — el fallo de FSM nunca es un 401
// ---------------------------------------------------------------------------

describe('CONNECTOR_MODE_FSM=real — errores de token', () => {
  it('sin token configurado: 503 UPSTREAM_AUTH_ERROR con reason MISSING y CERO llamadas', async () => {
    Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
    resetFsmTokenCache();
    spy = installFetchSpy(() => ({ status: 200, body: { data: [] } }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe('UPSTREAM_AUTH_ERROR');
    expect(body.meta).toMatchObject({
      integration: 'FSM',
      brand: 'telenews',
      reason: 'MISSING',
      retryable: false,
    });
    expect(body.message).toContain('no está configurado');
    expect(spy.calls).toHaveLength(0);
  });

  it('un 401 de FSM sale como 503, NUNCA como 401', async () => {
    const fetchSpy = useRealFsm(() => ({ status: 401, raw: 'Unauthorized' }));

    for (const url of [
      `${PREFIX}/accounts/35070291/previous-visits`,
      `${PREFIX}/accounts/35070291/unsatisfactory-tasks`,
      `${PREFIX}/accounts/35070291/visits`,
      `${PREFIX}/accounts/35070291/orders`,
      `${PREFIX}/accounts/35070291/contract-status`,
      `${PREFIX}/accounts/35070291/client-profile`,
      `${PREFIX}/workorders/tasks?workOrder=ORDER%2F1%2F2026`,
    ]) {
      resetHttpCache();
      resetFsmTokenCache();
      process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
      const res = await app.inject({ method: 'GET', url, headers: authHeaders });
      expect(res.statusCode, url).toBe(503);
      expect(res.json().code, url).toBe('UPSTREAM_AUTH_ERROR');
      expect(res.json().meta.reason, url).toBe('REJECTED');
    }
    expect(fetchSpy.calls.length).toBeGreaterThan(0);
  });

  it('con NAPS_PRIMARY_SOURCE=fsm y token rechazado, /naps/nearby cae a TEC con aviso', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm', CONNECTOR_MODE_TEC: 'mock' });
    useRealFsm(() => ({ status: 401, raw: 'Unauthorized' }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.247946&lng=-79.904161`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const naps = res.json() as Array<{ source: string }>;
    expect(naps.every((n) => n.source === 'TEC')).toBe(true);
    const header = res.headers['x-wifix-degraded'];
    expect(typeof header).toBe('string');
    const degraded = JSON.parse(decodeURIComponent(String(header))) as { reason: string };
    expect(degraded.reason).toBe('FSM_AUTH');
  });

  it('un 500 de FSM en /naps/nearby NO cae a TEC: se propaga como 502', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    useRealFsm(() => ({ status: 500, raw: 'boom' }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.247946&lng=-79.904161`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('CONNECTOR_ERROR');
  });
});

// ---------------------------------------------------------------------------
// Modo real — conteo de llamadas upstream (§12 del contrato)
// ---------------------------------------------------------------------------

describe('CONNECTOR_MODE_FSM=real — caudal hacia la operadora', () => {
  const ORDERS = {
    data: Array.from({ length: 12 }, (_, i) => ({
      names: 'María Cevallos Andrade',
      phoneNumber: '0991234567',
      email: 'maria@example.com',
      address: 'Av. Amazonas N1234, Quito',
      latitude: -2.247946,
      longitude: -79.904161,
      workOrder: `ORDER/${424900 + i}/2026`,
      task: 'INSTALACION',
      state: 'FINALIZADA',
      creationDate: `2026-0${(i % 9) + 1}-14 14:02:00`,
      endDate: `2026-0${(i % 9) + 1}-14 16:41:00`,
    })),
  };

  const TASKS = {
    data: [
      {
        taskId: 'TASK/294328/2026',
        status: 'CERRADA',
        createDate: '2026-08-14 14:02:00',
        finishDate: '2026-08-14 16:41:00',
        // Técnico que cerró la tarea, expuesto por la operadora el 2026-09-09.
        lastModifyUser: 'jcevallos',
        notes: [{ createDate: '2026-08-14 16:40:00', content: 'Visita reprogramada por el cliente.' }],
      },
    ],
  };

  it('previous-visits hace UNA sola llamada upstream', async () => {
    const fetchSpy = useRealFsm(() => ({ status: 200, body: ORDERS }));
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalOrders).toBe(12);
    expect(res.json().items).toHaveLength(12);
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0]!.url).toContain('/account/process');
  });

  it('unsatisfactory-tasks con 12 órdenes y limit=5 hace 1+5 llamadas y marca truncated', async () => {
    const fetchSpy = useRealFsm((call) =>
      call.url.includes('/account/process')
        ? { status: 200, body: ORDERS }
        : { status: 200, body: TASKS },
    );

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/unsatisfactory-tasks?limit=5`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.scanned).toBe(5);
    expect(body.totalOrders).toBe(12);
    expect(body.truncated).toBe(true);
    expect(body.degraded.reason).toBe('TRUNCATED');
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].result).toBe('INSATISFACTORIA');
    // Ya no es null: sale de `lastModifyUser`.
    expect(body.items[0].technician).toBe('jcevallos');
    expect(body.items[0].notesLoaded).toBe(true);
    expect(body.items[0].closingNotes).toContain('reprogramada');
    expect(fetchSpy.calls).toHaveLength(6);
  });

  it('contract-status hace exactamente 2 llamadas (status + process)', async () => {
    const fetchSpy = useRealFsm((call) =>
      call.url.includes('/account/status')
        ? { status: 200, body: { data: { accountId: 35070291, status: 'A', description: 'Activo' } } }
        : { status: 200, body: ORDERS },
    );

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/contract-status`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accounts[0]).toMatchObject({
      accountNumber: '35070291',
      contractId: null,
      status: 'ACTIVA',
      statusCode: 'A',
      statusDescription: 'Activo',
    });
    expect(body.accounts[0].lastWorkOrder).toMatch(/^ORDER\//);
    expect(body.clientName).toBe('María Cevallos Andrade');
    expect(fetchSpy.calls).toHaveLength(2);
  });

  it('client-profile hace UNA llamada y compone FSM + plan del mock', async () => {
    const fetchSpy = useRealFsm(() => ({ status: 200, body: ORDERS }));
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fullName).toBe('María Cevallos Andrade');
    expect(body.phones).toEqual(['0991234567']);
    expect(body.email).toBe('maria@example.com');
    expect(body.latitude).toBe(-2.247946);
    expect(body.sources).toMatchObject({
      fullName: 'FSM',
      address: 'FSM',
      phones: 'FSM',
      email: 'FSM',
      planName: 'MOCK',
    });
    expect(fetchSpy.calls).toHaveLength(1);
  });

  it('client-profile NO devuelve 404 cuando FSM real responde vacío: 200 degradado', async () => {
    // FSM devuelve `data: []` tanto para una cuenta inexistente como para una
    // cuenta sin órdenes. Un 404 acá dejaba al técnico sin la pantalla de Datos
    // Personales completa, así que se compone con el mock y se avisa.
    useRealFsm(() => ({ status: 200, body: { data: [] } }));
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/00000000/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountNumber).toBe('00000000');
    expect(body.degraded.reason).toBe('FSM_UNAVAILABLE');
    expect(body.sources).toMatchObject({ fullName: 'MOCK', address: 'MOCK', phones: 'MOCK' });
    const header = res.headers['x-wifix-degraded'];
    expect(typeof header).toBe('string');
    expect(JSON.parse(decodeURIComponent(String(header))).reason).toBe('FSM_UNAVAILABLE');
  });

  it('client-profile con FSM caído (500) devuelve 503 UPSTREAM_UNAVAILABLE, no 404', async () => {
    useRealFsm(() => ({ status: 500, raw: 'boom' }));
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(body.meta).toMatchObject({ integration: 'FSM', reason: 'UPSTREAM_ERROR', retryable: true });
  });


  it('/naps/{napId}/ports hace UNA sola llamada y no consulta ningún estado', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    const fetchSpy = useRealFsm(() => ({
      status: 200,
      body: {
        data: [
          { id: 11547, number: 1, accountId: 35070291, equipmentId: 'ZTEGD52E1A9B' },
          { id: 11547, number: 3, accountId: 71398253, equipmentId: null },
        ],
      },
    }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/11547/ports`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0]!.url).toContain('/naps/accounts?id=11547');
    expect(body.napId).toBe(11547);
    expect(body.source).toBe('FSM');
    expect(body.occupiedPorts).toBe(2);
    expect(body.ports.find((p: { portNumber: number }) => p.portNumber === 1)).toMatchObject({
      occupied: true,
      clientAccountNumber: '35070291',
      equipmentId: 'ZTEGD52E1A9B',
      clientStatus: null,
      statusPending: true,
    });
    expect(body.statusFanOut).toEqual({ supported: true, pendingAccounts: 2, batchLimit: 12 });
    // Regla de la operadora (2026-09-09): 2 ocupados ≤ 8 → NAP de 8 puertos.
    // La rejilla sale completa y ya no hay aviso de recorte.
    expect(body.totalPorts).toBe(8);
    expect(body.ports).toHaveLength(8);
    expect(body.ports.filter((p: { occupied: boolean }) => !p.occupied)).toHaveLength(6);
    expect(body.degraded).toBeUndefined();
  });

  it('/naps/{napId}/ports con más de 8 ocupados devuelve la rejilla de 16', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    useRealFsm(() => ({
      status: 200,
      body: {
        data: Array.from({ length: 9 }, (_, i) => ({
          id: 11548,
          number: i + 1,
          accountId: 35070291 + i,
          equipmentId: `ZTEGD52E1A9${i}`,
        })),
      },
    }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/11548/ports`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.occupiedPorts).toBe(9);
    expect(body.totalPorts).toBe(16);
    expect(body.ports).toHaveLength(16);
    expect(body.degraded).toBeUndefined();
  });

  it('/naps/{napCode}/ports (no numérico) va por el camino TEC sin tocar FSM', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm', CONNECTOR_MODE_TEC: 'real' });
    const fetchSpy = useRealFsm(() => ({ status: 200, body: { data: [] } }));

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/PL2KD9/ports`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.napRef).toBe('PL2KD9');
    expect(body.napId).toBeNull();
    expect(body.napCode).toBe('PL2KD9');
    expect(body.source).toBe('TEC');
    expect(body.detailAvailable).toBe(false);
    expect(body.ports).toEqual([]);
    expect(body.statusFanOut).toEqual({ supported: false, pendingAccounts: 0, batchLimit: 12 });
    expect(typeof body.note).toBe('string');
    // Cero llamadas: ni a FSM ni a TEC.
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it('status-batch: dedupe, exactamente N llamadas y una cuenta que falla no tumba el lote', async () => {
    const fetchSpy = useRealFsm((call) => {
      const body = call.body as { data: Record<string, unknown> };
      const account = String(body.data.account_id ?? body.data.accountId ?? '');
      if (account === '40012345') return { status: 500, raw: 'boom' };
      return {
        status: 200,
        body: {
          data: {
            accountId: Number(account),
            status: account === '71398253' ? 'S' : 'A',
            description: account === '71398253' ? 'Suspendido' : 'Activo',
          },
        },
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      // '35070291' repetido: se deduplica en silencio.
      payload: { accounts: ['35070291', '71398253', '40012345', '35070291'] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.requested).toBe(3);
    expect(body.resolved).toBe(2);
    expect(body.failed).toBe(1);
    expect(body.items.map((i: { accountNumber: string }) => i.accountNumber)).toEqual([
      '35070291',
      '71398253',
      '40012345',
    ]);
    expect(body.items[0]).toMatchObject({ status: 'ACTIVA', statusCode: 'A', error: null });
    expect(body.items[1]).toMatchObject({ status: 'SUSPENDIDA', statusCode: 'S' });
    expect(body.items[2].status).toBeNull();
    expect(typeof body.items[2].error).toBe('string');
    // Una llamada por cuenta ÚNICA, ni una más.
    expect(fetchSpy.calls).toHaveLength(3);
  });

  it('status-batch propaga el fallo de token como error global (503)', async () => {
    useRealFsm(() => ({ status: 401, raw: 'Unauthorized' }));
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/status-batch`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { accounts: ['35070291', '71398253'] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('UPSTREAM_AUTH_ERROR');
  });

  // La operadora dejó una sola marca activa (telenews), pero la plomería
  // multi-marca sigue siendo obligatoria: si vuelve seteinfo, el cache NO puede
  // mezclar realms. El test la habilita a mano para seguir protegiendo la regla.
  it('la marca del header cambia la consulta y no comparte cache con la otra', async () => {
    const fetchSpy = useRealFsm(() => ({ status: 200, body: ORDERS }));
    Object.assign(env, { FSM_BRANDS: ['telenews', 'seteinfo'] });

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: { ...authHeaders, 'x-wifix-brand': 'telenews' },
    });
    await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: { ...authHeaders, 'x-wifix-brand': 'seteinfo' },
    });
    // Misma cuenta, marcas distintas → dos llamadas reales.
    expect(fetchSpy.calls).toHaveLength(2);

    const repetida = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/35070291/previous-visits`,
      headers: { ...authHeaders, 'x-wifix-brand': 'telenews' },
    });
    expect(repetida.json().brand).toBe('telenews');
    // La repetición dentro de la ventana de cache no sale a la red.
    expect(fetchSpy.calls).toHaveLength(2);
  });
});
