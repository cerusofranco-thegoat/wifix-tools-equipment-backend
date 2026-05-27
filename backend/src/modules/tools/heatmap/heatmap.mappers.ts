import type { RoomApMeasurement, WifiHeatmap, WifiHeatmapRoom } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';

export interface RoomApMeasurementDto {
  id: string;
  bssid: string;
  accessPointId?: string;
  apLabelSnapshot?: string;
  signalDbm: number;
  band: string;
  channel?: number;
  isConnected: boolean;
}

export function toRoomApMeasurementDto(m: RoomApMeasurement): RoomApMeasurementDto {
  const dto: RoomApMeasurementDto = {
    id: m.id,
    bssid: m.bssid,
    signalDbm: m.signalDbm,
    band: m.band,
    isConnected: m.isConnected,
  };
  if (m.accessPointId) dto.accessPointId = m.accessPointId;
  if (m.apLabelSnapshot) dto.apLabelSnapshot = m.apLabelSnapshot;
  if (m.channel != null) dto.channel = m.channel;
  return dto;
}

export interface HeatmapRoomDto {
  id: string;
  roomName: string;
  floor: number;
  measurements: RoomApMeasurementDto[];
  legacyFormat: boolean;
  /** Deprecated. Conservado para retrocompatibilidad de lectura. */
  signalDbm?: number;
  measuredAt: string;
  notes?: string;
}

type RoomWithMeasurements = WifiHeatmapRoom & { measurements: RoomApMeasurement[] };

export function toHeatmapRoomDto(r: RoomWithMeasurements): HeatmapRoomDto {
  const dto: HeatmapRoomDto = {
    id: r.id,
    roomName: r.roomName,
    floor: r.floor,
    measurements: r.measurements.map(toRoomApMeasurementDto),
    legacyFormat: r.legacyFormat,
    measuredAt: r.measuredAt.toISOString(),
  };
  if (r.signalDbm != null) dto.signalDbm = r.signalDbm;
  if (r.notes) dto.notes = r.notes;
  return dto;
}

export interface HeatmapDto extends ContextDto {
  id: string;
  createdAt: string;
  label?: string;
  rooms: HeatmapRoomDto[];
  notes?: string;
}

export function toHeatmapDto(h: WifiHeatmap & { rooms: RoomWithMeasurements[] }): HeatmapDto {
  const dto: HeatmapDto = {
    ...toContextDto(h),
    id: h.id,
    createdAt: h.createdAt.toISOString(),
    rooms: h.rooms.map(toHeatmapRoomDto),
  };
  if (h.label) dto.label = h.label;
  if (h.notes) dto.notes = h.notes;
  return dto;
}
