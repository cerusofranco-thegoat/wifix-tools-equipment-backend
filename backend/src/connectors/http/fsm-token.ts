// ---------------------------------------------------------------------------
// Resolución del Bearer de `fsm-data-ms` por marca.
//
// La operadora expone dos realms de Keycloak, uno por marca comercial:
//
//   telenews → realm-ecommerce-callcenter-telenews (client apim_callcenter_telenews)
//   seteinfo → realm-ecommerce-callcenter-seteinfo
//
// Internamente NUNCA se habla de "realm": se habla de `brand`. Los nombres de
// realm quedan encerrados en este archivo y el técnico jamás los ve.
//
// Tres modos, en este orden de prioridad:
//
//   1. client_credentials — si están FSM_TOKEN_URL_<BRAND> + FSM_CLIENT_ID_<BRAND>
//      + FSM_CLIENT_SECRET_<BRAND>. Se cachea en memoria y se renueva
//      `FSM_TOKEN_SKEW_MS` antes del `exp`.
//   2. Token estático FSM_API_TOKEN_<BRAND> — pegado a mano, vence cada 24 h.
//   3. Nada configurado → UPSTREAM_AUTH_ERROR con reason MISSING, sin tocar la red.
//
// El token estático se revisa SIN SALIR A LA RED: se decodifica el `exp` del
// JWT (base64 del payload, sin verificar firma) y si ya venció se corta acá.
// Ahorra una llamada inútil a producción, que es exactamente lo que la
// operadora pidió evitar.
//
// Los tokens NUNCA se loguean. En logs solo viajan `brand`, `azp` y `exp`.
// ---------------------------------------------------------------------------

import { Buffer } from 'node:buffer';
import { env } from '../../config/env.js';
import { ApiError, type UpstreamAuthReason } from '../../middleware/error-handler.js';

export type FsmBrand = 'telenews' | 'seteinfo';

export type FsmTokenSource = 'STATIC' | 'CLIENT_CREDENTIALS';

export interface FsmToken {
  token: string;
  expiresAt: Date | null;
  source: FsmTokenSource;
}

export interface BrandHealth {
  brand: FsmBrand;
  available: boolean;
  reason: UpstreamAuthReason | null;
  tokenSource: FsmTokenSource | null;
  expiresAt: string | null;
  expiresInSeconds: number | null;
}

/** Única tabla marca → realm/client de Keycloak. No sale de este archivo. */
const BRAND_REALMS: Record<FsmBrand, { realm: string; clientId: string }> = {
  telenews: {
    realm: 'realm-ecommerce-callcenter-telenews',
    clientId: 'apim_callcenter_telenews',
  },
  seteinfo: {
    realm: 'realm-ecommerce-callcenter-seteinfo',
    clientId: 'apim_callcenter_seteinfo',
  },
};

