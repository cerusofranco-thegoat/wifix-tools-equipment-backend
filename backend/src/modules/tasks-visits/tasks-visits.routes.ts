// Campos 15 y 16 — tareas insatisfactorias, visitas anteriores y notas.
//
// Reparto de llamadas (ver ADR-06):
//   previous-visits      → 1 llamada, sin notas (`notesLoaded:false`).
//   workorders/tasks     → 1 llamada, al expandir una visita concreta.
//   unsatisfactory-tasks → 1 + como mucho `FSM_ORDERS_MAX_FANOUT` llamadas.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseParams, parseQuery } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { env } from '../../config/env.js';
import { getFsmConnector } from '../../connectors/index.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

const brandQuerySchema = z.object({
  brand: z.string().optional(),
});

const unsatisfactoryQuerySchema = brandQuerySchema.extend({
  limit: z.coerce.number().int().gte(1).lte(10).optional(),
});

const ordersQuerySchema = brandQuerySchema.extend({
  estado: z.enum(['Todas', 'Pendientes']).optional(),
});

/**
 * `workOrder` va por QUERY, no por path: el valor es `ORDER/424900/2026` y las
 * barras rompen el ruteo aunque se codifiquen como `%2F` (Fastify y varios
 * proxies las normalizan).
 */
const workOrderQuerySchema = brandQuerySchema.extend({
  workOrder: z
    .string()
    .min(1, 'workOrder es obligatorio.')
    .max(120, 'workOrder excede 120 caracteres.'),
});

export async function registerTasksVisitsRoutes(app: FastifyInstance): Promise<void> {
  // --- Campo 15: tareas cerradas de forma insatisfactoria -------------------
  app.get('/accounts/:accountNumber/unsatisfactory-tasks', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand, limit } = parseQuery(unsatisfactoryQuerySchema, request.query);
    return getFsmConnector().getUnsatisfactoryTasks(accountNumber, {
      brand: brandFromRequest(request, brand),
      limit: limit ?? env.FSM_ORDERS_MAX_FANOUT,
    });
  });

  // --- Campo 16: visitas anteriores (sin notas) -----------------------------
  app.get('/accounts/:accountNumber/previous-visits', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand } = parseQuery(brandQuerySchema, request.query);
    return getFsmConnector().getPreviousVisits(accountNumber, {
      brand: brandFromRequest(request, brand),
    });
  });

  // --- Órdenes crudas de la cuenta (base de los campos 1-3, 15 y 16) --------
  app.get('/accounts/:accountNumber/orders', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const { brand, estado } = parseQuery(ordersQuerySchema, request.query);
    return getFsmConnector().getAccountOrders(accountNumber, {
      brand: brandFromRequest(request, brand),
      estado: estado ?? 'Todas',
    });
  });

  // --- Notas de una orden concreta ------------------------------------------
  app.get('/workorders/tasks', async (request) => {
    const { workOrder, brand } = parseQuery(workOrderQuerySchema, request.query);
    return getFsmConnector().getWorkOrderTasks(workOrder, {
      brand: brandFromRequest(request, brand),
    });
  });
}
