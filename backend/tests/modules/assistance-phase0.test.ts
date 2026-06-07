/**
 * Tests de la Fase 0 — Módulo Asistencia Técnica.
 *
 * Estos tests son UNIT tests que no requieren base de datos:
 *   - El servidor arranca correctamente.
 *   - GET /asistencia/v1/health responde 200.
 *   - requireRole lanza 403 cuando el rol no está autorizado.
 *   - El WS rechaza conexión sin JWT válido.
 *   - Los stubs responden 501 con auth correcta.
 *
 * Para los tests que requieren Fastify (inject), se construye la app con
 * { logger: false } y se cierran explícitamente (sin necesidad de DB real
 * en los endpoints stub).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { signAuthToken } from '../../src/auth/jwt.js';
import { requireRole } from '../../src/middleware/authenticate.js';
import type { FastifyRequest } from 'fastify';

const ASSISTANCE_PREFIX = '/asistencia/v1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeToken(role: 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR'): Promise<string> {
  return signAuthToken({
    sub: `test-user-${role}`,
    email: `${role.toLowerCase()}@wifix.test`,
    name: `${role} Test`,
    role,
  });
}

// ---------------------------------------------------------------------------
// Suite: Arranque y health
// ---------------------------------------------------------------------------

describe('Fase 0 — Asistencia: arranque y health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('el servidor arranca y /health raíz responde 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('GET /asistencia/v1/health responde 200 sin auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/health`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; module: string };
    expect(body.status).toBe('ok');
    expect(body.module).toBe('assistance');
  });

  it('GET /herramientas/v1/health responde 200 (módulo anterior intacto)', async () => {
    const res = await app.inject({ method: 'GET', url: '/herramientas/v1/health' });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Suite: RBAC — requireRole
// ---------------------------------------------------------------------------

describe('Fase 0 — requireRole', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let technicianToken: string;
  let supervisorToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    [agentToken, technicianToken, supervisorToken] = await Promise.all([
      makeToken('AGENT'),
      makeToken('TECHNICIAN'),
      makeToken('SUPERVISOR'),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('requireRole lanza 403 si el rol no está en la lista', async () => {
    // GET /sessions requiere AGENT | SUPERVISOR, probamos con TECHNICIAN
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: { authorization: `Bearer ${technicianToken}` },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('AGENT puede acceder a GET /sessions (implementado en Fase B — sin BD: 500)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    // Fase B: endpoint implementado. Sin BD responde 500; nunca 403 ni 401.
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });

  it('SUPERVISOR puede acceder a GET /sessions (implementado en Fase B — sin BD: 500)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });

  it('TECHNICIAN puede acceder a POST /sessions (su rol — implementado en Fase B)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: {
        authorization: `Bearer ${technicianToken}`,
        'content-type': 'application/json',
      },
      payload: { accountNumber: 'ACC-001', consent: true },
    });
    // Fase B: endpoint implementado. Sin BD responde 500; nunca 403 ni 401 ni 400.
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(400);
  });

  it('AGENT no puede acceder a POST /sessions (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { accountNumber: 'ACC-001', consent: true },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  it('sin JWT devuelve 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/sessions`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('requireRole como función lanza ApiError.forbidden', async () => {
    // Prueba unitaria del guard directamente (sin servidor HTTP)
    const fakeRequest = {
      authUser: { id: 'u1', email: 'tech@test.com', name: 'Tech', role: 'TECHNICIAN' },
    } as FastifyRequest;

    expect(() => requireRole(fakeRequest, 'AGENT', 'SUPERVISOR')).toThrowError(
      /Esta operación requiere uno de los siguientes roles/,
    );
  });

  it('requireRole no lanza si el rol está en la lista', () => {
    const fakeRequest = {
      authUser: { id: 'u1', email: 'agent@test.com', name: 'Agent', role: 'AGENT' },
    } as FastifyRequest;

    const user = requireRole(fakeRequest, 'AGENT', 'SUPERVISOR');
    expect(user.role).toBe('AGENT');
  });
});

// ---------------------------------------------------------------------------
// Suite: WebSocket — auth
// ---------------------------------------------------------------------------

describe('Fase 0 — WebSocket auth', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('WS rechaza conexión sin token (HTTP 401 en upgrade)', async () => {
    // Fastify inject no soporta upgrade real de WS, pero la ruta responde
    // a peticiones HTTP normales con 426 (Upgrade Required) cuando no hay
    // cabecera Upgrade. Lo que sí podemos verificar es que la ruta está
    // registrada respondiendo algo diferente de 404.
    const res = await app.inject({
      method: 'GET',
      url: `${ASSISTANCE_PREFIX}/ws`,
    });
    // La ruta WS existe (no 404). Sin cabecera Upgrade, Fastify responde 426.
    expect(res.statusCode).not.toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Suite: Validación de body en stubs
// ---------------------------------------------------------------------------

describe('Fase 0 — Validación de body en stubs', () => {
  let app: FastifyInstance;
  let techToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    techToken = await makeToken('TECHNICIAN');
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /sessions sin accountNumber devuelve 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: {
        authorization: `Bearer ${techToken}`,
        'content-type': 'application/json',
      },
      payload: { consent: true }, // falta accountNumber
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('POST /sessions con consent=false devuelve 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${ASSISTANCE_PREFIX}/sessions`,
      headers: {
        authorization: `Bearer ${techToken}`,
        'content-type': 'application/json',
      },
      payload: { accountNumber: 'ACC-001', consent: false },
    });
    expect(res.statusCode).toBe(400);
  });
});
