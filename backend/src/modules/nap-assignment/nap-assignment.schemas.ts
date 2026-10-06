import { z } from 'zod';

/** Body de `POST /accounts/{accountNumber}/nap-assignment`. */
export const napAssignmentInputSchema = z
  .object({
    // FSM lo da numérico; se guarda como texto. null/ausente si la NAP no es de FSM.
    napId: z
      .union([z.string().trim().min(1).max(50), z.number().int().nonnegative()])
      .nullish()
      .transform((v) => (v === null || v === undefined ? null : String(v))),
    napCode: z
      .string({ required_error: 'napCode es obligatorio.' })
      .trim()
      .min(1, 'napCode es obligatorio.')
      .max(50, 'napCode excede 50 caracteres.'),
    napName: z.string().trim().max(200, 'napName excede 200 caracteres.').nullish(),
    port: z.number().int('port debe ser entero.').min(0).max(512).nullish(),
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
    distanceMeters: z.number().nonnegative('distanceMeters debe ser >= 0.').nullish(),
    source: z.enum(['FSM', 'TEC', 'MOCK']),
    taskId: z.string().trim().min(1).max(100).nullish(),
    workOrder: z.string().trim().min(1).max(120).nullish(),
  })
  // (0,0) es el "vacío" de los sistemas legados, no una NAP real.
  .refine((b) => !(b.latitude === 0 && b.longitude === 0), {
    message: 'La coordenada (0,0) no es válida.',
    path: ['latitude'],
  });

export type NapAssignmentInput = z.infer<typeof napAssignmentInputSchema>;

/** Query de `GET /nap-assignments` (vista de gerente, paginación por cursor). */
export const napAssignmentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().uuid('cursor inválido.').optional(),
  accountNumber: z.string().trim().min(1).max(50).optional(),
});

export type NapAssignmentListQuery = z.infer<typeof napAssignmentListQuerySchema>;
