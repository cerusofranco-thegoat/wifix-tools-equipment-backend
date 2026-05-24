import type { DistanceMeasurement } from '@prisma/client';
import { toContextDto, type ContextDto } from '../../../schemas/service-context.js';
import { toGeoPoint, type GeoPoint } from '../../../schemas/geo.js';

export interface DistanceMeasurementDto extends ContextDto {
  id: string;
  createdAt: string;
  distanceMeters: number;
  startPoint?: GeoPoint;
  endPoint?: GeoPoint;
  measuredAt: string;
  notes?: string;
}

export function toDistanceDto(row: DistanceMeasurement): DistanceMeasurementDto {
  const dto: DistanceMeasurementDto = {
    ...toContextDto(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    distanceMeters: row.distanceMeters,
    measuredAt: row.measuredAt.toISOString(),
  };
  const start = toGeoPoint(row.startLat, row.startLng);
  if (start) dto.startPoint = start;
  const end = toGeoPoint(row.endLat, row.endLng);
  if (end) dto.endPoint = end;
  if (row.notes) dto.notes = row.notes;
  return dto;
}
