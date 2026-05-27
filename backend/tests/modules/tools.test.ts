// Integración de las 5 herramientas — requiere Postgres y catálogos sembrados.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
const PREFIX = '/herramientas/v1';
const acct = () => `WX-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const now = () => new Date().toISOString();

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function post(url: string, payload: unknown): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `${PREFIX}${url}`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

async function get(url: string): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'GET', url: `${PREFIX}${url}`, headers: authHeaders });
}

async function patch(url: string, payload: unknown): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'PATCH',
    url: `${PREFIX}${url}`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: payload as object,
  });
}

describe('Distancia', () => {
  it('crea, lista filtrado por accountNumber y consulta por id', async () => {
    const account = acct();
    const create = await post('/distance-measurements', {
      accountNumber: account,
      distanceMeters: 142.7,
      startPoint: { latitude: -0.18, longitude: -78.46 },
      endPoint: { latitude: -0.181, longitude: -78.461 },
      measuredAt: now(),
      notes: 'casa → poste',
    });
    expect(create.statusCode).toBe(201);
    const dto = create.json();
    expect(dto.id).toBeTruthy();
    expect(dto.accountNumber).toBe(account);
    expect(dto.startPoint.latitude).toBeCloseTo(-0.18);

    const list = await get(`/distance-measurements?accountNumber=${account}`);
    expect(list.statusCode).toBe(200);
    const paged = list.json();
    expect(paged.page.totalItems).toBe(1);
    expect(paged.data[0].id).toBe(dto.id);

    const byId = await get(`/distance-measurements/${dto.id}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.json().id).toBe(dto.id);
  });

  it('rechaza accountNumber faltante', async () => {
    const res = await post('/distance-measurements', {
      distanceMeters: 10,
      measuredAt: now(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('rechaza measuredAt futuro', async () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min
    const res = await post('/distance-measurements', {
      accountNumber: acct(),
      distanceMeters: 10,
      measuredAt: future,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Speedtest', () => {
  it('crea y rechaza download/upload negativos', async () => {
    const account = acct();
    const ok = await post('/speedtests', {
      accountNumber: account,
      downloadMbps: 185.4,
      uploadMbps: 92.1,
      latencyMs: 11.3,
      measuredAt: now(),
    });
    expect(ok.statusCode).toBe(201);

    const bad = await post('/speedtests', {
      accountNumber: account,
      downloadMbps: -1,
      uploadMbps: 50,
      measuredAt: now(),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('Mapa de calor WiFi (legacy: signalDbm plano)', () => {
  it('acepta el formato viejo y devuelve legacyFormat=true + measurements sintéticas', async () => {
    const account = acct();
    const create = await post('/wifi-heatmaps', {
      accountNumber: account,
      label: 'piso 1',
      rooms: [
        { roomName: 'Sala', floor: 1, signalDbm: -58, measuredAt: now() },
        { roomName: 'Dormitorio', floor: 1, signalDbm: -72, measuredAt: now() },
      ],
    });
    expect(create.statusCode).toBe(201);
    const dto = create.json();
    expect(dto.rooms).toHaveLength(2);
    expect(dto.rooms[0].legacyFormat).toBe(true);
    expect(dto.rooms[0].measurements).toHaveLength(1);
    expect(dto.rooms[0].measurements[0].bssid).toBe('legacy-unknown');
    expect(dto.rooms[0].measurements[0].signalDbm).toBe(-58);

    const bad = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [{ roomName: 'X', signalDbm: 50, measuredAt: now() }],
    });
    expect(bad.statusCode).toBe(400);

    const empty = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [],
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('Mapa de calor WiFi (nuevo: measurements multi-AP)', () => {
  it('crea con array de measurements por habitación', async () => {
    const account = acct();
    const create = await post('/wifi-heatmaps', {
      accountNumber: account,
      label: 'multi-AP',
      rooms: [
        {
          roomName: 'Sala',
          floor: 1,
          measuredAt: now(),
          measurements: [
            { bssid: 'aa:bb:cc:dd:ee:01', signalDbm: -45, band: '5GHz', channel: 36, isConnected: true },
            { bssid: 'aa:bb:cc:dd:ee:02', signalDbm: -78, band: '2.4GHz', channel: 6 },
          ],
        },
      ],
    });
    expect(create.statusCode).toBe(201);
    const dto = create.json();
    expect(dto.rooms[0].legacyFormat).toBe(false);
    expect(dto.rooms[0].measurements).toHaveLength(2);
    expect(dto.rooms[0].measurements[0].band).toBe('5GHz');
    expect(dto.rooms[0].measurements[0].isConnected).toBe(true);
  });

  it('rechaza measurements vacío y bssid inválido', async () => {
    const account = acct();
    const emptyMeas = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [{ roomName: 'X', measurements: [], measuredAt: now() }],
    });
    expect(emptyMeas.statusCode).toBe(400);

    const badBssid = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [{
        roomName: 'Y',
        measuredAt: now(),
        measurements: [{ bssid: 'not-a-mac', signalDbm: -50 }],
      }],
    });
    expect(badBssid.statusCode).toBe(400);
  });

  it('asocia measurements a un WifiAccessPoint pre-registrado vía accessPointId', async () => {
    const account = acct();
    const ap = await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'aa:bb:cc:dd:ee:10',
      label: 'Router principal',
      apType: 'router',
      band: '5GHz',
    });
    expect(ap.statusCode).toBe(201);
    const apDto = ap.json();

    const heatmap = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [{
        roomName: 'Sala',
        measuredAt: now(),
        measurements: [{
          bssid: apDto.bssid,
          accessPointId: apDto.id,
          apLabelSnapshot: apDto.label,
          signalDbm: -52,
          band: '5GHz',
          isConnected: true,
        }],
      }],
    });
    expect(heatmap.statusCode).toBe(201);
    expect(heatmap.json().rooms[0].measurements[0].accessPointId).toBe(apDto.id);
  });
});

describe('WiFi Access Points', () => {
  it('upsert por (accountNumber, bssid): primer POST crea (201), segundo actualiza (200)', async () => {
    const account = acct();
    const first = await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'aa:bb:cc:dd:ee:ff',
      label: 'Router',
      apType: 'router',
      band: '5GHz',
    });
    expect(first.statusCode).toBe(201);
    const firstDto = first.json();

    const second = await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'aa:bb:cc:dd:ee:ff',
      label: 'Router principal (corregido)',
      apType: 'router',
      band: '5GHz',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(firstDto.id);
    expect(second.json().label).toBe('Router principal (corregido)');

    const bad = await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'not-a-mac',
      label: 'X',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lista APs por cuenta y permite PATCH para renombrar', async () => {
    const account = acct();
    await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'aa:bb:cc:dd:ee:01',
      label: 'Equipo 1',
    });
    await post(`/accounts/${account}/wifi-access-points`, {
      bssid: 'aa:bb:cc:dd:ee:02',
      label: 'Equipo 2',
      apType: 'extender',
    });
    const list = await get(`/accounts/${account}/wifi-access-points`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(2);
    const target = list.json().find((a: { label: string }) => a.label === 'Equipo 1');
    expect(target).toBeTruthy();

    const renamed = await patch(`/wifi-access-points/${target.id}`, { label: 'Router principal' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().label).toBe('Router principal');

    const empty = await patch(`/wifi-access-points/${target.id}`, {});
    expect(empty.statusCode).toBe(400);
  });
});

describe('Ping', () => {
  it('crea, asocia opcionalmente a heatmap y valida packetsReceived <= packetsSent', async () => {
    const account = acct();

    const heatmap = await post('/wifi-heatmaps', {
      accountNumber: account,
      rooms: [{ roomName: 'Sala', signalDbm: -60, measuredAt: now() }],
    });
    expect(heatmap.statusCode).toBe(201);
    const heatmapId = heatmap.json().id;

    const ok = await post('/ping-tests', {
      accountNumber: account,
      target: '8.8.8.8',
      packetsSent: 10,
      packetsReceived: 9,
      avgLatencyMs: 25.1,
      heatmapId,
      roomName: 'Sala',
      measuredAt: now(),
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().heatmapId).toBe(heatmapId);

    const bad = await post('/ping-tests', {
      accountNumber: account,
      target: '8.8.8.8',
      packetsSent: 5,
      packetsReceived: 10,
      measuredAt: now(),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.some((d: { field: string }) => d.field === 'packetsReceived')).toBe(true);

    const ghost = await post('/ping-tests', {
      accountNumber: account,
      target: '8.8.8.8',
      heatmapId: '00000000-0000-4000-8000-000000000000',
      measuredAt: now(),
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().details.some((d: { field: string }) => d.field === 'heatmapId')).toBe(true);
  });
});

describe('Traceroute', () => {
  it('crea con hops y los devuelve ordenados', async () => {
    const account = acct();
    const res = await post('/traceroute-tests', {
      accountNumber: account,
      target: 'www.example.com',
      hops: [
        { hopNumber: 1, host: '192.168.1.1', latencyMs: 1.2 },
        { hopNumber: 2, host: '10.0.0.1', latencyMs: 5.7 },
        { hopNumber: 3, host: null },
      ],
      measuredAt: now(),
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto.hops).toHaveLength(3);
    expect(dto.hops[0].hopNumber).toBe(1);
    expect(dto.hops[2].hopNumber).toBe(3);

    const byId = await get(`/traceroute-tests/${dto.id}`);
    expect(byId.statusCode).toBe(200);
    expect(byId.json().hops).toHaveLength(3);
  });
});
