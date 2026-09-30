// ---------------------------------------------------------------------------
// GET /accounts/{n}/current-nap — ¿en qué NAP y puerto está conectada la cuenta?
//
// FSM no expone el dato directo: se resuelve por BÚSQUEDA INVERSA.
//
//   1. Coordenada: `lat`/`lng` de override, o la del cliente según
//      `/account/process` (el mismo camino y cache de 60 s que client-profile).
//      Sin coordenada → `found:false, reason:'NO_COORDS'`.
//   2. `/naps/nearest` con `CURRENT_NAP_SEARCH` (150 m, 3 filas).
//   3. `/naps/accounts?id=` de cada NAP, SECUENCIAL y por cercanía, cortando en
//      cuanto aparece la cuenta. Nunca en paralelo: la NAP más cercana es casi
//      siempre la buena y cada consulta extra golpea producción.
//   4. Si se encontró: estado de ESA cuenta por el camino del status-batch
//      (`/account/status`, cache 5 min). Si falla, `clientStatus:null` con aviso.
//
// Presupuesto upstream: [1 process] + 1 nearest + ≤3 accounts + [1 status].
// El resultado completo se cachea 10 min por marca y cuenta.
//
// Con `NAPS_PRIMARY_SOURCE=tec` no hay búsqueda posible (TEC no expone las
// cuentas de una NAP): `reason:'NOT_SUPPORTED'` con CERO llamadas. Un fallo de
// token de FSM se propaga como 503 `UPSTREAM_AUTH_ERROR` (nunca 401) y NO cae
// a TEC: una NAP de TEC no serviría para nada acá.
//
// NAP ASIGNADA SIEMPRE (2026-09-30, decisión de Franco): en Visita técnica y
// Migraciones el cliente YA tiene una NAP contratada; el técnico no busca NAPs.
// Si la búsqueda real no la identifica (NOT_FOUND / NO_COORDS / NOT_SUPPORTED)
// o FSM no está disponible (token, 5xx, timeout), se responde una NAP asignada
// SIMULADA, determinística por cuenta, con `simulated:true` y
// `source:'SIMULATED'`. La búsqueda real, su presupuesto y su cache NO
// cambian: la simulación se arma DESPUÉS, sin llamadas extra. `?fallback=none`
// devuelve el comportamiento estricto anterior (found:false / 503).
// ---------------------------------------------------------------------------

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng } from '../../connectors/_shared.js';
import { cachedFetch } from '../../connectors/http/throttle.js';
import { CURRENT_NAP_SEARCH } from '../../connectors/fsm/index.js';
import {
  getFsmConnector,
  type AccountStatusCode,
  type AccountStatusName,
  type Coordinates,
  type Degraded,
  type FsmBrand,
  type NapPorts,
  type NearbyNap,
} from '../../connectors/index.js';

/** TTL del resultado completo de la búsqueda. */
export const CURRENT_NAP_CACHE_TTL_MS = 10 * 60_000;

export type CurrentNapReason = 'NOT_FOUND' | 'NO_COORDS' | 'NOT_SUPPORTED';

/** Por qué se respondió una NAP simulada: el motivo real o el fallo upstream. */
export type CurrentNapSimulationReason =
  | CurrentNapReason
  | 'UPSTREAM_AUTH_ERROR'
  | 'UPSTREAM_UNAVAILABLE';

/** De dónde salió la NAP asignada. */
export type CurrentNapSource = 'FSM' | 'SIMULATED';

/** Fila de NAP de current-nap: la de FSM o una simulada. */
export type CurrentNap = Omit<NearbyNap, 'source'> & { source: NearbyNap['source'] | 'SIMULATED' };

/** `simulated` (default): NAP simulada si no hay real. `none`: estricto (found:false / 503). */
export type CurrentNapFallback = 'simulated' | 'none';

export interface CurrentNapClientStatus {
  code: AccountStatusCode | null;
  name: AccountStatusName;
  description: string | null;
}

export interface CurrentNapResult {
  accountNumber: string;
  found: boolean;
  nap: CurrentNap | null;
  portNumber: number | null;
  equipmentId: string | null;
  clientStatus: CurrentNapClientStatus | null;
  /** NAPs cuyo `/naps/accounts` se consultó (0 a `CURRENT_NAP_SEARCH.maxRows`). */
  searchedNaps: number;
  reason?: CurrentNapReason;
  brand: FsmBrand;
  degraded?: Degraded;
  /** `FSM` si la NAP es real, `SIMULATED` si es la asignada simulada; `null` si no hay NAP. */
  source: CurrentNapSource | null;
  /** `true` solo cuando la NAP es simulada. */
  simulated: boolean;
  /** La NAP es la contratada/asignada al cliente; `null` si no hay NAP (`fallback=none`). */
  assignment: 'CONTRACTED' | null;
  /** Solo con `simulated:true`: por qué no se usó la NAP real. */
  simulationReason?: CurrentNapSimulationReason;
}

