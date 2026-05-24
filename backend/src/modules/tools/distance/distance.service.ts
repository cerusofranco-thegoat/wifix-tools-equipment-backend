import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { distanceRepository } from './distance.repository.js';
import { toDistanceDto, type DistanceMeasurementDto } from './distance.mappers.js';
import type { DistanceInput } from './distance.schemas.js';

export const distanceService = {
  async create(input: DistanceInput): Promise<DistanceMeasurementDto> {
    assertNotFuture(input.measuredAt, 'measuredAt');
    const ctx = toContextColumns(input);
    const row = await distanceRepository.create({
      ...ctx,
      distanceMeters: input.distanceMeters,
      startLat: input.startPoint?.latitude ?? null,
      startLng: input.startPoint?.longitude ?? null,
      endLat: input.endPoint?.latitude ?? null,
      endLng: input.endPoint?.longitude ?? null,
      measuredAt: input.measuredAt,
      notes: input.notes ?? null,
    });
    return toDistanceDto(row);
  },

  async getById(id: string): Promise<DistanceMeasurementDto> {
    const row = await distanceRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró la medición de distancia con id ${id}.`);
    return toDistanceDto(row);
  },

  async list(filters: ListFilters): Promise<PagedResponse<DistanceMeasurementDto>> {
    const { items, totalItems } = await distanceRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toDistanceDto));
  },
};
