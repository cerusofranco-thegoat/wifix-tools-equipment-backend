import { z } from 'zod';

export const accountParamsSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .min(1, 'accountNumber es obligatorio.')
    .max(50, 'accountNumber excede 50 caracteres.'),
});

/** Body de `POST /accounts/{accountNumber}/client-location`. */
export const clientLocationInputSchema = z
  .object({
    latitude: z.number().gte(-90).lte(90),
    longitude: z.number().gte(-180).lte(180),
    accuracyMeters: z.number().nonnegative('accuracyMeters debe ser >= 0.').optional(),
    label: z.enum(['CASA_CLIENTE']).default('CASA_CLIENTE'),
    source: z.enum(['GPS', 'MANUAL']),
    napCode: z.string().trim().min(1).max(50).optional(),
    napPort: z
      .union([z.string().trim().min(1).max(20), z.number().int().nonnegative()])
      .optional(),
    taskId: z.string().trim().min(1).max(100).optional(),
    capturedAt: z.coerce.date().optional(),
    notes: z.string().max(500, 'notes excede 500 caracteres.').optional(),
  })
  // (0,0) es el "vacío" de los sistemas legados, no un GPS válido.
  .refine((b) => !(b.latitude === 0 && b.longitude === 0), {
    message: 'La coordenada (0,0) no es válida.',
    path: ['latitude'],
  });

export type ClientLocationInput = z.infer<typeof clientLocationInputSchema>;

/** Query de `GET /client-locations` (vista de gerente). */
export const clientLocationListQuerySchema = z
  .object({
    accountNumber: z.string().trim().min(1).max(50).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    page: z.coerce.number().int().min(1).default(1),
  })
  .refine((q) => !q.from || !q.to || q.from.getTime() <= q.to.getTime(), {
    message: 'from debe ser anterior o igual a to.',
    path: ['from'],
  });

export type ClientLocationListQuery = z.infer<typeof clientLocationListQuerySchema>;
