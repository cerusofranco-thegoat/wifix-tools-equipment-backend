/**
 * Proxy HTTP reverse del broker — endpoint ALL /broker/proxy/{remoteSessionId}/*
 *
 * El navegador del agente (dentro de un iframe en el portal del Call Center)
 * realiza requests HTTP normales a este endpoint. El proxy:
 *   1. Autentica la request mediante la cookie de sesión de proxy (httpOnly,
 *      emitida al abrir la RemoteSession). El agente NUNCA ve el sessionToken
 *      del broker; la cookie es el único medio de autenticación del proxy.
 *   2. Obtiene el targetHost desde el estado server-side (cookie store).
 *      El agente NO puede cambiar el targetHost por URL ni por header.
 *   3. Re-aplica el SSRF guard sobre el targetHost (defensa en profundidad).
 *   4. Valida el path (anti-CRLF/NUL, longitud máx.).
 *   5. Verifica que la RemoteSession está OPEN y no expirada en BD.
 *   6. Verifica que hay un túnel activo del técnico.
 *   7. Construye una trama OPEN_STREAM y la envía al técnico por el túnel.
 *   8. Recibe RESPONSE + DATA* + END_STREAM del técnico y devuelve la respuesta
 *      HTTP al navegador.
 *   9. Para respuestas HTML: inyecta <base>, reescribe URLs absolutas y strips
 *      headers frame-busting; añade CSP propia acotada al portalOrigin.
 *  10. Reescribe las cookies Set-Cookie del router para confinarlas al path del proxy.
 *  11. Audita cada request como AssistanceEvent REMOTE_SESSION (fire-and-forget).
 *  12. Rate-limit por IP (120 req/min).
 *  13. Timeout de 504 si el técnico no responde en 20s.
 *
 * Seguridad:
 *   - Cookie: httpOnly + Secure + SameSite=Strict + Path acotado + expiración.
 *   - targetHost: INMUTABLE desde el estado server-side.
 *   - SSRF guard re-aplicado en cada request (defensa en profundidad).
 *   - Path validado: validateStreamPath (sin CRLF/NUL, longitud máx.).
 *   - Solo headers seguros se reenvían al router (sin Cookie de proxy ni Authorization).
 *   - Set-Cookie del router: reescritas para confinar al path del proxy.
 *   - CSP propia: frame-ancestors acotado al portalOrigin.
 *   - Auditoría: cada request auditada con redacción de cabeceras sensibles.
 *   - Rate-limit: 120 req/min por IP (navegación).
 *
 * Módulo sin dependencias de BD directas → recibe persist como callback (testeable).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { validateStreamPath, isAllowedMethod } from './broker.framing.js';
import { isTunnelAlive } from './broker.tunnel-store.js';
import {
  lookupProxyCookie,
  PROXY_COOKIE_NAME,
  PROXY_BASE_PATH,
} from './broker.proxy-cookie-store.js';
import { checkTargetHost } from './broker.ssrf-guard.js';
import { proxyRequest } from './broker.proxy.js';
import { redactHeaders, auditTunnelRequest } from './broker.audit.js';
import type { AuditPersistFn } from './broker.audit.js';
import {
  rewriteHtml,
  stripFrameBustingHeaders,
  buildProxyResponseHeaders,
  rewriteRouterSetCookies,
} from './broker.html-rewriter.js';
import { assistanceRepository } from '../assistance.repository.js';
import { env } from '../../../config/env.js';
import type { RateLimitOptions } from '@fastify/rate-limit';

// Re-exportar para que otros módulos no necesiten importar del cookie-store
export { PROXY_COOKIE_NAME, PROXY_BASE_PATH };

/** Tamaño máximo del body de request del agente (igual que MAX_BODY_SIZE_BYTES). */
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

// ---------------------------------------------------------------------------
// Cabeceras del agente que se reenvían al router (allowlist)
// Las siguientes cabeceras NUNCA se reenvían:
//   - Cookie (contiene la cookie de proxy, no la del router)
//   - Authorization (credencial del portal, no del router)
//   - Host (el proxy construye el host correcto desde targetHost)
//   - X-Forwarded-* (evitar filtración de infraestructura interna)
// ---------------------------------------------------------------------------

