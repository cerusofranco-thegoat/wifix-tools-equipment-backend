// GET/POST /accounts/lookup — ingreso por cédula/RUC y por nº de orden (TYTAN simulado).
// Sin base de datos: el repositorio se reemplaza por un doble en memoria con
// datos sintéticos. Protege la regla LOPDP: el documento NUNCA sale.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';
import { redactUrl } from '../../src/app.js';
import {
  LOOKUP_MAX_MATCHES,
  ORDER_DEMO_ACCOUNT,
  resetOrderCandidateCache,
  setAccountLookupRepository,
  type AccountLookupRepository,
  type LookupAccount,
} from '../../src/modules/account-lookup/account-lookup.service.js';

const PREFIX = '/herramientas/v1';
const IMPORTED_AT = new Date('2026-09-26T22:07:00.000Z');
const DOC = '0900000001';
const RUC = '0900000001001';

let app: FastifyInstance;
let authHeaders: Record<string, string>;

type Row = LookupAccount & { documentId: string; cpartyId: string };

function row(accountNumber: string, documentId: string, status: Row['status'], extra: Partial<Row> = {}): Row {
  return {
    accountNumber,
    documentId,
    cpartyId: `CP${accountNumber}`,
    status,
    city: 'CIUDAD X',
    node: 'N1',
    businessType: 'Internet GPON',
    accountType: 'Residencial',
    accessType: null,
    fullName: 'CLIENTE SINTETICO',
    ...extra,
  };
}

function fakeRepo(
  rows: Row[],
  importedAt: Date | null,
): AccountLookupRepository & { queries: string[]; candidateCalls: number } {
  const queries: string[] = [];
  const candidates = (onlyActive: boolean): Row[] =>
    rows
      .filter((r) => !onlyActive || r.status === 'ACTIVO')
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
  const repo = {
    queries,
    candidateCalls: 0,
    async findByDocument(documentId: string, take: number) {
      queries.push(documentId);
      // Devuelve las filas CON documentId y cpartyId: la capa de servicio no debe filtrarlas.
      return rows.filter((r) => r.documentId === documentId).slice(0, take);
    },
    async latestImportAt() {
      return importedAt;
    },
    async countOrderCandidates(onlyActive: boolean) {
      repo.candidateCalls += 1;
      return candidates(onlyActive).length;
    },
    // Devuelve la fila CON documentId y cpartyId: el servicio no debe filtrarlas.
    async findOrderCandidateAt(index: number, onlyActive: boolean) {
      return candidates(onlyActive)[index] ?? null;
    },
  };
  return repo;
}

let repo: ReturnType<typeof fakeRepo>;

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  setAccountLookupRepository(null);
  await app.close();
});

beforeEach(() => {
  resetOrderCandidateCache();
  repo = fakeRepo(
    [
      row('90000003', DOC, 'PENDIENTE'),
      row('90000001', DOC, 'SUSPENDIDO', { fullName: '  ' }),
      row('90000002', DOC, 'ACTIVO'),
      row('90000009', RUC, 'ACTIVO'),
    ],
    IMPORTED_AT,
  );
  setAccountLookupRepository(repo);
});

async function get(query: string, headers: Record<string, string> = authHeaders) {
  const res = await app.inject({ method: 'GET', url: `${PREFIX}/accounts/lookup?${query}`, headers });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

describe('GET /accounts/lookup?document=', () => {
  it('exige autenticación', async () => {
    const res = await get(`document=${DOC}`, {});
    expect(res.status).toBe(401);
  });

  it('devuelve las cuentas del documento, activas primero, sin el documento', async () => {
    const res = await get(`document=${DOC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      by: 'document',
      documentKind: 'CEDULA',
      count: 3,
      truncated: false,
      importedAt: IMPORTED_AT.toISOString(),
    });
    const matches = res.body.matches as LookupAccount[];
    expect(matches.map((m) => m.accountNumber)).toEqual(['90000002', '90000001', '90000003']);
    expect(matches[0]).toEqual({
      accountNumber: '90000002',
      status: 'ACTIVO',
      city: 'CIUDAD X',
      node: 'N1',
      businessType: 'Internet GPON',
      accountType: 'Residencial',
      accessType: null,
      fullName: 'CLIENTE SINTETICO',
    });
    // Nombre en blanco → null.
    expect(matches[1]?.fullName).toBeNull();
    // LOPDP: ni el documento ni el cpartyId salen en la respuesta.
    expect(res.raw).not.toContain(DOC);
    expect(res.raw).not.toContain('documentId');
    expect(res.raw).not.toContain('cpartyId');
  });

  it('normaliza igual que el import: sin cero inicial, con espacios y guiones', async () => {
    await get('document=900000001');
    await get('document=%20090-000-0001%20');
    expect(repo.queries).toEqual([DOC, DOC]);
  });

  it('RUC de 12 dígitos se completa a 13', async () => {
    const res = await get('document=900000001001');
    expect(repo.queries).toEqual([RUC]);
    expect(res.body).toMatchObject({ documentKind: 'RUC', count: 1 });
  });

  it('sin coincidencias: 200 con lista vacía', async () => {
    const res = await get('document=0999999999');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matches: [], count: 0, truncated: false });
    expect(res.body).not.toHaveProperty('reason');
  });

  it('whitelist nunca importada: reason WHITELIST_EMPTY', async () => {
    setAccountLookupRepository(fakeRepo([], null));
    const res = await get(`document=${DOC}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matches: [], reason: 'WHITELIST_EMPTY', importedAt: null });
  });

  it('recorta a LOOKUP_MAX_MATCHES y marca truncated', async () => {
    const many = Array.from({ length: LOOKUP_MAX_MATCHES + 5 }, (_, i) =>
      row(String(80000000 + i), RUC, 'ACTIVO'),
    );
    setAccountLookupRepository(fakeRepo(many, IMPORTED_AT));
    const res = await get(`document=${RUC}`);
    expect(res.body).toMatchObject({ count: LOOKUP_MAX_MATCHES, truncated: true });
  });

  it('documento demasiado corto → 400', async () => {
    const res = await get('document=123');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(repo.queries).toEqual([]);
  });

  it('sin parámetros o con ambos → 400', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get(`document=${DOC}&order=ORDER/1/2026`)).status).toBe(400);
  });
});

