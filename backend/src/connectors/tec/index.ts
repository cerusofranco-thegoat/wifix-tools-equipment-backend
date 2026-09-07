// Conector hacia TEC / registro GPON — campos 6 (NAPs cercanas) y 8 (puertos por NAP).
//
// Endpoint real (autenticación Digest):
//   GET /api/tec/naps/{lat},{lng}
//   → [{ "nap": "PL2KD9", "lat": -2.168419, "lng": -79.918913,
//         "distance": 20.0, "ports": 8, "used": 4 }, …]
//
// La consulta es por COORDENADA (la del técnico o la de la tarea), no por
// número de cuenta: es lo que hace la pestaña "GPON" de FSM.

import { connectorMode, env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, type AccountStatusCode, type Degraded } from '../_shared.js';
import { fetchNearbyNaps } from '../http/tec-api.js';
import { toNumber } from '../ispmonitor/normalize.js';

export interface Coordinates {
  latitude: number;
  longitude: number;
}

/** De dónde salió el dato de NAPs: FSM (fsm-data-ms) o TEC (registro GPON). */
export type NapSource = 'FSM' | 'TEC';

export interface NearbyNap {
  /** Id numérico de la NAP en FSM; null cuando la fuente es TEC. */
  napId: number | null;
  napCode: string;
  /** Red de acceso (OLT/puerto) a la que cuelga la NAP. Nunca "nodo". */
  networkName: string | null;
  /** Coordenada de la NAP; null si la API no la devuelve. */
  latitude: number | null;
  longitude: number | null;
  /** Distancia en metros calculada por la operadora desde la coordenada consultada. */
  distanceMeters: number;
  occupiedPorts: number;
  totalPorts: number;
  freePorts: number;
  source: NapSource;
}

export interface NapPort {
  portNumber: number;
  occupied: boolean;
  clientAccountNumber: string | null;
  /** Serial/ID GPON del equipo conectado al puerto. */
  equipmentId: string | null;
  /** Estado del cliente; null mientras no se haya consultado (`statusPending`). */
  clientStatus: AccountStatusCode | null;
  /** true en los puertos ocupados cuyo estado todavía no se consultó. */
  statusPending: boolean;
}

/** Cuántos estados quedan por resolver y con qué tope, para el paso 2. */
export interface StatusFanOut {
  supported: boolean;
  pendingAccounts: number;
  batchLimit: number;
}

export interface NapPorts {
  /** Valor tal como llegó en la ruta: id numérico de FSM o código de NAP. */
  napRef: string;
  napId: number | null;
  napCode: string | null;
  ports: NapPort[];
  /**
   * false cuando el detalle puerto a puerto no está disponible con los accesos
   * actuales (la API de TEC solo expone el conteo ocupados/total).
   */
  detailAvailable: boolean;
  occupiedPorts?: number;
  totalPorts?: number;
  /** Explicación para mostrar al técnico cuando `detailAvailable` es false. */
  note?: string;
  statusFanOut: StatusFanOut;
  source: NapSource;
  degraded?: Degraded;
}

export interface TecConnector {
  getNearbyNaps(coords: Coordinates): Promise<NearbyNap[]>;
  getNapPorts(napCode: string): Promise<NapPorts>;
}

