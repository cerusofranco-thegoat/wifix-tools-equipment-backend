// ---------------------------------------------------------------------------
// Cliente de `fsm-data-ms` (Grupo TVCable):
//
//   POST /account/process   { account_id, estado }   → órdenes del cliente
//   POST /workorder/tasks   { workOrder }            → tareas y notas de una orden
//   POST /account/status    { account_id }           → estado A/S/T/O/P de la cuenta
//   GET  /naps/nearest      ?lat&lng&meters&maxRows  → NAPs GPON cercanas
//   GET  /naps/accounts     ?id                      → cuentas/equipos de una NAP
//
// Autenticación: Bearer por marca (ver ./fsm-token.ts). Cada POST viaja con
// `{ channel, data, externalTransactionId }`; el UUID de transacción se genera
// por petición saliente y se loguea junto con la marca para poder trazar con la
// operadora, pero NO entra en la clave de cache (si no, el cache nunca acertaría).
//
// Política de caudal (igual que TEC, con semáforo propio):
//   - `cachedFetch` dedupe + TTL corto (60 s; 5 min para /account/status),
//   - `createLimiter(FSM_API_MAX_CONCURRENCY)` separado del de TEC: son dos
//     hosts distintos y no deben competir entre sí,
//   - toda consulta golpea PRODUCCIÓN: no hay ambiente de pruebas.
//
// ⚠ El cache de `throttle.ts` es un Map GLOBAL compartido con TEC: todas las
// claves de acá llevan el prefijo `FSM:{brand}:`. Sin el prefijo de marca, una
// cuenta consultada en `telenews` devolvería el resultado cacheado a `seteinfo`
// — es una fuga entre realms, no un detalle de estilo.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import {
  getFsmAccessToken,
  invalidateFsmToken,
  markFsmTokenRejected,
  type FsmBrand,
  type FsmToken,
} from './fsm-token.js';
import { cachedFetch, createLimiter } from './throttle.js';

export type Json = unknown;

export interface FsmRequestOptions {
  /** TTL del cache en ms. Default `FSM_API_CACHE_TTL_MS`. */
  ttlMs?: number;
}

function baseUrl(): string {
  return env.FSM_API_BASE_URL.replace(/\/+$/, '');
}

/** Semáforo propio de FSM: nunca más de N peticiones en vuelo hacia el MS. */
let limiter: ReturnType<typeof createLimiter> | null = null;
function gate<T>(task: () => Promise<T>): Promise<T> {
  limiter ??= createLimiter(env.FSM_API_MAX_CONCURRENCY);
  return limiter(task);
}

/** Vacía el semáforo (pruebas: permite cambiar la concurrencia configurada). */
export function resetFsmLimiter(): void {
  limiter = null;
}

/** JSON con claves ordenadas: dos objetos equivalentes dan la misma clave. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Clave de cache. SIEMPRE empieza por `FSM:{brand}:`. */
export function fsmCacheKey(
  brand: FsmBrand,
  method: 'GET' | 'POST',
  path: string,
  payload: unknown,
): string {
  return `FSM:${brand}:${method} ${path}:${stableStringify(payload)}`;
}

interface RawFetchInput {
  brand: FsmBrand;
  method: 'GET' | 'POST';
  path: string;
  token: FsmToken;
  data?: Record<string, unknown>;
  query?: Record<string, string | number>;
}

