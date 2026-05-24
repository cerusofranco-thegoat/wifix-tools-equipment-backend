import type { TracerouteTest, TracerouteHop } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';

export interface TracerouteHopDto {
  hopNumber: number;
  host?: string;
  latencyMs?: number;
}

export function toHopDto(h: TracerouteHop): TracerouteHopDto {
  const dto: TracerouteHopDto = { hopNumber: h.hopNumber };
  if (h.host) dto.host = h.host;
  if (h.latencyMs !== null) dto.latencyMs = h.latencyMs;
  return dto;
}

export interface TracerouteDto extends ContextDto {
  id: string;
  createdAt: string;
  target: string;
  serverId?: string;
  hops: TracerouteHopDto[];
  measuredAt: string;
  notes?: string;
}

export function toTracerouteDto(
  row: TracerouteTest & { hops: TracerouteHop[] },
): TracerouteDto {
  const dto: TracerouteDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    target: row.target,
    hops: row.hops.sort((a, b) => a.hopNumber - b.hopNumber).map(toHopDto),
    measuredAt: row.measuredAt.toISOString(),
  };
  if (row.serverId) dto.serverId = row.serverId;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
