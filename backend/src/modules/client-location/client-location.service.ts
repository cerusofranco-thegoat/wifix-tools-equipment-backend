// ---------------------------------------------------------------------------
// Ubicación "Casa cliente": el técnico captura su GPS (o la marca a mano) en el
// domicilio y queda GUARDADA, vinculada a la NAP del cliente, para que un
// gerente la compare con la ubicación que la operadora tiene registrada.
//
// - Append-only: cada captura es una fila; nunca se sobrescribe.
// - Ubicación registrada: FSM `/account/process` (coordenada del cliente o, si
//   no viene, la de la orden más reciente que la tenga), el mismo camino y
//   cache de 60 s que client-profile y current-nap. TEC NO expone el domicilio
//   (solo NAPs por coordenada) y la whitelist no guarda coordenadas (LOPDP).
// - NAP: la enviada por la app o, si no viene, la de current-nap (real o
//   asignada simulada). Sus coordenadas solo se usan si el código coincide.
// - Al guardar se toma una FOTO (registrada, NAP, distancias): leer el
//   historial no vuelve a llamar a FSM. Un fallo de FSM nunca impide guardar.
// ---------------------------------------------------------------------------

import { connectorMode } from '../../config/env.js';
import { getFsmConnector, type FsmBrand } from '../../connectors/index.js';
import { assertNotFuture } from '../../lib/not-future.js';
import { haversineMeters, isUsableLatLng } from '../../lib/geo-distance.js';
import { toPageInfo, type PageInfo } from '../../lib/pagination.js';
import { normalizeAccountNumber } from '../whitelist/whitelist.normalize.js';
import { findCurrentNap, type CurrentNapResult } from '../network-diagnostics/current-nap.service.js';
import { clientLocationRepository } from './client-location.repository.js';
import {
  toClientLocationDto,
  type ClientLocationDto,
  type RegisteredLocation,
} from './client-location.mappers.js';
import type { ClientLocationInput, ClientLocationListQuery } from './client-location.schemas.js';

export interface CapturedBy {
  id: string;
  email: string;
}

export interface AccountClientLocations {
  latest: ClientLocationDto | null;
  items: ClientLocationDto[];
  registeredLocation: RegisteredLocation | null;
}

export interface ClientLocationPage {
  items: ClientLocationDto[];
  page: PageInfo;
}

/** Cuenta que se guarda: normalizada (sin ceros a la izquierda si es numérica). */
export function storedAccountNumber(accountNumber: string): string {
  return normalizeAccountNumber(accountNumber) ?? accountNumber.trim();
}

