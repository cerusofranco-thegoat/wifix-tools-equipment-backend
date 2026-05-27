import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams } from '../../lib/validation.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import { getComarchConnector } from '../../connectors/index.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

const clientProfileUpdateSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    phones: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (v) => v.fullName !== undefined || v.address !== undefined || v.phones !== undefined,
    { message: 'Indica al menos un campo a actualizar (fullName, address o phones).' },
  );

export async function registerClientDataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/client-profile', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getComarchConnector().getClientProfile(accountNumber);
  });

  app.put('/accounts/:accountNumber/client-profile', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(clientProfileUpdateSchema, request.body);
    const user = getAuthUser(request);
    request.log.info(
      { user: user.id, accountNumber, action: 'updateClientProfile', fields: Object.keys(body) },
      'PUT client-profile',
    );
    return getComarchConnector().updateClientProfile(accountNumber, body);
  });

  app.get('/accounts/:accountNumber/contract-status', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getComarchConnector().getContractStatus(accountNumber);
  });
}
