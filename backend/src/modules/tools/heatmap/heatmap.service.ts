import { ApiError } from '../../../middleware/error-handler.js';
import { toContextColumns } from '../../../schemas/service-context.js';
import { assertNotFuture } from '../../../lib/not-future.js';
import { toPagedResponse, type PagedResponse } from '../../../lib/pagination.js';
import type { ListFilters } from '../../../schemas/filters.js';
import { heatmapRepository } from './heatmap.repository.js';
import { toHeatmapDto, type HeatmapDto } from './heatmap.mappers.js';
import type { HeatmapInput, HeatmapRoomInput, RoomApMeasurementInput } from './heatmap.schemas.js';

interface NormalizedRoom {
  roomName: string;
  floor: number;
  measuredAt: Date;
  notes: string | null;
  legacySignalDbm: number | null;
  legacyFormat: boolean;
  measurements: RoomApMeasurementInput[];
}

function normalizeRoom(room: HeatmapRoomInput): NormalizedRoom {
  // Si el cliente manda el formato nuevo, lo aceptamos tal cual.
  if (room.measurements && room.measurements.length > 0) {
    return {
      roomName: room.roomName,
      floor: room.floor,
      measuredAt: room.measuredAt,
      notes: room.notes ?? null,
      legacySignalDbm: typeof room.signalDbm === 'number' ? room.signalDbm : null,
      legacyFormat: false,
      measurements: room.measurements,
    };
  }
  // Fallback legacy: sintetizar una sola measurement con BSSID centinela.
  if (typeof room.signalDbm !== 'number') {
    // El schema Zod debería haber atrapado esto, pero por seguridad lo hacemos explícito.
    throw ApiError.validation('rooms[].measurements vacío y rooms[].signalDbm ausente.');
  }
  return {
    roomName: room.roomName,
    floor: room.floor,
    measuredAt: room.measuredAt,
    notes: room.notes ?? null,
    legacySignalDbm: room.signalDbm,
    legacyFormat: true,
    measurements: [
      {
        bssid: 'legacy-unknown',
        apLabelSnapshot: 'Medición previa (formato anterior)',
        signalDbm: room.signalDbm,
        band: 'unknown',
        isConnected: false,
      },
    ],
  };
}

export const heatmapService = {
  async create(input: HeatmapInput): Promise<HeatmapDto> {
    const normalized = input.rooms.map((r) => {
      assertNotFuture(r.measuredAt, 'rooms[].measuredAt');
      return normalizeRoom(r);
    });
    const ctx = toContextColumns(input);
    const row = await heatmapRepository.create({
      ...ctx,
      label: input.label ?? null,
      notes: input.notes ?? null,
      rooms: {
        create: normalized.map((r) => ({
          roomName: r.roomName,
          floor: r.floor,
          measuredAt: r.measuredAt,
          notes: r.notes,
          signalDbm: r.legacySignalDbm,
          legacyFormat: r.legacyFormat,
          measurements: {
            create: r.measurements.map((m) => ({
              bssid: m.bssid,
              accessPointId: m.accessPointId ?? null,
              apLabelSnapshot: m.apLabelSnapshot ?? null,
              signalDbm: m.signalDbm,
              band: m.band,
              channel: m.channel ?? null,
              isConnected: m.isConnected,
            })),
          },
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