interface BrandConfig {
  staticToken: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/** Configuración de una marca leída del env (por sufijo en mayúsculas). */
function brandConfig(brand: FsmBrand): BrandConfig {
  const suffix = brand.toUpperCase();
  const read = (prefix: string): string => (process.env[`${prefix}_${suffix}`] ?? '').trim();
  // Las cuatro variables de las dos marcas conocidas están declaradas en el
  // envSchema; la lectura por sufijo permite además marcas extra en FSM_BRANDS.
  return {
    staticToken: read('FSM_API_TOKEN'),
    tokenUrl: read('FSM_TOKEN_URL'),
    clientId: read('FSM_CLIENT_ID'),
    clientSecret: read('FSM_CLIENT_SECRET'),
  };
}

function usesClientCredentials(cfg: BrandConfig): boolean {
  return Boolean(cfg.tokenUrl && cfg.clientId && cfg.clientSecret);
}

/** Marcas habilitadas por configuración (`FSM_BRANDS`). */
export function configuredBrands(): FsmBrand[] {
  return env.FSM_BRANDS.filter((b): b is FsmBrand => b === 'telenews' || b === 'seteinfo');
}

/**
 * Valida la marca que llega por header `X-Wifix-Brand` o query `?brand=`.
 * Vacío/ausente → `FSM_DEFAULT_BRAND`. Valor no listado en `FSM_BRANDS` → 400.
 */
export function resolveBrand(raw?: string | null): FsmBrand {
  const brands = configuredBrands();
  const fallback = (brands.includes(env.FSM_DEFAULT_BRAND as FsmBrand)
    ? env.FSM_DEFAULT_BRAND
    : (brands[0] ?? 'telenews')) as FsmBrand;

  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (!brands.includes(value as FsmBrand)) {
    throw ApiError.validation(
      `Marca desconocida: "${value}". Valores admitidos: ${brands.join(', ')}.`,
      [{ field: 'brand', issue: 'Marca no configurada en el servidor.' }],
    );
  }
  return value as FsmBrand;
}

/** Realm de Keycloak de una marca (solo para diagnóstico/logs). */
export function brandRealm(brand: FsmBrand): string {
  return BRAND_REALMS[brand].realm;
}

/** Client de Keycloak de una marca (solo para diagnóstico/logs). */
export function brandClientId(brand: FsmBrand): string {
  return BRAND_REALMS[brand].clientId;
}

// --- Decodificación del JWT (sin verificar firma) ---------------------------

export interface JwtClaims {
  exp?: number;
  iat?: number;
  azp?: string;
  iss?: string;
  [key: string]: unknown;
}

/**
 * Payload de un JWT sin verificar la firma. Solo lo usamos para leer `exp`,
 * `azp` e `iss`: no confiamos en el token, lo emite y valida la operadora.
 */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = String(token || '').split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as JwtClaims;
  } catch {
    return null;
  }
}

/** Instante de expiración del JWT, o `null` si no se pudo determinar. */
export function decodeJwtExp(token: string): Date | null {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
  return new Date(claims.exp * 1000);
}

// --- Cache y single-flight --------------------------------------------------

const tokenCache = new Map<FsmBrand, FsmToken>();
/** Negociaciones en curso por marca: un vencimiento simultáneo = un refresh. */
const pendingNegotiations = new Map<FsmBrand, Promise<FsmToken>>();
/** Marcas cuyo token rechazó la operadora, para informarlo en /health. */
const rejectedBrands = new Set<FsmBrand>();

/** Invalida el token cacheado de una marca (tras un 401/403 upstream). */
export function invalidateFsmToken(brand: FsmBrand): void {
  tokenCache.delete(brand);
}

/** Marca la credencial como rechazada por la operadora (alimenta /health). */
export function markFsmTokenRejected(brand: FsmBrand): void {
  rejectedBrands.add(brand);
}

/** Vacía cache, negociaciones y rechazos (pruebas o rotación de credenciales). */
export function resetFsmTokenCache(): void {
  tokenCache.clear();
  pendingNegotiations.clear();
  rejectedBrands.clear();
}

function isFresh(token: FsmToken): boolean {
  if (!token.expiresAt) return true;
  return token.expiresAt.getTime() - env.FSM_TOKEN_SKEW_MS > Date.now();
}

/**
 * Negocia un token nuevo con Keycloak.
 *
 * ⚠ El emisor del token de ejemplo es `192.168.59.181:8080` (IP privada): si
 * `FSM_TOKEN_URL_<BRAND>` no es alcanzable desde el servidor, este modo falla
 * siempre. Se trata como un fallo normal que degrada a UPSTREAM_AUTH_ERROR con
 * reason REJECTED, y se loguea la URL (sin el secreto) para poder diagnosticarlo.
 */
