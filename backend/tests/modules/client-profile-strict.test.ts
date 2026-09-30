// client-profile con FSM en `real`: NUNCA identidad inventada.
//
// Reglas que estos tests protegen (decisión de Franco, 2026-09-26):
//   1. FSM sin datos → identidad `null`, `sources.<campo>='NONE'`, degraded
//      FSM_NO_DATA. Plan y velocidades siguen MOCK.
//   2. Si la cuenta está en la whitelist con nombre → `fullName` de ahí,
//      `sources.fullName='WHITELIST'` y el mensaje lo dice.
//   3. FSM con identidad parcial → lo que falta es `null`/`NONE`, sin degraded.
//   4. Un fallo leyendo la whitelist no tumba la pantalla.
//   5. PUT en real no rellena lo no editado con el mock.
//   6. `mock` no cambia; current-nap sin coordenadas reales → NO_COORDS.
//
// Sin base de datos (la whitelist es un doble) y sin red (`fetch` es un doble).
// Datos 100 % sintéticos.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp, futureJwt, installFetchSpy, type FetchSpy } from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import { resetHttpCache } from '../../src/connectors/http/throttle.js';
import { resetFsmTokenCache } from '../../src/connectors/http/fsm-token.js';
import { resetFsmLimiter } from '../../src/connectors/http/fsm-api.js';
import { resetNapRegistry } from '../../src/connectors/fsm/index.js';
import {
  setWhitelistRepository,
  type WhitelistRepository,
} from '../../src/modules/whitelist/whitelist.service.js';

const PREFIX = '/herramientas/v1';
const ACCOUNT = '90000077';
const WL_NAME = 'CLIENTE SINTETICO DE PRUEBA';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
let spy: FetchSpy | null = null;
let nameLookups: string[] = [];

const originalEnv = {
  CONNECTOR_MODE_FSM: env.CONNECTOR_MODE_FSM,
  NAPS_PRIMARY_SOURCE: env.NAPS_PRIMARY_SOURCE,
};

function whitelist(
  names: Record<string, string>,
  opts: { fail?: boolean } = {},
): WhitelistRepository {
  return {
    findEntry: async () => null,
    latestImportAt: async () => new Date('2026-09-01T00:00:00Z'),
    findFullName: async (account) => {
      nameLookups.push(account);
      if (opts.fail) throw new Error('db caída');
      return names[account] ?? null;
    },
  };
}

function useRealFsm(processBody: unknown): FetchSpy {
  process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
  Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
  resetFsmTokenCache();
  spy = installFetchSpy(() => ({ status: 200, body: processBody }));
  return spy;
}

async function getProfile(account = ACCOUNT) {
  const res = await app.inject({
    method: 'GET',
    url: `${PREFIX}/accounts/${account}/client-profile`,
    headers: authHeaders,
  });
  return { res, body: res.json() };
}

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
  Object.assign(env, originalEnv);
  setWhitelistRepository(null);
});

