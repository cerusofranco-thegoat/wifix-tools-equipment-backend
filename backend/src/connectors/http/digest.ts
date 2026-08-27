// ---------------------------------------------------------------------------
// Cliente HTTP con autenticación Digest (RFC 2617 / RFC 7616, qop="auth").
//
// La API de TEC / ISP Monitor (tec-api.grupotvcable.com, IIS + ASP.NET) exige
// Digest: la primera petición responde 401 con la cabecera `WWW-Authenticate`
// y hay que repetirla firmando la respuesta con MD5.
//
// El challenge se cachea por origen: la operadora confirmó (2026-08-27) que el
// nonce cambia día a día, no en cada petición, así que tras la primera llamada
// las siguientes van firmadas de entrada (una sola vuelta). Cuando el nonce
// rota, el propio 401 trae el challenge nuevo en `WWW-Authenticate`: se adopta
// y se re-firma sin gastar una vuelta extra de negociación.
//
// La negociación en frío se comparte por origen: si varias peticiones arrancan
// a la vez, solo una pide el challenge y las demás esperan su resultado, en vez
// de disparar N 401 contra un sistema en producción.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';

export interface DigestCredentials {
  username: string;
  password: string;
}

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
  /** Contador de peticiones (nc) para este nonce. */
  nc: number;
}

/** Cache de challenges por origen (`https://host:port`). */
const challengeCache = new Map<string, Challenge>();

/** Negociación en curso por origen, para no pedir el challenge N veces. */
const pendingNegotiations = new Map<string, Promise<Challenge | null>>();

function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

/**
 * Parsea la cabecera `WWW-Authenticate: Digest realm="…", nonce="…", …`.
 * Acepta valores entre comillas o sin comillas (p. ej. `stale=true`).
 */
export function parseDigestChallenge(header: string): Omit<Challenge, 'nc'> | null {
  const match = /^\s*Digest\s+(.*)$/is.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(match[1] as string)) !== null) {
    params[(m[1] as string).toLowerCase()] = (m[2] ?? m[3] ?? '') as string;
  }
  if (!params.realm || !params.nonce) return null;
  const out: Omit<Challenge, 'nc'> = { realm: params.realm, nonce: params.nonce };
  if (params.qop) out.qop = params.qop;
  if (params.opaque) out.opaque = params.opaque;
  if (params.algorithm) out.algorithm = params.algorithm;
  return out;
}

/** Construye el valor de la cabecera `Authorization` para una petición. */
export function buildDigestHeader(
  creds: DigestCredentials,
  challenge: Challenge,
  method: string,
  uri: string,
  cnonce: string,
): string {
  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  const nc = challenge.nc.toString(16).padStart(8, '0');

  // qop puede venir como lista ("auth,auth-int"); solo soportamos "auth".
  const qopList = (challenge.qop || '').split(',').map((q) => q.trim().toLowerCase());
  const useQop = qopList.includes('auth') ? 'auth' : undefined;

  let ha1 = md5(`${creds.username}:${challenge.realm}:${creds.password}`);
  if (algorithm === 'MD5-SESS') {
    ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  }
  const ha2 = md5(`${method.toUpperCase()}:${uri}`);

  const response = useQop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${useQop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${creds.username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (useQop) parts.push(`qop=${useQop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export interface DigestFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * `fetch` con autenticación Digest transparente.
 * Devuelve la `Response` final (ya autenticada) sin leer el cuerpo.
 */
export async function digestFetch(
  url: string,
  creds: DigestCredentials,
  options: DigestFetchOptions = {},
): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase();
  const parsed = new URL(url);
  const origin = parsed.origin;
  // El `uri` del digest es el path + query tal cual viaja en la request line.
  const requestUri = `${parsed.pathname}${parsed.search}`;

  const timeoutMs = options.timeoutMs ?? 15000;

  async function send(authorization?: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
      if (authorization) headers.Authorization = authorization;
      return await fetch(url, { method, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  function signWith(challenge: Challenge): string {
    challenge.nc += 1;
    return buildDigestHeader(creds, challenge, method, requestUri, randomBytes(8).toString('hex'));
  }

  /** Adopta el challenge que viene en un 401 y lo deja cacheado. */
  function adopt(res: Response): Challenge | null {
    const header = res.headers.get('www-authenticate');
    const advertised = header ? parseDigestChallenge(header) : null;
    if (!advertised) return null;
    const fresh: Challenge = { ...advertised, nc: 0 };
    challengeCache.set(origin, fresh);
    return fresh;
  }

  // 1) Si ya conocemos el challenge de este origen, firmamos de entrada.
  const cached = challengeCache.get(origin);
  if (cached) {
    const res = await send(signWith(cached));
    if (res.status !== 401) return res;
    // Nonce rotado (cambia a diario): el 401 ya trae el challenge nuevo.
    if (challengeCache.get(origin) === cached) challengeCache.delete(origin);
    const renewed = adopt(res);
    if (!renewed) return res; // 401 real (credenciales), que lo maneje el llamador.
    return send(signWith(renewed));
  }

  // 2) Si otra petición ya está negociando este origen, esperamos su challenge
  //    en vez de mandar otro 401.
  const inFlight = pendingNegotiations.get(origin);
  if (inFlight) {
    const shared = await inFlight;
    if (shared) return send(signWith(shared));
  }

  // 3) Negociación: petición sin credenciales para obtener el challenge.
  let settle: (challenge: Challenge | null) => void = () => {};
  const negotiation = new Promise<Challenge | null>((resolve) => {
    settle = resolve;
  });
  pendingNegotiations.set(origin, negotiation);

  try {
    const unauth = await send();
    if (unauth.status !== 401) {
      settle(null);
      return unauth;
    }
    const challenge = adopt(unauth);
    settle(challenge);
    if (!challenge) {
      return unauth; // No es Digest (o el servidor no envió challenge).
    }
    return send(signWith(challenge));
  } catch (err) {
    settle(null);
    throw err;
  } finally {
    pendingNegotiations.delete(origin);
  }
}

/** Vacía el cache de challenges (útil en pruebas). */
export function resetDigestCache(): void {
  challengeCache.clear();
  pendingNegotiations.clear();
}
