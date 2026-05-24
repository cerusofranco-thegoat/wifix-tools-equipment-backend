import { z } from 'zod';
import { serviceContextSchema } from '../../schemas/service-context.js';
import { contextFiltersSchema, dateRangeSchema } from '../../schemas/filters.js';
import { paginationSchema } from '../../lib/pagination.js';

export const REMOVAL_REASON_CODES = [
  'DANO_FISICO',
  'NO_ENCIENDE',
  'PUERTO_DANADO',
  'EQUIPO_INHIBIDO',
  'NO_DA_SERVICIO',
  'NO_SE_APROVISIONA',
  'EQUIPO_OK_CANCELACION',
  'OTROS',
] as const;

export const retiredEquipmentInputSchema = serviceContextSchema.extend({
  equipmentModelId: z.string().uuid('equipmentModelId debe ser un UUID v4 válido.'),
  serialValue: z.string().min(1, 'serialValue es obligatorio.'),
  barcodePhotoId: z.string().uuid().optional(),
  removalReasonCode: z.enum(REMOVAL_REASON_CODES),
  observations: z.string().optional(),
  retiredAt: z.coerce.date(),
});

export type RetiredEquipmentInput = z.infer<typeof retiredEquipmentInputSchema>;

export const retiredEquipmentFiltersSchema = contextFiltersSchema
  .extend({
    removalReasonCode: z.enum(REMOVAL_REASON_CODES).optional(),
    serialValue: z.string().min(1).optional(),
  })
  .merge(dateRangeSchema)
  .merge(paginationSchema);

export type RetiredEquipmentFilters = z.infer<typeof retiredEquipmentFiltersSchema>;
