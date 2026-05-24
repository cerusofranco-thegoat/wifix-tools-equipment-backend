import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { uuidParamSchema } from '../../schemas/common.js';
import {
  retiredEquipmentInputSchema,
  retiredEquipmentFiltersSchema,
} from './retired-equipment.schemas.js';
import { retiredEquipmentService } from './retired-equipment.service.js';

export async function registerRetiredEquipmentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/retired-equipment', async (request, reply) => {
    const body = parseBody(retiredEquipmentInputSchema, request.body);
    const dto = await retiredEquipmentService.create(body);
    return reply.code(201).send(dto);
  });

  app.get('/retired-equipment', async (request) => {
    const filters = parseQuery(retiredEquipmentFiltersSchema, request.query);
    return retiredEquipmentService.list(filters);
  });

  app.get('/retired-equipment/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    return retiredEquipmentService.getById(id);
  });
}
