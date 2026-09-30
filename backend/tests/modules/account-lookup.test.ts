// GET/POST /accounts/lookup — ingreso por cédula/RUC (y nº de orden, 501).
// Sin base de datos: el repositorio se reemplaza por un doble en memoria con
// datos sintéticos. Protege la regla LOPDP: el documento NUNCA sale.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';
import { redactUrl } from '../../src/app.js';
import {
  LOOKUP_MAX_MATCHES,
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

function fakeRepo(rows: Row[], importedAt: Date | null): AccountLookupRepository & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async findByDocument(documentId, take) {
      queries.push(documentId);
      // Devuelve las filas CON documentId y cpartyId: la capa de servicio no debe filtrarlas.
      return rows.filter((r) => r.documentId === documentId).slice(0, take);
    },
    async latestImportAt() {
      return importedAt;
    },
  };
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

describe('lookup por nº de orden', () => {
  it('reconocido pero no disponible: 501 NOT_IMPLEMENTED', async () => {
    const res = await get('order=ORDER%2F424900%2F2026');
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      code: 'NOT_IMPLEMENTED',
      meta: { lookup: 'order', order: 'ORDER/424900/2026' },
    });
    expect(repo.queries).toEqual([]);
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
