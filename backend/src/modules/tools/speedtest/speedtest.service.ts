import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { speedtestRepository } from './speedtest.repository.js';
import { toSpeedtestDto, type SpeedtestDto } from './speedtest.mappers.js';
import type { SpeedtestInput } from './speedtest.schemas.js';

export const speedtestService = {
  async create(input: SpeedtestInput): Promise<SpeedtestDto> {
    assertNotFuture(input.measuredAt, 'measuredAt');
    const ctx = toContextColumns(input);
    const row = await speedtestRepository.create({
      ...ctx,
      downloadMbps: input.downloadMbps,
      uploadMbps: input.uploadMbps,
      latencyMs: input.latencyMs ?? null,
      jitterMs: input.jitterMs ?? null,
      packetLossPercent: input.packetLossPercent ?? null,
      serverId: input.serverId ?? null,
      serverName: input.serverName ?? null,
      ispName: input.ispName ?? null,
      measuredAt: input.measuredAt,
      notes: input.notes ?? null,
    });
    return toSpeedtestDto(row);
  },

  async getById(id: string): Promise<SpeedtestDto> {
    const row = await speedtestRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró el test de velocidad con id ${id}.`);
    return toSpeedtestDto(row);
  },

  async list(filters: ListFilters): Promise<PagedResponse<SpeedtestDto>> {
    const { items, totalItems } = await speedtestRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toSpeedtestDto));
  },
};
