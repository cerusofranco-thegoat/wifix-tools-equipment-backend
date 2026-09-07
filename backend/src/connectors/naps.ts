// ---------------------------------------------------------------------------
// Política de fuente para el campo 6 (NAPs cercanas) y el campo 8 (puertos).
// Ver ADR-04.
//
// Dos APIs devuelven NAPs cercanas:
//
//   TEC  `/api/tec/naps/{lat},{lng}` — Digest permanente, identifica por código,
//        radio fijo, sin red de acceso, NO habilita el detalle por puerto.
//   FSM  `/naps/nearest`             — Bearer de 24 h, id numérico + nombre,
//        `meters`/`maxRows` configurables, red de acceso, y su `id` es la
//        entrada de `/naps/accounts` (campo 8).
//
// `NAPS_PRIMARY_SOURCE` decide cuál manda. Hoy se despliega en `tec`, que es lo
// que ya funciona en producción; se cambia a `fsm` el día que haya token.
//
// Con `fsm`, un fallo de AUTENTICACIÓN cae a TEC y responde 200 con
// `degraded.reason:'FSM_AUTH'`: nunca se rompe una pantalla que hoy funciona.
// Cualquier otro fallo de FSM (5xx, timeout) se propaga: un error transitorio
// no justifica duplicar la carga sobre la otra API de producción.
// ---------------------------------------------------------------------------

import { env } from '../config/env.js';
import { ApiError } from '../middleware/error-handler.js';
import type { Degraded } from './_shared.js';
import { getFsmConnector } from './fsm/index.js';
import type { FsmBrand } from './http/fsm-token.js';
import { getTecConnector, type Coordinates, type NapPorts, type NearbyNap } from './tec/index.js';

export interface NearbyNapsOptions {
  brand: FsmBrand;
  meters: number;
  maxRows: number;
  /** true si el cliente envió `meters`/`maxRows` de forma explícita. */
  rangeRequested?: boolean;
}

export interface NearbyNapsResult {
  naps: NearbyNap[];
  degraded?: Degraded;
}

function isUpstreamAuthError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'UPSTREAM_AUTH_ERROR';
}

const RANGE_IGNORED: Degraded = {
  reason: 'SOURCE_FALLBACK',
  message:
    'Las NAPs se están consultando en el registro GPON (TEC), que usa un radio fijo: ' +
    'los parámetros de distancia y cantidad no se aplicaron.',
};

/** NAPs cercanas según la fuente primaria configurada. */
export async function getNearbyNaps(
  coords: Coordinates,
  opts: NearbyNapsOptions,
): Promise<NearbyNapsResult> {
  if (env.NAPS_PRIMARY_SOURCE === 'fsm') {
    try {
      const naps = await getFsmConnector().getNearbyNaps(coords, {
        brand: opts.brand,
        meters: opts.meters,
        maxRows: opts.maxRows,
      });
      return { naps };
    } catch (err) {
      if (!isUpstreamAuthError(err)) throw err;
      const naps = await getTecConnector().getNearbyNaps(coords);
      return {
        naps,
        degraded: {
          reason: 'FSM_AUTH',
          message:
            'El acceso a FSM no está disponible: las NAPs se están mostrando desde el ' +
            'registro GPON (TEC), sin id de NAP ni detalle de puertos.',
        },
      };
    }
  }

  const naps = await getTecConnector().getNearbyNaps(coords);
  return { naps, ...(opts.rangeRequested ? { degraded: RANGE_IGNORED } : {}) };
}

export interface NapPortsOptions {
  brand: FsmBrand;
  withStatus: boolean;
}

/**
 * Puertos de una NAP.
 *
 * Ruteo del parámetro: `/^\d+$/` → id numérico de FSM (`/naps/accounts`);
 * cualquier otro valor → código de NAP y camino TEC heredado, que sigue
 * devolviendo `detailAvailable:false`. El frontend manda `nap.napId ?? nap.napCode`.
 */
export async function getNapPortsByRef(
  napRef: string,
  opts: NapPortsOptions,
): Promise<NapPorts> {
  if (/^\d+$/.test(napRef)) {
    return getFsmConnector().getNapPorts(Number(napRef), {
      brand: opts.brand,
      withStatus: opts.withStatus,
    });
  }
  const ports = await getTecConnector().getNapPorts(napRef);
  return { ...ports, napRef };
}