beforeEach(() => {
  Object.assign(env, { CONNECTOR_MODE_FSM: 'mock', NAPS_PRIMARY_SOURCE: 'tec' });
  delete process.env.FSM_API_TOKEN_TELENEWS;
  resetHttpCache();
  resetFsmTokenCache();
  resetFsmLimiter();
  resetNapRegistry();
  nameLookups = [];
  setWhitelistRepository(whitelist({ [ACCOUNT]: WL_NAME }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  spy?.restore();
  spy = null;
  vi.restoreAllMocks();
});

describe('client-profile — FSM real sin datos', () => {
  it('cuenta en la whitelist: nombre WHITELIST, resto null/NONE, degraded FSM_NO_DATA', async () => {
    useRealFsm({ data: [] });
    const { res, body } = await getProfile();
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      accountNumber: ACCOUNT,
      fullName: WL_NAME,
      address: null,
      phones: null,
      email: null,
      latitude: null,
      longitude: null,
    });
    expect(body.sources).toEqual({
      fullName: 'WHITELIST',
      address: 'NONE',
      phones: 'NONE',
      email: 'NONE',
      latitude: 'NONE',
      longitude: 'NONE',
      planName: 'MOCK',
      contractedDownloadMbps: 'MOCK',
      contractedUploadMbps: 'MOCK',
    });
    // Plan y velocidades siguen saliendo del mock, como hoy.
    expect(typeof body.planName).toBe('string');
    expect(typeof body.contractedDownloadMbps).toBe('number');
    expect(body.degraded).toEqual({
      reason: 'FSM_NO_DATA',
      message: 'Sin datos en FSM para esta cuenta; nombre tomado de la base de clientes Xtrim.',
    });
    const header = JSON.parse(decodeURIComponent(String(res.headers['x-wifix-degraded'])));
    expect(header.reason).toBe('FSM_NO_DATA');
  });

  it('la cuenta se normaliza al buscar en la whitelist (ceros a la izquierda)', async () => {
    useRealFsm({ data: [] });
    const { body } = await getProfile(`00${ACCOUNT}`);
    expect(body.fullName).toBe(WL_NAME);
    expect(nameLookups).toEqual([ACCOUNT]);
  });

  it('cuenta fuera de la whitelist: fullName null/NONE y mensaje sin whitelist', async () => {
    useRealFsm({ data: [] });
    const { body } = await getProfile('90000078');
    expect(body.fullName).toBeNull();
    expect(body.sources.fullName).toBe('NONE');
    expect(body.degraded).toEqual({
      reason: 'FSM_NO_DATA',
      message: 'Sin datos en FSM para esta cuenta.',
    });
  });

  it('whitelist caída: no rompe, fullName null/NONE', async () => {
    setWhitelistRepository(whitelist({ [ACCOUNT]: WL_NAME }, { fail: true }));
    useRealFsm({ data: [] });
    const { res, body } = await getProfile();
    expect(res.statusCode).toBe(200);
    expect(body.fullName).toBeNull();
    expect(body.sources.fullName).toBe('NONE');
    expect(body.degraded.reason).toBe('FSM_NO_DATA');
  });

  it('nunca aparece la identidad del mock (nombre/teléfono/email sembrados)', async () => {
    useRealFsm({ data: [] });
    const { res } = await getProfile('90000078');
    // El mock inventa emails @example.com y teléfonos 09xxxxxxxx.
    expect(res.body).not.toMatch(/@example\.com/);
    expect(res.body).not.toMatch(/"09\d{8}"/);
  });
});

describe('client-profile — FSM real con datos', () => {
  it('identidad completa de FSM: no consulta la whitelist ni degrada', async () => {
    useRealFsm({
      data: [
        {
          names: 'NOMBRE FSM SINTETICO',
          phoneNumber: '0990000000',
          email: 'fsm@sintetico.test',
          address: 'Calle Sintética 1',
          latitude: -2.1,
          longitude: -79.9,
          workOrder: 'ORDER/1/2026',
          task: 'INSTALACION',
          state: 'FINALIZADA',
          creationDate: '2026-08-14 14:02:00',
          endDate: '2026-08-14 16:41:00',
        },
      ],
    });
    const { body } = await getProfile();
    expect(body.fullName).toBe('NOMBRE FSM SINTETICO');
    expect(body.sources).toMatchObject({
      fullName: 'FSM',
      address: 'FSM',
      phones: 'FSM',
      email: 'FSM',
    });
    expect(body.degraded).toBeUndefined();
    expect(nameLookups).toEqual([]);
  });

  it('identidad parcial (sin nombre ni teléfono): nombre de la whitelist, teléfono null, sin degraded', async () => {
    useRealFsm({
      data: [
        {
          address: 'Calle Sintética 2',
          workOrder: 'ORDER/2/2026',
          task: 'INSTALACION',
          state: 'FINALIZADA',
          creationDate: '2026-08-14 14:02:00',
          endDate: '2026-08-14 16:41:00',
        },
      ],
    });
    const { body } = await getProfile();
    expect(body).toMatchObject({
      fullName: WL_NAME,
      address: 'Calle Sintética 2',
      phones: null,
      email: null,
    });
    expect(body.sources).toMatchObject({
      fullName: 'WHITELIST',
      address: 'FSM',
      phones: 'NONE',
      email: 'NONE',
    });
    expect(body.degraded).toBeUndefined();
  });
});

