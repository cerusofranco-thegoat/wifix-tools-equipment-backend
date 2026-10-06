import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import { accountParamsSchema } from '../client-location/client-location.schemas.js';
import { napAssignmentInputSchema, napAssignmentListQuerySchema } from './nap-assignment.schemas.js';
import { napAssignmentService } from './nap-assignment.service.js';

export async function registerNapAssignmentRoutes(app: FastifyInstance): Promise<void> {
  // NAP elegida en Instalación (append-only). Nunca se loguean las coordenadas.
  app.post('/accounts/:accountNumber/nap-assignment', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(napAssignmentInputSchema, request.body);
    const user = getAuthUser(request);
    const dto = await napAssignmentService.create(accountNumber, body, user.id);
    return reply.code(201).send(dto);
  });

  app.get('/accounts/:accountNumber/nap-assignment', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return napAssignmentService.listByAccount(accountNumber);
  });

  // Vista de gerente (sin UI todavía): todas las elecciones, por cursor.
  app.get('/nap-assignments', async (request) => {
    const query = parseQuery(napAssignmentListQuerySchema, request.query);
    return napAssignmentService.list(query);
  });
}