/** 7 decimales ≈ 1 cm: evita ruido de coma flotante en las fotos guardadas. */
function round7(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/** La cuenta tal cual y normalizada (`035070291` y `35070291` son la misma). */
export function accountVariants(accountNumber: string): string[] {
  const keys = new Set([accountNumber.trim()]);
  const normalized = normalizeAccountNumber(accountNumber);
  if (normalized) keys.add(normalized);
  return [...keys];
}

/**
 * Ubicación registrada del cliente según FSM. `null` si no hay coordenada o si
 * FSM no está disponible: nunca lanza.
 */
export async function resolveRegisteredLocation(
  accountNumber: string,
  brand: FsmBrand,
): Promise<RegisteredLocation | null> {
  try {
    const { client, orders } = await getFsmConnector().getAccountOrders(accountNumber, {
      brand,
      estado: 'Todas',
    });
    const source = connectorMode('fsm') === 'mock' ? 'MOCK' : 'FSM';
    const point =
      client && isUsableLatLng(client.latitude, client.longitude)
        ? client
        : orders.find((o) => isUsableLatLng(o.latitude, o.longitude));
    if (!point) return null;
    return {
      latitude: round7(point.latitude as number),
      longitude: round7(point.longitude as number),
      source,
    };
  } catch {
    return null;
  }
}

/** NAP asignada del cliente (real o simulada). `null` si falla: nunca lanza. */
async function safeCurrentNap(accountNumber: string, brand: FsmBrand): Promise<CurrentNapResult | null> {
  try {
    return await findCurrentNap(accountNumber, { brand });
  } catch {
    return null;
  }
}

interface NapLink {
  napCode: string | null;
  napPort: string | null;
  napLatitude: number | null;
  napLongitude: number | null;
  napSimulated: boolean | null;
}

/** Vincula la captura a la NAP: la enviada o la de current-nap. Pura. */
export function linkNap(
  input: Pick<ClientLocationInput, 'napCode' | 'napPort'>,
  current: CurrentNapResult | null,
): NapLink {
  const currentNap = current?.found ? current.nap : null;
  const napCode = input.napCode ?? currentNap?.napCode ?? null;
  const sameNap =
    currentNap !== null &&
    napCode !== null &&
    currentNap.napCode.trim().toUpperCase() === napCode.trim().toUpperCase();

  let napPort: string | null = null;
  if (input.napPort !== undefined) napPort = String(input.napPort);
  else if (sameNap && current?.portNumber !== null && current?.portNumber !== undefined) {
    napPort = String(current.portNumber);
  }

  const napCoords =
    sameNap && isUsableLatLng(currentNap.latitude, currentNap.longitude)
      ? { latitude: currentNap.latitude as number, longitude: currentNap.longitude as number }
      : null;

  return {
    napCode,
    napPort,
    napLatitude: napCoords ? round7(napCoords.latitude) : null,
    napLongitude: napCoords ? round7(napCoords.longitude) : null,
    napSimulated: napCoords ? (current?.simulated ?? false) : null,
  };
}

export const clientLocationService = {
  async create(
    accountNumber: string,
    input: ClientLocationInput,
    capturedBy: CapturedBy,
    brand: FsmBrand,
  ): Promise<ClientLocationDto> {
    const capturedAt = input.capturedAt ?? new Date();
    assertNotFuture(capturedAt, 'capturedAt');
    const account = accountNumber.trim();

    const [registered, current] = await Promise.all([
      resolveRegisteredLocation(account, brand),
      // Coordenadas de la NAP del cliente; suele estar en cache (10 min) porque
      // la app ya la pidió al abrir la visita.
      safeCurrentNap(account, brand),
    ]);
    const nap = linkNap(input, current);
    const point = { latitude: input.latitude, longitude: input.longitude };

    const row = await clientLocationRepository.create({
      accountNumber: storedAccountNumber(account),
      label: input.label,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracyMeters: input.accuracyMeters ?? null,
      source: input.source,
      ...nap,
      taskId: input.taskId ?? null,
      capturedAt,
      notes: input.notes ?? null,
      capturedById: capturedBy.id,
      capturedByEmail: capturedBy.email,
      registeredLatitude: registered?.latitude ?? null,
      registeredLongitude: registered?.longitude ?? null,
      registeredSource: registered?.source ?? null,
      distanceToRegisteredMeters: registered ? haversineMeters(point, registered) : null,
      distanceToNapMeters:
        nap.napLatitude !== null && nap.napLongitude !== null
          ? haversineMeters(point, { latitude: nap.napLatitude, longitude: nap.napLongitude })
          : null,
    });
    return toClientLocationDto(row);
  },

  /** Capturas de la cuenta (más reciente primero, máx. 50) + ubicación registrada. */
  async listByAccount(accountNumber: string, brand: FsmBrand): Promise<AccountClientLocations> {
    const account = accountNumber.trim();
    const [rows, live] = await Promise.all([
      clientLocationRepository.listByAccount(accountVariants(account)),
      resolveRegisteredLocation(account, brand),
    ]);
    const items = rows.map(toClientLocationDto);
    const latest = items[0] ?? null;
    return {
      latest,
      items,
      // Si FSM no responde, la última foto guardada.
      registeredLocation: live ?? latest?.registeredLocation ?? null,
    };
  },

  /** Lista para el gerente, paginada. Solo lee la base propia. */
  async list(query: ClientLocationListQuery): Promise<ClientLocationPage> {
    const { items, totalItems } = await clientLocationRepository.list({
      ...(query.accountNumber ? { accountNumbers: accountVariants(query.accountNumber) } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return {
      items: items.map(toClientLocationDto),
      page: toPageInfo({ page: query.page, pageSize: query.limit }, totalItems),
    };
  },
};
