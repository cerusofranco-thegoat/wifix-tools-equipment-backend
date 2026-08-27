// ---------------------------------------------------------------------------
// Cliente de la API de operadora (Grupo TVCable): TEC + ISP Monitor.
//
//   GET /api/tec/naps/{lat},{lng}                  → NAPs cercanas
//   GET /api/isp/terminals/{id}                    → estado equipo/red/evento
//   GET /api/isp/status/{id}                       → estado del terminal 24h
//   GET /api/isp/network/online/{id}               → estado de la red 24h
//   GET /api/isp/cablemodem/snr/{id}               → señal/ruido terminal 24h
//   GET /api/isp/network/snr/{id}                  → señal/ruido red 24h
//   GET /api/isp/cablemodem/codewords/{id}         → FEC terminal 24h
//   GET /api/isp/network/codewords/{id}            → FEC red 24h
//
// `{id}` es el serial GPON o la MAC del cablemódem HFC.
// Autenticación: HTTP Digest (ver ./digest.ts).
//
// Todo pasa por `cachedFetch` + semáforo (ver ./throttle.ts): la operadora
// pidió no consultar de más y no existe ambiente de pruebas, cada llamada
// golpea producción.
// ---------------------------------------------------------------------------

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { digestFetch } from './digest.js';
import { cachedFetch, createLimiter } from './throttle.js';

export type Json = unknown;

/** Caracteres permitidos en un id de terminal (serial GPON o MAC sin separadores). */
const TERMINAL_ID_RE = /^[A-Za-z0-9._-]{4,64}$/;

/**
 * Valida y normaliza el id de terminal antes de mandarlo a la URL.
 * IIS rechaza con 400 los paths que contienen `:`; las MAC se normalizan
 * quitando separadores para que `AA:BB:…` y `AABB…` funcionen igual.
 */
export function normalizeTerminalId(rawId: string): string {
  const id = String(rawId || '').trim();
  if (!id) {
    throw ApiError.validation('El identificador del terminal es obligatorio.');
  }
  // MAC con separadores (`:` o `-`) → hex plano.
  const macLike = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
  const normalized = macLike.test(id) ? id.replace(/[:-]/g, '') : id;
  if (!TERMINAL_ID_RE.test(normalized)) {
    throw ApiError.validation(
      'Identificador inválido: usa el serial GPON o la MAC del cablemódem (solo letras, números, punto o guion).',
    );
  }
  return normalized.toUpperCase();
}

function baseUrl(): string {
  return env.TEC_API_BASE_URL.replace(/\/+$/, '');
}

/** Semáforo global: nunca más de N peticiones en vuelo hacia la operadora. */
let limiter: ReturnType<typeof createLimiter> | null = null;
function gate<T>(task: () => Promise<T>): Promise<T> {
  limiter ??= createLimiter(env.TEC_API_MAX_CONCURRENCY);
  return limiter(task);
}

/**
 * Ejecuta un GET autenticado contra la API de operadora, con dedupe, cache
 * corto y semáforo de concurrencia.
 *
 * `ttlMs` permite acortar o desactivar (0) el cache por endpoint. El default
 * sale de `TEC_API_CACHE_TTL_MS`: los datos de la operadora son series de 24 h
 * que se refrescan cada 5 minutos, así que repetir la consulta a los segundos
 * devuelve exactamente lo mismo.
 */
export function tecApiGet<T = Json>(path: string, ttlMs?: number): Promise<T | null> {
  const ttl = ttlMs ?? env.TEC_API_CACHE_TTL_MS;
  return cachedFetch(`GET ${path}`, ttl, () => gate(() => tecApiFetch<T>(path)));
}

/** El GET propiamente dicho, sin cache ni cola. */
async function tecApiFetch<T = Json>(path: string): Promise<T | null> {
  const url = `${baseUrl()}${path}`;
  let res: Response;
  try {
    res = await digestFetch(
      url,
      { username: env.TEC_API_USERNAME, password: env.TEC_API_PASSWORD },
      { timeoutMs: env.TEC_API_TIMEOUT_MS },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw ApiError.connectorError(
      isAbort
        ? `La API de operadora no respondió en ${env.TEC_API_TIMEOUT_MS} ms (${path}).`
        : `No se pudo contactar la API de operadora (${path}): ${reason}`,
    );
  }

  if (res.status === 204 || res.status === 404) return null;

  // La API responde 400 {"Message":"Invalid serial number"} cuando el id no
  // tiene forma de serial GPON (4 letras + 8 hex) ni de MAC (12 hex). Es un
  // error del dato que ingresó el técnico, no del sistema: se traduce a 400.
  if (res.status === 400) {
    const body = await res.text().catch(() => '');
    let upstream = '';
    try {
      const parsed = JSON.parse(body) as { Message?: string };
      upstream = parsed.Message ?? '';
    } catch {
      upstream = body.slice(0, 120);
    }
    throw ApiError.validation(
      'La API de operadora rechazó el identificador: debe ser el serial GPON ' +
        '(4 letras + 8 caracteres, p. ej. ZTEGD52E1A9B) o la MAC del cablemódem ' +
        `(12 dígitos hexadecimales).${upstream ? ` Respuesta: ${upstream}.` : ''}`,
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw ApiError.connectorError(
      'La API de operadora rechazó las credenciales (Digest). Revisa TEC_API_USERNAME / TEC_API_PASSWORD.',
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw ApiError.connectorError(
      `La API de operadora respondió ${res.status} en ${path}. ${body.slice(0, 200)}`.trim(),
    );
  }

  const text = await res.text();
  if (!text.trim()) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw ApiError.connectorError(
      `La API de operadora devolvió una respuesta no-JSON en ${path}: ${text.slice(0, 200)}`,
    );
  }
}

// --- Endpoints concretos ---------------------------------------------------

export function fetchNearbyNaps(latitude: number, longitude: number): Promise<Json | null> {
  // La API espera "{lat},{lng}" con el signo incluido en cada componente.
  return tecApiGet(`/api/tec/naps/${latitude},${longitude}`);
}

export function fetchTerminal(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/terminals/${encodeURIComponent(id)}`);
}

export function fetchTerminalStatus24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/status/${encodeURIComponent(id)}`);
}

export function fetchNetworkStatus24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/network/online/${encodeURIComponent(id)}`);
}

export function fetchTerminalSnr24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/cablemodem/snr/${encodeURIComponent(id)}`);
}

export function fetchNetworkSnr24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/network/snr/${encodeURIComponent(id)}`);
}

export function fetchTerminalCodewords24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/cablemodem/codewords/${encodeURIComponent(id)}`);
}

export function fetchNetworkCodewords24h(id: string): Promise<Json | null> {
  return tecApiGet(`/api/isp/network/codewords/${encodeURIComponent(id)}`);
}
