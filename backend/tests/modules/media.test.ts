// Integración: requiere PostgreSQL y MinIO corriendo.
//   docker compose up -d
import { Buffer } from 'node:buffer';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { buildMultipart } from '../helpers/multipart.js';
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

const fakePng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...Array.from({ length: 32 }, (_, i) => i),
]);

describe('POST /media + GET /media/{id}', () => {
  it('sube una imagen y luego permite recuperar su metadato por id', async () => {
    const multipart = buildMultipart({
      name: 'file',
      filename: 'codigo-barra.png',
      contentType: 'image/png',
      data: fakePng,
    });

    const upload = await app.inject({
      method: 'POST',
      url: '/herramientas/v1/media',
      headers: { ...authHeaders, 'content-type': multipart.contentType },
      payload: multipart.body,
    });

    expect(upload.statusCode).toBe(201);
    const dto = upload.json() as {
      id: string;
      url: string;
      contentType: string;
      sizeBytes: number;
      createdAt: string;
    };
    expect(dto.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(dto.contentType).toBe('image/png');
    expect(dto.sizeBytes).toBe(fakePng.length);
    expect(dto.url).toContain('wifix-media');
    expect(dto.createdAt).toMatch(/T/);

    const lookup = await app.inject({
      method: 'GET',
      url: `/herramientas/v1/media/${dto.id}`,
      headers: authHeaders,
    });
    expect(lookup.statusCode).toBe(200);
    const fetched = lookup.json();
    expect(fetched.id).toBe(dto.id);
    expect(fetched.url).toBe(dto.url);
  });

  it('rechaza tipos de contenido no permitidos', async () => {
    const multipart = buildMultipart({
      name: 'file',
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      data: Buffer.from('hola'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/herramientas/v1/media',
      headers: { ...authHeaders, 'content-type': multipart.contentType },
      payload: multipart.body,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('responde MEDIA_NOT_FOUND con 404 cuando el id no existe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/media/00000000-0000-4000-8000-000000000000',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('MEDIA_NOT_FOUND');
  });

  it('responde VALIDATION_ERROR con 400 cuando el id no es UUID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/herramientas/v1/media/no-es-uuid',
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});
