/**
 * Rutas del módulo Asistencia Técnica — prefijo /asistencia/v1
 * Fase 0: handlers en stub. Devuelven 501 con mensaje claro.
 * La lógica de negocio se implementa a partir de la Fase B.
 *
 * El WebSocket (/asistencia/v1/ws) está registrado en assistance.ws.ts
 * y se registra desde app.ts junto con este archivo.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { requireRole } from '../../middleware/authenticate.js';
import {
  createSessionSchema,
  listSessionsSchema,
  changeStatusSchema,
  addNoteSchema,
  openRemoteSessionSchema,
  requestActionSchema,
  createOperatorTicketSchema,
  uuidParamSchema,
} from './assistance.schemas.js';

/** Respuesta de stub uniforme para endpoints aún no implementados */
async function notImplemented(reply: FastifyReply): Promise<void> {
  await reply.code(501).send({
    code: 'NOT_IMPLEMENTED',
    message: 'Este endpoint se implementa en la Fase B.',
  });
}

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
    requireRole(request, 'TECHNICIAN');
    parseBody(createSessionSchema, request.body);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Cola — GET /sessions
  // Rol: AGENT | SUPERVISOR
  // -------------------------------------------------------------------------
  app.get('/sessions', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    parseQuery(listSessionsSchema, request.query);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Detalle — GET /sessions/:id
  // Rol: participantes o SUPERVISOR (la verificación fina va en Fase B)
  // -------------------------------------------------------------------------
  app.get('/sessions/:id', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Asignar — POST /sessions/:id/assign
  // Rol: AGENT
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/assign', async (request, reply) => {
    requireRole(request, 'AGENT');
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Transición de estado — POST /sessions/:id/status
  // Rol: AGENT asignado | SUPERVISOR (la verificación fina va en Fase B)
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/status', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    parseParams(uuidParamSchema, request.params);
    parseBody(changeStatusSchema, request.body);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Timeline — GET /sessions/:id/events
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/events', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Nota — POST /sessions/:id/notes
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/notes', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    parseBody(addNoteSchema, request.body);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Acciones ACS — POST /sessions/:id/actions
  // Rol: AGENT
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/actions', async (request, reply) => {
    requireRole(request, 'AGENT');
    parseParams(uuidParamSchema, request.params);
    parseBody(requestActionSchema, request.body);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Listar acciones — GET /sessions/:id/actions
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/actions', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Sesión remota — POST /sessions/:id/remote-sessions
  // Rol: AGENT
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/remote-sessions', async (request, reply) => {
    requireRole(request, 'AGENT');
    parseParams(uuidParamSchema, request.params);
    parseBody(openRemoteSessionSchema, request.body);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Cerrar sesión remota — POST /remote-sessions/:id/close
  // Rol: AGENT | SUPERVISOR
  // -------------------------------------------------------------------------
  app.post('/remote-sessions/:id/close', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Video Jitsi — POST /sessions/:id/video
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/video', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Estudio WiFi — GET /sessions/:id/study
  // -------------------------------------------------------------------------
  app.get('/sessions/:id/study', async (request, reply) => {
    parseParams(uuidParamSchema, request.params);
    return notImplemented(reply);
  });

  // -------------------------------------------------------------------------
  // Ticket de operadora — POST /sessions/:id/tickets
  // Rol: AGENT | SUPERVISOR
  // -------------------------------------------------------------------------
  app.post('/sessions/:id/tickets', async (request, reply) => {
    requireRole(request, 'AGENT', 'SUPERVISOR');
    parseParams(uuidParamSchema, request.params);
    parseBody(createOperatorTicketSchema, request.body);
    return notImplemented(reply);
  });
}
