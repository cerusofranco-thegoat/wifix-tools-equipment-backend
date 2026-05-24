import { isFutureBeyondSkew } from './datetime.js';
import { ApiError } from '../middleware/error-handler.js';

export function assertNotFuture(value: Date, field: string): void {
  if (isFutureBeyondSkew(value)) {
    throw ApiError.validation(`El campo ${field} no puede ser una fecha futura.`, [
      { field, issue: 'fecha futura no permitida' },
    ]);
  }
}
