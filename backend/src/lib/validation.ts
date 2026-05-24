import type { ZodError} from 'zod';
import { type ZodSchema } from 'zod';
import { ApiError, type ApiErrorDetail } from '../middleware/error-handler.js';

export function zodErrorToDetails(error: ZodError): ApiErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.map(String).join('.') : '(raíz)',
    issue: issue.message,
  }));
}

export function zodErrorToApiError(error: ZodError, label = 'la solicitud'): ApiError {
  return ApiError.validation(
    `Los datos de ${label} contienen errores de validación.`,
    zodErrorToDetails(error),
  );
}

export function parseOrThrow<T>(
  schema: ZodSchema<T>,
  value: unknown,
  label = 'la solicitud',
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw zodErrorToApiError(result.error, label);
  }
  return result.data;
}

export function parseBody<T>(schema: ZodSchema<T>, value: unknown): T {
  return parseOrThrow(schema, value, 'el cuerpo de la solicitud');
}

export function parseQuery<T>(schema: ZodSchema<T>, value: unknown): T {
  return parseOrThrow(schema, value, 'los parámetros de consulta');
}

export function parseParams<T>(schema: ZodSchema<T>, value: unknown): T {
  return parseOrThrow(schema, value, 'los parámetros de la ruta');
}
