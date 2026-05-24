import { z } from 'zod';

export const geoPointSchema = z.object({
  latitude: z.number().gte(-90).lte(90),
  longitude: z.number().gte(-180).lte(180),
});

export type GeoPoint = z.infer<typeof geoPointSchema>;

export function toGeoPoint(
  latitude: number | null,
  longitude: number | null,
): GeoPoint | undefined {
  if (latitude === null || longitude === null) return undefined;
  return { latitude, longitude };
}
