import { z } from 'zod';
import { paginationSchema } from '../lib/pagination.js';

export const contextFiltersSchema = z.object({
  accountNumber: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
  visitId: z.string().min(1).optional(),
  technicianId: z.string().min(1).optional(),
});

export const dateRangeSchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export const listFiltersSchema = contextFiltersSchema.merge(dateRangeSchema).merge(paginationSchema);

export type ListFilters = z.infer<typeof listFiltersSchema>;

export interface ContextWhere {
  accountNumber?: string;
  clientId?: string;
  contractId?: string;
  visitId?: string;
  technicianId?: string;
}

export function buildContextWhere(filters: ListFilters): ContextWhere {
  const w: ContextWhere = {};
  if (filters.accountNumber) w.accountNumber = filters.accountNumber;
  if (filters.clientId) w.clientId = filters.clientId;
  if (filters.contractId) w.contractId = filters.contractId;
  if (filters.visitId) w.visitId = filters.visitId;
  if (filters.technicianId) w.technicianId = filters.technicianId;
  return w;
}

export function buildDateRangeWhere(
  filters: ListFilters,
): { gte?: Date; lte?: Date } | undefined {
  if (!filters.dateFrom && !filters.dateTo) return undefined;
  const r: { gte?: Date; lte?: Date } = {};
  if (filters.dateFrom) r.gte = filters.dateFrom;
  if (filters.dateTo) r.lte = filters.dateTo;
  return r;
}
