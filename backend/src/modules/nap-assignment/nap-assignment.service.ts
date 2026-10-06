// NAP elegida por el técnico en Instalación — APPEND-ONLY.
//
// Cada elección es una fila; la vigente es la más reciente (`latest`). Se
// guarda la foto de la NAP tal como la vio la app (FSM, TEC o mock) y el
// técnico del JWT. Solo lee/escribe la base propia: cero llamadas externas.

import { accountVariants, storedAccountNumber } from '../client-location/client-location.service.js';
import { napAssignmentRepository } from './nap-assignment.repository.js';
import { toNapAssignmentDto, type NapAssignmentDto } from './nap-assignment.mappers.js';
import type { NapAssignmentInput, NapAssignmentListQuery } from './nap-assignment.schemas.js';

export interface AccountNapAssignments {
  latest: NapAssignmentDto | null;
  items: NapAssignmentDto[];
}

export interface NapAssignmentPage {
  items: NapAssignmentDto[];
  /** `id` a pasar como `cursor` para la página siguiente; `null` si no hay más. */
  nextCursor: string | null;
}

export const napAssignmentService = {
  async create(accountNumber: string, input: NapAssignmentInput, technicianId: string): Promise<NapAssignmentDto> {
    const row = await napAssignmentRepository.create({
      accountNumber: storedAccountNumber(accountNumber),
      napId: input.napId,
      napCode: input.napCode,
      napName: input.napName ?? null,
      port: input.port ?? null,
      latitude: input.latitude,
      longitude: input.longitude,
      distanceMeters: input.distanceMeters ?? null,
      source: input.source,
      taskId: input.taskId ?? null,
      workOrder: input.workOrder ?? null,
      technicianId,
    });
    return toNapAssignmentDto(row);
  },

  /** Elecciones de la cuenta, más reciente primero (máx. 50). */
  async listByAccount(accountNumber: string): Promise<AccountNapAssignments> {
    const rows = await napAssignmentRepository.listByAccount(accountVariants(accountNumber));
    const items = rows.map(toNapAssignmentDto);
    return { latest: items[0] ?? null, items };
  },

  /** Vista de gerente: todas las cuentas (o una), paginado por cursor. */
  async list(query: NapAssignmentListQuery): Promise<NapAssignmentPage> {
    const rows = await napAssignmentRepository.listPage({
      ...(query.accountNumber ? { accountNumbers: accountVariants(query.accountNumber) } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toNapAssignmentDto),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  },
};
