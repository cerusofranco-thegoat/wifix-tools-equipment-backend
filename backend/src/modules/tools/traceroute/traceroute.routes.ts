import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { listFiltersSchema } from '../../../schemas/filters.js';
import { tracerouteInputSchema } from './traceroute.schemas.js';
import { tracerouteService } from './traceroute.service.js';

export async function registerTracerouteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/traceroute-tests', async (request, reply) => {
    const body = parseBody(tracerouteInputSchema, request.body);
    const dto = await tracerouteService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/traceroute-tests', async (request) => {
    const filters = parseQuery(listFiltersSchema, request.query);
    return tracerouteService.list(filters);
  });

  app.get('/traceroute-tests/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return tracerouteService.getById(id);
  });
}