export interface CurrentNapOptions {
  brand: FsmBrand;
  /** Override de la coordenada (GPS del técnico). Sin él, la del cliente en FSM. */
  coords?: Coordinates;
  /** Default `simulated`. */
  fallback?: CurrentNapFallback;
}

/** Resultado de la búsqueda real + la coordenada desde la que se buscó. */
interface SearchOutcome {
  result: CurrentNapResult;
  coords: Coordinates | null;
}

const STATUS_DEGRADED: Degraded = {
  reason: 'FSM_UNAVAILABLE',
  message:
    'Se identificó la NAP y el puerto del cliente, pero no se pudo consultar el ' +
    'estado de su cuenta en este momento.',
};

/** Cuenta comparable: sin espacios y, si es numérica, sin ceros a la izquierda. */
export function normalizeAccount(value: string | number): string {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return text;
  return text.replace(/^0+(?=\d)/, '');
}

/**
 * Clave de cache. SIEMPRE con el prefijo `FSM:{brand}:` (cache compartido con TEC).
 *
 * La cuenta va solo recortada, SIN quitar ceros: es exactamente el valor que
 * viaja a FSM (`/account/process`, `/account/status`), igual que en el resto
 * del conector (`dedupe`, `fsmCacheKey`). Así una entrada nunca mezcla
 * resultados de dos consultas upstream distintas. `normalizeAccount` se usa
 * solo para COMPARAR contra las cuentas que devuelve `/naps/accounts`.
 */
export function currentNapCacheKey(
  brand: FsmBrand,
  accountNumber: string,
  coords?: Coordinates,
): string {
  const base = `FSM:${brand}:currentNap:${accountNumber.trim()}`;
  if (!coords) return base;
  // 5 decimales ≈ 1 m: dos GPS casi idénticos comparten la entrada.
  return `${base}:${coords.latitude.toFixed(5)},${coords.longitude.toFixed(5)}`;
}

function emptyResult(
  accountNumber: string,
  brand: FsmBrand,
  reason: CurrentNapReason,
  searchedNaps = 0,
): CurrentNapResult {
  return {
    accountNumber,
    found: false,
    nap: null,
    portNumber: null,
    equipmentId: null,
    clientStatus: null,
    searchedNaps,
    reason,
    brand,
    source: null,
    simulated: false,
    assignment: null,
  };
}