describe('PUT client-profile — FSM real', () => {
  it('lo editado manda; lo no editado NO sale del mock', async () => {
    useRealFsm({ data: [] });
    const account = '90000079';
    const put = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/client-profile`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { address: 'Dirección tecleada por el técnico' },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    expect(body.address).toBe('Dirección tecleada por el técnico');
    expect(body.sources.address).toBe('MOCK');
    expect(body).toMatchObject({ fullName: null, phones: null, email: null, latitude: null });
    expect(body.sources).toMatchObject({ fullName: 'NONE', phones: 'NONE' });
  });

  it('si FSM falla en el PUT, igual guarda y no inventa', async () => {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
    Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
    resetFsmTokenCache();
    spy = installFetchSpy(() => ({ status: 500, raw: 'boom' }));
    const put = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/90000080/client-profile`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      payload: { phones: ['0980000000'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ phones: ['0980000000'], fullName: null, address: null });
  });
});

describe('otros modos y consumidores', () => {
  it('mock: sin cambios (identidad simulada marcada MOCK/FSM, nunca NONE)', async () => {
    const { res, body } = await getProfile('35070291');
    expect(res.statusCode).toBe(200);
    expect(typeof body.fullName).toBe('string');
    expect(Object.values(body.sources)).not.toContain('NONE');
    expect(Object.values(body.sources)).not.toContain('WHITELIST');
    expect(nameLookups).toEqual([]);
  });

  it('current-nap real sin datos en FSM: NO_COORDS, nunca coordenadas inventadas', async () => {
    Object.assign(env, { NAPS_PRIMARY_SOURCE: 'fsm' });
    const fetchSpy = useRealFsm({ data: [] });
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${ACCOUNT}/current-nap`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    // NAP asignada siempre: la de relleno es SIMULADA y lo dice; nunca pasa por real.
    expect(res.json()).toMatchObject({
      found: true,
      simulated: true,
      source: 'SIMULATED',
      simulationReason: 'NO_COORDS',
      nap: { source: 'SIMULATED', napId: null },
      equipmentId: null,
    });
    expect(fetchSpy.calls.every((c) => c.url.includes('/account/process'))).toBe(true);

    // Estricto (`fallback=none`): igual que antes, sin inventar nada.
    const strict = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${ACCOUNT}/current-nap?fallback=none`,
      headers: authHeaders,
    });
    expect(strict.json()).toMatchObject({ found: false, reason: 'NO_COORDS', nap: null });
  });

  async function contractStatus(account: string, processBody: unknown) {
    process.env.FSM_API_TOKEN_TELENEWS = futureJwt(12);
    Object.assign(env, { CONNECTOR_MODE_FSM: 'real' });
    resetFsmTokenCache();
    spy = installFetchSpy((call) =>
      call.url.includes('/account/status')
        ? { status: 200, body: { data: { accountId: 1, status: 'A', description: 'Activo' } } }
        : { status: 200, body: processBody },
    );
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${account}/contract-status`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('contract-status real sin datos en FSM: nombre de la whitelist, clientNameSource WHITELIST', async () => {
    const body = await contractStatus(ACCOUNT, { data: [] });
    expect(body.clientName).toBe(WL_NAME);
    expect(body.clientNameSource).toBe('WHITELIST');
  });

  it('contract-status real fuera de la whitelist: clientName vacío y NONE, nunca el mock', async () => {
    const body = await contractStatus('90000078', { data: [] });
    expect(body.clientName).toBe('');
    expect(body.clientNameSource).toBe('NONE');
  });

  it('contract-status real con nombre en FSM: FSM y sin consultar la whitelist', async () => {
    const body = await contractStatus(ACCOUNT, {
      data: [
        {
          names: 'NOMBRE FSM SINTETICO',
          workOrder: 'ORDER/3/2026',
          task: 'INSTALACION',
          state: 'FINALIZADA',
          creationDate: '2026-08-14 14:02:00',
          endDate: '2026-08-14 16:41:00',
        },
      ],
    });
    expect(body.clientName).toBe('NOMBRE FSM SINTETICO');
    expect(body.clientNameSource).toBe('FSM');
    expect(nameLookups).toEqual([]);
  });
});
