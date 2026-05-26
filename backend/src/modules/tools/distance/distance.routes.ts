import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { listFiltersSchema } from '../../../schemas/filters.js';
import { getAuthUser } from '../../../middleware/authenticate.js';
import { distanceInputSchema } from './distance.schemas.js';
import { distanceService } from './distance.service.js';

export async function registerDistanceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/distance-measurements', async (request, reply) => {
    const body = parseBody(distanceInputSchema, request.body);
    body.technicianId = getAuthUser(request).id;
    const dto = await distanceService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/distance-measurements', async (request) => {
    const filters = parseQuery(listFiltersSchema, request.query);
    return distanceService.list(filters);
  });

  app.get('/distance-measurements/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return distanceService.getById(id);
  });
}