/** La petición HTTP propiamente dicha, sin cache ni cola. */
async function rawFetch(input: RawFetchInput): Promise<{ status: number; body: string }> {
  const { brand, method, path, token, data, query } = input;

  const url = new URL(`${baseUrl()}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  const externalTransactionId = randomUUID();
  const headers: Record<string, string> = {
    accept: 'application/json',
    Authorization: `Bearer ${token.token}`,
  };
  let body: string | undefined;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({
      channel: env.FSM_API_CHANNEL,
      data: data ?? {},
      externalTransactionId,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FSM_API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw ApiError.connectorError(
      isAbort
        ? `FSM no respondió en ${env.FSM_API_TIMEOUT_MS} ms (${path}, marca ${brand}, tx ${externalTransactionId}).`
        : `No se pudo contactar FSM (${path}, marca ${brand}, tx ${externalTransactionId}): ${reason}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = res.status === 204 ? '' : await res.text().catch(() => '');
  return { status: res.status, body: text };
}

/**
 * Traduce la respuesta cruda al modelo de errores interno.
 *
 * | upstream                        | acción                                |
 * |---------------------------------|---------------------------------------|
 * | 200 con body vacío / 204 / 404  | `null`                                |
 * | 400                             | VALIDATION_ERROR con el mensaje recortado |
 * | 401 / 403                       | token inválido → reintento o UPSTREAM_AUTH_ERROR |
 * | otro no-ok                      | CONNECTOR_ERROR con status y 200 chars |
 * | JSON inválido                   | CONNECTOR_ERROR                       |
 */
function translate<T>(
  brand: FsmBrand,
  path: string,
  status: number,
  body: string,
): T | null {
  if (status === 204 || status === 404) return null;

  if (status === 400) {
    throw ApiError.validation(
      `FSM rechazó los parámetros de la consulta (${path}). ${upstreamMessage(body)}`.trim(),
    );
  }

  if (!(status >= 200 && status < 300)) {
    throw ApiError.connectorError(
      `FSM respondió ${status} en ${path} (marca ${brand}). ${body.slice(0, 200)}`.trim(),
    );
  }

  if (!body.trim()) return null;

  try {
    return JSON.parse(body) as T;
  } catch {
    throw ApiError.connectorError(
      `FSM devolvió una respuesta no-JSON en ${path}: ${body.slice(0, 200)}`,
    );
  }
}

/** Mensaje de error de la operadora, recortado a 200 caracteres. */
function upstreamMessage(body: string): string {
  if (!body.trim()) return '';
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ['message', 'Message', 'error', 'detail', 'description']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.slice(0, 200);
    }
  } catch {
    /* cuerpo no-JSON: se usa tal cual */
  }
  return body.slice(0, 200);
}

interface CallInput {
  brand: FsmBrand;
  method: 'GET' | 'POST';
  path: string;
  data?: Record<string, unknown>;
  query?: Record<string, string | number>;
}

/**
 * Resuelve el token FUERA del semáforo (el refresh no es una consulta de datos
 * y no debe competir por los 4 slots), ejecuta la petición dentro del semáforo
 * y aplica la política de 401/403.
 */
async function call<T>(input: CallInput): Promise<T | null> {
  const { brand, method, path, data, query } = input;

  const token = await getFsmAccessToken(brand);
  const first = await gate(() => rawFetch({ ...input, token }));

  if (first.status !== 401 && first.status !== 403) {
    return translate<T>(brand, path, first.status, first.body);
  }

  // La operadora rechazó el token: se invalida el cacheado y, SOLO en modo
  // client_credentials, se reintenta una vez con uno nuevo. Con token estático
  // no hay con qué renovar → REJECTED directo.
  invalidateFsmToken(brand);
  if (token.source !== 'CLIENT_CREDENTIALS') {
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({ brand, reason: 'REJECTED', expiresAt: token.expiresAt });
  }

  const renewed = await getFsmAccessToken(brand);
  const second = await gate(() => rawFetch({ brand, method, path, data, query, token: renewed }));
  if (second.status === 401 || second.status === 403) {
    invalidateFsmToken(brand);
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({ brand, reason: 'REJECTED', expiresAt: renewed.expiresAt });
  }
  return translate<T>(brand, path, second.status, second.body);
}

/** POST autenticado con dedupe, cache y semáforo. */
export function fsmPost<T = Json>(
  brand: FsmBrand,
  path: string,
  data: Record<string, unknown>,
  opts: FsmRequestOptions = {},
): Promise<T | null> {
  const ttl = opts.ttlMs ?? env.FSM_API_CACHE_TTL_MS;
  return cachedFetch(fsmCacheKey(brand, 'POST', path, data), ttl, () =>
    call<T>({ brand, method: 'POST', path, data }),
  );
}

