import { z } from 'zod';

export const accountParamsSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .min(1, 'accountNumber es obligatorio.')
    .max(50, 'accountNumber excede 50 caracteres.'),
});

/** Body de `POST /accounts/{accountNumber}/device-validations`. */
export const deviceValidationInputSchema = z.object({
  serial: z.string().trim().min(1, 'serial es obligatorio.').max(64, 'serial excede 64 caracteres.'),
  model: z.string().trim().min(1, 'model es obligatorio.').max(120, 'model excede 120 caracteres.'),
  category: z.enum(['instalaciones', 'migraciones', 'visitas'], {
    errorMap: () => ({ message: "category debe ser 'instalaciones', 'migraciones' o 'visitas'." }),
  }),
  taskId: z.string().trim().min(1).max(120, 'taskId excede 120 caracteres.').optional(),
  serialSource: z
    .enum(['barcode', 'ocr', 'manual'], {
      errorMap: () => ({ message: "serialSource debe ser 'barcode', 'ocr' o 'manual'." }),
    })
    .optional(),
});

export type DeviceValidationInput = z.infer<typeof deviceValidationInputSchema>;

/** Query de `GET /device-validations` (vista de gerente). */
export const deviceValidationListQuerySchema = z
  .object({
    result: z.enum(['ok', 'blocked', 'unknown_plan']).optional(),
    accountNumber: z.string().trim().min(1).max(50).optional(),
    category: z.enum(['instalaciones', 'migraciones', 'visitas']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    page: z.coerce.number().int().min(1).default(1),
  })
  .refine((q) => !q.from || !q.to || q.from.getTime() <= q.to.getTime(), {
    message: 'from debe ser anterior o igual a to.',
    path: ['from'],
  });

export type DeviceValidationListQuery = z.infer<typeof deviceValidationListQuerySchema>;