/** El fan-out de estados no existe por el camino TEC. */
function tecFanOut(): StatusFanOut {
  return { supported: false, pendingAccounts: 0, batchLimit: env.FSM_STATUS_BATCH_LIMIT };
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

function makeNapCode(rng: ReturnType<typeof seededRng>): string {
  const cluster = rng.intBetween(1, 30);
  const card = rng.intBetween(1, 16);
  const port = rng.intBetween(1, 8);
  return `NAP-${cluster.toString().padStart(2, '0')}-${card.toString().padStart(2, '0')}-${port}`;
}

/** Desplaza una coordenada `meters` metros en un rumbo dado (aprox. plana). */
function offsetCoords(coords: Coordinates, meters: number, bearingRad: number): Coordinates {
  const dLat = (meters * Math.cos(bearingRad)) / 111_320;
  const dLng =
    (meters * Math.sin(bearingRad)) / (111_320 * Math.cos((coords.latitude * Math.PI) / 180));
  return { latitude: coords.latitude + dLat, longitude: coords.longitude + dLng };
}

export const tecMock: TecConnector = {
  async getNearbyNaps(coords) {
    // Semilla estable por coordenada redondeada: dos consultas desde el mismo
    // punto devuelven el mismo clúster de NAPs.
    const seed = `tec:nearby:${coords.latitude.toFixed(4)},${coords.longitude.toFixed(4)}`;
    const rng = seededRng(seed);
    const n = rng.intBetween(4, 8);
    const naps: NearbyNap[] = [];
    for (let i = 0; i < n; i++) {
      const total = rng.pick([8, 16] as const);
      const occupied = rng.intBetween(0, total);
      const distance = rng.floatBetween(20, 320, 1);
      const position = offsetCoords(coords, distance, rng.floatBetween(0, Math.PI * 2, 4));
      naps.push({
        napId: null,
        napCode: makeNapCode(rng),
        networkName: null,
        latitude: position.latitude,
        longitude: position.longitude,
        distanceMeters: distance,
        occupiedPorts: occupied,
        totalPorts: total,
        freePorts: total - occupied,
        source: 'TEC',
      });
    }
    return naps.sort((a, b) => a.distanceMeters - b.distanceMeters);
  },

  async getNapPorts(napCode) {
    const rng = seededRng(`tec:napports:${napCode}`);
    const total = rng.pick([8, 16] as const);
    const ports: NapPort[] = [];
    let occupiedCount = 0;
    for (let i = 1; i <= total; i++) {
      const occupied = rng.bool(0.7);
      if (occupied) occupiedCount += 1;
      const port: NapPort = {
        portNumber: i,
        occupied,
        clientAccountNumber: occupied ? `WX-${rng.intBetween(100000, 999999)}` : null,
        equipmentId: occupied ? `ZTEG${rng.intBetween(10000000, 99999999)}` : null,
        clientStatus: occupied ? (rng.bool(0.85) ? 'A' : 'S') : null,
        statusPending: false,
      };
      ports.push(port);
    }
    return {
      napRef: napCode,
      napId: null,
      napCode,
      ports,
      detailAvailable: true,
      occupiedPorts: occupiedCount,
      totalPorts: total,
      statusFanOut: tecFanOut(),
      source: 'TEC',
    };
  },
};

// ---------------------------------------------------------------------------
// Real
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Primer valor no nulo entre varias claves candidatas. */
function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const match = Object.keys(row).find((k) => k.toLowerCase() === key.toLowerCase());
    if (match !== undefined && row[match] !== null && row[match] !== undefined) return row[match];
  }
  return undefined;
}

/** Mapea una fila de `/api/tec/naps/…` al modelo interno. */
export function mapNapRow(row: unknown): NearbyNap | null {
  if (!isPlainObject(row)) return null;
  const code = pick(row, ['nap', 'napCode', 'codigo', 'code', 'name', 'nombre']);
  if (code === undefined) return null;

  const total = toNumber(pick(row, ['ports', 'totalPorts', 'puertos', 'capacidad'])) ?? 0;
  const used = toNumber(pick(row, ['used', 'occupiedPorts', 'ocupados', 'usados'])) ?? 0;
  const distance = toNumber(pick(row, ['distance', 'distanceMeters', 'distancia', 'metros'])) ?? 0;

  return {
    // TEC identifica la NAP por código, no por id numérico, y no expone la red
    // de acceso: ambos campos quedan en null y `source` lo deja explícito.
    napId: null,
    napCode: String(code),
    networkName: null,
    latitude: toNumber(pick(row, ['lat', 'latitude', 'latitud'])),
    longitude: toNumber(pick(row, ['lng', 'lon', 'long', 'longitude', 'longitud'])),
    distanceMeters: distance,
    occupiedPorts: used,
    totalPorts: total,
    freePorts: Math.max(0, total - used),
    source: 'TEC',
  };
}

export const tecReal: TecConnector = {
  async getNearbyNaps(coords) {
    const raw = await fetchNearbyNaps(coords.latitude, coords.longitude);
    if (raw === null) return [];
    const rows = Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : [];
    const naps = rows
      .map(mapNapRow)
      .filter((n): n is NearbyNap => n !== null)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
    return naps;
  },

  async getNapPorts(napCode) {
    // La API de operadora expone el conteo ocupados/total en el listado de NAPs,
    // pero no el detalle por puerto (eso vive en tec.grupotvcable.com/Gpon/Coverage,
    // que todavía no está publicado como API). Se devuelve una respuesta explícita
    // en vez de fallar, para que la app muestre el conteo y avise del faltante.
    return {
      napRef: napCode,
      napId: null,
      napCode,
      ports: [],
      detailAvailable: false,
      note:
        'El detalle puerto a puerto (clientes activos/suspendidos) todavía no está ' +
        'expuesto en la API de operadora. Se muestran los puertos ocupados del listado de NAPs.',
      statusFanOut: tecFanOut(),
      source: 'TEC',
    };
  },
};

export function getTecConnector(): TecConnector {
  const mode = connectorMode('tec');
  switch (mode) {
    case 'mock':
      return tecMock;
    case 'real':
      return tecReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${mode}`);
  }
}
