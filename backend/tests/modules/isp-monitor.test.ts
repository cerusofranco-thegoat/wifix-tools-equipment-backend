// ISP Monitor por número de cuenta (SIMULADO):
//   GET /accounts/:n/isp-monitor
//   GET /accounts/:n/isp-monitor/access-network
// Sin base de datos: la whitelist se reemplaza por un doble en memoria.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';
import { env } from '../../src/config/env.js';
import { comarchMock } from '../../src/connectors/comarch/index.js';
import {
  resolveAccountTechnology,
  simulatedAccessLayout,
  simulatedClientDevice,
} from '../../src/connectors/ispmonitor/account-simulation.js';
import {
  buildAccessNetwork,
  buildIspMonitorAccount,
  planFromContract,
  simulatedScenario,
  type DiagnosisScope,
  type IspAccessNetwork,
  type IspClientInput,
} from '../../src/modules/network-diagnostics/isp-monitor.generator.js';
import {
  setWhitelistRepository,
  type WhitelistEntry,
  type WhitelistRepository,
} from '../../src/modules/whitelist/whitelist.service.js';

const PREFIX = '/herramientas/v1';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const IMPORTED_AT = new Date('2026-09-26T22:07:00.000Z');

const originalEnv = {
  WHITELIST_ENFORCE: env.WHITELIST_ENFORCE,
  WHITELIST_EXTRA_ACCOUNTS: env.WHITELIST_EXTRA_ACCOUNTS,
  CONNECTOR_MODE_TEC: env.CONNECTOR_MODE_TEC,
  CONNECTOR_MODE_ISPMONITOR: env.CONNECTOR_MODE_ISPMONITOR,
};

let app: FastifyInstance;
let authHeaders: Record<string, string>;

/** Barrido determinístico de cuentas para encontrar cada caso. */
const SWEEP = Array.from({ length: 3000 }, (_, i) => String(100_000_000 + i * 104_729));

async function inputFor(accountNumber: string, extra: Partial<IspClientInput> = {}): Promise<IspClientInput> {
  const profile = await comarchMock.getClientProfile(accountNumber);
  return {
    accountNumber,
    clientName: profile.fullName.toUpperCase(),
    accountStatus: 'A',
    city: null,
    plan: planFromContract(profile),
    ...extra,
  };
}

function firstWith(predicate: (account: string) => boolean): string {
  const found = SWEEP.find(predicate);
  if (!found) throw new Error('El barrido no encontró una cuenta para el caso.');
  return found;
}

function entry(accountNumber: string, extra: Partial<WhitelistEntry> = {}): WhitelistEntry & { fullName: string } {
  return {
    accountNumber,
    status: 'ACTIVO',
    city: 'QUITO',
    node: 'QQ4B',
    businessType: 'Internet CM',
    accountType: 'Residencial',
    accessType: 'Acceso Completo',
    importedAt: IMPORTED_AT,
    fullName: 'Cliente Sintetico Whitelist',
    ...extra,
  };
}

function fakeRepo(entries: Array<WhitelistEntry & { fullName: string }>): WhitelistRepository {
  return {
    async findEntry(accountNumber) {
      return entries.find((e) => e.accountNumber === accountNumber) ?? null;
    },
    async latestImportAt() {
      return IMPORTED_AT;
    },
    async findFullName(accountNumber) {
      return entries.find((e) => e.accountNumber === accountNumber)?.fullName ?? null;
    },
  };
}

