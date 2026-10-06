// Normalización de nº de orden (`ORDER/463158/2026`) y de tarea
// (`TASK/549487/2026`). Compartido por /accounts/lookup (by order) y /orders/*.
//
// Ambos aceptan "solo los dígitos": se completan con el año ACTUAL de Ecuador
// (UTC-5, sin horario de verano). Formato inválido → 400 VALIDATION_ERROR.

import { ApiError } from '../../middleware/error-handler.js';

const ECUADOR_OFFSET_MS = 5 * 3600_000;

/** Año calendario actual en Ecuador. */
export function currentEcuadorYear(now: Date = new Date()): number {
  return new Date(now.getTime() - ECUADOR_OFFSET_MS).getUTCFullYear();
}

const ORDER_FULL = /^ORDER\s*\/\s*(\d{4,10})\s*\/\s*(\d{4})$/i;
const ORDER_DIGITS = /^\d{4,10}$/;
const TASK_FULL = /^TASK\s*\/\s*(\d{6,7})\s*\/\s*(\d{4})$/i;
const TASK_DIGITS = /^\d{6,7}$/;

function validYear(year: number): boolean {
  return year >= 2000 && year <= 2100;
}

function invalid(field: string, message: string): ApiError {
  return ApiError.validation(message, [{ field, issue: 'Formato inválido.' }]);
}

/**
 * `ORDER/463158/2026` | `order/463158/2026` | `463158` → `ORDER/463158/2026`.
 * Los ceros a la izquierda del número se respetan tal cual.
 */
export function normalizeWorkOrder(raw: string, field = 'order', now: Date = new Date()): string {
  const value = raw.trim();
  if (ORDER_DIGITS.test(value)) return `ORDER/${value}/${currentEcuadorYear(now)}`;
  const m = ORDER_FULL.exec(value);
  if (m && validYear(Number(m[2]))) return `ORDER/${m[1]}/${m[2]}`;
  throw invalid(field, 'Número de orden inválido: usa ORDER/<número>/<año> o solo el número (4 a 10 dígitos).');
}

/** `TASK/549487/2026` | `549487` → `TASK/549487/2026` (6 o 7 dígitos). */
export function normalizeTaskId(raw: string, field = 'taskId', now: Date = new Date()): string {
  const value = raw.trim();
  if (TASK_DIGITS.test(value)) return `TASK/${value}/${currentEcuadorYear(now)}`;
  const m = TASK_FULL.exec(value);
  if (m && validYear(Number(m[2]))) return `TASK/${m[1]}/${m[2]}`;
  throw invalid(field, 'Número de tarea inválido: usa TASK/<6-7 dígitos>/<año> o solo el número.');
}

/** Partes de una orden YA normalizada. */
export function workOrderParts(workOrder: string): { number: string; year: number } {
  const m = ORDER_FULL.exec(workOrder);
  if (!m) throw invalid('workOrder', 'Número de orden inválido.');
  return { number: m[1] as string, year: Number(m[2]) };
}