function isUsableCoord(lat: number | null, lng: number | null): boolean {
  if (lat === null || lng === null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  // (0,0) es el "vacío" típico de los sistemas legados, no un domicilio en Ecuador.
  return !(lat === 0 && lng === 0);
}

/**
 * Coordenada del cliente según FSM `/account/process` (mismo camino que
 * client-profile: comparte su cache de 60 s). Primero la del cliente; si no
 * viene, la de la orden más reciente que la tenga.
 */
async function clientCoords(accountNumber: string, brand: FsmBrand): Promise<Coordinates | null> {
  let orders;
  try {
    orders = await getFsmConnector().getAccountOrders(accountNumber, { brand, estado: 'Todas' });
  } catch (err) {
    // Igual que client-profile: un 5xx/timeout de FSM no es "cuenta sin datos".
    if (err instanceof ApiError && err.code === 'CONNECTOR_ERROR') {
      throw ApiError.upstreamUnavailable({
        integration: 'FSM',
        brand,
        reason: 'UPSTREAM_ERROR',
        detail: err.message,
      });
    }
    throw err;
  }

  const client = orders.client;
  if (client && isUsableCoord(client.latitude, client.longitude)) {
    return { latitude: client.latitude as number, longitude: client.longitude as number };
  }
  const order = orders.orders.find((o) => isUsableCoord(o.latitude, o.longitude));
  return order ? { latitude: order.latitude as number, longitude: order.longitude as number } : null;
}

/** Estado de UNA cuenta por el camino del status-batch. Nunca tumba la respuesta. */
async function resolveClientStatus(
  accountNumber: string,
  brand: FsmBrand,
): Promise<{ clientStatus: CurrentNapClientStatus | null; degraded?: Degraded }> {
  try {
    const batch = await getFsmConnector().getAccountsStatusBatch([accountNumber], { brand });
    const item = batch.items[0];
    if (!item || item.status === null) return { clientStatus: null, degraded: STATUS_DEGRADED };
    return {
      clientStatus: {
        code: item.statusCode,
        name: item.status,
        description: item.statusDescription,
      },
    };
  } catch {
    // Incluye un fallo de token: la NAP ya se encontró y eso vale más que el
    // estado. El aviso evita que la respuesta degradada se cachee 10 min.
    return { clientStatus: null, degraded: STATUS_DEGRADED };
  }
}

async function searchCurrentNap(
  accountNumber: string,
  opts: CurrentNapOptions,
): Promise<SearchOutcome> {
  const { brand } = opts;
  const fsm = getFsmConnector();

  const coords = opts.coords ?? (await clientCoords(accountNumber, brand));
  if (!coords) return { result: emptyResult(accountNumber, brand, 'NO_COORDS'), coords: null };

  const naps = (await fsm.getNearbyNaps(coords, { brand, ...CURRENT_NAP_SEARCH }))
    .slice()
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, CURRENT_NAP_SEARCH.maxRows);

  const target = normalizeAccount(accountNumber);
  let searched = 0;

  for (const nap of naps) {
    if (nap.napId === null) continue;
    searched += 1;

    let ports: NapPorts;
    try {
      ports = await fsm.getNapPorts(nap.napId, { brand, withStatus: false });
    } catch (err) {
      // Una NAP que FSM no reconoce no aborta la búsqueda; todo lo demás
      // (token, 5xx) sí se propaga, igual que en /naps/{napRef}/ports.
      if (err instanceof ApiError && err.code === 'NOT_FOUND') continue;
      throw err;
    }

    const hit = ports.ports.find(
      (p) => p.clientAccountNumber !== null && normalizeAccount(p.clientAccountNumber) === target,
    );
    if (!hit) continue;

    const { clientStatus, degraded } = await resolveClientStatus(accountNumber, brand);
    return {
      coords,
      result: {
        accountNumber,
        found: true,
        nap,
        portNumber: hit.portNumber,
        equipmentId: hit.equipmentId,
        clientStatus,
        searchedNaps: searched,
        brand,
        ...(degraded ? { degraded } : {}),
        source: 'FSM',
        simulated: false,
        assignment: 'CONTRACTED',
      },
    };
  }

  return { result: emptyResult(accountNumber, brand, 'NOT_FOUND', searched), coords };
}

// ---------------------------------------------------------------------------
// NAP asignada simulada
// ---------------------------------------------------------------------------

/**
 * Centro del clúster de los mocks (mismo que el domicilio mock de FSM). Se usa
 * cuando no se conoce la coordenada del cliente.
 */
export const SIMULATED_NAP_CLUSTER: Coordinates = { latitude: -2.247946, longitude: -79.904161 };

/** Desplaza una coordenada `meters` metros en un rumbo dado (aprox. plana). */
function offsetCoords(coords: Coordinates, meters: number, bearingRad: number): Coordinates {
  const dLat = (meters * Math.cos(bearingRad)) / 111_320;
  const dLng =
    (meters * Math.sin(bearingRad)) / (111_320 * Math.cos((coords.latitude * Math.PI) / 180));
  return {
    latitude: Number((coords.latitude + dLat).toFixed(6)),
    longitude: Number((coords.longitude + dLng).toFixed(6)),
  };
}

const SIMULATION_DEGRADED: Partial<Record<CurrentNapSimulationReason, Degraded>> = {
  UPSTREAM_AUTH_ERROR: {
    reason: 'FSM_AUTH',
    message:
      'El acceso a FSM no está disponible: se muestra la NAP asignada del cliente ' +
      'de forma simulada.',
  },
  UPSTREAM_UNAVAILABLE: {
    reason: 'FSM_UNAVAILABLE',
    message:
      'FSM no está respondiendo: se muestra la NAP asignada del cliente de forma simulada.',
  },
};

/**
 * NAP asignada SIMULADA, determinística por cuenta (misma cuenta → mismo
 * resultado). Pura: cero llamadas. Si se conoce la coordenada del cliente, la
 * NAP queda a 15-120 m de ella; si no, alrededor del clúster de los mocks
 * (también determinístico por cuenta).
 *
 * `equipmentId` va en `null`: un serial GPON inventado se confundiría con uno real.
 */
