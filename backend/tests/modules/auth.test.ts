// Auth — login, /auth/me y enforcement del middleware.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/test-app.js';
import { prisma } from '../../src/db/prisma.js';

let app: FastifyInstance;
let authHeaders: Record<string, string>;
const PREFIX = '/herramientas/v1';

const LOGIN_USER_EMAIL = 'auth-test@wifix.test';
const LOGIN_USER_PASSWORD = 'login-secret-123';

beforeAll(async () => {
  const ctx = await buildTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;

  const passwordHash = await bcrypt.hash(LOGIN_USER_PASSWORD, 4);
  await prisma.user.upsert({
    where: { email: LOGIN_USER_EMAIL },
    update: { passwordHash, name: 'Auth Test', active: true },
    create: {
      email: LOGIN_USER_EMAIL,
      passwordHash,
      name: 'Auth Test',
      active: true,
    },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('POST /auth/login', () => {
  it('devuelve un JWT y los datos del usuario con credenciales válidas', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: LOGIN_USER_EMAIL, password: LOGIN_USER_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // header.payload.signature
    expect(body.user.email).toBe(LOGIN_USER_EMAIL);
    expect(body.user.name).toBe('Auth Test');
    expect(body.user.active).toBe(true);
  });

  it('rechaza credenciales inválidas con UNAUTHORIZED', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: LOGIN_USER_EMAIL, password: 'wrong-pass' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('valida el formato del email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: 'no-es-email', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /auth/me', () => {
  it('devuelve el usuario del token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/auth/me`,
      headers: authHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBeTruthy();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe('Middleware de auth', () => {
  it('rechaza acceso a endpoints protegidos sin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/catalogs/equipment-models`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('rechaza un token con firma inválida', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${PREFIX}/catalogs/equipment-models`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
  });

  it('permite acceso a /health sin token', async () => {
    const root = await app.inject({ method: 'GET', url: '/health' });
    expect(root.statusCode).toBe(200);
    const api = await app.inject({ method: 'GET', url: `${PREFIX}/health` });
    expect(api.statusCode).toBe(200);
  });
});
