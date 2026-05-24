import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { heatmapRepository } from './heatmap.repository.js';
import { toHeatmapDto, type HeatmapDto } from './heatmap.mappers.js';
import type { HeatmapInput } from './heatmap.schemas.js';

export const heatmapService = {
  async create(input: HeatmapInput): Promise<HeatmapDto> {
    for (const room of input.rooms) {
      assertNotFuture(room.measuredAt, 'rooms[].measuredAt');
    }
    const ctx = toContextColumns(input);
    const row = await heatmapRepository.create({
      ...ctx,
      label: input.label ?? null,
      notes: input.notes ?? null,
      rooms: {
        create: input.rooms.map((r) => ({
          roomName: r.roomName,
          floor: r.floor,
          signalDbm: r.signalDbm,
          measuredAt: r.measuredAt,
          notes: r.notes ?? null,
        })),
      },
    });
    return toHeatmapDto(row);
  },

  async getById(id: string): Promise<HeatmapDto> {
    const row = await heatmapRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró el mapa de calor con id ${id}.`);
    return toHeatmapDto(row);
  },

  async list(filters: ListFilters): Promise<PagedResponse<HeatmapDto>> {
    const { items, totalItems } = await heatmapRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toHeatmapDto));
  },
};
