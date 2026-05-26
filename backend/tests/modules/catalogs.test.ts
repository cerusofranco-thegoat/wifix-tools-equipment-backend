// Integración: requiere PostgreSQL corriendo y catálogos sembrados.
//   docker compose up -d postgres
//   npm run prisma:migrate && npm run prisma:seed
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
let authHeaders: Record<string, string>;

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /catalogs/equipment-models', () => {
  it('devuelve los 10 modelos sembrados con serialFieldType en formato del contrato', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/catalogs/equipment-models',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json() as Array<{ name: string; serialFieldType: string; category: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(10);

    const ontHuawei = data.find((m) => m.name === 'ONT Huawei OptiXstar');
    expect(ontHuawei).toBeDefined();
    expect(ontHuawei?.serialFieldType).toBe('SN');

    const ontZte = data.find((m) => m.name === 'ONT ZTE (todas)');
    expect(ontZte?.serialFieldType).toBe('GPON-SN');

    const decoHd = data.find((m) => m.name === 'Decodificadores HD');
    expect(decoHd?.serialFieldType).toBe('HOST-SN');
    expect(decoHd?.category).toBe('DECODIFICADOR_HD');

    const routerZte = data.find((m) => m.name === 'Router ZTE');
    expect(routerZte?.serialFieldType).toBe('D-SN');
  });
});

describe('GET /catalogs/removal-reasons', () => {
  it('devuelve los 8 motivos ordenados por sortOrder', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/catalogs/removal-reasons',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json() as Array<{ code: string; label: string; active: boolean }>;
    expect(data.length).toBe(8);
    expect(data[0].code).toBe('DANO_FISICO');
    expect(data[data.length - 1].code).toBe('OTROS');
    const puerto = data.find((r) => r.code === 'PUERTO_DANADO');
    expect(puerto?.label).toBe('Puerto LAN o RF dañado (no da conectividad)');
  });
});

describe('GET /catalogs/speedtest-servers', () => {
  it('devuelve servidores con location cuando hay coordenadas', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/catalogs/speedtest-servers',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json() as Array<{
      name: string;
      host: string;
      location?: { latitude: number; longitude: number };
    }>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    const quito = data.find((s) => s.name === 'Servidor Quito');
    expect(quito).toBeDefined();
    expect(quito?.location).toBeDefined();
    expect(quito?.location?.latitude).toBeCloseTo(-0.180653);
  });
});

describe('GET /catalogs/network-servers', () => {
  it('devuelve los servidores de red sembrados con type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/catalogs/network-servers',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const data = res.json() as Array<{ name: string; target: string; type: string }>;
    expect(data.length).toBeGreaterThanOrEqual(3);
    const google = data.find((n) => n.target === '8.8.8.8');
    expect(google?.type).toBe('DNS');
    const cdn = data.find((n) => n.type === 'CDN');
    expect(cdn).toBeDefined();
  });
});
