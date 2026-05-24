import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseParams, parseQuery } from '../../lib/validation.js';
import { dateRangeSchema } from '../../schemas/filters.js';
import { accountHistoryService } from './account-history.service.js';

const paramsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

export async function registerAccountHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/tool-history', async (request) => {
    const { accountNumber } = parseParams(paramsSchema, request.params);
    const { dateFrom, dateTo } = parseQuery(dateRangeSchema, request.query);
    return accountHistoryService.get({ accountNumber, dateFrom, dateTo });
  });
}
