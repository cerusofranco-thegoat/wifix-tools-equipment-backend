import type { ClientLocation } from '@prisma/client';

/** De dónde salió la ubicación registrada del cliente. Hoy solo FSM (o MOCK en demo). */
export type RegisteredLocationSource = 'FSM' | 'TEC' | 'MOCK';

export interface RegisteredLocation {
  latitude: number;
  longitude: number;
  source: RegisteredLocationSource;
}

export interface ClientLocationDto {
  id: string;
  accountNumber: string;
  label: 'CASA_CLIENTE';
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  source: 'GPS' | 'MANUAL';
  napCode: string | null;
  /** Número si el puerto es numérico; texto tal cual si no. */
  napPort: string | number | null;
  taskId: string | null;
  capturedAt: string;
  createdAt: string;
  capturedBy: { id: string; email: string };
  /** Foto de la ubicación registrada del cliente al capturar. */
  registeredLocation: RegisteredLocation | null;
  distanceToRegisteredMeters: number | null;
  distanceToNapMeters: number | null;
  /** Aditivo: coordenada de la NAP usada para `distanceToNapMeters`. */
  napLocation: { latitude: number; longitude: number; simulated: boolean } | null;
  /** Aditivo. */
  notes: string | null;
}

function toRegisteredSource(value: string | null): RegisteredLocationSource | null {
  return value === 'FSM' || value === 'TEC' || value === 'MOCK' ? value : null;
}

export function toClientLocationDto(row: ClientLocation): ClientLocationDto {
  const registeredSource = toRegisteredSource(row.registeredSource);
  const registered =
    row.registeredLatitude !== null && row.registeredLongitude !== null && registeredSource
      ? {
          latitude: row.registeredLatitude,
          longitude: row.registeredLongitude,
          source: registeredSource,
        }
      : null;
  const napLocation =
    row.napLatitude !== null && row.napLongitude !== null
      ? { latitude: row.napLatitude, longitude: row.napLongitude, simulated: row.napSimulated ?? false }
      : null;
  return {
    id: row.id,
    accountNumber: row.accountNumber,
    label: row.label,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracyMeters,
    source: row.source,
    napCode: row.napCode,
    napPort: row.napPort === null ? null : /^\d+$/.test(row.napPort) ? Number(row.napPort) : row.napPort,
    taskId: row.taskId,
    capturedAt: row.capturedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    capturedBy: { id: row.capturedById, email: row.capturedByEmail },
    registeredLocation: registered,
    distanceToRegisteredMeters: row.distanceToRegisteredMeters,
    distanceToNapMeters: row.distanceToNapMeters,
    napLocation,
    notes: row.notes,
  };
}
