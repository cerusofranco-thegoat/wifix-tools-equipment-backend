// GET /terminals/:id/diagnostics — contrato por tecnología (mock, sin red ni DB).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildFsmTestApp } from '../helpers/fsm-app.js';

const PREFIX = '/herramientas/v1';
let app: FastifyInstance;
let authHeaders: Record<string, string>;

beforeAll(async () => {
  const ctx = await buildFsmTestApp();
  app = ctx.app;
  authHeaders = ctx.authHeaders;
});

afterAll(async () => {
  await app.close();
});

async function get(path: string) {
  const res = await app.inject({ method: 'GET', url: `${PREFIX}${path}`, headers: authHeaders });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe('GET /terminals/:id/diagnostics', () => {
  it('GPON: technology + gpon, sin docsis', async () => {
    const res = await get('/terminals/ZTEGD3F9BBE5/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ technology: 'GPON', simulated: true, docsis: null });
    expect(res.body.gpon).toMatchObject({ technology: 'GPON', simulated: true });
    expect(res.body.outages).toMatchObject({ timezone: 'America/Guayaquil' });
    expect(res.body).toHaveProperty('uptime');
  });

  it('HFC: technology + docsis, sin gpon', async () => {
    const res = await get('/terminals/384C90A2DB11/diagnostics');
    expect(res.body).toMatchObject({ technology: 'HFC', gpon: null });
    expect(res.body.docsis).toMatchObject({ technology: 'HFC' });
  });

  it('?technology=ONT fuerza GPON para una MAC (ONT escaneado por MAC)', async () => {
    const res = await get('/terminals/A4B87E112233/diagnostics?technology=ONT');
    expect(res.body).toMatchObject({ technology: 'GPON', technologySource: 'HINT', docsis: null });
  });

  it('?technology inválida → 400', async () => {
    const res = await get('/terminals/ZTEGD3F9BBE5/diagnostics?technology=ADSL');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('la ficha suelta también acepta la pista', async () => {
    const res = await get('/terminals/A4B87E112233?technology=GPON');
    expect(res.body).toMatchObject({ technology: 'GPON', technologySource: 'HINT' });
  });
});
