// ---------------------------------------------------------------------------
// Cliente HTTP con autenticación Digest (RFC 2617 / RFC 7616, qop="auth").
//
// La API de TEC / ISP Monitor (tec-api.grupotvcable.com, IIS + ASP.NET) exige
// Digest: la primera petición responde 401 con la cabecera `WWW-Authenticate`
// y hay que repetirla firmando la respuesta con MD5.
//
// El challenge se cachea por origen: el servidor usa un nonce estático, así que
// tras la primera llamada las siguientes van firmadas de entrada (una sola
// vuelta). Si el servidor rota el nonce y devuelve 401, se descarta el cache y
// se reintenta una vez.
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

  // 1) Si ya conocemos el challenge de este origen, firmamos de entrada.
  const cached = challengeCache.get(origin);
  if (cached) {
    const res = await send(signWith(cached));
    if (res.status !== 401) return res;
    // Nonce caducado o rotado: descartamos el cache y renegociamos.
    challengeCache.delete(origin);
  }

  // 2) Negociación: petición sin credenciales para obtener el challenge.
  const unauth = cached ? await send() : await send();
  if (unauth.status !== 401) return unauth;

  const header = unauth.headers.get('www-authenticate');
  const parsedChallenge = header ? parseDigestChallenge(header) : null;
  if (!parsedChallenge) {
    return unauth; // No es Digest (o el servidor no envió challenge): que decida el llamador.
  }
  const challenge: Challenge = { ...parsedChallenge, nc: 0 };
  challengeCache.set(origin, challenge);

  return send(signWith(challenge));
}

/** Vacía el cache de challenges (útil en pruebas). */
export function resetDigestCache(): void {
  challengeCache.clear();
}
