import type { Speedtest } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';

export interface SpeedtestDto extends ContextDto {
  id: string;
  createdAt: string;
  downloadMbps: number;
  uploadMbps: number;
  latencyMs?: number;
  jitterMs?: number;
  packetLossPercent?: number;
  serverId?: string;
  serverName?: string;
  ispName?: string;
  measuredAt: string;
  notes?: string;
}

export function toSpeedtestDto(row: Speedtest): SpeedtestDto {
  const dto: SpeedtestDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    downloadMbps: row.downloadMbps,
    uploadMbps: row.uploadMbps,
    measuredAt: row.measuredAt.toISOString(),
  };
  if (row.latencyMs !== null) dto.latencyMs = row.latencyMs;
  if (row.jitterMs !== null) dto.jitterMs = row.jitterMs;
  if (row.packetLossPercent !== null) dto.packetLossPercent = row.packetLossPercent;
  if (row.serverId) dto.serverId = row.serverId;
  if (row.serverName) dto.serverName = row.serverName;
  if (row.ispName) dto.ispName = row.ispName;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
