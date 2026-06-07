/**
 * Rutas del módulo Asistencia Técnica — prefijo /asistencia/v1
 * Fase B: lógica real en todos los endpoints salvo /study y /tickets (Fase C/F).
 *
 * El WebSocket (/asistencia/v1/ws) está registrado en assistance.ws.ts
 * y se registra desde app.ts junto con este archivo.
 */
import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { requireRole, getAuthUser } from '../../middleware/authenticate.js';
import {
  createSessionSchema,
  listSessionsSchema,
  changeStatusSchema,
  addNoteSchema,
  openRemoteSessionSchema,
  requestActionSchema,
  createOperatorTicketSchema,
  applyRemediationSchema,
  uuidParamSchema,
  paginationOnlySchema,
} from './assistance.schemas.js';
import { assistanceService } from './assistance.service.js';
import { getStudyOverview } from './study.service.js';
import { createOperatorTicket } from './tickets.service.js';
import { getAutoAssistAnalysis, applyRemediation } from './auto-assist.service.js';
import { remoteSessionRateLimitConfig } from './broker/broker.rate-limit.js';

export async function registerAssistanceRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Health propio del módulo
  // -------------------------------------------------------------------------
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      module: 'assistance',
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------------------
  // Sesiones — POST /sessions
  // Rol: TECHNICIAN
  // -------------------------------------------------------------------------
  app.post('/sessions', async (request, reply) => {
    const actor = requireRole(request, 'TECHNICIAN');
    const body = parseBody(createSessionSchema, request.body);
    const result = await assistanceService.createSession(body, actor.id);
    return reply.code(201).send(result);
  });

  // -------------------------------------------------------------------------
  // Cola — GET /sessions
  // Rol: AGENT | SUPERVISOR
  // -------------------------------------------------------------------------
  app.get('/sessions', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    const query = parseQuery(listSessionsSchema, request.query);
    const result = await assistanceService.listSessions(query);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Detalle — GET /sessions/:id
  // Rol: participantes o SUPERVISOR
  // -------------------------------------------------------------------------
  app.get('/sessions/:id', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await assistanceService.getSessionDetail(id, actor.id, actor.role);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Asignar — POST /sessions/:id/assign
  // Rol: AGENT
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/assign', async (request, reply) => {
    const actor = requireRole(request, 'AGENT');
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await assistanceService.assignSession(id, actor.id);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Transición de estado — POST /sessions/:id/status
  // Rol: AGENT asignado | SUPERVISOR
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/status', async (request, reply) => {
    const actor = requireRole(request, 'AGENT', 'SUPERVISOR');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(changeStatusSchema, request.body);
    const result = await assistanceService.changeStatus(id, body, actor.id, actor.role);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Timeline — GET /sessions/:id/events
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/events', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const query = parseQuery(paginationOnlySchema, request.query);
    const result = await assistanceService.listEvents(
      id,
      query.page,
      query.pageSize,
      actor.id,
      actor.role,
    );
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Nota — POST /sessions/:id/notes
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/notes', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(addNoteSchema, request.body);
    const result = await assistanceService.addNote(id, body, actor.id, actor.role);
    return reply.code(201).send(result);
  });

  // -------------------------------------------------------------------------
  // Acciones ACS — POST /sessions/:id/actions
  // Fase C: conector real (mock determinista o real según CONNECTOR_MODE)
  // Rol: AGENT asignado; sesión ACTIVE; respuesta 202 + ACTION_RESULT por WS
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/actions', async (request, reply) => {
    const actor = requireRole(request, 'AGENT');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(requestActionSchema, request.body);
    const result = await assistanceService.requestAction(id, body, actor.id);
    return reply.code(202).send(result);
  });

  // -------------------------------------------------------------------------
  // Listar acciones — GET /sessions/:id/actions
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/actions', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const query = parseQuery(paginationOnlySchema, request.query);
    const result = await assistanceService.listActions(
      id,
      query.page,
      query.pageSize,
      actor.id,
      actor.role,
    );
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Sesión remota — POST /sessions/:id/remote-sessions
  // Rol: AGENT asignado
  // Rate-limit: BROKER_RATE_LIMIT_MAX por IP en BROKER_RATE_LIMIT_WINDOW_MS.
  // Emite una cookie de sesión de proxy httpOnly acotada al remoteSessionId
  // para que el navegador del agente pueda navegar el panel del router sin
  // necesitar el sessionToken del broker (Fase E).
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/remote-sessions', {
    config: { rateLimit: remoteSessionRateLimitConfig },
  }, async (request, reply) => {
    const actor = requireRole(request, 'AGENT');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(openRemoteSessionSchema, request.body);
    const result = await assistanceService.openRemoteSession(id, body, actor.id);
    // Emitir cookie de proxy: httpOnly, SameSite=Strict, Path acotado.
    // El navegador la almacena y la envía automáticamente en cada request al proxy.
    reply.header('set-cookie', result.proxyCookieHeader);
    // No incluir proxyCookieHeader en el body JSON (el agente no necesita verla)
    const { proxyCookieHeader: _dropped, ...responseBody } = result;
    return reply.code(201).send(responseBody);
  });

  // -------------------------------------------------------------------------
  // Cerrar sesión remota — POST /remote-sessions/:id/close
  // Rol: AGENT | SUPERVISOR
  // -------------------------------------------------------------------------
  app.post('/remote-sessions/:id/close', async (request, reply) => {
    const actor = requireRole(request, 'AGENT', 'SUPERVISOR');
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await assistanceService.closeRemoteSession(id, actor.id, actor.role);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Video Jitsi — POST /sessions/:id/video (MOCK)
  // Participantes o SUPERVISOR
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/video', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await assistanceService.provisionVideo(id, actor.id, actor.role);
    return reply.code(201).send(result);
  });

  // -------------------------------------------------------------------------
  // Estudio WiFi — GET /sessions/:id/study (Fase F — REAL)
  // Auth: participantes o SUPERVISOR
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/study', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await getStudyOverview(id, actor.id, actor.role);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Ticket de operadora — POST /sessions/:id/tickets (Fase F — REAL)
  // Auth: AGENT asignado o SUPERVISOR. Síncrono → 502 si la operadora falla.
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/tickets', async (request, reply) => {
    const actor = requireRole(request, 'AGENT', 'SUPERVISOR');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(createOperatorTicketSchema, request.body);
    const result = await createOperatorTicket(id, body, actor.id, actor.role);
    return reply.code(201).send(result);
  });

  // -------------------------------------------------------------------------
  // Auto-asistencia — GET /sessions/:id/auto-assist (Fase F)
  // Devuelve causas detectadas + remediaciones propuestas. NO aplica nada.
  // Auth: participantes o SUPERVISOR.
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/auto-assist', async (request, reply) => {
    const actor = getAuthUser(request);
    const { id } = parseParams(uuidParamSchema, request.params);
    const result = await getAutoAssistAnalysis(id, actor.id, actor.role);
    return reply.send(result);
  });

  // -------------------------------------------------------------------------
  // Auto-asistencia — POST /sessions/:id/auto-assist/apply (Fase F)
  // Aplica una remediación propuesta.
  // Auth: AGENT asignado; sesión ACTIVE; consentAt obligatorio.
  // 409 si no hay consentimiento. 502 si el conector falla.
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/auto-assist/apply', async (request, reply) => {
    const actor = requireRole(request, 'AGENT');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(applyRemediationSchema, request.body);
    const result = await applyRemediation(id, body, actor.id);
    return reply.code(200).send(result);
  });
}
