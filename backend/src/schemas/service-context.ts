import { z } from 'zod';

// ServiceContext del contrato: accountNumber obligatorio (clave de Fase 1);
// el resto son referencias upstream opcionales.
export const serviceContextSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
  clientId: z.string().min(1).optional(),
  contractId: z.string().min(1).optional(),
  visitId: z.string().min(1).optional(),
  technicianId: z.string().min(1).optional(),
  /**
   * Visita FSM en la que se tomó el registro: tarea (`TASK/294328/2026`) u
   * orden (`ORDER/424900/2026`). Es lo que asocia el registro a una visita
   * anterior en `GET /accounts/{n}/visits?include=records`.
   */
  taskId: z.string().trim().min(1).max(120, 'taskId excede 120 caracteres.').optional(),
});

export type ServiceContextInput = z.infer<typeof serviceContextSchema>;

export interface ContextColumns {
  accountNumber: string;
  clientId: string | null;
  contractId: string | null;
  visitId: string | null;
  technicianId: string | null;
  taskId: string | null;
}

export function toContextColumns(ctx: ServiceContextInput): ContextColumns {
  return {
    accountNumber: ctx.accountNumber,
    clientId: ctx.clientId ?? null,
    contractId: ctx.contractId ?? null,
    visitId: ctx.visitId ?? null,
    technicianId: ctx.technicianId ?? null,
    taskId: ctx.taskId ?? null,
  };
}

export interface ContextDto {
  accountNumber: string;
  clientId?: string;
  contractId?: string;
  visitId?: string;
  technicianId?: string;
  taskId?: string;
}

export function toContextDto(row: ContextColumns): ContextDto {
  const dto: ContextDto = { accountNumber: row.accountNumber };
  if (row.clientId) dto.clientId = row.clientId;
  if (row.contractId) dto.contractId = row.contractId;
  if (row.visitId) dto.visitId = row.visitId;
  if (row.technicianId) dto.technicianId = row.technicianId;
  if (row.taskId) dto.taskId = row.taskId;
  return dto;
}
