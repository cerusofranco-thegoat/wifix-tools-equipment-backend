import type { PingTest } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';

export interface PingTestDto extends ContextDto {
  id: string;
  createdAt: string;
  target: string;
  serverId?: string;
  packetsSent?: number;
  packetsReceived?: number;
  packetLossPercent?: number;
  minLatencyMs?: number;
  avgLatencyMs?: number;
  maxLatencyMs?: number;
  continuous: boolean;
  heatmapId?: string;
  roomName?: string;
  measuredAt: string;
  notes?: string;
}

export function toPingDto(row: PingTest): PingTestDto {
  const dto: PingTestDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    target: row.target,
    continuous: row.continuous,
    measuredAt: row.measuredAt.toISOString(),
  };
  if (row.serverId) dto.serverId = row.serverId;
  if (row.packetsSent !== null) dto.packetsSent = row.packetsSent;
  if (row.packetsReceived !== null) dto.packetsReceived = row.packetsReceived;
  if (row.packetLossPercent !== null) dto.packetLossPercent = row.packetLossPercent;
  if (row.minLatencyMs !== null) dto.minLatencyMs = row.minLatencyMs;
  if (row.avgLatencyMs !== null) dto.avgLatencyMs = row.avgLatencyMs;
  if (row.maxLatencyMs !== null) dto.maxLatencyMs = row.maxLatencyMs;
  if (row.heatmapId) dto.heatmapId = row.heatmapId;
  if (row.roomName) dto.roomName = row.roomName;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
