// Órdenes (TYTAN SIMULADO).
//
//   GET /orders/context?workOrder=ORDER/463158/2026
//   GET /orders/task-check?workOrder=ORDER/463158/2026&taskId=TASK/549487/2026
//
// `workOrder` y `taskId` van SIEMPRE como query param (llevan barras). Ambos
// aceptan solo los dígitos (se completa el año actual). Formato inválido → 400.
// Autenticadas como el resto de /herramientas/v1 (hook global).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseQuery } from '../../lib/validation.js';
import { checkTask, getOrderContext } from './orders.service.js';

const idParam = (field: string) =>
  z
    .string({ required_error: `${field} es obligatorio.` })
    .trim()
    .min(1, `${field} es obligatorio.`)
    .max(120, `${field} no puede superar 120 caracteres.`);

export const orderContextQuerySchema = z.object({ workOrder: idParam('workOrder') });

export const taskCheckQuerySchema = z.object({
  workOrder: idParam('workOrder'),
  taskId: idParam('taskId'),
});

export async function registerOrdersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orders/context', async (request) => {
    const { workOrder } = parseQuery(orderContextQuerySchema, request.query);
    return getOrderContext(workOrder);
  });

  app.get('/orders/task-check', async (request) => {
    const { workOrder, taskId } = parseQuery(taskCheckQuerySchema, request.query);
    return checkTask(workOrder, taskId);
  });
}
