import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { listFiltersSchema } from '../../../schemas/filters.js';
import { heatmapInputSchema } from './heatmap.schemas.js';
import { heatmapService } from './heatmap.service.js';

export async function registerHeatmapRoutes(app: FastifyInstance): Promise<void> {
  app.post('/wifi-heatmaps', async (request, reply) => {
    const body = parseBody(heatmapInputSchema, request.body);
    const dto = await heatmapService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/wifi-heatmaps', async (request) => {
    const filters = parseQuery(listFiltersSchema, request.query);
    return heatmapService.list(filters);
  });

  app.get('/wifi-heatmaps/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return heatmapService.getById(id);
  });
}
