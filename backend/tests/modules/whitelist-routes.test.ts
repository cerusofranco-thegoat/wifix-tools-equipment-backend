// GET /accounts/{n}/whitelist — sin base de datos: el repositorio se reemplaza
// por un doble en memoria con datos sintéticos.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import {
  setWhitelistRepository,
  type WhitelistEntry,
  type WhitelistRepository,
} from '../../src/modules/whitelist/whitelist.service.js';

const PREFIX = '/herramientas/v1';
const IMPORTED_AT = new Date('2026-09-01T12:00:00.000Z');

let app: FastifyInstance;
let authHeaders: Record<string, string>;

const originalEnv = {
  WHITELIST_ENFORCE: env.WHITELIST_ENFORCE,
  WHITELIST_EXTRA_ACCOUNTS: env.WHITELIST_EXTRA_ACCOUNTS,
};

/** Doble del repositorio. Guarda un documentId para probar que NUNCA sale. */
function fakeRepo(
  entries: Array<WhitelistEntry & { documentId: string }>,
  importedAt: Date | null,
): WhitelistRepository & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async findEntry(accountNumber) {
      lookups.push(accountNumber);
      // Devuelve el objeto CON documentId: la capa de servicio no debe filtrarlo.
      return entries.find((e) => e.accountNumber === accountNumber) ?? null;
    },
    async latestImportAt() {
      return importedAt;
    },
  };
}

const LISTED = {
  accountNumber: '90000001',
  documentId: '0900000001',
  status: 'SUSPENDIDO' as const,
  city: 'CIUDAD X',
  node: 'N1',
  businessType: 'Internet CM',
  accountType: 'Residencial',
  accessType: 'Mora Dia 31',
  importedAt: IMPORTED_AT,
};

async function check(account: string, headers: Record<string, string> = authHeaders) {
  const res = await app.inject({
    method: 'GET',
    url: `${PREFIX}/accounts/${account}/whitelist`,
    headers,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown>, raw: res.body };
}

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  setWhitelistRepository(null);
  Object.assign(env, originalEnv);
  await app.close();
});

beforeEach(() => {
  Object.assign(env, { WHITELIST_ENFORCE: false, WHITELIST_EXTRA_ACCOUNTS: [] });
  setWhitelistRepository(fakeRepo([LISTED], IMPORTED_AT));
});

describe('GET /accounts/:n/whitelist', () => {
  it('exige autenticación', async () => {
    const res = await check('90000001', {});
    expect(res.status).toBe(401);
  });

  it('cuenta listada: datos de la lista, source IMPORT, sin documentId', async () => {
    const res = await check('90000001');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountNumber: '90000001',
      listed: true,
      source: 'IMPORT',
      status: 'SUSPENDIDO',
      city: 'CIUDAD X',
      node: 'N1',
      businessType: 'Internet CM',
      accountType: 'Residencial',
      accessType: 'Mora Dia 31',
      importedAt: IMPORTED_AT.toISOString(),
      enforce: false,
    });
    expect(res.body).not.toHaveProperty('documentId');
    expect(res.raw).not.toContain('0900000001');
  });

  it('normaliza la cuenta: espacios y ceros a la izquierda', async () => {
    const res = await check('%20%200090000001%20');
    expect(res.body).toMatchObject({ accountNumber: '90000001', listed: true });
  });

  it('cuenta no listada', async () => {
    const res = await check('12345678');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accountNumber: '12345678',
      listed: false,
      importedAt: IMPORTED_AT.toISOString(),
      enforce: false,
    });
  });

  it('lista vacía (nunca se importó): listed null, WHITELIST_EMPTY y enforce false aunque esté activado', async () => {
    setWhitelistRepository(fakeRepo([], null));
    Object.assign(env, { WHITELIST_ENFORCE: true });
    const res = await check('12345678');
    expect(res.body).toEqual({
      accountNumber: '12345678',
      listed: null,
      reason: 'WHITELIST_EMPTY',
      importedAt: null,
      enforce: false,
    });
  });

  it('cuenta EXTRA: ACTIVO, source EXTRA, sin consultar la lista', async () => {
    const repo = fakeRepo([], IMPORTED_AT);
    setWhitelistRepository(repo);
    Object.assign(env, { WHITELIST_EXTRA_ACCOUNTS: [' 040123456 ', '99'] });
    const res = await check('40123456');
    expect(res.body).toEqual({
      accountNumber: '40123456',
      listed: true,
      source: 'EXTRA',
      status: 'ACTIVO',
      city: null,
      node: null,
      businessType: null,
      accountType: null,
      accessType: null,
      importedAt: IMPORTED_AT.toISOString(),
      enforce: false,
    });
    expect(repo.lookups).toEqual([]);
  });

  it('cuenta EXTRA con la lista vacía: sigue listada, importedAt null', async () => {
    setWhitelistRepository(fakeRepo([], null));
    Object.assign(env, { WHITELIST_EXTRA_ACCOUNTS: ['40123456'] });
    const res = await check('40123456');
    expect(res.body).toMatchObject({ listed: true, source: 'EXTRA', importedAt: null });
  });

  it('WHITELIST_ENFORCE=true se refleja en listed y no listed', async () => {
    Object.assign(env, { WHITELIST_ENFORCE: true });
    expect((await check('90000001')).body.enforce).toBe(true);
    expect((await check('12345678')).body.enforce).toBe(true);
  });
});
