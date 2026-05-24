import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
const PREFIX = '/herramientas/v1';

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /accounts/{accountNumber}/tool-history', () => {
  it('agrega los 6 tipos de registro para una cuenta', async () => {
    const account = `WX-HIST-${Date.now()}`;
    const now = new Date().toISOString();

    // 1 distance + 1 speedtest + 1 heatmap + 1 ping + 1 traceroute + 1 retired
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/distance-measurements`,
      headers: { 'content-type': 'application/json' },
      payload: { accountNumber: account, distanceMeters: 25, measuredAt: now },
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/speedtests`,
      headers: { 'content-type': 'application/json' },
      payload: { accountNumber: account, downloadMbps: 100, uploadMbps: 50, measuredAt: now },
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/wifi-heatmaps`,
      headers: { 'content-type': 'application/json' },
      payload: {
        accountNumber: account,
        rooms: [{ roomName: 'A', signalDbm: -50, measuredAt: now }],
      },
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/ping-tests`,
      headers: { 'content-type': 'application/json' },
      payload: { accountNumber: account, target: '8.8.8.8', measuredAt: now },
    });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/traceroute-tests`,
      headers: { 'content-type': 'application/json' },
      payload: {
        accountNumber: account,
        target: 'example.com',
        hops: [{ hopNumber: 1, host: '10.0.0.1' }],
        measuredAt: now,
      },
    });
    const model = await prisma.equipmentModel.findFirst();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: { 'content-type': 'application/json' },
      payload: {
        accountNumber: account,
        equipmentModelId: model!.id,
        serialValue: 'HISTSER01',
        removalReasonCode: 'OTROS',
        retiredAt: now,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${account}/tool-history`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accountNumber).toBe(account);
    expect(body.distanceMeasurements).toHaveLength(1);
    expect(body.speedtests).toHaveLength(1);
    expect(body.wifiHeatmaps).toHaveLength(1);
    expect(body.pingTests).toHaveLength(1);
    expect(body.tracerouteTests).toHaveLength(1);
    expect(body.retiredEquipment).toHaveLength(1);
  });

  it('respeta dateFrom/dateTo (rango pasado vacío)', async () => {
    const account = `WX-HIST-${Date.now()}-2`;
    const now = new Date().toISOString();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/distance-measurements`,
      headers: { 'content-type': 'application/json' },
      payload: { accountNumber: account, distanceMeters: 5, measuredAt: now },
    });

    const past = '2020-01-01T00:00:00Z';
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/accounts/${account}/tool-history?dateFrom=${past}&dateTo=2020-12-31T23:59:59Z`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().distanceMeasurements).toHaveLength(0);
  });
});
