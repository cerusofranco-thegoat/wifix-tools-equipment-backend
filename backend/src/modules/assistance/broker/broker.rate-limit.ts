/**
 * Rate-limiting del broker de sesión remota.
 *
 * Aplica límites diferenciados a los puntos de mayor valor del módulo asistencia:
 *
 *   1. POST /asistencia/v1/sessions/:id/remote-sessions
 *      Emisión de sessionToken de un solo uso. Límite por agentId (del JWT) + IP.
 *      Umbral: BROKER_RATE_LIMIT_MAX req / BROKER_RATE_LIMIT_WINDOW_MS ms.
 *      Default: 10 req / 60 000 ms.
 *
 *   2. GET /asistencia/v1/broker/connect  (upgrade WS del agente)
 *   3. GET /asistencia/v1/broker/tunnel   (upgrade WS del técnico)
 *      Conexiones WS por IP. Umbral: BROKER_WS_RATE_LIMIT_MAX / BROKER_RATE_LIMIT_WINDOW_MS.
 *      Default: 30 / 60 000 ms.
 *
 * Los límites se aplican SOLO a las rutas del módulo asistencia registrando
 * @fastify/rate-limit en el sub-plugin de asistencia con `global: false`.
 * No afectan a herramientas u otros módulos del backend.
 *
 * Las rutas específicas leen su configuración desde `FastifyContextConfig.rateLimit`
 * (mecanismo estándar de @fastify/rate-limit para overrides por-ruta).
 *
 * Mensajes de error: español (message), código en inglés (code), HTTP 429.
 */

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import { env } from '../../../config/env.js';

// ---------------------------------------------------------------------------
// Helpers de construcción de mensajes de error
// ---------------------------------------------------------------------------

function secondsUntilReset(ttlMs: number): number {
  return Math.ceil(ttlMs / 1000);
}

// ---------------------------------------------------------------------------
// Registro del plugin (scope: módulo asistencia)
// ---------------------------------------------------------------------------

/**
 * Registra @fastify/rate-limit acotado al sub-plugin del módulo asistencia.
 *
 * Se llama UNA VEZ desde el sub-plugin de asistencia (dentro del `app.register`
 * con prefix /asistencia/v1) para que los límites solo apliquen a esas rutas.
 *
 * `global: false` evita que el plugin aplique un límite por defecto a TODAS
 * las rutas del scope; los límites se definen explícitamente por-ruta mediante
 * la opción `config.rateLimit` en cada handler.
 *
 * @param app  Instancia de Fastify (el sub-plugin de asistencia).
 */
export async function registerBrokerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false, // sin límite global; cada ruta define el suyo
    // Store en memoria (por defecto); adecuado para una instancia.
    // En multi-instancia se reemplazaría por un store Redis.
    errorResponseBuilder: (_request, context) => ({
      code: 'RATE_LIMITED',
      message: `Demasiadas solicitudes. Intente nuevamente en ${secondsUntilReset(context.ttl)} segundos.`,
      retryAfter: secondsUntilReset(context.ttl),
    }),
    addHeaders: {
      'x-ratelimit-limit': false,
      'x-ratelimit-remaining': false,
      'x-ratelimit-reset': false,
      'retry-after': true,
    },
  });
}

// ---------------------------------------------------------------------------
// Configuraciones por-ruta
// ---------------------------------------------------------------------------

/**
 * Config de rate-limit para POST /sessions/:id/remote-sessions.
 *
 * Clave: agentId (sub del JWT) + IP. Si el JWT no está disponible en el
 * momento del rate-check (el plugin corre en onRequest, antes de que el
 * middleware de auth decore el request), recae en IP sola.
 *
 * Nota: el middleware de auth de Wifix añade `request.authUser` en onRequest.
 * @fastify/rate-limit corre también en onRequest; el orden de registro
 * determina cuál va primero. Dado que registramos rate-limit ANTES de auth,
 * usamos IP como clave primaria (conservador y correcto).
 */
export const remoteSessionRateLimitConfig: RateLimitOptions = {
  max: env.BROKER_RATE_LIMIT_MAX,
  timeWindow: env.BROKER_RATE_LIMIT_WINDOW_MS,
  keyGenerator: (request: FastifyRequest): string => `broker:rs:${request.ip}`,
  errorResponseBuilder: (_request, context) => ({
    code: 'RATE_LIMITED',
    message: `Límite de emisión de sesiones remotas alcanzado. Intente nuevamente en ${secondsUntilReset(context.ttl)} segundos.`,
    retryAfter: secondsUntilReset(context.ttl),
  }),
};

/**
 * Config de rate-limit para rutas WS del broker.
 * Se aplica a /broker/connect (agente) y /broker/tunnel (técnico).
 * Clave: IP (el JWT se verifica después del handshake WS).
 */
export const wsRateLimitConfig: RateLimitOptions = {
  max: env.BROKER_WS_RATE_LIMIT_MAX,
  timeWindow: env.BROKER_RATE_LIMIT_WINDOW_MS,
  keyGenerator: (request: FastifyRequest): string => `broker:ws:${request.ip}`,
  errorResponseBuilder: (_request, context) => ({
    code: 'RATE_LIMITED',
    message: `Demasiados intentos de conexión al broker. Intente nuevamente en ${secondsUntilReset(context.ttl)} segundos.`,
    retryAfter: secondsUntilReset(context.ttl),
  }),
};