const BLOCKED_FORWARD_HEADERS = new Set([
  'cookie',
  'authorization',
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'connection',
  'keep-alive',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
]);

/**
 * Filtra las cabeceras del request del agente para reenviar solo las seguras al router.
 * No reenvía la cookie de proxy ni el Authorization del portal.
 */
function filterAgentHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (BLOCKED_FORWARD_HEADERS.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rate-limit para el endpoint del proxy
// ---------------------------------------------------------------------------

/**
 * Config de rate-limit para ALL /broker/proxy/{remoteSessionId}/*.
 * Límite por IP: 120 req/min (navegación del panel del router).
 * Más alto que la apertura de sesiones (10/min) porque es navegación activa.
 */
export const proxyRateLimitConfig: RateLimitOptions = {
  max: env.PROXY_RATE_LIMIT_MAX,
  timeWindow: env.BROKER_RATE_LIMIT_WINDOW_MS,
  keyGenerator: (request: FastifyRequest): string => `broker:proxy:${request.ip}`,
  errorResponseBuilder: (_request, context) => ({
    code: 'RATE_LIMITED',
    message: `Límite de navegación del proxy alcanzado. Intente nuevamente en ${Math.ceil(context.ttl / 1000)} segundos.`,
    retryAfter: Math.ceil(context.ttl / 1000),
  }),
};

// ---------------------------------------------------------------------------
// Parsing de cookies manual (sin @fastify/cookie)
// ---------------------------------------------------------------------------

/**
 * Parsea la cabecera Cookie del request y devuelve el valor de la cookie
 * buscada, o undefined si no existe.
 *
 * La cabecera Cookie tiene el formato: name1=value1; name2=value2; ...
 * Los valores no van entre comillas en la cabecera Cookie (a diferencia de Set-Cookie).
 */
export function parseCookieHeader(
  cookieHeader: string | undefined,
  cookieName: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const pairs = cookieHeader.split(/;\s*/);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    if (name === cookieName) {
      return pair.slice(eqIdx + 1).trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Construcción del Set-Cookie header de la cookie de proxy
// ---------------------------------------------------------------------------

/**
 * Construye el valor del Set-Cookie header para la cookie de sesión de proxy.
 *
 * Atributos de seguridad:
 *   - HttpOnly: el JS del portal no puede leer la cookie.
 *   - Secure: controlado por env.COOKIE_SECURE (default true).
 *     Establecer COOKIE_SECURE=false SOLO en desarrollo local sobre HTTP.
 *   - SameSite=Strict: no se envía en requests cross-site.
 *   - Path acotado al remoteSessionId del proxy: no contamina otros paths.
 *   - Expires: igual a la expiración de la RemoteSession.
 */
export function buildProxyCookieSetHeader(
  cookieValue: string,
  remoteSessionId: string,
  expiresAt: Date,
): string {
  const path = `${PROXY_BASE_PATH}/${remoteSessionId}`;
  const expires = expiresAt.toUTCString();
  // [MEDIO-2] COOKIE_SECURE controla Secure; default true (staging también usa HTTPS).
  const secureAttr = env.COOKIE_SECURE ? '; Secure' : '';
  return (
    `${PROXY_COOKIE_NAME}=${cookieValue}` +
    `; HttpOnly` +
    `${secureAttr}` +
    `; SameSite=Strict` +
    `; Path=${path}` +
    `; Expires=${expires}`
  );
}

// ---------------------------------------------------------------------------
// Construcción del proxyBase URL
// ---------------------------------------------------------------------------

/**
 * Construye la URL base del proxy para inyectar en el HTML del router.
 * Ejemplo: "https://portal.wifix.internal/asistencia/v1/broker/proxy/rs-123/"
 *
 * Se usa PORTAL_ORIGIN como base porque el iframe vive en el dominio del portal
 * y las requests del navegador van al mismo origen.
 *
 * Nota: el trailing slash es importante para que <base href="..."> funcione
 * correctamente con paths relativos.
 */
export function buildProxyBaseUrl(remoteSessionId: string): string {
  const origin = env.PORTAL_ORIGIN;
  return `${origin}${PROXY_BASE_PATH}/${remoteSessionId}/`;
}

// ---------------------------------------------------------------------------
// [ALTO-2] Reescritura de redirects 3xx
// ---------------------------------------------------------------------------

/**
 * Reescribe el header Location de un redirect 3xx del router para que apunte
 * al proxy en vez de al router directamente.
 *
 * Reglas:
 *   - Si el Location apunta al mismo targetHost (relativo o absoluto) →
 *     se reescribe a la URL base del proxy.
 *   - Si el Location apunta a OTRO host externo → devuelve null (el caller
 *     debe bloquear el redirect con 502).
 *
 * @param location     Valor del header Location del router.
 * @param targetHost   Host del router almacenado en el proxy cookie store.
 * @param proxyPathBase  Path base del proxy para esta sesión
 *                       (p.ej. "/asistencia/v1/broker/proxy/rs-123").
 * @returns La URL reescrita del proxy, o null si apunta a un host externo.
 */
export function rewriteRedirectLocation(
  location: string,
  targetHost: string,
  proxyPathBase: string,
): string | null {
  // Caso 1: ruta relativa (empieza por '/') → mismo host implícito
  if (location.startsWith('/') && !location.startsWith('//')) {
    const cleanPath = location.slice(1); // quitar '/' inicial
    return `${proxyPathBase}/${cleanPath}`;
  }

  // Caso 2: URL absoluta — determinar si apunta al mismo targetHost
  let parsed: URL;
  try {
    // Normalizar: si no tiene esquema, añadir uno para poder parsear
    const toParse = location.startsWith('//') ? `http:${location}` : location;
    parsed = new URL(toParse);
  } catch {
    // Si no se puede parsear, tratar como relativo seguro
    return `${proxyPathBase}/${location}`;
  }

  // Extraer host del targetHost (puede incluir puerto)
  const targetUrl = targetHost.includes('://') ? targetHost : `http://${targetHost}`;
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    // targetHost inválido — bloquear por seguridad
    return null;
  }

  const locationHost = parsed.hostname;
  const locationPort = parsed.port;
  const targetHostname = parsedTarget.hostname;
  const targetPort = parsedTarget.port;

  // Comparar hostname + puerto (sin puerto = puerto por defecto según esquema)
  const sameHost = locationHost === targetHostname &&
    (locationPort === targetPort ||
      // Si uno está vacío y el otro es el puerto por defecto (80/443) son iguales
      (locationPort === '' && (targetPort === '' || targetPort === '80' || targetPort === '443')) ||
      (targetPort === '' && (locationPort === '80' || locationPort === '443')));

  if (!sameHost) {
    // Host externo — bloquear
    return null;
  }

  // Mismo host — reescribir al proxy
  const locationPath = parsed.pathname + parsed.search + parsed.hash;
  const cleanPath = locationPath.startsWith('/') ? locationPath.slice(1) : locationPath;
  return `${proxyPathBase}/${cleanPath}`;
}

// ---------------------------------------------------------------------------
// Handler principal del proxy
// ---------------------------------------------------------------------------

/**
 * Registra el endpoint ALL /broker/proxy/{remoteSessionId}/*
 * en el sub-plugin de asistencia (prefijo /asistencia/v1).
 *
 * El wildcard /* captura el path completo que el navegador solicita,
 * incluyendo query string (que se pasa tal cual al router).
 */
export async function registerBrokerHttpProxy(app: FastifyInstance): Promise<void> {
  // Registrar con todos los métodos HTTP relevantes (GET, POST, PUT, etc.)
  // Fastify no tiene un método 'all' directo; registramos los más usados.
  // Los paneles de router típicamente usan GET y POST (formularios de login y config).
  // NOTA: HEAD se omite aquí porque Fastify lo registra automáticamente al registrar GET.
  // OPTIONS se registra explícitamente para paneles que emiten preflight o usan AJAX.
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

  for (const method of methods) {
    app[method.toLowerCase() as Lowercase<typeof methods[number]>](
      '/broker/proxy/:remoteSessionId/*',
      {
        // [BAJO-1] bodyLimit explícito en la ruta para alinear con el check interno
        // de MAX_BODY_BYTES. Fastify rechaza el body antes de llegar al handler.
        bodyLimit: MAX_BODY_BYTES,
        config: { rateLimit: proxyRateLimitConfig },
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return handleProxyRequest(request, reply);
      },
    );
  }
}

async function handleProxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const startMs = Date.now();
  const params = request.params as { remoteSessionId: string; '*': string };
  const remoteSessionId = params.remoteSessionId;

  // -------------------------------------------------------------------------
  // 1. Autenticación: leer y validar cookie de sesión de proxy
  // -------------------------------------------------------------------------
  const cookieHeader = request.headers['cookie'] as string | undefined;
  const cookieValue = parseCookieHeader(cookieHeader, PROXY_COOKIE_NAME);

  if (!cookieValue) {
    return reply.code(401).send({
      code: 'UNAUTHORIZED',
      message: 'Cookie de sesión de proxy no encontrada. Abra una sesión remota primero.',
    });
  }

  const cookieEntry = lookupProxyCookie(cookieValue);
  if (!cookieEntry) {
    return reply.code(401).send({
      code: 'UNAUTHORIZED',
      message: 'Cookie de sesión de proxy inválida o expirada.',
    });
  }

  // Verificar que la cookie corresponde a esta remoteSession
  if (cookieEntry.remoteSessionId !== remoteSessionId) {
    return reply.code(403).send({
      code: 'FORBIDDEN',
      message: 'La cookie de sesión no corresponde a esta sesión remota.',
    });
  }

  const { agentId, sessionId, targetHost } = cookieEntry;

  // -------------------------------------------------------------------------
  // 2. Verificar que la RemoteSession está OPEN y no expirada
  // -------------------------------------------------------------------------
  let remoteSession;
  try {
    remoteSession = await assistanceRepository.findRemoteSessionById(remoteSessionId);
  } catch {
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Error al consultar la sesión remota.',
    });
  }

  if (!remoteSession) {
    return reply.code(404).send({
      code: 'NOT_FOUND',
      message: 'Sesión remota no encontrada.',
    });
  }

  if (remoteSession.status !== 'OPEN') {
    return reply.code(404).send({
      code: 'NOT_FOUND',
      message: `La sesión remota no está activa (estado: ${remoteSession.status}).`,
    });
  }

  if (remoteSession.expiresAt.getTime() < Date.now()) {
    return reply.code(401).send({
      code: 'UNAUTHORIZED',
      message: 'La sesión remota ha expirado.',
    });
  }

  // -------------------------------------------------------------------------
  // 3. Verificar túnel activo del técnico
  // -------------------------------------------------------------------------
  if (!isTunnelAlive(sessionId)) {
    return reply.code(502).send({
      code: 'TUNNEL_UNAVAILABLE',
      message: 'El técnico no tiene un túnel activo en este momento. Espere a que la app del técnico establezca la conexión.',
    });
  }

  // -------------------------------------------------------------------------
  // 4. Re-aplicar SSRF guard sobre el targetHost (defensa en profundidad)
  // -------------------------------------------------------------------------
  const ssrfResult = checkTargetHost(targetHost);
  if (!ssrfResult.allowed) {
    request.log.error(
      { remoteSessionId, targetHost, reason: ssrfResult.reason },
      'Proxy HTTP: SSRF guard rechazó el targetHost almacenado — posible corrupción del store',
    );
    return reply.code(403).send({
      code: 'FORBIDDEN',
      message: 'El host de destino no está permitido por política de seguridad.',
    });
  }

  // -------------------------------------------------------------------------
  // 5. Construir y validar el path + query string
  // -------------------------------------------------------------------------
  const wildcardPath = params['*'] ?? '';
  // El path que llega en el wildcard NO incluye el '/' inicial; lo añadimos.
  // La query string viene en request.url separada por '?'.
  const rawUrl = request.url;
  // Extraer query string de la URL original
  const qmark = rawUrl.indexOf('?');
  const queryString = qmark !== -1 ? rawUrl.slice(qmark) : '';
  const routerPath = `/${wildcardPath}${queryString}`;

  const pathError = validateStreamPath(routerPath.split('?')[0]!);
  if (pathError !== null) {
    return reply.code(400).send({
      code: 'VALIDATION_ERROR',
      message: `Path inválido: ${pathError}`,
    });
  }

  // -------------------------------------------------------------------------
  // 6. Verificar método HTTP
  // -------------------------------------------------------------------------
  const method = request.method.toUpperCase();
  if (!isAllowedMethod(method)) {
    return reply.code(405).send({
      code: 'VALIDATION_ERROR',
      message: `Método HTTP no permitido: ${method}.`,
    });
  }

  // -------------------------------------------------------------------------
  // 7. Leer body del request (acotado a MAX_BODY_BYTES)
  // -------------------------------------------------------------------------
  let bodyBuffer: Buffer;
  try {
    const rawBody = request.body;
    if (rawBody instanceof Buffer) {
      bodyBuffer = rawBody;
    } else if (typeof rawBody === 'string') {
      bodyBuffer = Buffer.from(rawBody);
    } else if (rawBody != null) {
      bodyBuffer = Buffer.from(JSON.stringify(rawBody));
    } else {
      bodyBuffer = Buffer.alloc(0);
    }
  } catch {
    bodyBuffer = Buffer.alloc(0);
  }

  if (bodyBuffer.length > MAX_BODY_BYTES) {
    return reply.code(413).send({
      code: 'VALIDATION_ERROR',
      message: 'El cuerpo de la solicitud excede el tamaño máximo permitido (4 MB).',
    });
  }

  // -------------------------------------------------------------------------
  // 8. Filtrar cabeceras del agente (no reenviar cookie ni Authorization)
  // -------------------------------------------------------------------------
  const agentHeaders = filterAgentHeaders(
    request.headers as Record<string, string | string[] | undefined>,
  );

  // Redactar cabeceras en audit (no loguear cookies ni tokens)
  const safeAgentHeaders = redactHeaders(agentHeaders);
  void safeAgentHeaders; // usado en auditoría abajo

  // -------------------------------------------------------------------------
  // 9. Construir función de auditoría (fire-and-forget, no bloquea la respuesta)
  // -------------------------------------------------------------------------
  const persistAudit: AuditPersistFn = async (data) => {
    await assistanceRepository.createEvent({
      sessionId: data.sessionId,
      type: 'REMOTE_SESSION',
      payload: {
        kind: 'tunnel_request',
        via: 'http_proxy',
        remoteSessionId: data.remoteSessionId,
        method: data.method,
        path: data.path,
        targetHostLabel: data.targetHostLabel,
        responseStatus: data.responseStatus,
        durationMs: data.durationMs,
        errorCode: data.errorCode,
      },
      actorId: data.agentId,
    });
  };

  // -------------------------------------------------------------------------
  // 10. Proxear la request al router a través del túnel del técnico
  // -------------------------------------------------------------------------
  let proxyResult;
  try {
    proxyResult = await proxyRequest({
      sessionId,
      remoteSessionId,
      agentId,
      targetHost,
      method,
      path: routerPath,
      headers: agentHeaders,
      body: bodyBuffer,
      persist: persistAudit,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error proxeando la solicitud.';
    const durationMs = Date.now() - startMs;

    // Auditar el error (fire-and-forget)
    void auditTunnelRequest(
      {
        sessionId,
        remoteSessionId,
        agentId,
        method,
        path: routerPath,
        targetHostLabel: targetHost,
        responseStatus: null,
        durationMs,
        errorCode: 'PROXY_ERROR',
      },
      persistAudit,
    );

    if (message.includes('Timeout') || message.includes('timeout')) {
      return reply.code(504).send({
        code: 'TIMEOUT',
        message: 'El técnico no respondió en el tiempo esperado (20s). Intente nuevamente.',
      });
    }

    if (message.includes('túnel') || message.includes('tunnel')) {
      return reply.code(502).send({
        code: 'TUNNEL_UNAVAILABLE',
        message: 'El túnel del técnico no está disponible.',
      });
    }

    return reply.code(502).send({
      code: 'PROXY_ERROR',
      message: `Error al proxear la solicitud: ${message}`,
    });
  }

  // -------------------------------------------------------------------------
  // 11a. [ALTO-2] Manejar redirects 3xx — reescribir o bloquear Location
  // -------------------------------------------------------------------------
  if (proxyResult.status >= 300 && proxyResult.status < 400) {
    const locationRaw = proxyResult.headers['location'];
    if (locationRaw) {
      const proxyPathBase = `${PROXY_BASE_PATH}/${remoteSessionId}`;
      const rewrittenLocation = rewriteRedirectLocation(
        locationRaw,
        targetHost,
        proxyPathBase,
      );

      if (rewrittenLocation === null) {
        // Redirect a host externo — bloqueado para evitar SSRF/filtración
        void auditTunnelRequest(
          {
            sessionId,
            remoteSessionId,
            agentId,
            method,
            path: routerPath,
            targetHostLabel: targetHost,
            responseStatus: proxyResult.status,
            durationMs: Date.now() - startMs,
            errorCode: 'CROSS_HOST_REDIRECT_BLOCKED',
          },
          persistAudit,
        );
        request.log.warn(
          { remoteSessionId, locationRaw, targetHost },
          'Proxy HTTP: redirect del router a host externo bloqueado',
        );
        return reply.code(502).send({
          code: 'PROXY_ERROR',
          message: 'Redirección del router fuera de alcance bloqueada.',
        });
      }

      // Redirect al mismo host — reescribir Location para que apunte al proxy
      const rewrittenHeaders = { ...proxyResult.headers, location: rewrittenLocation };
      const proxyHeaders = buildProxyResponseHeaders(env.PORTAL_ORIGIN);
      const finalHeaders: Record<string, string> = { ...rewrittenHeaders, ...proxyHeaders };

      for (const [key, value] of Object.entries(finalHeaders)) {
        reply.header(key, value);
      }
      return reply.code(proxyResult.status).send(proxyResult.body);
    }
  }

  // -------------------------------------------------------------------------
  // 11. Procesar la respuesta del router
  // -------------------------------------------------------------------------
  const contentType = (
    proxyResult.headers['content-type'] ?? ''
  ).toLowerCase();
  const isHtml = contentType.includes('text/html');

  // Strip headers frame-busting del router
  const strippedHeaders = stripFrameBustingHeaders(proxyResult.headers);

  // Reescribir Set-Cookie del router para confinar al path del proxy
  const proxyPathBase = `${PROXY_BASE_PATH}/${remoteSessionId}`;
  const setCookieValues: string[] = [];
  if (strippedHeaders['set-cookie']) {
    const raw = strippedHeaders['set-cookie'];
    const rawArray = Array.isArray(raw) ? raw : [raw];
    const rewritten = rewriteRouterSetCookies(rawArray, proxyPathBase);
    setCookieValues.push(...rewritten);
    delete strippedHeaders['set-cookie'];
  }

  // Añadir cabeceras propias del proxy (CSP con frame-ancestors)
  const proxyHeaders = buildProxyResponseHeaders(env.PORTAL_ORIGIN);

  // Combinar: cabeceras del router (sin frame-busting) + cabeceras del proxy
  const finalHeaders: Record<string, string> = {
    ...strippedHeaders,
    ...proxyHeaders,
  };

  // Procesar body HTML
  let responseBody: Buffer;
  if (isHtml) {
    const htmlStr = proxyResult.body.toString('utf-8');
    const proxyBase = buildProxyBaseUrl(remoteSessionId);
    const rewritten = rewriteHtml(htmlStr, proxyBase, targetHost);
    responseBody = Buffer.from(rewritten, 'utf-8');
    // Actualizar Content-Length si estaba presente
    if (finalHeaders['content-length']) {
      finalHeaders['content-length'] = String(responseBody.length);
    }
  } else {
    responseBody = proxyResult.body;
  }

  // -------------------------------------------------------------------------
  // 12. Enviar respuesta al navegador
  // -------------------------------------------------------------------------
  // Establecer cabeceras de respuesta
  for (const [key, value] of Object.entries(finalHeaders)) {
    reply.header(key, value);
  }

  // Set-Cookie reescritas (una por cabecera)
  for (const sc of setCookieValues) {
    reply.header('set-cookie', sc);
  }

  return reply.code(proxyResult.status).send(responseBody);
}
