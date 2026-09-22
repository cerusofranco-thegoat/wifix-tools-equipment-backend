import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CATALOG_ITEM_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'CONNECTOR_ERROR'
  | 'UPSTREAM_AUTH_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetail[];
  /** Contexto adicional legible por máquina (integración, marca, motivo…). */
  meta?: Record<string, unknown>;
}

/** Por qué no se pudo autenticar contra la API de un tercero. */
export type UpstreamAuthReason = 'MISSING' | 'EXPIRED' | 'REJECTED';

export interface UpstreamAuthOptions {
  brand: string;
  reason: UpstreamAuthReason;
  expiresAt?: Date | null;
  /** Detalle de diagnóstico (nunca un secreto). */
  detail?: string;
}

/** dd/MM/yyyy HH:mm en UTC, para los mensajes al técnico. */
function formatExpiry(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly details?: ApiErrorDetail[];
  public readonly meta?: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    statusCode: number,
    message: string,
    details?: ApiErrorDetail[],
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.meta = meta;
  }

  static validation(message: string, details?: ApiErrorDetail[]): ApiError {
    return new ApiError('VALIDATION_ERROR', 400, message, details);
  }

  static notFound(message = 'Recurso no encontrado.'): ApiError {
    return new ApiError('NOT_FOUND', 404, message);
  }

  static catalogItemNotFound(message = 'Elemento de catálogo no encontrado.'): ApiError {
    return new ApiError('CATALOG_ITEM_NOT_FOUND', 404, message);
  }

  static mediaNotFound(message = 'Archivo de media no encontrado.'): ApiError {
    return new ApiError('MEDIA_NOT_FOUND', 404, message);
  }

  static unauthorized(message = 'No autorizado.'): ApiError {
    return new ApiError('UNAUTHORIZED', 401, message);
  }

  static connectorError(message = 'Error consultando un sistema externo.'): ApiError {
    return new ApiError('CONNECTOR_ERROR', 502, message);
  }

  /**
   * El token de una integración de terceros (hoy FSM) falta, venció o fue
   * rechazado. Es **503, nunca 401**: la webapp borra la sesión del técnico
   * ante cualquier 401 (`wifix-webapp/api.js`), y un token caducado de la
   * operadora no puede sacar al técnico al login en medio de una visita.
   */
  static upstreamAuth(opts: UpstreamAuthOptions): ApiError {
    const { brand, reason, expiresAt, detail } = opts;
    const message =
      reason === 'MISSING'
        ? `El acceso a FSM (marca ${brand}) no está configurado en el servidor. ` +
          `Los datos de la operadora no se pueden consultar; el resto de la app ` +
          `funciona con normalidad.`
        : reason === 'EXPIRED'
          ? `El token de FSM (marca ${brand}) venció el ` +
            `${expiresAt ? formatExpiry(expiresAt) : 'sin fecha conocida'}. ` +
            `Pide la renovación al contacto de la operadora.`
          : `FSM rechazó el token de la marca ${brand} (401). ` +
            `Puede estar revocado o pertenecer a otro realm.`;

    const meta: Record<string, unknown> = {
      integration: 'FSM',
      brand,
      reason,
      tokenExpiresAt: expiresAt ? expiresAt.toISOString() : null,
      retryable: false,
    };
    if (detail) meta.detail = detail;

    return new ApiError('UPSTREAM_AUTH_ERROR', 503, message, undefined, meta);
  }

  /**
   * La integración de un tercero (hoy FSM) está caída, no responde o devolvió
   * un error propio. Es **503 y nunca 404**: una cuenta no deja de existir
   * porque el sistema de la operadora no contesta, y un 404 en el perfil del
   * cliente deja al técnico sin pantalla en medio de una visita.
   *
   * Mismo sobre que `upstreamAuth` (`meta.integration` / `meta.reason`) para que
   * el frontend tenga un solo camino de "integración no disponible", con la
   * diferencia de que esto SÍ es reintentable.
   */
  static upstreamUnavailable(opts: {
    integration: string;
    brand?: string;
    reason: 'TIMEOUT' | 'UPSTREAM_ERROR' | 'NO_DATA';
    message?: string;
    detail?: string;
  }): ApiError {
    const { integration, brand, reason, detail } = opts;
    const message =
      opts.message ??
      `${integration} no está respondiendo en este momento. ` +
        `Los datos de la operadora no se pueden consultar; el resto de la app ` +
        `funciona con normalidad.`;
    const meta: Record<string, unknown> = {
      integration,
      reason,
      retryable: true,
    };
    if (brand) meta.brand = brand;
    if (detail) meta.detail = detail;
    return new ApiError('UPSTREAM_UNAVAILABLE', 503, message, undefined, meta);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
        ...(error.meta ? { meta: error.meta } : {}),
      };
      return reply.code(error.statusCode).send(body);
    }

    if (error instanceof ZodError) {
      const details: ApiErrorDetail[] = error.issues.map((issue) => ({
        field: issue.path.length ? issue.path.map(String).join('.') : '(raíz)',
        issue: issue.message,
      }));
      const body: ApiErrorBody = {
        code: 'VALIDATION_ERROR',
        message: 'Los datos de la solicitud contienen errores de validación.',
        details,
      };
      return reply.code(400).send(body);
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      const body: ApiErrorBody = {
        code: 'VALIDATION_ERROR',
        message: error.message || 'Solicitud inválida.',
      };
      return reply.code(error.statusCode).send(body);
    }

    request.log.error({ err: error }, 'Error interno no controlado');
    const body: ApiErrorBody = {
      code: 'INTERNAL_ERROR',
      message: 'Ocurrió un error interno. Intente nuevamente más tarde.',
    };
    return reply.code(500).send(body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiErrorBody = {
      code: 'NOT_FOUND',
      message: 'Ruta no encontrada.',
    };
    return reply.code(404).send(body);
  });
}
