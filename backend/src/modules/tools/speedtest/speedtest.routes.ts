import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { listFiltersSchema } from '../../../schemas/filters.js';
import { getAuthUser } from '../../../middleware/authenticate.js';
import { speedtestInputSchema } from './speedtest.schemas.js';
import { speedtestService } from './speedtest.service.js';

export async function registerSpeedtestRoutes(app: FastifyInstance): Promise<void> {
  app.post('/speedtests', async (request, reply) => {
    const body = parseBody(speedtestInputSchema, request.body);
    body.technicianId = getAuthUser(request).id;
    const dto = await speedtestService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/speedtests', async (request) => {
    const filters = parseQuery(listFiltersSchema, request.query);
    return speedtestService.list(filters);
  });

  app.get('/speedtests/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return speedtestService.getById(id);
  });
}
