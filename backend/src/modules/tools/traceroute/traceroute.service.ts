import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { tracerouteRepository } from './traceroute.repository.js';
import { toTracerouteDto, type TracerouteDto } from './traceroute.mappers.js';
import type { TracerouteInput } from './traceroute.schemas.js';

export const tracerouteService = {
  async create(input: TracerouteInput): Promise<TracerouteDto> {
    assertNotFuture(input.measuredAt, 'measuredAt');
    const ctx = toContextColumns(input);
    const row = await tracerouteRepository.create({
      ...ctx,
      target: input.target,
      serverId: input.serverId ?? null,
      measuredAt: input.measuredAt,
      notes: input.notes ?? null,
      hops: {
        create: input.hops.map((h) => ({
          hopNumber: h.hopNumber,
          host: h.host ?? null,
          latencyMs: h.latencyMs ?? null,
        })),
      },
    });
    return toTracerouteDto(row);
  },

  async getById(id: string): Promise<TracerouteDto> {
    const row = await tracerouteRepository.findById(id);
    if (!row) throw ApiError.notFound(`No se encontró el traceroute con id ${id}.`);
    return toTracerouteDto(row);
  },

  async list(filters: ListFilters): Promise<PagedResponse<TracerouteDto>> {
    const { items, totalItems } = await tracerouteRepository.list(filters);
    return toPagedResponse(filters, totalItems, items.map(toTracerouteDto));
  },
};
