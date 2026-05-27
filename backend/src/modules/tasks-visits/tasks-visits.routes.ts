import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseParams } from '../../lib/validation.js';
import { getFsmConnector } from '../../connectors/index.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

export async function registerTasksVisitsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/unsatisfactory-tasks', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getFsmConnector().getUnsatisfactoryTasks(accountNumber);
  });

  app.get('/accounts/:accountNumber/previous-visits', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getFsmConnector().getPreviousVisits(accountNumber);
  });
}
