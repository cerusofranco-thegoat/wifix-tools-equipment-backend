/**
 * Wrapper de auditoría para llamadas a conectores.
 * Registra en ConnectorCallLog: conector, operación, cuenta, status,
 * request (con credenciales redactadas), response, duración y actor.
 *
 * Regla: ningún error de auditoría rompe la operación principal.
 * Si la escritura en BD falla, se emite un warning de log y se continúa.
 */

import pino from 'pino';
import { prisma } from '../db/prisma.js';
import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';

const logger = pino({ name: 'connector-audit', level: env.LOG_LEVEL });

// ---------------------------------------------------------------------------
// Redacción de credenciales / secretos
// ---------------------------------------------------------------------------

/**
 * Lista de claves cuyo valor debe reemplazarse por "[REDACTED]" antes de persistir.
 * Insensible a mayúsculas.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'accesskey',
  'access_key',
  'secretkey',
  'secret_key',
  'private_key',
  'privatekey',
  'client_secret',
  'clientsecret',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      result[k] = '[REDACTED]';
    } else {
      result[k] = redact(v, depth + 1);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Interfaz pública
// ---------------------------------------------------------------------------

export interface AuditContext {
  connector: string;
  operation: string;
  accountNumber?: string;
  actorId?: string | null;
}

/**
 * Envuelve una llamada a conector con auditoría a ConnectorCallLog.
 *
 * Uso:
 * ```ts
 * const result = await withConnectorAudit(
 *   { connector: 'ticketing', operation: 'generaTicket', accountNumber, actorId },
 *   () => ticketing.generaTicket({ accountNumber, description }),
 * );
 * ```
 */
export async function withConnectorAudit<T>(
  ctx: AuditContext,
  fn: () => Promise<T>,
  requestPayload?: Record<string, unknown>,
): Promise<T> {
  const startMs = Date.now();
  let status: 'SUCCESS' | 'ERROR' = 'SUCCESS';
  let responsePayload: unknown = null;

  try {
    const result = await fn();
    responsePayload = result;
    return result;
  } catch (err) {
    status = 'ERROR';
    const errMsg = err instanceof Error ? err.message : String(err);
    responsePayload = { error: errMsg };
    throw err;
  } finally {
    const durationMs = Date.now() - startMs;
    const safeRequest = requestPayload ? (redact(requestPayload) as Record<string, unknown>) : null;
    const safeResponse = responsePayload !== null
      ? (redact(responsePayload) as Record<string, unknown>)
      : null;

    // status: Int en el schema — se mapea a HTTP-like codes: 200 success, 500 error.
    const statusCode = status === 'SUCCESS' ? 200 : 500;

    // Fire-and-forget: nunca lanza hacia el llamador
    prisma.connectorCallLog
      .create({
        data: {
          connector: ctx.connector,
          operation: ctx.operation,
          accountNumber: ctx.accountNumber ?? null,
          status: statusCode,
          request: safeRequest != null ? (safeRequest as Prisma.InputJsonValue) : undefined,
          response: safeResponse != null ? (safeResponse as Prisma.InputJsonValue) : undefined,
          durationMs,
          actorId: ctx.actorId ?? null,
        },
      })
      .catch((auditErr: Error) => {
        logger.warn(
          { connector: ctx.connector, operation: ctx.operation, err: auditErr.message },
          'Auditoría de conector: fallo al escribir en ConnectorCallLog (operación no interrumpida)',
        );
      });
  }
}
