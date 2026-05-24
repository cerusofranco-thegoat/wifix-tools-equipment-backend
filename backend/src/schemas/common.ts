import { z } from 'zod';

export const uuidParamSchema = z.object({
  id: z.string().uuid('El id debe ser un UUID v4 válido.'),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;
