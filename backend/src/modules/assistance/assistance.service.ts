/**
 * Servicio del módulo Asistencia Técnica.
 * Fase B: sesiones, ciclo de vida, sesiones remotas (mock).
 * Fase C: acciones de equipo reales vía conector ACS.
 * Fase D: broker WSS real (token single-use, SSRF guard, Jitsi real).
 */

import pino from 'pino';
import { ApiError } from '../../middleware/error-handler.js';
import { getAcsConnector } from '../../connectors/acs/index.js';
import type { WifiBand } from '../../connectors/acs/index.js';
import { issueSessionToken } from './broker/broker.session-token.js';
import { assertTargetHostAllowed } from './broker/broker.ssrf-guard.js';
import { scheduleExpiry, cancelExpiry } from './broker/broker.expiry.js';
import { sendTunnelError } from './broker/broker.proxy.js';
import { provisionJitsiRoom, type JitsiParticipantRole } from './broker/broker.jitsi.js';
import {
  issueProxyCookie,
  invalidateProxyCookieBySession,
  buildProxyCookieSetHeader,
} from './broker/broker.proxy-cookie-store.js';
import { env } from '../../config/env.js';

// Logger de módulo para contextos donde no hay request.log disponible (callbacks de timers, etc.)
const moduleLogger = pino({ name: 'assistance.service', level: env.LOG_LEVEL });
import { assistanceRepository } from './assistance.repository.js';
import {
  mapSession,
  mapEvent,
  mapRemoteAction,
  mapRemoteSession,
  toPaginated,
  type AssistanceSessionDto,
  type AssistanceEventDto,
  type RemoteActionDto,
  type RemoteSessionDto,
  type SessionDetailDto,
  type PaginatedDto,
} from './assistance.mappers.js';
import { isValidTransition, requiresNote } from './assistance.state-machine.js';
import {
  broadcastQueueUpdated,
  broadcastSessionStateChanged,
  broadcastActionResult,
  broadcastRemoteSessionReady,
} from './assistance.hub.js';
import type {
  CreateSessionInput,
  ListSessionsInput,
  ChangeStatusInput,
  AddNoteInput,
  OpenRemoteSessionInput,
  RequestActionInput,
} from './assistance.schemas.js';
import type { RemoteActionType } from './assistance.mappers.js';

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

/** Verifica que la sesión existe; lanza 404 si no. */
async function requireSession(id: string) {
  const session = await assistanceRepository.findSessionById(id);
  if (!session) {
    throw ApiError.notFound('Sesión de asistencia no encontrada.');
  }
  return session;
}

/**
 * Verifica que el usuario es participante (técnico o agente) o supervisor.
 * Lanza 403 si no tiene acceso.
 */
function assertParticipantOrSupervisor(
  session: { technicianId: string | null; agentId: string | null },
  userId: string,
  role: string,
): void {
  if (role === 'SUPERVISOR') return;
  if (session.technicianId === userId || session.agentId === userId) return;
  throw ApiError.forbidden('No tiene acceso a esta sesión de asistencia.');
}

/** Verifica que el usuario es el agente asignado o supervisor. */
function assertAssignedAgentOrSupervisor(
  session: { agentId: string | null },
  userId: string,
  role: string,
): void {
  if (role === 'SUPERVISOR') return;
  if (role === 'AGENT' && session.agentId === userId) return;
  throw ApiError.forbidden(
    'Solo el agente asignado o un supervisor puede realizar esta operación.',
  );
}

// ---------------------------------------------------------------------------
// POST /sessions (TECHNICIAN)
// ---------------------------------------------------------------------------

async function createSession(
  input: CreateSessionInput,
  technicianId: string,
): Promise<{ session: AssistanceSessionDto }> {
  const consentAt = input.consent ? new Date() : null;

  const session = await assistanceRepository.createSession({
    accountNumber: input.accountNumber,
    visitId: input.visitId,
    reason: input.reason,
    technicianId,
    consentAt,
  });

  // Auditoría: evento CONSENT si el consentimiento fue capturado
  if (consentAt) {
    await assistanceRepository.createEvent({
      sessionId: session.id,
      type: 'CONSENT',
      payload: { consentAt: consentAt.toISOString() },
      actorId: technicianId,
    });
  }

  const dto = mapSession(session);

  // Notificar a la cola (agentes suscritos)
  broadcastQueueUpdated(dto);

  return { session: dto };
}

