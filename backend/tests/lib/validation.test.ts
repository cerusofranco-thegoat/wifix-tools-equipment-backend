import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseOrThrow, zodErrorToDetails } from '../../src/lib/validation.js';
import { ApiError } from '../../src/middleware/error-handler.js';

const userSchema = z.object({
  name: z.string().min(1, 'El nombre es obligatorio.'),
  age: z.number().int().nonnegative('La edad no puede ser negativa.'),
  email: z.string().email().optional(),
});

describe('parseOrThrow', () => {
  it('devuelve el valor parseado cuando es válido', () => {
    const result = parseOrThrow(userSchema, { name: 'Ana', age: 30 });
    expect(result).toEqual({ name: 'Ana', age: 30 });
  });

  it('lanza ApiError con código VALIDATION_ERROR y detalles por campo', () => {
    try {
      parseOrThrow(userSchema, { name: '', age: -1, email: 'no-email' });
      throw new Error('no lanzó');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.statusCode).toBe(400);
      expect(apiErr.details).toBeDefined();
      expect(apiErr.details!.length).toBe(3);
      const fields = apiErr.details!.map((d) => d.field);
      expect(fields).toContain('name');
      expect(fields).toContain('age');
      expect(fields).toContain('email');
    }
  });

  it('usa "(raíz)" como campo cuando el error es a nivel raíz', () => {
    const issues = userSchema.safeParse('no es un objeto');
    expect(issues.success).toBe(false);
    if (!issues.success) {
      const details = zodErrorToDetails(issues.error);
      expect(details[0].field).toBe('(raíz)');
    }
  });
});
