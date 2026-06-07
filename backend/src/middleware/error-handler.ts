import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CATALOG_ITEM_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'CONFLICT'
  | 'CONNECTOR_ERROR'
  | 'INTERNAL_ERROR';

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetail[];
}

export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly details?: ApiErrorDetail[];

  constructor(
    code: ApiErrorCode,
    statusCode: number,
    message: string,
    details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
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

  static forbidden(message = 'No tiene permisos para realizar esta operación.'): ApiError {
    return new ApiError('FORBIDDEN', 403, message);
  }

  static conflict(message = 'El recurso ya existe o la operación no es válida en el estado actual.'): ApiError {
    return new ApiError('CONFLICT', 409, message);
  }

  static connectorError(message = 'Error consultando un sistema externo.'): ApiError {
    return new ApiError('CONNECTOR_ERROR', 502, message);
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      const body: ApiErrorBody = {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
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
