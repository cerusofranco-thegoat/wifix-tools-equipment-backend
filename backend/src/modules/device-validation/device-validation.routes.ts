import type { FastifyInstance } from 'fastify';
import { parseBody, parseParams, parseQuery } from '../../lib/validation.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import {
  accountParamsSchema,
  deviceValidationInputSchema,
  deviceValidationListQuerySchema,
} from './device-validation.schemas.js';
import { deviceValidationService } from './device-validation.service.js';

export async function registerDeviceValidationRoutes(app: FastifyInstance): Promise<void> {
  // Catálogo de equipos homologados (solo activos).
  app.get('/device-catalog', async () => deviceValidationService.listCatalog());

  // Validación del equipo a instalar (append-only). Un `blocked` es una alerta.
  app.post('/accounts/:accountNumber/device-validations', async (request, reply) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(deviceValidationInputSchema, request.body);
    const user = getAuthUser(request);
    const dto = await deviceValidationService.create(accountNumber, body, {
      id: user.id,
      email: user.email,
      name: user.name,
    });
    if (dto.result !== 'ok') {
      // Sin serial ni cuenta en el log: el id basta para ubicar la alerta.
      request.log.warn(
        {
          validationId: dto.id,
          result: dto.result,
          category: dto.category,
          reasons: dto.reasons.map((r) => r.kind),
        },
        'Validación de equipo con alerta',
      );
    }
    return reply.code(201).send(dto);
  });

  app.get('/accounts/:accountNumber/device-validations', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return deviceValidationService.listByAccount(accountNumber);
  });

  // Vista de gerente (sin UI por ahora): alertas filtrables por resultado y fecha.
  app.get('/device-validations', async (request) => {
    const query = parseQuery(deviceValidationListQuerySchema, request.query);
    return deviceValidationService.list(query);
  });
}
