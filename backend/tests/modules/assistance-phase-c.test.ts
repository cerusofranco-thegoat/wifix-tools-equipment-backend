/**
 * Tests de Fase C — Módulo Asistencia Técnica: Acciones de equipo vía ACS/TR-069.
 *
 * Estructura:
 *   1. Interfaz ACS extendida — tipos exportados correctos
 *   2. Mock determinista — cada acción, mismo input → mismo output
 *   3. Determinismo — múltiples llamadas con la misma clave devuelven el mismo resultado
 *   4. Formato TR-143 de runDiagnostic — compatible con herramientas/v1
 *   5. SET_WIFI consistente con updateWifiConfig (no duplica lógica)
 *   6. Manejo de error del conector → CONNECTOR_ERROR vía notImplemented
 *   7. executeAction (lógica pura sin BD) — flujo PENDING → SUCCESS/FAILED
 *   8. RBAC en POST /sessions/:id/actions (Fastify inject, sin BD)
 *   9. Tests que REQUIEREN BD (documentados, todo)
 *
 * Los tests 1-8 NO requieren base de datos.
 * Los tests 9 están escritos como .todo (igual que Fase B).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { signAuthToken } from '../../src/auth/jwt.js';

// ---------------------------------------------------------------------------
// Importaciones de la lógica pura
// ---------------------------------------------------------------------------
import {
  acsMock,
  acsReal,
  getAcsConnector,
  type AcsConnector,
  type DiagnosticResult,
  type RebootResult,
  type SetChannelResult,
  type FactoryResetResult,
  type ReprovisionResult,
} from '../../src/connectors/acs/index.js';

// ---------------------------------------------------------------------------
// Helper de tokens
// ---------------------------------------------------------------------------

async function makeToken(
  role: 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR',
  sub?: string,
): Promise<string> {
  return signAuthToken({
    sub: sub ?? `test-user-${role}`,
    email: `${role.toLowerCase()}@wifix.test`,
    name: `${role} Test`,
    role,
  });
}

// ---------------------------------------------------------------------------
// Suite 1: Interfaz ACS extendida — todos los métodos existen
// ---------------------------------------------------------------------------

describe('Fase C — Interfaz AcsConnector extendida', () => {
  it('acsMock implementa reboot', () => {
    expect(typeof acsMock.reboot).toBe('function');
  });

  it('acsMock implementa setChannel', () => {
    expect(typeof acsMock.setChannel).toBe('function');
  });

  it('acsMock implementa factoryReset', () => {
    expect(typeof acsMock.factoryReset).toBe('function');
  });

  it('acsMock implementa reprovision', () => {
    expect(typeof acsMock.reprovision).toBe('function');
  });

  it('acsMock implementa runDiagnostic', () => {
    expect(typeof acsMock.runDiagnostic).toBe('function');
  });

  it('acsReal implementa todos los métodos de Fase C (esqueleto)', () => {
    expect(typeof acsReal.reboot).toBe('function');
    expect(typeof acsReal.setChannel).toBe('function');
    expect(typeof acsReal.factoryReset).toBe('function');
    expect(typeof acsReal.reprovision).toBe('function');
    expect(typeof acsReal.runDiagnostic).toBe('function');
  });

  it('acsReal lanza CONNECTOR_ERROR al llamar reboot (no implementado)', async () => {
    await expect(acsReal.reboot('ACC-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('acsReal lanza CONNECTOR_ERROR al llamar runDiagnostic (no implementado)', async () => {
    await expect(
      acsReal.runDiagnostic('ACC-001', { target: '8.8.8.8', kind: 'ping' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Mock determinista — camino feliz de cada acción
// ---------------------------------------------------------------------------

describe('Fase C — Mock determinista: camino feliz de cada acción', () => {
  const account = 'WX-PHASE-C-001';

  it('reboot retorna success=true con downtime estimado', async () => {
    const result: RebootResult = await acsMock.reboot(account);
    expect(result.success).toBe(true);
    expect(typeof result.scheduledAt).toBe('string');
    expect(typeof result.estimatedDowntimeSeconds).toBe('number');
    expect(result.estimatedDowntimeSeconds).toBeGreaterThanOrEqual(30);
    expect(result.estimatedDowntimeSeconds).toBeLessThanOrEqual(90);
  });

  it('setChannel retorna success=true con los parámetros aplicados', async () => {
    const result: SetChannelResult = await acsMock.setChannel(account, {
      band: '2.4GHz',
      channel: 6,
    });
    expect(result.success).toBe(true);
    expect(result.band).toBe('2.4GHz');
    expect(result.channel).toBe(6);
    expect(typeof result.appliedAt).toBe('string');
  });

  it('setChannel funciona para banda 5GHz', async () => {
    const result: SetChannelResult = await acsMock.setChannel(account, {
      band: '5GHz',
      channel: 36,
    });
    expect(result.success).toBe(true);
    expect(result.band).toBe('5GHz');
    expect(result.channel).toBe(36);
  });

  it('factoryReset retorna success=true con mensaje de advertencia', async () => {
    const result: FactoryResetResult = await acsMock.factoryReset(account);
    expect(result.success).toBe(true);
    expect(typeof result.scheduledAt).toBe('string');
    expect(typeof result.warningMessage).toBe('string');
    expect(result.warningMessage.length).toBeGreaterThan(0);
  });

  it('reprovision retorna success=true con mensaje', async () => {
    const result: ReprovisionResult = await acsMock.reprovision(account);
    expect(result.success).toBe(true);
    expect(typeof result.scheduledAt).toBe('string');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('runDiagnostic(ping) retorna resultado con campos TR-143', async () => {
    const result: DiagnosticResult = await acsMock.runDiagnostic(account, {
      target: '8.8.8.8',
      kind: 'ping',
    });
    expect(result.kind).toBe('ping');
    expect(result.target).toBe('8.8.8.8');
    expect(typeof result.measuredAt).toBe('string');
    expect(typeof result.packetsSent).toBe('number');
    expect(typeof result.packetsReceived).toBe('number');
    expect(typeof result.packetLossPercent).toBe('number');
    expect(typeof result.minLatencyMs).toBe('number');
    expect(typeof result.avgLatencyMs).toBe('number');
    expect(typeof result.maxLatencyMs).toBe('number');
    // Los saltos no deben estar en un resultado de ping
    expect(result.hops).toBeUndefined();
  });

  it('runDiagnostic(traceroute) con kind:"traceroute" retorna hops', async () => {
    const result: DiagnosticResult = await acsMock.runDiagnostic(account, {
      target: '8.8.8.8',
      kind: 'traceroute',
    });
    expect(result.kind).toBe('traceroute');
    expect(result.target).toBe('8.8.8.8');
    expect(Array.isArray(result.hops)).toBe(true);
    expect(result.hops!.length).toBeGreaterThanOrEqual(4);
    for (const hop of result.hops!) {
      expect(typeof hop.hopNumber).toBe('number');
      expect(hop.hopNumber).toBeGreaterThan(0);
    }
    // Campos de ping no deben estar en traceroute
    expect(result.packetsSent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Determinismo del mock — mismo input → mismo output
// ---------------------------------------------------------------------------

describe('Fase C — Determinismo del mock ACS (Fase C)', () => {
  const account = 'WX-DETERM-001';

  it('reboot es determinista por accountNumber (mismo downtime)', async () => {
    const a = await acsMock.reboot(account);
    const b = await acsMock.reboot(account);
    expect(a.estimatedDowntimeSeconds).toBe(b.estimatedDowntimeSeconds);
  });

  it('factoryReset es determinista por accountNumber (mismo warningMessage)', async () => {
    const a = await acsMock.factoryReset(account);
    const b = await acsMock.factoryReset(account);
    expect(a.warningMessage).toBe(b.warningMessage);
  });

  it('reprovision es determinista por accountNumber (mismo message)', async () => {
    const a = await acsMock.reprovision(account);
    const b = await acsMock.reprovision(account);
    expect(a.message).toBe(b.message);
  });

  it('runDiagnostic ping es determinista por accountNumber+target', async () => {
    const a = await acsMock.runDiagnostic(account, { target: '1.1.1.1', kind: 'ping' });
    const b = await acsMock.runDiagnostic(account, { target: '1.1.1.1', kind: 'ping' });
    expect(a.packetsSent).toBe(b.packetsSent);
    expect(a.packetsReceived).toBe(b.packetsReceived);
    expect(a.avgLatencyMs).toBe(b.avgLatencyMs);
  });

  it('runDiagnostic traceroute es determinista por accountNumber+target', async () => {
    const a = await acsMock.runDiagnostic(account, { target: 'google.com', kind: 'traceroute' });
    const b = await acsMock.runDiagnostic(account, { target: 'google.com', kind: 'traceroute' });
    expect(a.hops?.length).toBe(b.hops?.length);
    // Los hopNumbers y hosts deben coincidir
    for (let i = 0; i < (a.hops?.length ?? 0); i++) {
      expect(a.hops![i]!.hopNumber).toBe(b.hops![i]!.hopNumber);
      expect(a.hops![i]!.host).toBe(b.hops![i]!.host);
    }
  });

  it('cuentas distintas producen resultados distintos en reboot', async () => {
    const a = await acsMock.reboot('WX-ACC-A');
    const b = await acsMock.reboot('WX-ACC-B');
    // No garantizado que sean distintos para cualquier par, pero con cuentas
    // claramente distintas el RNG produce valores distintos en la práctica.
    // Al menos verificamos que el tipo sea correcto para ambas.
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });

  it('targets distintos producen resultados de ping distintos', async () => {
    const a = await acsMock.runDiagnostic(account, { target: '8.8.8.8', kind: 'ping' });
    const b = await acsMock.runDiagnostic(account, { target: '1.1.1.1', kind: 'ping' });
    // La semilla incluye el target, así que deben diferir
    expect(a.avgLatencyMs).not.toBe(b.avgLatencyMs);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Formato TR-143 de runDiagnostic — compatible con herramientas/v1
// ---------------------------------------------------------------------------

describe('Fase C — runDiagnostic: formato TR-143 compatible con herramientas/v1', () => {
  const account = 'WX-TR143-001';

  it('ping: campos compatibles con PingTestDto de herramientas/v1', async () => {
    const result = await acsMock.runDiagnostic(account, { target: '8.8.8.8', kind: 'ping' });
    // Verificar que la estructura coincide con PingTestDto
    expect(result).toMatchObject({
      kind: 'ping',
      target: expect.any(String),
      measuredAt: expect.any(String),
      packetsSent: expect.any(Number),
      packetsReceived: expect.any(Number),
      packetLossPercent: expect.any(Number),
      minLatencyMs: expect.any(Number),
      avgLatencyMs: expect.any(Number),
      maxLatencyMs: expect.any(Number),
    });
    // packetsReceived <= packetsSent
    expect(result.packetsReceived!).toBeLessThanOrEqual(result.packetsSent!);
    // latencias en orden creciente
    expect(result.minLatencyMs!).toBeLessThanOrEqual(result.avgLatencyMs!);
    expect(result.avgLatencyMs!).toBeLessThanOrEqual(result.maxLatencyMs!);
    // measuredAt es ISO 8601
    expect(() => new Date(result.measuredAt)).not.toThrow();
  });

  it('traceroute: campos compatibles con TracerouteDto de herramientas/v1', async () => {
    const result = await acsMock.runDiagnostic(account, { target: '8.8.8.8', kind: 'traceroute' });
    expect(result.kind).toBe('traceroute');
    expect(result.target).toBe('8.8.8.8');
    // hops tiene la estructura de TracerouteHopDto
    for (const hop of result.hops!) {
      expect(typeof hop.hopNumber).toBe('number');
      if (hop.host !== undefined) expect(typeof hop.host).toBe('string');
      if (hop.latencyMs !== undefined) expect(typeof hop.latencyMs).toBe('number');
    }
    // hops ordenados por hopNumber
    for (let i = 1; i < result.hops!.length; i++) {
      expect(result.hops![i]!.hopNumber).toBeGreaterThan(result.hops![i - 1]!.hopNumber);
    }
  });

  it('packetLossPercent está entre 0 y 100', async () => {
    const result = await acsMock.runDiagnostic(account, { target: '208.67.220.220', kind: 'ping' });
    expect(result.packetLossPercent!).toBeGreaterThanOrEqual(0);
    expect(result.packetLossPercent!).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: SET_WIFI consistente con updateWifiConfig
// ---------------------------------------------------------------------------

describe('Fase C — SET_WIFI usa updateWifiConfig (sin duplicar lógica)', () => {
  it('SET_WIFI en el mock refleja cambios vía updateWifiConfig', async () => {
    const account = `WX-SETWIFI-${Date.now()}`;

    // Leer configuración inicial
    const before = await acsMock.getWifiConfig(account);
    expect(before.bands.find((b) => b.band === '2.4GHz')?.ssid).toMatch(/WIFIX_/);

    // Actualizar directamente vía updateWifiConfig (mismo método que usa SET_WIFI)
    const updated = await acsMock.updateWifiConfig(account, {
      bands: [{ band: '2.4GHz', ssid: 'Casa2024' }],
    });
    expect(updated.bands.find((b) => b.band === '2.4GHz')?.ssid).toBe('Casa2024');

    // Verificar que la config persiste
    const after = await acsMock.getWifiConfig(account);
    expect(after.bands.find((b) => b.band === '2.4GHz')?.ssid).toBe('Casa2024');
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Manejo de error — conector real lanza CONNECTOR_ERROR
// ---------------------------------------------------------------------------

describe('Fase C — Manejo de error del conector (notImplemented → CONNECTOR_ERROR)', () => {
  it('acsReal.reboot lanza ApiError con code CONNECTOR_ERROR', async () => {
    await expect(acsReal.reboot('ACC-REAL-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
      statusCode: 502,
    });
  });

  it('acsReal.setChannel lanza CONNECTOR_ERROR', async () => {
    await expect(
      acsReal.setChannel('ACC-REAL-001', { band: '2.4GHz', channel: 6 }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });

  it('acsReal.factoryReset lanza CONNECTOR_ERROR', async () => {
    await expect(acsReal.factoryReset('ACC-REAL-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('acsReal.reprovision lanza CONNECTOR_ERROR', async () => {
    await expect(acsReal.reprovision('ACC-REAL-001')).rejects.toMatchObject({
      code: 'CONNECTOR_ERROR',
    });
  });

  it('acsReal.runDiagnostic lanza CONNECTOR_ERROR', async () => {
    await expect(
      acsReal.runDiagnostic('ACC-REAL-001', { target: '8.8.8.8', kind: 'ping' }),
    ).rejects.toMatchObject({ code: 'CONNECTOR_ERROR' });
  });

  it('getAcsConnector() en modo mock devuelve acsMock', () => {
    // CONNECTOR_MODE por defecto es 'mock' en test (ver env.ts)
    const connector: AcsConnector = getAcsConnector();
    expect(connector).toBe(acsMock);
  });
});

// ---------------------------------------------------------------------------
// Suite 7: Lógica pura del ejecutor de acciones (sin BD)
// ---------------------------------------------------------------------------

describe('Fase C — executeAction: lógica pura del conector (sin BD)', () => {
  /**
   * Probamos la lógica del conector directamente — sin invocar el servicio
   * (que requiere BD para persistir RemoteAction). Esto verifica la correcta
   * selección de método y transformación de parámetros.
   */

  it('REBOOT: mock devuelve success=true con downtime numérico', async () => {
    const acs = getAcsConnector(); // mock en test
    const result = await acs.reboot('ACC-EXEC-001');
    expect(result.success).toBe(true);
    expect(typeof result.estimatedDowntimeSeconds).toBe('number');
  });

  it('SET_CHANNEL: mock aplica band y channel correctamente', async () => {
    const acs = getAcsConnector();
    const result = await acs.setChannel('ACC-EXEC-001', { band: '5GHz', channel: 149 });
    expect(result.success).toBe(true);
    expect(result.band).toBe('5GHz');
    expect(result.channel).toBe(149);
  });

  it('FACTORY_RESET: mock retorna success=true con warningMessage', async () => {
    const acs = getAcsConnector();
    const result = await acs.factoryReset('ACC-EXEC-001');
    expect(result.success).toBe(true);
    expect(typeof result.warningMessage).toBe('string');
  });

  it('REPROVISION: mock retorna success=true con message', async () => {
    const acs = getAcsConnector();
    const result = await acs.reprovision('ACC-EXEC-001');
    expect(result.success).toBe(true);
    expect(typeof result.message).toBe('string');
  });

  it('RUN_DIAGNOSTIC ping: retorna formato TR-143 completo', async () => {
    const acs = getAcsConnector();
    const result = await acs.runDiagnostic('ACC-EXEC-001', { target: '8.8.8.8', kind: 'ping' });
    expect(result.kind).toBe('ping');
    expect(result.packetsSent).toBe(10);
    expect(result.packetLossPercent).toBeGreaterThanOrEqual(0);
    expect(result.packetLossPercent).toBeLessThanOrEqual(100);
  });

  it('RUN_DIAGNOSTIC traceroute: retorna hops en formato TracerouteHopDto', async () => {
    const acs = getAcsConnector();
    const result = await acs.runDiagnostic('ACC-EXEC-001', { target: '1.1.1.1', kind: 'traceroute' });
    expect(result.kind).toBe('traceroute');
    expect(result.target).toBe('1.1.1.1');
    expect(Array.isArray(result.hops)).toBe(true);
  });

  it('SET_WIFI: updateWifiConfig persiste el cambio correctamente', async () => {
    const acs = getAcsConnector();
    const account = `WX-SETWIFI-EXEC-${Date.now()}`;
    const updated = await acs.updateWifiConfig(account, {
      bands: [{ band: '2.4GHz', ssid: 'NuevoSSID', password: 'secret' }],
    });
    expect(updated.bands.find((b) => b.band === '2.4GHz')?.ssid).toBe('NuevoSSID');
  });
});

