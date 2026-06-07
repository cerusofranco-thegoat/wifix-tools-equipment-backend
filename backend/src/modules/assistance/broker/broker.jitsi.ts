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
 * Notas de seguridad (Fase D hardening):
 *   TTL: El JWT se emite con TTL corto (JITSI_JWT_TTL, default 1800s = 30 min).
 *        provisionJitsiRoom se llama en cada solicitud POST /sessions/:id/video,
 *        de modo que el participante siempre recibe un token fresco al unirse.
 *        El cliente debe reinvocar /video si el JWT expira durante la llamada.
 *
 *   Rol moderador por rol de aplicación (decisión de producto):
 *        AGENT y SUPERVISOR → moderator: true  (lidera la llamada desde el Call Center)
 *        TECHNICIAN         → moderator: false (opera el equipo, no modera la sala)
 *
 * Módulo sin I/O → testeable sin BD.
 */

import { SignJWT } from 'jose';
import { TextEncoder } from 'node:util';
import { env } from '../../../config/env.js';

function jitsiSecretKey(): Uint8Array {
  return new TextEncoder().encode(env.JITSI_APP_SECRET);
}

/** Roles del sistema que pueden provisionar una sala Jitsi. */
export type JitsiParticipantRole = 'TECHNICIAN' | 'AGENT' | 'SUPERVISOR';

export interface JitsiUserContext {
  id: string;
  name: string;
  email: string;
  role: JitsiParticipantRole;
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
 * Devuelve true si el rol debe ser moderador de la sala Jitsi.
 *
 * Política:
 *   AGENT / SUPERVISOR → moderador (dirigen la llamada desde el Call Center)
 *   TECHNICIAN         → no moderador (ejecuta acciones en campo)
 */
function isModerator(role: JitsiParticipantRole): boolean {
  return role === 'AGENT' || role === 'SUPERVISOR';
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
 *
 * El JWT tiene vida corta (JITSI_JWT_TTL, default 1800s) y se reemite en
 * cada llamada a provisionJitsiRoom para garantizar que el token es siempre
 * fresco al momento de unirse.
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
        moderator: isModerator(input.user.role),
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
 * El JWT se reemite en cada llamada para garantizar TTL corto al unirse.
 *
 * @param sessionId  ID de la AssistanceSession.
 * @param user       Datos del usuario que solicita el JWT (incluye su rol).
 */
export async function provisionJitsiRoom(
  sessionId: string,
  user: JitsiUserContext,
): Promise<JitsiRoomResult> {
  const roomName = deriveRoomName(sessionId);
  const jwt = await signJitsiRoomToken({ room: roomName, user });
  return { roomName, domain: env.JITSI_DOMAIN, jwt };
}
