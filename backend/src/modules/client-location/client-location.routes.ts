import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import {
  accountParamsSchema,
  clientLocationInputSchema,
  clientLocationListQuerySchema,
} from './client-location.schemas.js';
import { clientLocationService } from './client-location.service.js';

export async function registerClientLocationRoutes(app: FastifyInstance): Promise<void> {
  // Captura "Casa cliente" (append-only). Nunca se loguean las coordenadas.
  app.post('/accounts/:accountNumber/client-location', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(clientLocationInputSchema, request.body);
    const user = getAuthUser(request);
    const dto = await clientLocationService.create(
      accountNumber,
      body,
      { id: user.id, email: user.email },
      brandFromRequest(request),
    );
    return reply.code(201).send(dto);
  });

  app.get('/accounts/:accountNumber/client-location', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return clientLocationService.listByAccount(accountNumber, brandFromRequest(request));
  });

  // Vista de gerente (se construirá después): lista paginada de capturas.
  app.get('/client-locations', async (request) => {
    const query = parseQuery(clientLocationListQuerySchema, request.query);
    return clientLocationService.list(query);
  });
}