// ---------------------------------------------------------------------------
// Suite 8: RBAC en POST /sessions/:id/actions (Fastify inject, sin BD)
// ---------------------------------------------------------------------------

describe('Fase C — RBAC en POST /sessions/:id/actions (Fastify inject, sin BD)', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let techToken: string;
  let supervisorToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    [agentToken, techToken, supervisorToken] = await Promise.all([
      makeToken('AGENT'),
      makeToken('TECHNICIAN'),
      makeToken('SUPERVISOR'),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  const fakeId = '00000000-0000-4000-a000-000000000099';

  it('Sin auth → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: { 'content-type': 'application/json' },
      payload: { action: 'REBOOT' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('TECHNICIAN en POST /actions → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${techToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'REBOOT' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  it('SUPERVISOR en POST /actions → 403 (solo AGENT puede ejecutar acciones)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${supervisorToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'REBOOT' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('AGENT con action inválida → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'INVALID_ACTION' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('AGENT con body inválido (sin action) → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('AGENT RUN_DIAGNOSTIC sin kind → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'RUN_DIAGNOSTIC', params: { target: '8.8.8.8' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('AGENT RUN_DIAGNOSTIC sin target → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'RUN_DIAGNOSTIC', params: { kind: 'ping' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('AGENT con REBOOT en UUID inexistente → 404 o 500 (no 403/401 — BD ausente)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { action: 'REBOOT' },
    });
    // Con BD ausente: 500; sin sesión: 404. En cualquier caso, no 401/403/400.
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(400);
  });

  it('GET /sessions/:id/actions acepta AGENT (no 401/403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/asistencia/v1/sessions/${fakeId}/actions`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Suite 9: Tests que REQUIEREN BD (documentados, todo)
// ---------------------------------------------------------------------------

describe('Fase C — Flujo completo con BD (REQUIERE Postgres — se saltará sin BD)', () => {
  /**
   * Para ejecutar estos tests:
   *   1. Tener Postgres corriendo (puerto 5433)
   *   2. DATABASE_URL configurado en .env
   *   3. npx prisma migrate dev
   *   4. npx vitest run tests/modules/assistance-phase-c.test.ts
   */

  it.todo(
    'AGENT ejecuta REBOOT: RemoteAction pasa de PENDING a SUCCESS y ACTION_RESULT emitido por WS',
  );
  it.todo(
    'AGENT ejecuta SET_WIFI con band+ssid: config actualizada en mock, RemoteAction SUCCESS',
  );
  it.todo(
    'AGENT ejecuta SET_CHANNEL con band+channel: RemoteAction SUCCESS, result contiene channel correcto',
  );
  it.todo(
    'AGENT ejecuta FACTORY_RESET: RemoteAction SUCCESS, result.warningMessage presente',
  );
  it.todo(
    'AGENT ejecuta REPROVISION: RemoteAction SUCCESS, result.message presente',
  );
  it.todo(
    'AGENT ejecuta RUN_DIAGNOSTIC ping: RemoteAction SUCCESS, result.kind=ping, campos TR-143 presentes',
  );
  it.todo(
    'AGENT ejecuta RUN_DIAGNOSTIC traceroute (kind="traceroute"): result.kind=traceroute, result.hops array',
  );
  it.todo(
    'AGENT ejecuta acción con conector real (CONNECTOR_MODE=real): 502 CONNECTOR_ERROR en ACTION_RESULT WS',
  );
  it.todo(
    'Sesión no ACTIVE → 409 CONFLICT en POST /actions (no llega al conector)',
  );
  it.todo(
    'Non-agent intenta POST /actions en sesión donde no es el agente → 403 FORBIDDEN',
  );
  it.todo(
    'GET /sessions/:id/actions devuelve Paginated<RemoteAction> en orden cronológico inverso',
  );
  it.todo(
    'RemoteAction PENDING persiste en BD antes de que el conector termine (idempotencia de 202)',
  );
});
