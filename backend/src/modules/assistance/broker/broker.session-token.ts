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
 *   4. Si el agente intenta reutilizar el mismo JWT → consumeToken devuelve ALREADY_USED → rechazado.
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
  registerToken({
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
 *   2. Llama a reserveToken(jti) de forma síncrona — check-and-set atómico en el Map.
 *      Si falla (ya usado / no existe) → rechazado inmediatamente, antes del await.
 *   3. Solo si la reserva tuvo éxito, realiza el await jwtVerify (costoso).
 *   4. Si la verificación posterior (firma, exp, claims) falla → releaseToken(jti)
 *      para no dejar el token marcado como "usado" por un JWT malformado ajeno.
 *
 * Resultado de replay (segundo intento concurrente con el mismo token):
 *   El segundo llamador llega a reserveToken ya con entry.used=true → ALREADY_USED.
 */
export async function verifyAndConsumeToken(rawJwt: string): Promise<VerifyTokenResult> {
  // -------------------------------------------------------------------
  // 1. Decodificar jti sin verificar firma (solo para la reserva síncrona)
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
  // 2. Reservar el jti de forma síncrona (elimina ventana TOCTOU)
  //    Si ya está marcado como used o no existe → rechazar antes del await
  // -------------------------------------------------------------------

  // Comprobar si existe en el store antes de reservar (para distinguir NOT_FOUND)
  // Nota: consumeToken hace check completo pero tiene el mismo problema TOCTOU.
  // Usamos reserveToken que es check-and-set atómico.
  const reserved = reserveToken(preliminaryJti);
  if (!reserved) {
    // Puede ser NOT_FOUND o ALREADY_USED; distinguimos consultando el store.
    // consumeToken a estas alturas devuelve ALREADY_USED o NOT_FOUND correctamente
    // porque reserveToken ya verificó el estado.
    const probe: ConsumeResult = consumeToken(preliminaryJti);
    // probe.ok siempre será false aquí porque la reserva falló
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
      releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (!payload.sub) {
      releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (typeof payload['sessionId'] !== 'string') {
      releaseToken(preliminaryJti);
      return { ok: false, reason: 'MALFORMED' };
    }
    if (typeof payload['remoteSessionId'] !== 'string') {
      releaseToken(preliminaryJti);
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
    // Verificación fallida: liberar la reserva para no consumir el token en falso
    releaseToken(preliminaryJti);
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
    releaseToken(preliminaryJti);
    return { ok: false, reason: 'MALFORMED' };
  }

  return {
    ok: true,
    payload: { jti: jtiFromJwt, agentId, sessionId, remoteSessionId, targetHost, expiresAt },
  };
}
