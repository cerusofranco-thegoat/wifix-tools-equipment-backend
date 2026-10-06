// Contexto de una orden y validación de tarea — TYTAN SIMULADO.
//
// La cuenta sale de `resolveOrderAccount` (la MISMA función del lookup por
// orden), así que `/orders/context` y `/accounts/lookup {order}` siempre
// coinciden. No se mezcla con el conector FSM real: todo esto es simulado y va
// etiquetado `simulated: true, source: "TYTAN"`.
//
// TODO(tytan-real): leer la orden de TYTAN (cabecera, tareas, cierres,
// materiales y equipos) cuando la operadora entregue el endpoint.

import { resolveOrderAccount } from '../account-lookup/account-lookup.service.js';
import { buildOrderContext, type OrderContext, type OrderTask } from './orders.generator.js';
import { normalizeTaskId, normalizeWorkOrder } from './order-ids.js';

export type TaskCheckResult =
  | { valid: true; taskId: string; workOrder: string; task: OrderTask; simulated: true }
  | { valid: false; reason: 'TASK_NOT_IN_ORDER'; taskId: string; workOrder: string; simulated: true };

export async function getOrderContext(rawWorkOrder: string, now: Date = new Date()): Promise<OrderContext> {
  const workOrder = normalizeWorkOrder(rawWorkOrder, 'workOrder', now);
  const { account } = await resolveOrderAccount(workOrder);
  return buildOrderContext(workOrder, account, now);
}

/** La tarea es válida si está en `tasks` del contexto (la "Pendiente" es la de hoy). */
export async function checkTask(
  rawWorkOrder: string,
  rawTaskId: string,
  now: Date = new Date(),
): Promise<TaskCheckResult> {
  // Ambos formatos se validan ANTES de tocar la base: un formato inválido es 400.
  const workOrder = normalizeWorkOrder(rawWorkOrder, 'workOrder', now);
  const taskId = normalizeTaskId(rawTaskId, 'taskId', now);
  const context = await getOrderContext(workOrder, now);
  const task = context.tasks.find((t) => t.taskId === taskId);
  if (!task) return { valid: false, reason: 'TASK_NOT_IN_ORDER', taskId, workOrder, simulated: true };
  return { valid: true, taskId, workOrder, task, simulated: true };
}