async function get(path: string, headers: Record<string, string> = authHeaders) {
  const res = await app.inject({ method: 'GET', url: `${PREFIX}${path}`, headers });
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
  setWhitelistRepository(fakeRepo([]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(env, {
    CONNECTOR_MODE_TEC: originalEnv.CONNECTOR_MODE_TEC,
    CONNECTOR_MODE_ISPMONITOR: originalEnv.CONNECTOR_MODE_ISPMONITOR,
  });
});

// ---------------------------------------------------------------------------
// Generador puro
// ---------------------------------------------------------------------------

describe('plan en bits', () => {
  it('RES-<kbps>/<kbps>-I con el mismo número que client-profile, simétrico', async () => {
    for (const account of SWEEP.slice(0, 100)) {
      const profile = await comarchMock.getClientProfile(account);
      const plan = planFromContract(profile);
      expect(plan.downloadKbps).toBe(profile.contractedDownloadMbps * 1000);
      expect(plan.uploadKbps).toBe(plan.downloadKbps);
      expect(plan.downloadMbps).toBe(profile.contractedDownloadMbps);
      expect(plan.uploadMbps).toBe(plan.downloadMbps);
      expect(plan.profile).toBe(`RES-${plan.downloadKbps}/${plan.uploadKbps}-I`);
      expect(plan.name).toBe(profile.planName);
    }
    expect(planFromContract({ planName: 'X', contractedDownloadMbps: 300, contractedUploadMbps: 300 }).profile).toBe(
      'RES-300000/300000-I',
    );
  });
});

describe('buildIspMonitorAccount', () => {
  it('determinístico y con la tecnología compartida con la orden', async () => {
    for (const account of SWEEP.slice(0, 150)) {
      const input = await inputFor(account);
      const a = buildIspMonitorAccount(input, NOW);
      expect(buildIspMonitorAccount(input, NOW)).toEqual(a);
      expect(a.simulated).toBe(true);
      expect(a.source).toBe('ISP_MONITOR');
      expect(a.technology).toBe(resolveAccountTechnology(account));
      const device = simulatedClientDevice(account);
      expect(a.searchRow.serial).toBe(device.ispId);
      expect(a.device?.serial).toBe(device.ispId);
      expect(a.searchRow.profile).toBe(a.plan.profile);
      expect(a.searchRow.accessNetwork).toBe(simulatedAccessLayout(account).accessNetwork);
      expect(a.device?.nap).toBe(simulatedAccessLayout(account).clientNap);
      expect(a.searchRow.clientName).toBe(a.searchRow.clientName.toUpperCase());
      expect(['A', 'S', 'T']).toContain(a.searchRow.accountStatus);
      expect(['working', 'lost']).toContain(a.device?.state);
    }
  });

  it('GPON: ONU Info con óptica y sin DOCSIS', async () => {
    const account = firstWith((a) => resolveAccountTechnology(a) === 'GPON' && simulatedScenario(a) === 'NONE');
    const r = buildIspMonitorAccount(await inputFor(account), NOW);
    expect(r.technology).toBe('GPON');
    expect(r.docsis).toBeNull();
    const d = r.device;
    expect(d?.serial).toMatch(/^ZTEG[0-9A-F]{8}$/);
    expect(d?.model).toBe('F6600V9.0');
    expect(d?.port).toMatch(/^gpon_olt-1\/\d{1,2}\/\d{1,2}$/);
    expect(d?.onuId).toMatch(/^gpon-onu_1\/\d{1,2}\/\d{1,2}:\d{1,2}$/);
    expect(d?.headend).toMatch(/^[A-Z]{3} HEADEND ZTE \d$/);
    expect(d?.speedMode).toBe('GPON');
    expect(d?.state).toBe('working');
    expect(d?.wanIp).toBe('DHCP');
    expect(d?.servicePorts[0]).toMatchObject({
      id: 1,
      mode: 'tag',
      service: 'INT Residencial',
      trafficProfile: `DOWN-RES-${r.plan.downloadKbps}-I`,
    });
    expect(d?.cpes[0]?.mac).toMatch(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
    const o = d?.optics;
    expect(o).not.toBeNull();
    expect(typeof o?.rxDbm).toBe('number');
    expect(o?.rxOk).toBe((o?.rxDbm as number) >= -27 && (o?.rxDbm as number) <= -8);
    expect(o?.rxOltOk).toBe((o?.rxOltDbm as number) >= -28 && (o?.rxOltDbm as number) <= -8);
    expect(o?.txOk).toBe((o?.txDbm as number) >= 0.5 && (o?.txDbm as number) <= 5);
  });

  it('HFC: cablemódem con DOCSIS y sin óptica GPON', async () => {
    const account = firstWith((a) => resolveAccountTechnology(a) === 'HFC' && simulatedScenario(a) === 'NONE');
    const r = buildIspMonitorAccount(await inputFor(account), NOW);
    expect(r.technology).toBe('HFC');
    expect(r.device?.optics).toBeNull();
    expect(r.device?.onuId).toBeNull();
    expect(r.device?.servicePorts).toEqual([]);
    expect(r.device?.offlineCause).toBeNull();
    expect(r.device?.serial).toMatch(/^[0-9A-F]{12}$/);
    expect(r.device?.speedMode).toMatch(/^DOCSIS/);
    expect(r.docsis).not.toBeNull();
    expect(r.docsis?.downstream.length).toBeGreaterThan(0);
    expect(r.docsis?.upstream.length).toBeGreaterThan(0);
    for (const c of [...(r.docsis?.downstream ?? []), ...(r.docsis?.upstream ?? [])]) {
      expect(Object.keys(c).sort()).toEqual(['channel', 'frequencyMHz', 'powerDbmv', 'snrDb']);
    }
    expect(typeof r.docsis?.codewords.corrected).toBe('number');
    expect(typeof r.docsis?.ok).toBe('boolean');
  });

  it('nunca expone ifIndex/index internos ni habla de "nodo"', async () => {
    for (const account of SWEEP.slice(0, 60)) {
      const input = await inputFor(account);
      const json = JSON.stringify([buildIspMonitorAccount(input, NOW), buildAccessNetwork(input)]);
      expect(json).not.toMatch(/"ifIndex"|"index"|"device_id"/i);
      expect(json.toLowerCase()).not.toContain('nodo');
    }
  });
});

describe('buildAccessNetwork', () => {
  function checkShape(r: IspAccessNetwork, account: string) {
    expect(r.simulated).toBe(true);
    expect(r.technology).toBe(resolveAccountTechnology(account));
    expect(r.naps.length).toBeGreaterThanOrEqual(4);
    expect(r.naps.length).toBeLessThanOrEqual(7);
    expect(r.naps[0]?.nap).toBe(r.clientNap);
    expect(new Set(r.naps.map((n) => n.nap)).size).toBe(r.naps.length);
    const clients = r.naps.flatMap((n) => n.devices.filter((d) => d.isClient));
    expect(clients).toHaveLength(1);
    expect(r.naps[0]?.devices.some((d) => d.isClient)).toBe(true);
    let devices = 0;
    let lost = 0;
    const accounts = new Set<string>();
    for (const nap of r.naps) {
      expect(nap.devices.length).toBeGreaterThanOrEqual(2);
      expect(nap.devices.length).toBeLessThanOrEqual(16);
      const napLost = nap.devices.filter((d) => d.state === 'lost').length;
      expect(nap.summary).toEqual({
        total: nap.devices.length,
        working: nap.devices.length - napLost,
        lost: napLost,
        state: napLost === 0 ? 'OK' : napLost === nap.devices.length ? 'DOWN' : 'PARTIAL',
      });
      devices += nap.devices.length;
      lost += napLost;
      for (const d of nap.devices) {
        accounts.add(d.accountNumber);
        expect(['A', 'S', 'T']).toContain(d.accountStatus);
        expect(d.clientName).toBe(d.clientName.toUpperCase());
        if (r.technology === 'GPON') expect(d.serial).toMatch(/^(ZTEG|STGU|XPON)[0-9A-F]{8}$/);
        else expect(d.serial).toMatch(/^[0-9A-F]{12}$/);
      }
    }
    expect(accounts.size).toBe(devices);
    expect(r.totals).toEqual({ devices, working: devices - lost, lost });
  }

  it('agrupado por NAP, totales coherentes y el cliente en su NAP con el mismo estado que device', async () => {
    for (const account of SWEEP.slice(0, 300)) {
      const input = await inputFor(account);
      const r = buildAccessNetwork(input);
      expect(buildAccessNetwork(input)).toEqual(r);
      checkShape(r, account);
      const monitor = buildIspMonitorAccount(input, NOW);
      const client = r.naps[0]?.devices.find((d) => d.isClient);
      expect(client?.serial).toBe(monitor.device?.serial);
      expect(client?.state).toBe(monitor.device?.state);
      expect(client?.accountNumber).toBe(monitor.searchRow.accountNumber);
      expect(r.clientNap).toBe(monitor.device?.nap);
      expect(r.accessNetwork).toBe(monitor.device?.accessNetwork);
    }
  });

  it('los 4 diagnósticos aparecen y cumplen su regla (≈10 % de cuentas con falla)', async () => {
    const found = new Map<DiagnosisScope, string>();
    let failures = 0;
    for (const account of SWEEP) {
      const scenario = simulatedScenario(account);
      if (scenario !== 'NONE') failures += 1;
      if (!found.has(scenario)) found.set(scenario, account);
    }
    expect(failures / SWEEP.length).toBeGreaterThan(0.06);
    expect(failures / SWEEP.length).toBeLessThan(0.14);
    expect([...found.keys()].sort()).toEqual(['EXTERNAL_NAP', 'EXTERNAL_NETWORK', 'INTERNAL', 'NONE']);

    for (const [scope, account] of found) {
      const input = await inputFor(account);
      const r = buildAccessNetwork(input);
      const monitor = buildIspMonitorAccount(input, NOW);
      checkShape(r, account);
      expect(r.diagnosis.scope).toBe(scope);
      expect(r.diagnosis.message.length).toBeGreaterThan(20);
      const clientNap = r.naps[0];
      const client = clientNap?.devices.find((d) => d.isClient);
      const napsWithLost = r.naps.filter((n) => n.summary.lost > 0).length;
      switch (scope) {
        case 'NONE':
          expect(client?.state).toBe('working');
          expect(monitor.device?.state).toBe('working');
          expect(clientNap?.summary.lost).toBe(0);
          break;
        case 'INTERNAL':
          expect(client?.state).toBe('lost');
          expect(monitor.device?.state).toBe('lost');
          // Solo el cliente: el resto de su NAP está working.
          expect(clientNap?.summary.lost).toBe(1);
          expect(r.diagnosis.message).toContain('interna');
          break;
        case 'EXTERNAL_NAP':
          expect(client?.state).toBe('lost');
          expect((clientNap?.summary.lost ?? 0) / (clientNap?.summary.total ?? 1)).toBeGreaterThanOrEqual(0.5);
          expect(napsWithLost).toBe(1);
          break;
        case 'EXTERNAL_NETWORK':
          expect(r.totals.lost / r.totals.devices).toBeGreaterThanOrEqual(0.3);
          expect(napsWithLost).toBeGreaterThanOrEqual(2);
          break;
      }
      if (scope !== 'NONE' && monitor.technology === 'GPON') {
        expect(monitor.device?.offlineCause).not.toBeNull();
        expect(monitor.device?.optics?.rxOk).toBe(false);
        expect(monitor.device?.optics?.rxDbm).toBeNull();
        expect(monitor.device?.cpes).toEqual([]);
      }
    }
  });

  it('el diagnóstico (regla sobre los datos) coincide con el escenario simulado en todo el barrido', async () => {
    for (const account of SWEEP.slice(0, 1500)) {
      const r = buildAccessNetwork(await inputFor(account));
      expect(r.diagnosis.scope).toBe(simulatedScenario(account));
    }
  });
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

describe('GET /accounts/:n/isp-monitor', () => {
  it('exige autenticación', async () => {
    expect((await get('/accounts/100926544/isp-monitor', {})).status).toBe(401);
    expect((await get('/accounts/100926544/isp-monitor/access-network', {})).status).toBe(401);
  });

  it('responde el contrato; el plan coincide con client-profile', async () => {
    const account = '100926544';
    const res = await get(`/accounts/${account}/isp-monitor`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      ['device', 'docsis', 'plan', 'searchRow', 'simulated', 'source', 'technology'],
    );
    const profile = await get(`/accounts/${account}/client-profile`);
    expect(profile.status).toBe(200);
    const plan = res.body.plan as Record<string, number | string>;
    expect(plan.downloadMbps).toBe(profile.body.contractedDownloadMbps);
    expect(plan.downloadKbps).toBe((profile.body.contractedDownloadMbps as number) * 1000);
    expect(plan.uploadKbps).toBe(plan.downloadKbps);
    expect(res.body.technology).toBe(resolveAccountTechnology(account));
  });

  it('ceros a la izquierda → misma cuenta', async () => {
    const a = await get('/accounts/100926544/isp-monitor/access-network');
    const b = await get('/accounts/00100926544/isp-monitor/access-network');
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
  });

  it('cuenta con formato inválido → 400 VALIDATION_ERROR', async () => {
    for (const bad of ['ABC123', '12', '0000123', '1234567890123', 'WX-INT-001']) {
      for (const suffix of ['isp-monitor', 'isp-monitor/access-network']) {
        const res = await get(`/accounts/${bad}/${suffix}`);
        expect(res.status).toBe(400);
        expect((res.body.error as Record<string, unknown> | undefined)?.code ?? res.body.code).toBe(
          'VALIDATION_ERROR',
        );
      }
    }
  });

  it('con WHITELIST_ENFORCE y la cuenta fuera de la lista → 404; listada → 200', async () => {
    Object.assign(env, { WHITELIST_ENFORCE: true });
    setWhitelistRepository(fakeRepo([entry('90000001')]));
    for (const suffix of ['isp-monitor', 'isp-monitor/access-network']) {
      const missing = await get(`/accounts/90000002/${suffix}`);
      expect(missing.status).toBe(404);
      expect(missing.raw).toContain('NOT_FOUND');
      expect((await get(`/accounts/90000001/${suffix}`)).status).toBe(200);
    }
    // Sin modo bloqueo, la cuenta no listada sí responde (solo se avisa en la app).
    Object.assign(env, { WHITELIST_ENFORCE: false });
    expect((await get('/accounts/90000002/isp-monitor')).status).toBe(200);
  });

  it('usa estado, ciudad y nombre de la whitelist cuando la cuenta está', async () => {
    setWhitelistRepository(fakeRepo([entry('90000001', { status: 'SUSPENDIDO', city: 'QUITO' })]));
    const res = await get('/accounts/90000001/isp-monitor');
    const row = res.body.searchRow as Record<string, string>;
    expect(row.accountStatus).toBe('S');
    expect(row.city).toBe('Quito');
    expect(row.clientName).toBe('CLIENTE SINTETICO WHITELIST');
    expect((res.body.device as Record<string, string>).adminState).toBe('down');
    const network = await get('/accounts/90000001/isp-monitor/access-network');
    const client = (network.body.naps as Array<{ devices: Array<Record<string, unknown>> }>)
      .flatMap((n) => n.devices)
      .find((d) => d.isClient);
    expect(client?.accountStatus).toBe('S');
    expect(client?.clientName).toBe('CLIENTE SINTETICO WHITELIST');
  });

  it('no consulta TEC ni ISP Monitor real aunque los conectores estén en real', async () => {
    Object.assign(env, { CONNECTOR_MODE_TEC: 'real', CONNECTOR_MODE_ISPMONITOR: 'real' });
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch no permitido en este test');
    });
    vi.stubGlobal('fetch', fetchSpy);
    expect((await get('/accounts/100926544/isp-monitor')).status).toBe(200);
    expect((await get('/accounts/100926544/isp-monitor/access-network')).status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