export function simulatedCurrentNap(
  accountNumber: string,
  brand: FsmBrand,
  near: Coordinates | null,
  simulationReason: CurrentNapSimulationReason,
): CurrentNapResult {
  const rng = seededRng(`sim:current-nap:${normalizeAccount(accountNumber)}`);
  // Se sortea SIEMPRE en el mismo orden, haya o no coordenada, para que la
  // NAP (código, puertos) no cambie si mañana FSM sí devuelve el domicilio.
  const clusterOffset = {
    latitude: rng.floatBetween(-0.01, 0.01, 6),
    longitude: rng.floatBetween(-0.01, 0.01, 6),
  };
  const distance = rng.floatBetween(15, 120, 1);
  const bearing = rng.floatBetween(0, Math.PI * 2, 4);
  const occupied = rng.intBetween(1, 16);
  const total = occupied > 8 ? 16 : 8;
  const portNumber = rng.intBetween(1, occupied);
  const napCode = `PL${rng.intBetween(10, 99)}${rng.pick(['KD', 'AB', 'XR', 'MN'] as const)}${rng.intBetween(1, 9)}`;
  const networkName = `OLT-GYE-${String(rng.intBetween(1, 9)).padStart(2, '0')}/1/${rng.intBetween(1, 8)}`;

  const base = near ?? {
    latitude: SIMULATED_NAP_CLUSTER.latitude + clusterOffset.latitude,
    longitude: SIMULATED_NAP_CLUSTER.longitude + clusterOffset.longitude,
  };
  const position = offsetCoords(base, distance, bearing);
  const degraded = SIMULATION_DEGRADED[simulationReason];

  return {
    accountNumber,
    found: true,
    nap: {
      // Sin id de FSM: la webapp no debe pedir `/naps/{napRef}/ports` de una NAP simulada.
      napId: null,
      napCode,
      networkName,
      latitude: position.latitude,
      longitude: position.longitude,
      distanceMeters: distance,
      occupiedPorts: occupied,
      totalPorts: total,
      freePorts: total - occupied,
      source: 'SIMULATED',
    },
    portNumber,
    equipmentId: null,
    clientStatus: { code: 'A', name: 'ACTIVA', description: 'Activo (simulado)' },
    searchedNaps: 0,
    brand,
    ...(degraded ? { degraded } : {}),
    source: 'SIMULATED',
    simulated: true,
    assignment: 'CONTRACTED',
    simulationReason,
  };
}

/** Fallo upstream que se cubre con la NAP simulada (el resto se propaga). */
function upstreamFailure(err: unknown): CurrentNapSimulationReason | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'UPSTREAM_AUTH_ERROR') return 'UPSTREAM_AUTH_ERROR';
  if (err.code === 'UPSTREAM_UNAVAILABLE' || err.code === 'CONNECTOR_ERROR') {
    return 'UPSTREAM_UNAVAILABLE';
  }
  return null;
}

/** Búsqueda real (con su cache), sin simulación. */
async function findRealCurrentNap(account: string, opts: CurrentNapOptions): Promise<SearchOutcome> {
  // TEC no expone cuentas por NAP: no hay búsqueda posible y no se gasta nada.
  if (env.NAPS_PRIMARY_SOURCE !== 'fsm') {
    return { result: emptyResult(account, opts.brand, 'NOT_SUPPORTED'), coords: null };
  }

  return cachedFetch(
    currentNapCacheKey(opts.brand, account, opts.coords),
    CURRENT_NAP_CACHE_TTL_MS,
    () => searchCurrentNap(account, opts),
    // Una respuesta con aviso (estado no disponible) no se fija 10 min.
    { cacheIf: (outcome) => outcome.result.degraded === undefined },
  );
}

/**
 * NAP y puerto asignados a la cuenta: búsqueda inversa real y, si no se
 * identifica o FSM no está disponible, la NAP asignada simulada (salvo
 * `fallback:'none'`).
 */
export async function findCurrentNap(
  accountNumber: string,
  opts: CurrentNapOptions,
): Promise<CurrentNapResult> {
  const account = accountNumber.trim();
  const strict = opts.fallback === 'none';

  let outcome: SearchOutcome;
  try {
    outcome = await findRealCurrentNap(account, opts);
  } catch (err) {
    const failure = upstreamFailure(err);
    if (strict || failure === null) throw err;
    return simulatedCurrentNap(account, opts.brand, opts.coords ?? null, failure);
  }

  const { result, coords } = outcome;
  if (result.found || strict) return result;
  return simulatedCurrentNap(
    account,
    opts.brand,
    coords ?? opts.coords ?? null,
    result.reason ?? 'NOT_FOUND',
  );
}
