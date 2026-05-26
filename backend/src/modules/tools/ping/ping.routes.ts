import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { listFiltersSchema } from '../../../schemas/filters.js';
import { getAuthUser } from '../../../middleware/authenticate.js';
import { pingInputSchema } from './ping.schemas.js';
import { pingService } from './ping.service.js';

export async function registerPingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/ping-tests', async (request, reply) => {
    const body = parseBody(pingInputSchema, request.body);
    body.technicianId = getAuthUser(request).id;
    const dto = await pingService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/ping-tests', async (request) => {
    const filters = parseQuery(listFiltersSchema, request.query);
    return pingService.list(filters);
  });

  app.get('/ping-tests/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return pingService.getById(id);
  });
}
