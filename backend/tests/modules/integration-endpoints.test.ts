// Tests de los endpoints de integración (campos 1-21) — todos contra
// los conectores mock; verifican contrato, auth y persistencia del PUT.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
const PREFIX = '/herramientas/v1';

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const jsonHeaders = () => ({ ...authHeaders, 'content-type': 'application/json' });

describe('Datos del Cliente', () => {
  it('GET client-profile devuelve los campos 1-5', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-001/client-profile`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountNumber).toBe('WX-INT-001');
    expect(typeof body.fullName).toBe('string');
    expect(typeof body.address).toBe('string');
    expect(Array.isArray(body.phones)).toBe(true);
    expect(typeof body.planName).toBe('string');
    expect(typeof body.contractedDownloadMbps).toBe('number');
  });

  it('PUT client-profile refleja el cambio en el siguiente GET', async () => {
    const account = `WX-INT-PUT-${Date.now()}`;
    const put = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/client-profile`,
      headers: jsonHeaders(),
      payload: { fullName: 'Cliente Editado', phones: ['0991234567'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().fullName).toBe('Cliente Editado');

    const get = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${account}/client-profile`,
      headers: authHeaders,
    });
    expect(get.json().fullName).toBe('Cliente Editado');
    expect(get.json().phones).toEqual(['0991234567']);
  });

  it('PUT client-profile rechaza cuerpo vacío con VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/WX-INT-EMPTY/client-profile`,
      headers: jsonHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('GET contract-status devuelve nombre y al menos 1 cuenta', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-002/contract-status`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.clientName).toBe('string');
    expect(body.accounts.length).toBeGreaterThanOrEqual(1);
    expect(body.accounts[0].accountNumber).toBe('WX-INT-002');
  });
});

describe('Diagnóstico de Red', () => {
  it('GET /naps/nearby devuelve lista ordenada por distancia', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/nearby?lat=-2.247946&lng=-79.904161`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const naps = res.json() as Array<{
      napCode: string;
      distanceMeters: number;
      napId: number | null;
      source: string;
    }>;
    for (let i = 0; i < naps.length - 1; i++) {
      expect(naps[i]!.distanceMeters).toBeLessThanOrEqual(naps[i + 1]!.distanceMeters);
    }
    // Campos nuevos del contrato FSM, presentes también por el camino TEC.
    for (const nap of naps) {
      expect(nap).toHaveProperty('napId');
      expect(nap).toHaveProperty('networkName');
      expect(['FSM', 'TEC']).toContain(nap.source);
    }
  });

  it('GET naps/{napRef}/ports devuelve la rejilla con statusFanOut', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/naps/NAP-05-03-2/ports`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.napRef).toBe('NAP-05-03-2');
    expect(body.napCode).toBe('NAP-05-03-2');
    expect(Array.isArray(body.ports)).toBe(true);
    expect(body.statusFanOut).toHaveProperty('supported');
    expect(['FSM', 'TEC']).toContain(body.source);
    // Con detalle disponible (mock de TEC) tiene que haber puertos; sin él, [].
    if (body.detailAvailable) {
      expect(body.ports.length).toBeGreaterThan(0);
    } else {
      expect(body.ports).toEqual([]);
    }
  });

  it('GET network-metrics incluye signalLevels y campos GPON/HFC condicionales', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-METRICS/network-metrics`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(['GPON', 'HFC']).toContain(m.technology);
    expect(typeof m.signalLevels.rxDbm).toBe('number');
    if (m.technology === 'HFC') {
      expect(typeof m.signalToNoiseDb).toBe('number');
    }
  });

  it('GET node-events siempre responde (puede ser []) con esquema válido', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-EV/node-events`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('GET lan-devices y wifi-devices devuelven listas', async () => {
    const lan = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-LAN/lan-devices`,
      headers: authHeaders,
    });
    expect(lan.statusCode).toBe(200);
    expect(Array.isArray(lan.json())).toBe(true);

    const wifi = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-LAN/wifi-devices`,
      headers: authHeaders,
    });
    expect(wifi.statusCode).toBe(200);
    const devices = wifi.json() as Array<{ band: string }>;
    expect(devices.every((d) => ['2.4GHz', '5GHz'].includes(d.band))).toBe(true);
  });

  it('PUT wifi-config aplica el cambio y rechaza inputs inválidos', async () => {
    const account = `WX-INT-WIFI-${Date.now()}`;
    const put = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/wifi-config`,
      headers: jsonHeaders(),
      payload: {
        bands: [
          { band: '2.4GHz', ssid: 'MiCasaWiFi', password: 'segura123' },
          { band: '5GHz', ssid: 'MiCasaWiFi_5' },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().bands.find((b: { band: string }) => b.band === '2.4GHz').ssid).toBe('MiCasaWiFi');

    const bad = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/wifi-config`,
      headers: jsonHeaders(),
      payload: { bands: [{ band: '2.4GHz', ssid: 'X', password: 'corta' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION_ERROR');

    const dup = await app.inject({
      method: 'PUT',
      url: `${PREFIX}/accounts/${account}/wifi-config`,
      headers: jsonHeaders(),
      payload: {
        bands: [
          { band: '5GHz', ssid: 'A' },
          { band: '5GHz', ssid: 'B' },
        ],
      },
    });
    expect(dup.statusCode).toBe(400);
  });
});

describe('Tareas y Visitas', () => {
  it('GET unsatisfactory-tasks devuelve el objeto envolvente con solo INSATISFACTORIA', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-TASK/unsatisfactory-tasks`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ result: string }>;
      scanned: number;
      totalOrders: number;
      truncated: boolean;
      brand: string;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.every((t) => t.result === 'INSATISFACTORIA')).toBe(true);
    expect(typeof body.scanned).toBe('number');
    expect(typeof body.totalOrders).toBe('number');
    expect(typeof body.truncated).toBe('boolean');
    expect(body.brand).toBe('telenews');
  });

  it('GET previous-visits devuelve { items, totalOrders, brand } con al menos 1 visita', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/WX-INT-VIS/previous-visits`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<{ technician: string | null; notesLoaded: boolean }>;
      totalOrders: number;
      brand: string;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.totalOrders).toBe(body.items.length);
    // FSM no expone el técnico: siempre null (⚠2 del contrato).
    expect(body.items.every((v) => v.technician === null)).toBe(true);
    expect(body.items.every((v) => v.notesLoaded === false)).toBe(true);
  });
});