describe('POST /accounts/lookup', () => {
  it('acepta el documento en el cuerpo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/lookup`,
      headers: authHeaders,
      payload: { document: DOC },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ by: 'document', count: 3 });
  });
});

describe('lookup por nº de orden (TYTAN simulado)', () => {
  async function postOrder(order: string) {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/accounts/lookup`,
      headers: authHeaders,
      payload: { order },
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
  }

  it('devuelve exactamente 1 cuenta ACTIVO de la whitelist, con el shape del lookup por documento', async () => {
    const res = await postOrder('ORDER/463158/2026');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      by: 'order',
      workOrder: 'ORDER/463158/2026',
      simulated: true,
      source: 'TYTAN',
      count: 1,
      truncated: false,
      importedAt: IMPORTED_AT.toISOString(),
    });
    expect(res.body).not.toHaveProperty('reason');
    const matches = res.body.matches as LookupAccount[];
    expect(matches).toHaveLength(1);
    // Solo hay 2 cuentas ACTIVO: se elige entre ellas.
    expect(['90000002', '90000009']).toContain(matches[0]?.accountNumber);
    expect(Object.keys(matches[0] as object).sort()).toEqual(
      ['accessType', 'accountNumber', 'accountType', 'businessType', 'city', 'fullName', 'node', 'status'],
    );
    // LOPDP: ni documento ni cpartyId.
    expect(res.raw).not.toContain('documentId');
    expect(res.raw).not.toContain('cpartyId');
    expect(res.raw).not.toContain(DOC);
    expect(res.raw).not.toContain(RUC);
    // El documento nunca se consulta para este camino.
    expect(repo.queries).toEqual([]);
  });

  it('determinístico: misma orden → misma cuenta; GET y POST coinciden', async () => {
    const a = await postOrder('ORDER/463158/2026');
    const b = await get('order=ORDER%2F463158%2F2026');
    expect(b.status).toBe(200);
    expect(b.body.matches).toEqual(a.body.matches);
  });

  it('reparte órdenes distintas entre varias cuentas', async () => {
    const many = Array.from({ length: 40 }, (_, i) => row(String(70000000 + i), `09${String(i).padStart(8, '0')}`, 'ACTIVO'));
    setAccountLookupRepository(fakeRepo(many, IMPORTED_AT));
    const seen = new Set<string>();
    for (let n = 0; n < 20; n++) {
      const res = await postOrder(`ORDER/${460000 + n}/2026`);
      seen.add((res.body.matches as LookupAccount[])[0]?.accountNumber as string);
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('solo dígitos → ORDER/<n>/<año actual de Ecuador>', async () => {
    const year = new Date(Date.now() - 5 * 3600_000).getUTCFullYear();
    const res = await postOrder(' 463158 ');
    expect(res.status).toBe(200);
    expect(res.body.workOrder).toBe(`ORDER/463158/${year}`);
  });

  it('acepta minúsculas y espacios alrededor de las barras', async () => {
    const res = await postOrder('order / 463158 / 2026');
    expect(res.body.workOrder).toBe('ORDER/463158/2026');
  });

  it('formato inválido → 400 VALIDATION_ERROR', async () => {
    for (const bad of ['TASK/463158/2026', 'ORDER/12/2026', 'ORDER/463158', 'abc', 'ORDER/463158/1800']) {
      const res = await postOrder(bad);
      expect(res.status, bad).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('sin cuentas ACTIVO usa cualquier estado', async () => {
    setAccountLookupRepository(fakeRepo([row('90000001', DOC, 'SUSPENDIDO')], IMPORTED_AT));
    const res = await postOrder('ORDER/463158/2026');
    expect((res.body.matches as LookupAccount[])[0]?.accountNumber).toBe('90000001');
  });

  it('whitelist vacía → cuenta demo 40123456 con reason WHITELIST_EMPTY', async () => {
    setAccountLookupRepository(fakeRepo([], null));
    const res = await postOrder('463158');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 1, importedAt: null, reason: 'WHITELIST_EMPTY' });
    expect((res.body.matches as LookupAccount[])[0]).toMatchObject({
      accountNumber: ORDER_DEMO_ACCOUNT,
      status: 'ACTIVO',
    });
  });

  it('cachea el conteo de candidatas por import (no recuenta en cada orden)', async () => {
    await postOrder('ORDER/463158/2026');
    await postOrder('ORDER/463159/2026');
    await postOrder('ORDER/463160/2026');
    expect(repo.candidateCalls).toBe(1);
  });
});

describe('redactUrl (log de peticiones)', () => {
  it('oculta el documento y conserva el resto', () => {
    expect(redactUrl(`/herramientas/v1/accounts/lookup?document=${DOC}&x=1`)).toBe(
      '/herramientas/v1/accounts/lookup?document=[REDACTADO]&x=1',
    );
    expect(redactUrl('/a?order=ORDER%2F1%2F2026')).toBe('/a?order=ORDER%2F1%2F2026');
    expect(redactUrl('/a')).toBe('/a');
  });
});
