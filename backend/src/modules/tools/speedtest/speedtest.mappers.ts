import type { Speedtest, SpeedtestSource } from '@prisma/client';
import type { SpeedtestSourceValue } from './speedtest.schemas.js';

const SOURCE_TO_API: Record<SpeedtestSource, SpeedtestSourceValue> = {
  APP: 'app',
  EXTERNAL_DEVICE: 'external-device',
};

export function toSpeedtestSourceEnum(source: SpeedtestSourceValue): SpeedtestSource {
  return source === 'external-device' ? 'EXTERNAL_DEVICE' : 'APP';
}
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
  /** `app` | `external-device`. Siempre presente (default `app`). */
  source: SpeedtestSourceValue;
  deviceName?: string;
  deviceId?: string;
  simulated: boolean;
}

export function toSpeedtestDto(row: Speedtest): SpeedtestDto {
  const dto: SpeedtestDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    downloadMbps: row.downloadMbps,
    uploadMbps: row.uploadMbps,
    measuredAt: row.measuredAt.toISOString(),
    source: SOURCE_TO_API[row.source],
    simulated: row.simulated,
  };
  if (row.deviceName) dto.deviceName = row.deviceName;
  if (row.deviceId) dto.deviceId = row.deviceId;
  if (row.latencyMs !== null) dto.latencyMs = row.latencyMs;
  if (row.jitterMs !== null) dto.jitterMs = row.jitterMs;
  if (row.packetLossPercent !== null) dto.packetLossPercent = row.packetLossPercent;
  if (row.serverId) dto.serverId = row.serverId;
  if (row.serverName) dto.serverName = row.serverName;
  if (row.ispName) dto.ispName = row.ispName;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
