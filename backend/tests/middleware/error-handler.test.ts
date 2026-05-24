// Integración: una ruta de prueba que usa la utilidad de validación debe
// rechazar entradas inválidas con el esquema Error del OpenAPI.
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseQuery } from '../../src/lib/validation.js';
import {
  registerErrorHandler,
  ApiError,
} from '../../src/middleware/error-handler.js';
import { paginationSchema } from '../../src/lib/pagination.js';

const CreateThingInput = z.object({
  name: z.string().min(1),
  count: z.number().int().nonnegative(),
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);

  app.post('/__test/things', async (req) => {
    const body = parseBody(CreateThingInput, req.body);
    return { ok: true, body };
  });

  app.get('/__test/things', async (req) => {
    const pagination = parseQuery(paginationSchema, req.query);
    return { pagination };
  });

  app.get('/__test/boom', async () => {
    throw ApiError.catalogItemNotFound('Modelo XYZ no existe.');
  });

  app.get('/__test/raw-zod', async () => {
    // Si una ZodError se escapa sin envolverse, el handler debe formatearla igual.
    z.object({ x: z.string() }).parse({});
    return { unreachable: true };
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('error handler — formato Error del OpenAPI', () => {
  it('responde 400 con code, message y details para body inválido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__test/things',
      payload: { name: '', count: -1 },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(typeof body.message).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThanOrEqual(2);
    for (const d of body.details) {
      expect(typeof d.field).toBe('string');
      expect(typeof d.issue).toBe('string');
    }
  });

  it('responde 400 con detalle de paginación cuando pageSize > 100', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/__test/things?page=1&pageSize=500',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details.some((d: { field: string }) => d.field === 'pageSize')).toBe(true);
  });

  it('aplica defaults de paginación cuando no se envían', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/things' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pagination).toEqual({ page: 1, pageSize: 20 });
  });

  it('responde con código CATALOG_ITEM_NOT_FOUND cuando el servicio lo lanza', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/boom' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('CATALOG_ITEM_NOT_FOUND');
    expect(body.message).toContain('Modelo XYZ');
  });

  it('formatea ZodError no envuelto como VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/raw-zod' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.details[0].field).toBe('x');
  });

  it('404 con esquema Error en rutas inexistentes', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-existe' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe('NOT_FOUND');
  });
});
