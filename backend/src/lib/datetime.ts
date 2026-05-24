// Tolerancia para `measuredAt` / `retiredAt` (SPEC §10): no deben ser
// futuros, con margen de 5 minutos para drift de reloj entre dispositivos.
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export function isFutureBeyondSkew(date: Date, now: Date = new Date()): boolean {
  return date.getTime() - now.getTime() > CLOCK_SKEW_TOLERANCE_MS;
}
