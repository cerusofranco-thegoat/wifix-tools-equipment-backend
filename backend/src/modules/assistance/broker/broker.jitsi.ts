/**
 * Firma de JWT de sala Jitsi.
 *
 * Implementa el formato de claims de Jitsi Meet self-host (versión moderna):
 *   - aud: JITSI_APP_ID
 *   - iss: JITSI_APP_ID
 *   - sub: JITSI_SUB (dominio del Jitsi, ej. "meet.wifix.internal")
 *   - room: nombre de la sala
 *   - exp: JITSI_JWT_TTL segundos desde ahora
 *   - context.user: { id, name, email, moderator }
 *
 * Firmado HS256 con JITSI_APP_SECRET vía jose (mismo stack del proyecto).
 *
 * Módulo sin I/O → testeable sin BD.
 */

import { SignJWT } from 'jose';
import { TextEncoder } from 'node:util';
import { env } from '../../../config/env.js';

function jitsiSecretKey(): Uint8Array {
  return new TextEncoder().encode(env.JITSI_APP_SECRET);
}

export interface JitsiUserContext {
  id: string;
  name: string;
  email: string;
  /** Si el usuario es moderador de la sala (técnico y agente lo son en este contexto). */
  moderator: boolean;
}

export interface SignJitsiTokenInput {
  room: string;
  user: JitsiUserContext;
}

export interface JitsiRoomResult {
  roomName: string;
  domain: string;
  jwt: string;
}

/**
 * Deriva el nombre canónico de sala para una sesión de asistencia.
 * Usa los primeros 8 caracteres del sessionId para mantenerlo corto.
 * El nombre es el mismo para todos los participantes de una sesión.
 */
export function deriveRoomName(sessionId: string): string {
  return `wifix-assist-${sessionId.slice(0, 8)}`;
}

/**
 * Firma un JWT de sala Jitsi para el usuario indicado.
 *
 * Sigue el contrato de claims esperado por Jitsi Meet self-host moderno:
 *   https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-ljm-tokens
 */
export async function signJitsiRoomToken(input: SignJitsiTokenInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + env.JITSI_JWT_TTL;

  return new SignJWT({
    aud: env.JITSI_APP_ID,
    iss: env.JITSI_APP_ID,
    sub: env.JITSI_SUB,
    room: input.room,
    context: {
      user: {
        id: input.user.id,
        name: input.user.name,
        email: input.user.email,
        moderator: input.user.moderator,
      },
    },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(jitsiSecretKey());
}

/**
 * Provisiona una sala Jitsi para una sesión de asistencia.
 * La sala es idempotente: el mismo sessionId siempre produce el mismo roomName.
 *
 * @param sessionId  ID de la AssistanceSession.
 * @param user       Datos del usuario que solicita el JWT.
 */
export async function provisionJitsiRoom(
  sessionId: string,
  user: JitsiUserContext,
): Promise<JitsiRoomResult> {
  const roomName = deriveRoomName(sessionId);
  // TODO(seguridad): atar TTL del JWT de sala a la duración de la sesión; revisar rol moderador
  const jwt = await signJitsiRoomToken({ room: roomName, user });
  return { roomName, domain: env.JITSI_DOMAIN, jwt };
}
