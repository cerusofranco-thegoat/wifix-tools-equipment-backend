import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams } from '../../../lib/validation.js';
import { uuidParamSchema } from '../../../schemas/common.js';
import { z } from 'zod';
import {
  wifiAccessPointInputSchema,
  wifiAccessPointUpdateSchema,
} from './access-points.schemas.js';
import { accessPointsService } from './access-points.service.js';

const accountParamSchema = z.object({
  accountNumber: z.string().min(1),
});

export async function registerAccessPointsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/wifi-access-points', async (request) => {
    const { accountNumber } = parseParams(accountParamSchema, request.params);
    return accessPointsService.listByAccount(accountNumber);
  });

  app.post('/accounts/:accountNumber/wifi-access-points', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamSchema, request.params);
    const body = parseBody(wifiAccessPointInputSchema, request.body);
    const { dto, created } = await accessPointsService.upsertForAccount(accountNumber, body);
    return reply.code(created ? 201 : 200).send(dto);
  });

  app.patch('/wifi-access-points/:id', async (request) => {
    const { id } = parseParams(uuidParamSchema, request.params);
    const body = parseBody(wifiAccessPointUpdateSchema, request.body);
    return accessPointsService.update(id, body);
  });
}
