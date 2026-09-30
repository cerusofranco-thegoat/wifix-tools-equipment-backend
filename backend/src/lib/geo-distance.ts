// Distancia entre dos coordenadas (fórmula de Haversine), en metros.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Radio medio de la Tierra (m). */
const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Distancia de gran círculo en metros, redondeada a 0,1 m. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.round(meters * 10) / 10;
}

/** Coordenada utilizable: finita y distinta de (0,0), el "vacío" de los sistemas legados. */
export function isUsableLatLng(lat: number | null | undefined, lng: number | null | undefined): boolean {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return !(lat === 0 && lng === 0);
}