/** GET autenticado con dedupe, cache y semáforo. */
export function fsmGet<T = Json>(
  brand: FsmBrand,
  path: string,
  query: Record<string, string | number>,
  opts: FsmRequestOptions = {},
): Promise<T | null> {
  const ttl = opts.ttlMs ?? env.FSM_API_CACHE_TTL_MS;
  return cachedFetch(fsmCacheKey(brand, 'GET', path, query), ttl, () =>
    call<T>({ brand, method: 'GET', path, query }),
  );
}

// --- Endpoints concretos ----------------------------------------------------

/** Órdenes de un cliente. `estado`: Todas | Pendientes. */
export function fetchAccountProcess(
  brand: FsmBrand,
  accountId: string,
  estado: 'Todas' | 'Pendientes' = 'Todas',
): Promise<Json | null> {
  return fsmPost(brand, '/account/process', { account_id: accountId, estado });
}

/** Tareas y notas de una orden de trabajo (`ORDER/424900/2026`). */
export function fetchWorkOrderTasks(brand: FsmBrand, workOrder: string): Promise<Json | null> {
  return fsmPost(brand, '/workorder/tasks', { workOrder });
}

/**
 * Cuál de las dos claves acepta `/account/status`. La documentación dice
 * `data.account_id`, la colección Postman manda `data.accountId`: se prueba
 * `account_id` y, ante un 400, se reintenta UNA vez con `accountId`. La que
 * funcione queda memoizada para no volver a gastar la vuelta.
 */
let accountStatusKey: 'account_id' | 'accountId' | null = null;

/** Solo para pruebas: olvida qué clave funcionó en `/account/status`. */
export function resetAccountStatusKey(): void {
  accountStatusKey = null;
}

/** Clave que quedó activa en `/account/status` (diagnóstico). */
export function activeAccountStatusKey(): 'account_id' | 'accountId' | null {
  return accountStatusKey;
}

/** El endpoint documenta `account_id` como entero; la cuenta suele ser numérica. */
function accountStatusValue(accountId: string): string | number {
  return /^\d+$/.test(accountId) ? Number(accountId) : accountId;
}

/** Estado A/S/T/O/P de una cuenta. Cache propio de 5 min. */
export async function fetchAccountStatus(
  brand: FsmBrand,
  accountId: string,
): Promise<Json | null> {
  const value = accountStatusValue(accountId);
  const opts: FsmRequestOptions = { ttlMs: env.FSM_STATUS_CACHE_TTL_MS };

  if (accountStatusKey) {
    return fsmPost(brand, '/account/status', { [accountStatusKey]: value }, opts);
  }

  try {
    const result = await fsmPost(brand, '/account/status', { account_id: value }, opts);
    accountStatusKey = 'account_id';
    console.warn('[FSM] /account/status acepta la clave "account_id".');
    return result;
  } catch (err) {
    // Solo un 400 (VALIDATION_ERROR) justifica probar la otra clave; cualquier
    // otro fallo se propaga tal cual para no duplicar carga sobre producción.
    if (!(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR') throw err;
    const result = await fsmPost(brand, '/account/status', { accountId: value }, opts);
    accountStatusKey = 'accountId';
    console.warn('[FSM] /account/status acepta la clave "accountId" (no "account_id").');
    return result;
  }
}

/** NAPs GPON cercanas a una coordenada. */
export function fetchNapsNearest(
  brand: FsmBrand,
  lat: number,
  lng: number,
  meters: number,
  maxRows: number,
): Promise<Json | null> {
  return fsmGet(brand, '/naps/nearest', { lat, lng, meters, maxRows });
}

/** Cuentas y equipos GPON conectados a una NAP. */
export function fetchNapAccounts(brand: FsmBrand, napId: number): Promise<Json | null> {
  return fsmGet(brand, '/naps/accounts', { id: napId });
}
