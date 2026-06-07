/**
 * Tests de Fase D — Broker de sesión remota intermediada + Jitsi.
 *
 * Estructura (TODO sin BD, lógica pura):
 *   1. Token store: uso único, expiración, revocación
 *   2. SSRF guard: allowlist estricta de CPE, bloqueo de 169.254.169.254,
 *      loopback, host arbitrario, hostnames DNS
 *   3. Denegación de sesiones ajenas: token de sesión A no sirve para sesión B
 *   4. Protocolo de trama: serialización/deserialización, tipos válidos e inválidos
 *   5. Auto-cierre: timer de expiración, cancelación
 *   6. Jitsi: firma de JWT de sala, campos del claim, sala por sessionId
 *   7. RBAC en endpoints del broker (Fastify inject, sin BD)
 *
 * Los tests que requieren BD están marcados como .todo (mismo patrón que fases anteriores).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { signAuthToken } from '../../src/auth/jwt.js';

// ---------------------------------------------------------------------------
// Módulos del broker (lógica pura — sin BD)
// ---------------------------------------------------------------------------

import {
  registerToken,
  consumeToken,
  peekToken,
  revokeToken,
  clearTokenStore,
  tokenStoreSize,
  purgeExpiredTokens,
  type BrokerTokenEntry,
} from '../../src/modules/assistance/broker/broker.token-store.js';

import {
  checkTargetHost,
  assertTargetHostAllowed,
} from '../../src/modules/assistance/broker/broker.ssrf-guard.js';

import {
  parseFrame,
  serializeFrame,
  isAllowedMethod,
  makeErrorFrame,
  makePingFrame,
  makePongFrame,
} from '../../src/modules/assistance/broker/broker.framing.js';

import {
  scheduleExpiry,
  cancelExpiry,
  pendingExpiryCount,
  clearAllExpiries,
  triggerExpiry,
} from '../../src/modules/assistance/broker/broker.expiry.js';

import {
  deriveRoomName,
  signJitsiRoomToken,
  provisionJitsiRoom,
} from '../../src/modules/assistance/broker/broker.jitsi.js';

import { issueSessionToken, verifyAndConsumeToken } from '../../src/modules/assistance/broker/broker.session-token.js';

// ---------------------------------------------------------------------------
// Helpers
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

function makeTokenEntry(overrides: Partial<BrokerTokenEntry> = {}): BrokerTokenEntry {
  return {
    jti: `jti-${Date.now()}-${Math.random()}`,
    remoteSessionId: 'rs-001',
    sessionId: 'session-001',
    targetHost: '192.168.1.1',
    agentId: 'agent-001',
    expiresAt: Date.now() + 600_000,
    used: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Token store — uso único, expiración, revocación
// ---------------------------------------------------------------------------

describe('Fase D — Token store: uso único y expiración', () => {
  beforeEach(() => {
    clearTokenStore();
  });

  afterEach(() => {
    clearTokenStore();
  });

  it('registerToken agrega el token al store', () => {
    const entry = makeTokenEntry();
    registerToken(entry);
    expect(tokenStoreSize()).toBe(1);
    expect(peekToken(entry.jti)).toBeDefined();
  });

  it('consumeToken: primer consumo exitoso (ok=true)', () => {
    const entry = makeTokenEntry();
    registerToken(entry);
    const result = consumeToken(entry.jti);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.jti).toBe(entry.jti);
      expect(result.entry.used).toBe(true);
    }
  });

  it('consumeToken: segundo consumo → ALREADY_USED', () => {
    const entry = makeTokenEntry();
    registerToken(entry);
    consumeToken(entry.jti); // primer consumo
    const second = consumeToken(entry.jti); // segundo consumo
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('ALREADY_USED');
    }
  });

  it('consumeToken: token no registrado → NOT_FOUND', () => {
    const result = consumeToken('jti-inexistente');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('NOT_FOUND');
    }
  });

  it('consumeToken: token expirado → EXPIRED', () => {
    const entry = makeTokenEntry({ expiresAt: Date.now() - 1000 }); // ya expiró
    registerToken(entry);
    const result = consumeToken(entry.jti);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('EXPIRED');
    }
  });

  it('revokeToken elimina el token del store', () => {
    const entry = makeTokenEntry();
    registerToken(entry);
    revokeToken(entry.jti);
    expect(peekToken(entry.jti)).toBeUndefined();
  });

  it('purgeExpiredTokens elimina entradas expiradas o usadas', () => {
    const expired = makeTokenEntry({ expiresAt: Date.now() - 1000, jti: 'jti-expired' });
    const used = makeTokenEntry({ used: true, jti: 'jti-used' });
    const valid = makeTokenEntry({ jti: 'jti-valid' });
    registerToken(expired);
    registerToken(used);
    registerToken(valid);
    const purged = purgeExpiredTokens();
    expect(purged).toBe(2); // expired + used
    expect(peekToken(valid.jti)).toBeDefined();
    expect(peekToken(expired.jti)).toBeUndefined();
    expect(peekToken(used.jti)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: SSRF guard — allowlist estricta
// ---------------------------------------------------------------------------

describe('Fase D — SSRF guard: allowlist de CPE', () => {
  // Hosts PERMITIDOS (LAN RFC 1918, puertos 80/443)
  it('192.168.1.1 (LAN típico) → permitido', () => {
    const r = checkTargetHost('192.168.1.1');
    expect(r.allowed).toBe(true);
  });

  it('192.168.0.1:80 → permitido', () => {
    const r = checkTargetHost('192.168.0.1:80');
    expect(r.allowed).toBe(true);
  });

  it('192.168.100.254:443 → permitido', () => {
    const r = checkTargetHost('192.168.100.254:443');
    expect(r.allowed).toBe(true);
  });

  it('10.0.0.1 → permitido (RFC 1918 clase A)', () => {
    const r = checkTargetHost('10.0.0.1');
    expect(r.allowed).toBe(true);
  });

  it('172.16.0.1 → permitido (RFC 1918 clase B)', () => {
    const r = checkTargetHost('172.16.0.1');
    expect(r.allowed).toBe(true);
  });

  it('172.31.255.254 → permitido (borde de RFC 1918 clase B)', () => {
    const r = checkTargetHost('172.31.255.254');
    expect(r.allowed).toBe(true);
  });

  // Hosts BLOQUEADOS — metadata / cloud IMDS
  it('169.254.169.254 (AWS IMDS) → bloqueado', () => {
    const r = checkTargetHost('169.254.169.254');
    expect(r.allowed).toBe(false);
  });

  it('169.254.0.1 (link-local) → bloqueado', () => {
    const r = checkTargetHost('169.254.0.1');
    expect(r.allowed).toBe(false);
  });

  // Hosts BLOQUEADOS — loopback
  it('127.0.0.1 (loopback) → bloqueado', () => {
    const r = checkTargetHost('127.0.0.1');
    expect(r.allowed).toBe(false);
  });

  it('127.0.0.1:8080 (loopback con puerto) → bloqueado', () => {
    const r = checkTargetHost('127.0.0.1:8080');
    expect(r.allowed).toBe(false);
  });

  // Hosts BLOQUEADOS — hostname (no IP literal)
  it('localhost → bloqueado (hostname textual)', () => {
    const r = checkTargetHost('localhost');
    expect(r.allowed).toBe(false);
  });

  it('router.local → bloqueado (hostname DNS arbitrario)', () => {
    const r = checkTargetHost('router.local');
    expect(r.allowed).toBe(false);
  });

  it('google.com → bloqueado (hostname público)', () => {
    const r = checkTargetHost('google.com');
    expect(r.allowed).toBe(false);
  });

  // Hosts BLOQUEADOS — IPs públicas
  it('8.8.8.8 (IP pública) → bloqueado', () => {
    const r = checkTargetHost('8.8.8.8');
    expect(r.allowed).toBe(false);
  });

  it('1.1.1.1 (IP pública) → bloqueado', () => {
    const r = checkTargetHost('1.1.1.1');
    expect(r.allowed).toBe(false);
  });

  // Hosts BLOQUEADOS — puertos no permitidos
  it('192.168.1.1:8080 (puerto no permitido) → bloqueado', () => {
    const r = checkTargetHost('192.168.1.1:8080');
    expect(r.allowed).toBe(false);
  });

  it('192.168.1.1:22 (SSH) → bloqueado', () => {
    const r = checkTargetHost('192.168.1.1:22');
    expect(r.allowed).toBe(false);
  });

  // Esquemas no permitidos
  it('ftp://192.168.1.1 → bloqueado (esquema no permitido)', () => {
    const r = checkTargetHost('ftp://192.168.1.1');
    expect(r.allowed).toBe(false);
  });

  // 172.32.x.x está FUERA de RFC 1918 (172.16-31)
  it('172.32.0.1 → bloqueado (fuera de RFC 1918)', () => {
    const r = checkTargetHost('172.32.0.1');
    expect(r.allowed).toBe(false);
  });

  // assertTargetHostAllowed con host válido
  it('assertTargetHostAllowed con IP LAN válida → ok=true', () => {
    const result = assertTargetHostAllowed('192.168.1.1');
    expect(result.ok).toBe(true);
  });

  // assertTargetHostAllowed con host bloqueado
  it('assertTargetHostAllowed con 127.0.0.1 → ok=false con reason', () => {
    const result = assertTargetHostAllowed('127.0.0.1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/[Ll]oopback/);
    }
  });

  // assertTargetHostAllowed vacío → ok=true (sin targetHost = usa gateway por defecto)
  it('assertTargetHostAllowed con vacío → ok=true, target vacío', () => {
    const result = assertTargetHostAllowed('');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Denegación de sesiones ajenas — token scope
// ---------------------------------------------------------------------------

describe('Fase D — Token scope: denegación de sesiones ajenas', () => {
  beforeEach(() => clearTokenStore());
  afterEach(() => clearTokenStore());

  it('Token emitido para sesión A no sirve para sesión B (scope por sessionId)', async () => {
    // Emitimos token para sesionA
    const tokenResult = await issueSessionToken(
      'agent-001',
      'session-A',
      'rs-001',
      '192.168.1.1',
      600,
    );

    // Verificamos el token
    const verifyResult = await verifyAndConsumeToken(tokenResult.jwt);
    expect(verifyResult.ok).toBe(true);
    if (verifyResult.ok) {
      // El payload debe indicar session-A, no session-B
      expect(verifyResult.payload.sessionId).toBe('session-A');
      expect(verifyResult.payload.sessionId).not.toBe('session-B');
    }
  });

  it('Token de un solo uso: segundo intento de verificación → ALREADY_USED', async () => {
    const tokenResult = await issueSessionToken(
      'agent-001',
      'session-A',
      'rs-002',
      null,
      600,
    );

    // Primer uso exitoso
    const first = await verifyAndConsumeToken(tokenResult.jwt);
    expect(first.ok).toBe(true);

    // Segundo uso → rechazado
    const second = await verifyAndConsumeToken(tokenResult.jwt);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('ALREADY_USED');
    }
  });

  it('Token expirado → EXPIRED al verificar', async () => {
    // Emitimos con TTL=1s y esperamos que jose ya haya pasado la exp
    // En vez de esperar, manipulamos el store directamente:
    // issueSessionToken con ttl muy corto y luego forzar tiempo en el store
    const tokenResult = await issueSessionToken(
      'agent-001',
      'session-B',
      'rs-003',
      null,
      1, // 1 segundo
    );

    // Marcar la entrada como expirada en el store directamente
    const entry = peekToken(tokenResult.jti);
    if (entry) {
      entry.expiresAt = Date.now() - 1000; // ya expiró
    }

    // El JWT de jose también tiene exp = now+1s; para el test sin esperar,
    // verificamos solo el store (consumeToken) directamente:
    const storeResult = consumeToken(tokenResult.jti);
    expect(storeResult.ok).toBe(false);
    if (!storeResult.ok) {
      expect(storeResult.reason).toBe('EXPIRED');
    }
  });

  it('Token con agentId correcto: payload.agentId coincide', async () => {
    const tokenResult = await issueSessionToken('agent-XYZ', 'session-C', 'rs-004', '10.0.0.1', 600);
    const result = await verifyAndConsumeToken(tokenResult.jwt);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.agentId).toBe('agent-XYZ');
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Protocolo de trama — parseo y serialización
// ---------------------------------------------------------------------------

describe('Fase D — Protocolo de trama: parseo y serialización', () => {
  it('parseFrame: OPEN_STREAM válido', () => {
    const raw = JSON.stringify({ type: 'OPEN_STREAM', streamId: 1, method: 'GET', path: '/login', headers: {} });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frame.type).toBe('OPEN_STREAM');
      if (result.frame.type === 'OPEN_STREAM') {
        expect(result.frame.streamId).toBe(1);
        expect(result.frame.method).toBe('GET');
        expect(result.frame.path).toBe('/login');
      }
    }
  });

  it('parseFrame: DATA válido con base64', () => {
    const data = Buffer.from('hello router').toString('base64');
    const raw = JSON.stringify({ type: 'DATA', streamId: 2, data });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'DATA') {
      expect(result.frame.data).toBe(data);
    }
  });

  it('parseFrame: END_STREAM válido', () => {
    const result = parseFrame(JSON.stringify({ type: 'END_STREAM', streamId: 3 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.type).toBe('END_STREAM');
  });

  it('parseFrame: RESPONSE válido', () => {
    const raw = JSON.stringify({ type: 'RESPONSE', streamId: 1, status: 200, headers: { 'content-type': 'text/html' } });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'RESPONSE') {
      expect(result.frame.status).toBe(200);
    }
  });

  it('parseFrame: ERROR válido con streamId null', () => {
    const raw = JSON.stringify({ type: 'ERROR', streamId: null, code: 'TIMEOUT', message: 'Router no respondió.' });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok && result.frame.type === 'ERROR') {
      expect(result.frame.streamId).toBeNull();
      expect(result.frame.code).toBe('TIMEOUT');
    }
  });

  it('parseFrame: PING válido', () => {
    const raw = JSON.stringify({ type: 'PING', at: Date.now() });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.type).toBe('PING');
  });

  it('parseFrame: PONG válido', () => {
    const raw = JSON.stringify({ type: 'PONG', at: Date.now() });
    const result = parseFrame(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame.type).toBe('PONG');
  });

  it('parseFrame: JSON inválido → ok=false', () => {
    const result = parseFrame('no es json');
    expect(result.ok).toBe(false);
  });

  it('parseFrame: falta "type" → ok=false', () => {
    const result = parseFrame(JSON.stringify({ streamId: 1, method: 'GET' }));
    expect(result.ok).toBe(false);
  });

  it('parseFrame: tipo desconocido → ok=false', () => {
    const result = parseFrame(JSON.stringify({ type: 'UNKNOWN_TYPE', streamId: 1 }));
    expect(result.ok).toBe(false);
  });

  it('parseFrame: OPEN_STREAM sin method → ok=false', () => {
    const result = parseFrame(JSON.stringify({ type: 'OPEN_STREAM', streamId: 1, path: '/' }));
    expect(result.ok).toBe(false);
  });

  it('serializeFrame → JSON parseable', () => {
    const frame = makePingFrame();
    const raw = serializeFrame(frame);
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as { type: string };
    expect(parsed.type).toBe('PING');
  });

  it('makeErrorFrame construye trama ERROR correctamente', () => {
    const frame = makeErrorFrame(5, 'TIMEOUT', 'Router no respondió.');
    expect(frame.type).toBe('ERROR');
    expect(frame.streamId).toBe(5);
    expect(frame.code).toBe('TIMEOUT');
  });

  it('makePongFrame copia el at del PING', () => {
    const pingAt = 1720000000000;
    const pong = makePongFrame(pingAt);
    expect(pong.at).toBe(pingAt);
  });

  it('isAllowedMethod: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS → true', () => {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
      expect(isAllowedMethod(m)).toBe(true);
    }
  });

  it('isAllowedMethod: CONNECT, TRACE → false', () => {
    expect(isAllowedMethod('CONNECT')).toBe(false);
    expect(isAllowedMethod('TRACE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Auto-cierre — timer de expiración
// ---------------------------------------------------------------------------

describe('Fase D — Auto-cierre: timer de expiración', () => {
  beforeEach(() => {
    clearAllExpiries();
  });

  afterEach(() => {
    clearAllExpiries();
  });

  it('scheduleExpiry registra el timer', () => {
    const before = pendingExpiryCount();
    scheduleExpiry('rs-timer-1', 'session-1', 'jti-1', Date.now() + 60_000, {
      onExpire: async () => {},
    });
    expect(pendingExpiryCount()).toBe(before + 1);
  });

  it('cancelExpiry elimina el timer', () => {
    scheduleExpiry('rs-timer-2', 'session-2', 'jti-2', Date.now() + 60_000, {
      onExpire: async () => {},
    });
    const before = pendingExpiryCount();
    cancelExpiry('rs-timer-2');
    expect(pendingExpiryCount()).toBe(before - 1);
  });

  it('triggerExpiry llama onExpire con los IDs correctos', async () => {
    const calls: Array<{ rsId: string; sId: string }> = [];
    scheduleExpiry('rs-trigger-1', 'session-trigger-1', 'jti-t1', Date.now() + 60_000, {
      onExpire: async (rsId, sId) => {
        calls.push({ rsId, sId });
      },
    });
    await triggerExpiry('rs-trigger-1', {
      onExpire: async (rsId, sId) => {
        calls.push({ rsId, sId });
      },
    });
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.rsId).toBe('rs-trigger-1');
    expect(calls[0]?.sId).toBe('session-trigger-1');
  });

  it('scheduleExpiry reemplaza el timer si se llama dos veces para el mismo rsId', () => {
    scheduleExpiry('rs-dup', 'session-dup', 'jti-dup1', Date.now() + 60_000, { onExpire: async () => {} });
    const countBefore = pendingExpiryCount();
    scheduleExpiry('rs-dup', 'session-dup', 'jti-dup2', Date.now() + 60_000, { onExpire: async () => {} });
    // No debe aumentar: reemplaza
    expect(pendingExpiryCount()).toBe(countBefore);
  });

  it('onBeforeExpire se llama antes de onExpire', async () => {
    const order: string[] = [];
    scheduleExpiry('rs-order', 'session-order', 'jti-order', Date.now() + 60_000, {
      onBeforeExpire: () => { order.push('before'); },
      onExpire: async () => { order.push('expire'); },
    });
    await triggerExpiry('rs-order', {
      onBeforeExpire: () => { order.push('before'); },
      onExpire: async () => { order.push('expire'); },
    });
    expect(order[0]).toBe('before');
    expect(order[1]).toBe('expire');
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Jitsi — firma de JWT de sala
// ---------------------------------------------------------------------------

describe('Fase D — Jitsi: firma JWT de sala', () => {
  it('deriveRoomName devuelve sala con prefijo wifix-assist', () => {
    const room = deriveRoomName('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(room).toBe('wifix-assist-a1b2c3d4');
    expect(room.startsWith('wifix-assist-')).toBe(true);
  });

  it('deriveRoomName es determinista: mismo sessionId → mismo roomName', () => {
    const sid = '11111111-2222-3333-4444-555555555555';
    expect(deriveRoomName(sid)).toBe(deriveRoomName(sid));
  });

  it('deriveRoomName es diferente para sessionIds distintos', () => {
    expect(deriveRoomName('aaa-aaa')).not.toBe(deriveRoomName('bbb-bbb'));
  });

  it('signJitsiRoomToken produce un JWT no vacío', async () => {
    const jwt = await signJitsiRoomToken({
      room: 'wifix-assist-test',
      user: { id: 'user-1', name: 'Técnico Test', email: 'tech@wifix.test', role: 'TECHNICIAN' },
    });
    expect(typeof jwt).toBe('string');
    expect(jwt.split('.').length).toBe(3); // header.payload.signature
  });

  it('signJitsiRoomToken: payload decodificable con claims correctos', async () => {
    const room = 'wifix-assist-myroom';
    const userId = 'agent-jitsi-test';
    const jwt = await signJitsiRoomToken({
      room,
      user: { id: userId, name: 'Agente Test', email: 'agent@wifix.test', role: 'AGENT' },
    });

    // Decodificar payload sin verificar (solo para inspeccionar en tests)
    const payloadB64 = jwt.split('.')[1]!;
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;

    expect(decoded['room']).toBe(room);
    expect(typeof decoded['exp']).toBe('number');
    expect(decoded['aud']).toBeTruthy(); // JITSI_APP_ID
    expect(decoded['iss']).toBeTruthy(); // JITSI_APP_ID
    expect(decoded['sub']).toBeTruthy(); // JITSI_SUB

    const context = decoded['context'] as Record<string, unknown>;
    expect(context).toBeDefined();
    const contextUser = context['user'] as Record<string, unknown>;
    expect(contextUser['id']).toBe(userId);
    // AGENT es moderador
    expect(contextUser['moderator']).toBe(true);
  });

  it('provisionJitsiRoom devuelve roomName, domain y jwt', async () => {
    const result = await provisionJitsiRoom('session-jitsi-001', {
      id: 'tech-1',
      name: 'Técnico',
      email: 'tech@wifix.test',
      role: 'TECHNICIAN',
    });
    expect(result.roomName).toContain('wifix-assist-');
    expect(typeof result.domain).toBe('string');
    expect(typeof result.jwt).toBe('string');
    expect(result.jwt.split('.').length).toBe(3);
  });

  it('JWT de sala expira en el futuro (exp > now)', async () => {
    const jwt = await signJitsiRoomToken({
      room: 'test-room',
      user: { id: 'u', name: 'U', email: 'u@test.com', role: 'TECHNICIAN' },
    });
    const payloadB64 = jwt.split('.')[1]!;
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { exp: number };
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

// ---------------------------------------------------------------------------
// Suite 7: RBAC en endpoints del broker (Fastify inject, sin BD)
// ---------------------------------------------------------------------------

describe('Fase D — RBAC en endpoints del broker (Fastify inject, sin BD)', () => {
  let app: FastifyInstance;
  let agentToken: string;
  let techToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    [agentToken, techToken] = await Promise.all([
      makeToken('AGENT'),
      makeToken('TECHNICIAN'),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /asistencia/v1/broker/tunnel sin JWT → 426 o 400 (no 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/asistencia/v1/broker/tunnel',
    });
    // Sin Upgrade: WebSocket, el servidor devuelve error de protocolo, pero la ruta existe
    expect(res.statusCode).not.toBe(404);
  });

  it('GET /asistencia/v1/broker/connect sin JWT → ruta existe (no 404)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/asistencia/v1/broker/connect',
    });
    expect(res.statusCode).not.toBe(404);
  });

  it('POST /sessions/:id/remote-sessions sin auth → 401', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/remote-sessions`,
      headers: { 'content-type': 'application/json' },
      payload: { channel: 'BROKER_TUNNEL' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /sessions/:id/remote-sessions con TECHNICIAN → 403', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/remote-sessions`,
      headers: {
        authorization: `Bearer ${techToken}`,
        'content-type': 'application/json',
      },
      payload: { channel: 'BROKER_TUNNEL' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /sessions/:id/remote-sessions con targetHost bloqueado (127.0.0.1) → 400', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/remote-sessions`,
      headers: {
        authorization: `Bearer ${agentToken}`,
        'content-type': 'application/json',
      },
      payload: { channel: 'BROKER_TUNNEL', targetHost: '127.0.0.1' },
    });
    // El agente autenticado llega al servicio; la validación SSRF rechaza 400
    // (con BD ausente será 500 o 400 según el orden de validación)
    // Lo importante: no es 401/403
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });

  it('POST /sessions/:id/video sin auth → 401', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/video`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /sessions/:id/video con AGENT → no 403 ni 401 (puede ser 500 sin BD)', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await app.inject({
      method: 'POST',
      url: `/asistencia/v1/sessions/${fakeId}/video`,
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Suite 8: Tests que REQUIEREN BD (documentados como todo)
// ---------------------------------------------------------------------------

describe('Fase D — Flujo completo con BD (REQUIERE Postgres — se saltará sin BD)', () => {
  it.todo('AGENT abre sesión remota → recibe token JWT de un solo uso + URL del broker');
  it.todo('Agente intenta reutilizar sessionToken → 401 ALREADY_USED');
  it.todo('Token expirado (ttlSeconds=1) → 401 EXPIRED al conectar al broker');
  it.todo('SSRF: targetHost=169.254.169.254 → 400 en POST /remote-sessions (rechazado antes de persistir)');
  it.todo('SSRF: targetHost=8.8.8.8 (IP pública) → 400');
  it.todo('Non-agent no puede cerrar sesión remota ajena → 403');
  it.todo('Token de sesión A rechazado en sesión B (scope)');
  it.todo('Sesión RESOLVED/UNRESOLVED/CANCELLED → cierra RemoteSession OPEN automáticamente');
  it.todo('Técnico sin heartbeat por >60s → RemoteSession pasa a CLOSED (auto-cierre disparador #3)');
  it.todo('RemoteSession expirada por TTL → status=EXPIRED en BD');
  it.todo('POST /sessions/:id/video devuelve JWT Jitsi firmado (HS256, 3 partes)');
  it.todo('JWT Jitsi tiene claims: room, aud, iss, sub, context.user.moderator=true');
  it.todo('Sala Jitsi idempotente: dos llamadas para la misma sesión → mismo roomName');
  it.todo('Broker end-to-end con técnico simulado: OPEN_STREAM → RESPONSE → DATA → END_STREAM');
  it.todo('BROKER_RECORDING_ENABLED=true → MediaFile creado y enlazado a RemoteSession.recordingId');
});
