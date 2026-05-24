// Integración de las 5 herramientas — requiere Postgres y catálogos sembrados.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
const PREFIX = '/herramientas/v1';
const acct = () => `WX-TEST-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const now = () => new Date().toISOString();

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function post(url: string, payload: unknown): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `${PREFIX}${url}`,
    headers: { 'content-type': 'application/json' },
    payload: payload as object,
  });
}

async function get(url: string): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'GET', url: `${PREFIX}${url}` });
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

describe('Mapa de calor WiFi', () => {
  it('crea con habitaciones y rechaza signalDbm fuera de -120..0', async () => {
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