// ---------------------------------------------------------------------------
// GET /sessions (AGENT | SUPERVISOR)
// ---------------------------------------------------------------------------

async function listSessions(input: ListSessionsInput): Promise<PaginatedDto<AssistanceSessionDto>> {
  const { items, total } = await assistanceRepository.listSessions({
    status: input.status,
    accountNumber: input.accountNumber,
    page: input.page,
    pageSize: input.pageSize,
  });
  return toPaginated(items.map(mapSession), total, input.page, input.pageSize);
}

// ---------------------------------------------------------------------------
// GET /sessions/:id (participantes o SUPERVISOR)
// ---------------------------------------------------------------------------

async function getSessionDetail(
  id: string,
  userId: string,
  role: string,
): Promise<SessionDetailDto> {
  const session = await requireSession(id);
  assertParticipantOrSupervisor(session, userId, role);

  const [activeRemoteSession, videoRoom, recentActions] = await Promise.all([
    assistanceRepository.findActiveRemoteSession(id),
    assistanceRepository.findVideoRoom(id),
    assistanceRepository.findRecentActions(id, 5),
  ]);

  return {
    session: mapSession(session),
    activeRemoteSession: activeRemoteSession ? mapRemoteSession(activeRemoteSession) : null,
    videoRoom,
    recentActions: recentActions.map(mapRemoteAction),
  };
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/assign (AGENT)
// ---------------------------------------------------------------------------

async function assignSession(
  id: string,
  agentId: string,
): Promise<{ session: AssistanceSessionDto }> {
  const session = await requireSession(id);

  // 409 si ya tiene agente asignado (distinto)
  if (session.agentId && session.agentId !== agentId) {
    throw ApiError.conflict('Esta sesión ya fue asignada a otro agente.');
  }

  // Idempotente: si ya está asignada al mismo agente, devolvemos la sesión
  if (session.agentId === agentId && session.status === 'ASSIGNED') {
    return { session: mapSession(session) };
  }

  // La sesión debe estar en QUEUED para poder asignarla
  if (session.status !== 'QUEUED' && session.status !== 'REQUESTED') {
    throw ApiError.conflict(`No se puede asignar una sesión en estado ${session.status}.`);
  }

  const updated = await assistanceRepository.updateSessionStatus(id, 'ASSIGNED', {
    agentId,
  });

  await assistanceRepository.createEvent({
    sessionId: id,
    type: 'STATE_CHANGE',
    payload: { from: session.status, to: 'ASSIGNED' },
    actorId: agentId,
  });

  const dto = mapSession(updated);
  broadcastSessionStateChanged(dto);
  broadcastQueueUpdated(dto);

  return { session: dto };
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/status (AGENT asignado | SUPERVISOR)
// ---------------------------------------------------------------------------

async function changeStatus(
  id: string,
  input: ChangeStatusInput,
  userId: string,
  role: string,
): Promise<{ session: AssistanceSessionDto }> {
  const session = await requireSession(id);
  assertAssignedAgentOrSupervisor(session, userId, role);

  const from = session.status as Parameters<typeof isValidTransition>[0];
  const to = input.status;

  if (!isValidTransition(from, to)) {
    throw ApiError.conflict(`Transición inválida: no se puede pasar de ${from} a ${to}.`);
  }

  if (requiresNote(to) && !input.note) {
    throw ApiError.validation(`El campo 'note' es obligatorio para el estado ${to}.`);
  }

  const isTerminal = to === 'RESOLVED' || to === 'UNRESOLVED' || to === 'CANCELLED';

  const updated = await assistanceRepository.updateSessionStatus(id, to, {
    ...(input.note ? { resolutionNote: input.note } : {}),
    ...(isTerminal ? { closedAt: new Date() } : {}),
  });

  await assistanceRepository.createEvent({
    sessionId: id,
    type: 'STATE_CHANGE',
    payload: { from, to, note: input.note ?? null },
    actorId: userId,
  });

  // Auto-cierre de sesión remota al terminar la sesión de asistencia (ADR-0002 disparador #2)
  if (isTerminal) {
    const activeRemote = await assistanceRepository.findActiveRemoteSession(id);
    if (activeRemote) {
      cancelExpiry(activeRemote.id);
      // Invalidar la cookie de sesión de proxy HTTP (Fase E)
      invalidateProxyCookieBySession(activeRemote.id);
      sendTunnelError(id, 'SESSION_CLOSED', `Sesión de asistencia cerrada (${to}).`);
      await assistanceRepository.closeRemoteSession(activeRemote.id);
      await assistanceRepository.createEvent({
        sessionId: id,
        type: 'REMOTE_SESSION',
        payload: { remoteSessionId: activeRemote.id, action: 'closed', reason: `assistance_${to.toLowerCase()}` },
        actorId: userId,
      });
    }
  }

  const dto = mapSession(updated);
  broadcastSessionStateChanged(dto);
  // También notificar a la cola cuando cambia a estado visible en ella
  broadcastQueueUpdated(dto);

  return { session: dto };
}

// ---------------------------------------------------------------------------
// GET /sessions/:id/events (participantes o SUPERVISOR)
// ---------------------------------------------------------------------------

async function listEvents(
  sessionId: string,
  page: number,
  pageSize: number,
  userId: string,
  role: string,
): Promise<PaginatedDto<AssistanceEventDto>> {
  const session = await requireSession(sessionId);
  assertParticipantOrSupervisor(session, userId, role);

  const { items, total } = await assistanceRepository.listEvents({ sessionId, page, pageSize });
  return toPaginated(items.map(mapEvent), total, page, pageSize);
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/notes (participantes o SUPERVISOR)
// ---------------------------------------------------------------------------

async function addNote(
  sessionId: string,
  input: AddNoteInput,
  userId: string,
  role: string,
): Promise<{ event: AssistanceEventDto }> {
  const session = await requireSession(sessionId);
  assertParticipantOrSupervisor(session, userId, role);

  const event = await assistanceRepository.createEvent({
    sessionId,
    type: 'NOTE',
    payload: { note: input.note },
    actorId: userId,
  });

  return { event: mapEvent(event) };
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/actions (AGENT asignado) — MOCK
// ---------------------------------------------------------------------------

async function requestAction(
  sessionId: string,
  input: RequestActionInput,
  userId: string,
): Promise<{ action: RemoteActionDto }> {
  const session = await requireSession(sessionId);

  // Solo el agente asignado
  if (session.agentId !== userId) {
    throw ApiError.forbidden('Solo el agente asignado puede ejecutar acciones.');
  }

  // La sesión debe estar ACTIVE
  if (session.status !== 'ACTIVE') {
    throw ApiError.conflict('Solo se pueden ejecutar acciones en sesiones ACTIVE.');
  }

  // Crear registro en PENDING
  const action = await assistanceRepository.createRemoteAction({
    sessionId,
    accountNumber: session.accountNumber,
    action: input.action as RemoteActionType,
    request: input.params ?? null,
    performedBy: userId,
  });

  await assistanceRepository.createEvent({
    sessionId,
    type: 'ACTION',
    payload: { actionId: action.id, actionType: input.action, request: input.params ?? null },
    actorId: userId,
  });

  const dto = mapRemoteAction(action);

  // Ejecutar la acción vía el conector ACS (mock o real según env) de forma
  // asíncrona (fire-and-forget) para devolver 202 inmediatamente.
  void executeAction(action.id, sessionId, input, session.accountNumber);

  return { action: dto };
}

/**
 * Ejecuta la acción vía el conector ACS (mock determinista o real según CONNECTOR_MODE).
 * Persiste PENDING → SUCCESS/FAILED en RemoteAction y emite ACTION_RESULT por WS.
 * 502 CONNECTOR_ERROR si el ACS no responde o el equipo no soporta la acción.
 */
async function executeAction(
  actionId: string,
  sessionId: string,
  input: RequestActionInput,
  accountNumber: string,
): Promise<void> {
  const acs = getAcsConnector();

  try {
    let result: Record<string, unknown>;

    switch (input.action) {
      case 'SET_WIFI': {
        /**
         * SET_WIFI se mapea a updateWifiConfig — no se duplica la lógica.
         * Params del contrato: { ssid?, password?, band? }
         */
        const bands: { band: WifiBand; ssid: string; password?: string }[] = [];
        if (input.params && typeof input.params === 'object') {
          const p = input.params as { ssid?: string; password?: string; band?: string };
          if (p.band && p.ssid) {
            bands.push({
              band: p.band as WifiBand,
              ssid: p.ssid,
              ...(p.password ? { password: p.password } : {}),
            });
          }
        }
        if (bands.length > 0) {
          const updated = await acs.updateWifiConfig(accountNumber, { bands });
          result = { success: true, config: updated };
        } else {
          result = { success: true, message: 'No se especificaron bandas para actualizar.' };
        }
        break;
      }

      case 'REBOOT': {
        const r = await acs.reboot(accountNumber);
        result = r as unknown as Record<string, unknown>;
        break;
      }

      case 'SET_CHANNEL': {
        const p = (input.params ?? {}) as { band?: string; channel?: number };
        if (!p.band || p.channel === undefined) {
          throw ApiError.validation(
            'SET_CHANNEL requiere los parámetros band y channel.',
          );
        }
        const r = await acs.setChannel(accountNumber, {
          band: p.band as WifiBand,
          channel: p.channel,
        });
        result = r as unknown as Record<string, unknown>;
        break;
      }

      case 'FACTORY_RESET': {
        const r = await acs.factoryReset(accountNumber);
        result = r as unknown as Record<string, unknown>;
        break;
      }

      case 'REPROVISION': {
        const r = await acs.reprovision(accountNumber);
        result = r as unknown as Record<string, unknown>;
        break;
      }

      case 'RUN_DIAGNOSTIC': {
        /**
         * Ejecuta ping/traceroute a través del conector ACS.
         * El resultado sigue el formato TR-143, compatible con los tipos de
         * PingTestDto y TracerouteDto del módulo /herramientas/v1.
         * Los parámetros { target, kind } son validados por el schema Zod antes
         * de llegar aquí, por lo que target y kind siempre están presentes.
         */
        const p = (input.params ?? {}) as { target?: string; kind?: 'ping' | 'traceroute' };
        if (!p.target || !p.kind) {
          throw ApiError.validation(
            'RUN_DIAGNOSTIC requiere los parámetros target y kind.',
          );
        }
        const r = await acs.runDiagnostic(accountNumber, { target: p.target, kind: p.kind });
        result = r as unknown as Record<string, unknown>;
        break;
      }

      default: {
        throw ApiError.validation(`Acción desconocida: ${input.action as string}.`);
      }
    }

    const updated = await assistanceRepository.updateRemoteActionResult(
      actionId,
      'SUCCESS',
      result,
    );
    broadcastActionResult(sessionId, mapRemoteAction(updated));
  } catch (err) {
    // Determinar si el error viene del conector (502) o es de validación (re-lanzar)
    if (err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
      // Error de parámetros — marcar como FAILED pero no 502
      const errorResult = {
        success: false,
        code: 'VALIDATION_ERROR',
        message: err.message,
      };
      try {
        const updated = await assistanceRepository.updateRemoteActionResult(
          actionId,
          'FAILED',
          errorResult,
        );
        broadcastActionResult(sessionId, mapRemoteAction(updated));
      } catch {
        // Si falla la actualización del resultado, ya no hay más que hacer.
      }
      return;
    }

    // Error de conector (ACS no responde, equipo sin soporte, notImplemented, etc.)
    const errorMessage =
      err instanceof Error
        ? err.message
        : 'El conector ACS no pudo ejecutar la acción.';

    const errorResult: Record<string, unknown> = {
      success: false,
      code: 'CONNECTOR_ERROR',
      message: errorMessage,
    };

    try {
      const updated = await assistanceRepository.updateRemoteActionResult(
        actionId,
        'FAILED',
        errorResult,
      );
      broadcastActionResult(sessionId, mapRemoteAction(updated));
    } catch {
      // Si falla la actualización del resultado, ya no hay más que hacer.
    }
  }
}

// ---------------------------------------------------------------------------
// GET /sessions/:id/actions (participantes o SUPERVISOR)
// ---------------------------------------------------------------------------

async function listActions(
  sessionId: string,
  page: number,
  pageSize: number,
  userId: string,
  role: string,
): Promise<PaginatedDto<RemoteActionDto>> {
  const session = await requireSession(sessionId);
  assertParticipantOrSupervisor(session, userId, role);

  const { items, total } = await assistanceRepository.listActions({ sessionId, page, pageSize });
  return toPaginated(items.map(mapRemoteAction), total, page, pageSize);
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/remote-sessions (AGENT asignado) — REAL (Fase D)
// ---------------------------------------------------------------------------

async function openRemoteSession(
  sessionId: string,
  input: OpenRemoteSessionInput,
  userId: string,
): Promise<{
  remoteSession: RemoteSessionDto;
  connect: { wsUrl: string; sessionToken: string; expiresAt: string };
  /**
   * Cabecera Set-Cookie lista para incluir en la respuesta HTTP.
   * El route handler debe pasarla al reply con reply.header('set-cookie', ...).
   * httpOnly + Secure + SameSite=Strict + Path acotado + Expires = expiresAt.
   */
  proxyCookieHeader: string;
}> {
  const session = await requireSession(sessionId);

  // Solo agente asignado
  if (session.agentId !== userId) {
    throw ApiError.forbidden('Solo el agente asignado puede abrir una sesión remota.');
  }

  // La sesión debe estar ACTIVE
  if (session.status !== 'ACTIVE') {
    throw ApiError.conflict('Solo se puede abrir sesión remota en sesiones ACTIVE.');
  }

  // Consentimiento obligatorio
  if (!session.consentAt) {
    throw ApiError.conflict(
      'No se puede abrir sesión remota sin consentimiento previo del cliente.',
    );
  }

  // No debe haber otra sesión remota abierta
  const existing = await assistanceRepository.findActiveRemoteSession(sessionId);
  if (existing) {
    throw ApiError.conflict('Ya existe una sesión remota abierta para esta sesión.');
  }

  // --- SSRF Guard: validar targetHost antes de persistir ---
  const ssrfResult = assertTargetHostAllowed(input.targetHost);
  if (!ssrfResult.ok) {
    throw ApiError.validation(
      `targetHost bloqueado por política de seguridad: ${ssrfResult.reason}`,
    );
  }
  const safeTargetHost = ssrfResult.target || null;

  const ttlSeconds = input.ttlSeconds ?? env.BROKER_DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const remoteSession = await assistanceRepository.createRemoteSession({
    sessionId,
    channel: input.channel,
    targetHost: safeTargetHost ?? undefined,
    expiresAt,
  });

  await assistanceRepository.createEvent({
    sessionId,
    type: 'REMOTE_SESSION',
    payload: {
      remoteSessionId: remoteSession.id,
      channel: input.channel,
      targetHost: safeTargetHost,
      action: 'opened',
    },
    actorId: userId,
  });

  // --- Emitir token de un solo uso firmado para el broker ---
  const tokenResult = await issueSessionToken(
    userId,
    sessionId,
    remoteSession.id,
    safeTargetHost,
    ttlSeconds,
  );

  // B-3: Construir el wsUrl desde la variable de entorno BROKER_PUBLIC_WS_URL.
  // Esto permite configurar el endpoint real en producción sin recompilar.
  const wsUrl = env.BROKER_PUBLIC_WS_URL;

  const connect = {
    wsUrl,
    sessionToken: tokenResult.jwt,
    expiresAt: tokenResult.expiresAt.toISOString(),
  };

  // --- Registrar timer de expiración automática ---
  scheduleExpiry(
    remoteSession.id,
    sessionId,
    tokenResult.jti,
    tokenResult.expiresAt.getTime(),
    {
      onExpire: async (rsId, sId) => {
        // Invalidar la cookie de sesión de proxy HTTP (Fase E) — sincrónico, sin await
        invalidateProxyCookieBySession(rsId);
        try {
          await assistanceRepository.expireRemoteSession(rsId);
          await assistanceRepository.createEvent({
            sessionId: sId,
            type: 'REMOTE_SESSION',
            payload: { remoteSessionId: rsId, action: 'expired' },
            actorId: null,
          });
          // Notificar cierre al túnel del técnico
          sendTunnelError(sId, 'SESSION_EXPIRED', 'La sesión remota ha expirado.');
        } catch {
          // Si la BD no está disponible, el cierre del túnel ya se realizó
        }
      },
      onBeforeExpire: (rsId, sId) => {
        // M-3: Log estructurado vía pino (moduleLogger) — no console.info en producción
        moduleLogger.info(
          { remoteSessionId: rsId, sessionId: sId },
          'Broker: expiración de sesión remota programada',
        );
      },
    },
  );

  const dto = mapRemoteSession(remoteSession);

  // Notificar a los participantes de la sesión por WS
  broadcastRemoteSessionReady(sessionId, dto, connect);

  // --- Emitir cookie de sesión de proxy HTTP (Fase E) ---
  // La cookie es httpOnly, SameSite=Strict, Path acotado al remoteSessionId.
  // El navegador del agente NUNCA ve el sessionToken del broker.
  // El targetHost queda fijado en el store server-side; el agente no puede cambiarlo.
  const proxyCookieValue = issueProxyCookie({
    remoteSessionId: remoteSession.id,
    sessionId,
    agentId: userId,
    targetHost: safeTargetHost ?? '',
    expiresAt: tokenResult.expiresAt.getTime(),
  });

  const proxyCookieHeader = buildProxyCookieSetHeader(
    proxyCookieValue,
    remoteSession.id,
    tokenResult.expiresAt,
  );

  return { remoteSession: dto, connect, proxyCookieHeader };
}

// ---------------------------------------------------------------------------
// POST /remote-sessions/:id/close (AGENT asignado o SUPERVISOR)
// ---------------------------------------------------------------------------

async function closeRemoteSession(
  remoteSessionId: string,
  userId: string,
  role: string,
): Promise<{ remoteSession: RemoteSessionDto }> {
  const remoteSession = await assistanceRepository.findRemoteSessionById(remoteSessionId);
  if (!remoteSession) {
    throw ApiError.notFound('Sesión remota no encontrada.');
  }

  // Verificar que el usuario tiene acceso a la sesión padre
  const session = await requireSession(remoteSession.sessionId);
  assertAssignedAgentOrSupervisor(session, userId, role);

  // Cancelar el timer de expiración automática
  cancelExpiry(remoteSessionId);

  // Invalidar la cookie de sesión de proxy HTTP (Fase E)
  invalidateProxyCookieBySession(remoteSessionId);

  // Cerrar el túnel del técnico (si está activo)
  sendTunnelError(remoteSession.sessionId, 'SESSION_CLOSED', 'La sesión remota fue cerrada.');

  const closed = await assistanceRepository.closeRemoteSession(remoteSessionId);

  await assistanceRepository.createEvent({
    sessionId: remoteSession.sessionId,
    type: 'REMOTE_SESSION',
    payload: { remoteSessionId, action: 'closed', closedBy: userId },
    actorId: userId,
  });

  return { remoteSession: mapRemoteSession(closed) };
}

// ---------------------------------------------------------------------------
// POST /sessions/:id/video (participantes) — REAL Jitsi (Fase D)
// ---------------------------------------------------------------------------

async function provisionVideo(
  sessionId: string,
  userId: string,
  role: string,
): Promise<{ roomName: string; domain: string; jwt: string }> {
  const session = await requireSession(sessionId);
  assertParticipantOrSupervisor(session, userId, role);

  // Provisionar la sala Jitsi real y firmar el JWT de sala
  // El userId es el claim `sub`; name y email se toman del JWT de auth pero
  // el servicio solo recibe userId + role, así que construimos un display name
  // a partir del rol para no requerir lookup a BD.
  const displayName =
    role === 'TECHNICIAN' ? 'Técnico Wifix' : role === 'AGENT' ? 'Agente Call Center' : 'Supervisor';

  // Rol explícito por perfil: AGENT/SUPERVISOR son moderadores de la sala;
  // TECHNICIAN opera el equipo en campo pero no modera la llamada.
  const jitsiResult = await provisionJitsiRoom(sessionId, {
    id: userId,
    name: displayName,
    email: `${role.toLowerCase()}@wifix.internal`,
    role: role as JitsiParticipantRole,
  });

  // Persistir el videoRoom como evento (idempotente — solo si no existe)
  const existing = await assistanceRepository.findVideoRoom(sessionId);
  if (!existing) {
    await assistanceRepository.createEvent({
      sessionId,
      type: 'REMOTE_SESSION',
      payload: { kind: 'video', roomName: jitsiResult.roomName, domain: jitsiResult.domain },
      actorId: userId,
    });
  }

  return {
    roomName: jitsiResult.roomName,
    domain: jitsiResult.domain,
    jwt: jitsiResult.jwt,
  };
}

// ---------------------------------------------------------------------------
// Exportaciones
// ---------------------------------------------------------------------------

export const assistanceService = {
  createSession,
  listSessions,
  getSessionDetail,
  assignSession,
  changeStatus,
  listEvents,
  addNote,
  requestAction,
  listActions,
  openRemoteSession,
  closeRemoteSession,
  provisionVideo,
};
