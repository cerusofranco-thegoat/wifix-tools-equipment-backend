// Integración de equipos retirados — requiere Postgres + catálogos sembrados + MinIO.
import { Buffer } from 'node:buffer';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { buildMultipart } from '../helpers/multipart.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
const PREFIX = '/herramientas/v1';
const acct = () => `WX-RE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
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

const jsonHeaders = () => ({ ...authHeaders, 'content-type': 'application/json' });

describe('Equipos retirados', () => {
  it('crea sin barcodePhotoId y copia serialFieldType del modelo', async () => {
    const ontZte = await prisma.equipmentModel.findFirst({ where: { name: 'ONT ZTE (todas)' } });
    expect(ontZte).toBeDefined();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: jsonHeaders(),
      payload: {
        accountNumber: acct(),
        equipmentModelId: ontZte!.id,
        serialValue: 'GPONABC123XYZ',
        removalReasonCode: 'NO_ENCIENDE',
        observations: 'Sin LED de power',
        retiredAt: now(),
      },
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto.serialFieldType).toBe('GPON-SN');
    expect(dto.equipmentModelId).toBe(ontZte!.id);
  });

  it('crea con barcodePhotoId válido y devuelve barcodePhotoUrl', async () => {
    const router = await prisma.equipmentModel.findFirst({ where: { name: 'Router ZTE' } });
    const multipart = buildMultipart({
      name: 'file',
      filename: 'barcode.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    });
    const upload = await app.inject({
      method: 'POST',
      url: `${PREFIX}/media`,
      headers: { ...authHeaders, 'content-type': multipart.contentType },
      payload: multipart.body,
    });
    const photo = upload.json();

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: jsonHeaders(),
      payload: {
        accountNumber: acct(),
        equipmentModelId: router!.id,
        serialValue: 'DSN-001',
        barcodePhotoId: photo.id,
        removalReasonCode: 'DANO_FISICO',
        retiredAt: now(),
      },
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json();
    expect(dto.barcodePhotoId).toBe(photo.id);
    expect(dto.barcodePhotoUrl).toBe(photo.url);
    expect(dto.serialFieldType).toBe('D-SN');
  });

  it('responde CATALOG_ITEM_NOT_FOUND cuando equipmentModelId no existe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: jsonHeaders(),
      payload: {
        accountNumber: acct(),
        equipmentModelId: '00000000-0000-4000-8000-000000000001',
        serialValue: 'X',
        removalReasonCode: 'OTROS',
        retiredAt: now(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('CATALOG_ITEM_NOT_FOUND');
  });

  it('responde MEDIA_NOT_FOUND cuando barcodePhotoId no existe', async () => {
    const model = await prisma.equipmentModel.findFirst();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: jsonHeaders(),
      payload: {
        accountNumber: acct(),
        equipmentModelId: model!.id,
        serialValue: 'X',
        barcodePhotoId: '00000000-0000-4000-8000-000000000002',
        removalReasonCode: 'OTROS',
        retiredAt: now(),
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MEDIA_NOT_FOUND');
  });

  it('lista filtrando por removalReasonCode y serialValue', async () => {
    const account = acct();
    const model = await prisma.equipmentModel.findFirst({ where: { name: 'MTA' } });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/retired-equipment`,
      headers: jsonHeaders(),
      payload: {
        accountNumber: account,
        equipmentModelId: model!.id,
        serialValue: 'MTAFILTER001',
        removalReasonCode: 'EQUIPO_INHIBIDO',
        retiredAt: now(),
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: `${PREFIX}/retired-equipment?accountNumber=${account}&removalReasonCode=EQUIPO_INHIBIDO&serialValue=MTAFILTER`,
      headers: authHeaders,
    });
    expect(list.statusCode).toBe(200);
    const data = list.json();
    expect(data.page.totalItems).toBe(1);
    expect(data.data[0].serialValue).toBe('MTAFILTER001');
  });
});
