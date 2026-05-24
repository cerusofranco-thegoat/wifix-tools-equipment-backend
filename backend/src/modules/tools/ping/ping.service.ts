import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { pingRepository } from './ping.repository.js';
import { toPingDto, type PingTestDto } from './ping.mappers.js';
import type { PingInput } from './ping.schemas.js';

export const pingService = {
  async create(input: PingInput): Promise<PingTestDto> {
    assertNotFuture(input.measuredAt, 'measuredAt');
    if (input.heatmapId) {
      const exists = await pingRepository.heatmapExists(input.heatmapId);
      if (!exists) {
        throw ApiError.validation(
          `El heatmapId ${input.heatmapId} no existe.`,
          [{ field: 'heatmapId', issue: 'no encontrado' }],
        );
      }
    }
    const ctx = toContextColumns(input);
    const row = await pingRepository.create({
      ...ctx,
      target: input.target,
      serverId: input.serverId ?? null,
      packetsSent: input.packetsSent ?? null,
      packetsReceived: input.packetsReceived ?? null,
      packetLossPercent: input.packetLossPercent ?? null,
      minLatencyMs: input.minLatencyMs ?? null,
      avgLatencyMs: input.avgLatencyMs ?? null,
      maxLatencyMs: input.maxLatencyMs ?? null,
      continuous: input.continuous,
      heatmapId: input.heatmapId ?? null,
      roomName: input.roomName ?? null,
      measuredAt: input.measuredAt,
      notes: input.notes ?? null,
    });
    return toPingDto(row);
  },

  async getById(id: string): Promise<PingTestDto> {
    const row = await pingRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró la prueba de ping con id ${id}.`);
    return toPingDto(row);
  },

  async list(filters: ListFilters): Promise<PagedResponse<PingTestDto>> {
    const { items, totalItems } = await pingRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toPingDto));
  },
};