async function negotiate(brand: FsmBrand, cfg: BrandConfig): Promise<FsmToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.FSM_API_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[FSM] No se pudo negociar el token de la marca ${brand} contra ${cfg.tokenUrl}: ${reason}`,
    );
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({
      brand,
      reason: 'REJECTED',
      detail: `No se pudo contactar el emisor de tokens (${cfg.tokenUrl}).`,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `[FSM] El emisor de tokens (${cfg.tokenUrl}) respondió ${res.status} para la marca ` +
        `${brand}. ${text.slice(0, 200)}`.trim(),
    );
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({
      brand,
      reason: 'REJECTED',
      detail: `El emisor de tokens respondió ${res.status}.`,
    });
  }

  let payload: { access_token?: unknown; expires_in?: unknown };
  try {
    payload = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  } catch {
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({
      brand,
      reason: 'REJECTED',
      detail: 'El emisor de tokens devolvió una respuesta no-JSON.',
    });
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken) {
    markFsmTokenRejected(brand);
    throw ApiError.upstreamAuth({
      brand,
      reason: 'REJECTED',
      detail: 'El emisor de tokens no devolvió access_token.',
    });
  }

  const expiresIn = Number(payload.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? new Date(Date.now() + expiresIn * 1000)
    : decodeJwtExp(accessToken);

  const claims = decodeJwtClaims(accessToken);
  console.info(
    `[FSM] Token renovado para la marca ${brand} (azp ${claims?.azp ?? '—'}, exp ` +
      `${expiresAt ? expiresAt.toISOString() : 'desconocido'}).`,
  );

  const token: FsmToken = { token: accessToken, expiresAt, source: 'CLIENT_CREDENTIALS' };
  tokenCache.set(brand, token);
  rejectedBrands.delete(brand);
  return token;
}

/**
 * Bearer vigente de una marca. Lanza `UPSTREAM_AUTH_ERROR` (503) si no hay
 * acceso configurado, el token estático venció o la operadora lo rechazó.
 */
export async function getFsmAccessToken(brand: FsmBrand): Promise<FsmToken> {
  const cfg = brandConfig(brand);

  if (usesClientCredentials(cfg)) {
    const cached = tokenCache.get(brand);
    if (cached && isFresh(cached)) return cached;

    // Single-flight: varios técnicos con el token vencido a la vez no pueden
    // disparar N negociaciones contra el Keycloak de la operadora.
    const running = pendingNegotiations.get(brand);
    if (running) return running;

    const promise = negotiate(brand, cfg).finally(() => {
      pendingNegotiations.delete(brand);
    });
    pendingNegotiations.set(brand, promise);
    return promise;
  }

  if (cfg.staticToken) {
    const expiresAt = decodeJwtExp(cfg.staticToken);
    // Chequeo previo SIN RED: si ya venció, no gastamos una llamada a producción.
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw ApiError.upstreamAuth({ brand, reason: 'EXPIRED', expiresAt });
    }
    if (rejectedBrands.has(brand)) {
      throw ApiError.upstreamAuth({ brand, reason: 'REJECTED', expiresAt });
    }
    return { token: cfg.staticToken, expiresAt, source: 'STATIC' };
  }

  throw ApiError.upstreamAuth({ brand, reason: 'MISSING' });
}

/**
 * Estado de la integración por marca, **sin tocar la red**. Es lo que permite
 * a la UI pintar el banner correcto sin gastar una llamada a producción.
 */
export function fsmTokenStatus(): BrandHealth[] {
  const now = Date.now();
  return configuredBrands().map((brand) => {
    const cfg = brandConfig(brand);

    if (usesClientCredentials(cfg)) {
      const cached = tokenCache.get(brand);
      const expiresAt = cached?.expiresAt ?? null;
      const rejected = rejectedBrands.has(brand) && !cached;
      return {
        brand,
        available: !rejected,
        reason: rejected ? 'REJECTED' : null,
        tokenSource: 'CLIENT_CREDENTIALS',
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        expiresInSeconds: expiresAt ? Math.round((expiresAt.getTime() - now) / 1000) : null,
      };
    }

    if (cfg.staticToken) {
      const expiresAt = decodeJwtExp(cfg.staticToken);
      const expired = expiresAt !== null && expiresAt.getTime() <= now;
      const rejected = rejectedBrands.has(brand);
      return {
        brand,
        available: !expired && !rejected,
        reason: expired ? 'EXPIRED' : rejected ? 'REJECTED' : null,
        tokenSource: 'STATIC',
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        expiresInSeconds: expiresAt ? Math.round((expiresAt.getTime() - now) / 1000) : null,
      };
    }

    return {
      brand,
      available: false,
      reason: 'MISSING',
      tokenSource: null,
      expiresAt: null,
      expiresInSeconds: null,
    };
  });
}
