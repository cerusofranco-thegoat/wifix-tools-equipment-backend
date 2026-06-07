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
  uuidParamSchema,
  paginationOnlySchema,
} from './assistance.schemas.js';
import { assistanceService } from './assistance.service.js';

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
  // Acciones ACS — POST /sessions/:id/actions (MOCK)
  // Rol: AGENT asignado
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
  // Sesión remota — POST /sessions/:id/remote-sessions (MOCK)
  // Rol: AGENT asignado
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/remote-sessions', async (request, reply) => {
    const actor = requireRole(request, 'AGENT');
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(openRemoteSessionSchema, request.body);
    const result = await assistanceService.openRemoteSession(id, body, actor.id);
    return reply.code(201).send(result);
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
  // Estudio WiFi — GET /sessions/:id/study
  // Fase C/F — stub 501
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/study', async (_request, reply) => {
    return reply.code(501).send({
      code: 'NOT_IMPLEMENTED',
      message: 'Este endpoint se implementa en la Fase C/F.',
    });
  });

  // -------------------------------------------------------------------------
  // Ticket de operadora — POST /sessions/:id/tickets
  // Fase C/F — stub 501
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/tickets', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    parseParams(uuidParamSchema, request.params);
    parseBody(createOperatorTicketSchema, request.body);
    return reply.code(501).send({
      code: 'NOT_IMPLEMENTED',
      message: 'Este endpoint se implementa en la Fase F.',
    });
  });
}
