import type { WifiHeatmap, WifiHeatmapRoom } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';

export interface HeatmapRoomDto {
  id: string;
  roomName: string;
  floor: number;
  signalDbm: number;
  measuredAt: string;
  notes?: string;
}

export function toHeatmapRoomDto(r: WifiHeatmapRoom): HeatmapRoomDto {
  const dto: HeatmapRoomDto = {
    id: r.id,
    roomName: r.roomName,
    floor: r.floor,
    signalDbm: r.signalDbm,
    measuredAt: r.measuredAt.toISOString(),
  };
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

export function toHeatmapDto(h: WifiHeatmap & { rooms: WifiHeatmapRoom[] }): HeatmapDto {
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
