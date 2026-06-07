/**
 * Emisión y verificación de tokens de sesión remota del broker.
 *
 * Diseño:
 *   - JWT HS256 firmado con BROKER_TOKEN_SECRET (distinto de JWT_SECRET del auth).
 *   - Payload: { sub: agentId, jti: uuid, sessionId, remoteSessionId, targetHost, iat, exp }.
 *   - El jti es el identificador de un solo uso; se registra en broker.token-store.ts
 *     y se consume al primer uso (uso único).
 *   - La firma protege la integridad; el jti protege contra replay.
 *
 * Flujo:
 *   1. Servicio llama issueSessionToken() → JWT firmado + jti registrado en store.
 *   2. Agente se conecta al broker con el JWT.
 *   3. Broker llama verifyAndConsumeToken() → verifica firma + consume jti.
 *   4. Si el agente intenta reutilizar el mismo JWT → reserveToken devuelve false → rechazado.
 *
 * Atomicidad TOCTOU:
 *   - InMemory: reserveToken es check-and-set síncrono (sin await entre check y set).
 *   - Redis: SET NX EX — atómica cross-instancia (garantizada por Redis).
 *   - En ambos casos no hay nueva ventana TOCTOU introducida por el paso a async:
 *     el único await antes de marcar el token es la resolución de la Promise de
 *     reserveToken, que en InMemory resuelve en el mismo tick.
 */

import { SignJWT, jwtVerify, decodeJwt, errors as joseErrors } from 'jose';
import { randomUUID } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { env } from '../../../config/env.js';
import {
  registerToken,
  consumeToken,
  reserveToken,
  releaseToken,
  type ConsumeResult,
} from './broker.token-store.js';

function brokerSecretKey(): Uint8Array {
  return new TextEncoder().encode(env.BROKER_TOKEN_SECRET);
}

export interface SessionTokenPayload {
  jti: string;
  agentId: string;
  sessionId: string;
  remoteSessionId: string;
  targetHost: string | null;
  expiresAt: number; // epoch ms
}

export interface IssueSessionTokenResult {
  jwt: string;
  jti: string;
  expiresAt: Date;
}

/**
 * Emite un JWT de sesión remota de un solo uso.
 * Registra el jti en el token store para validación de uso único.
 */
export async function issueSessionToken(
  agentId: string,
  sessionId: string,
  remoteSessionId: string,
  targetHost: string | null,
  ttlSeconds: number,
): Promise<IssueSessionTokenResult> {
  const jti = randomUUID();
  const now = Date.now();
  const expiresAt = new Date(now + ttlSeconds * 1000);

  const jwt = await new SignJWT({
    sessionId,
    remoteSessionId,
    targetHost: targetHost ?? null,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(agentId)
    .setJti(jti)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(brokerSecretKey());

  // Registrar en el store de uso único
  await registerToken({
    jti,
    remoteSessionId,
    sessionId,
    targetHost,
    agentId,
    expiresAt: expiresAt.getTime(),
    used: false,
  });

  return { jwt, jti, expiresAt };
}

// ---------------------------------------------------------------------------
// Resultado de verificación
// ---------------------------------------------------------------------------

export type VerifyTokenResult =
  | { ok: true; payload: SessionTokenPayload }
  | { ok: false; reason: 'INVALID_SIGNATURE' | 'EXPIRED' | 'ALREADY_USED' | 'NOT_FOUND' | 'MALFORMED' };

/**
 * Verifica la firma del JWT, extrae el payload, y consume el jti (uso único).
 * Después de esta llamada, el mismo JWT será rechazado.
 *
 * Implementación libre de condición TOCTOU:
 *   1. Decodifica el jti sin verificar firma (solo para leer el claim).
 *   2. Llama a reserveToken(jti) — atómico (SET NX EX en Redis; check-and-set en InMemory).
 *      Si falla (ya usado / no existe) → rechazado inmediatamente.
 *   3. Solo si la reserva tuvo éxito, realiza el await jwtVerify (costoso).
 *   4. Si la verificación posterior (firma, exp, claims) falla → releaseToken(jti)
 *      para no dejar el token marcado como "usado" por un JWT malformado ajeno.
 *      (En Redis release es no-op por diseño; ver broker.token-store.redis.ts).
 *
 * Nota sobre atomicidad async:
 *   En InMemory, el await de reserveToken() resuelve en el mismo turno del event loop
 *   (la Promise envuelve una operación síncrona), por lo que la semántica de "sin
 *   TOCTOU en proceso único" se mantiene. En Redis la atomicidad es garantizada por
 *   el SET NX EX del servidor Redis, independientemente del await.
 */
export async function verifyAndConsumeToken(rawJwt: string): Promise<VerifyTokenResult> {
  // -------------------------------------------------------------------
  // 1. Decodificar jti sin verificar firma (solo para la reserva)
  // -------------------------------------------------------------------
  let preliminaryJti: string;
  try {
    const preliminaryPayload = decodeJwt(rawJwt);
    if (!preliminaryPayload.jti || typeof preliminaryPayload.jti !== 'string') {
      return { ok: false, reason: 'MALFORMED' };
    }
    preliminaryJti = preliminaryPayload.jti;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  // -------------------------------------------------------------------
  // 2. Reservar el jti de forma atómica
  // -------------------------------------------------------------------
  const reserved = await reserveToken(preliminaryJti);
  if (!reserved) {
    // Puede ser NOT_FOUND o ALREADY_USED; distinguimos consultando el store.
    const probe: ConsumeResult = await consumeToken(preliminaryJti);
    if (!probe.ok) {
      if (probe.reason === 'ALREADY_USED') return { ok: false, reason: 'ALREADY_USED' };
      if (probe.reason === 'EXPIRED') return { ok: false, reason: 'EXPIRED' };
    }
    return { ok: false, reason: 'NOT_FOUND' };
  }

  // -------------------------------------------------------------------
  // 3. Verificar firma y expiración vía jose (puede lanzar)
  // -------------------------------------------------------------------
  let jtiFromJwt: string;
  let agentId: string;
  let sessionId: string;
  let remoteSessionId: string;
  let targetHost: string | null;
  let expiresAt: number;

  try {
    const { payload } = await jwtVerify(rawJwt, brokerSecretKey(), { algorithms: ['HS256'] });

    if (!payload.jti || typeof payload.jti !== 'string') {
      await releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (!payload.sub) {
      await releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (typeof payload['sessionId'] !== 'string') {
      await releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (typeof payload['remoteSessionId'] !== 'string') {
      await releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }

    jtiFromJwt = payload.jti;
    agentId = payload.sub;
    sessionId = payload['sessionId'] as string;
    remoteSessionId = payload['remoteSessionId'] as string;
    targetHost =
      typeof payload['targetHost'] === 'string' ? payload['targetHost'] : null;
    expiresAt = (payload.exp ?? 0) * 1000;
  } catch (err) {
    await releaseToken(preliminaryJti);
    if (err instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'EXPIRED' };
    }
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  // -------------------------------------------------------------------
  // 4. Verificar coherencia: el jti del payload verificado debe coincidir
  //    con el jti preliminar (protege contra sustitución de header)
  // -------------------------------------------------------------------
  if (jtiFromJwt !== preliminaryJti) {
    await releaseToken(preliminaryJti);
    return { ok: false, reason: 'MALFORMED' };
  }

  return {
    ok: true,
    payload: { jti: jtiFromJwt, agentId, sessionId, remoteSessionId, targetHost, expiresAt },
  };
}
