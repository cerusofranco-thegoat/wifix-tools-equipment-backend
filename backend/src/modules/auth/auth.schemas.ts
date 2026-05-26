import { z } from 'zod';

export const loginInputSchema = z.object({
  email: z.string().email('Correo inválido.'),
  password: z.string().min(1, 'La contraseña es obligatoria.'),
});

export type LoginInputSchema = z.infer<typeof loginInputSchema>;
