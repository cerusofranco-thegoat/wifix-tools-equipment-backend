import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';

export const tracerouteHopSchema = z.object({
  hopNumber: z.number().int().positive('hopNumber debe ser entero positivo.'),
  host: z.string().nullish(),
  latencyMs: z.number().nonnegative().nullish(),
});

export const tracerouteInputSchema = serviceContextSchema.extend({
  target: z.string().min(1, 'target es obligatorio.'),
  serverId: z.string().min(1).optional(),
  hops: z.array(tracerouteHopSchema),
  measuredAt: z.coerce.date(),
  notes: z.string().optional(),
});

export type TracerouteInput = z.infer<typeof tracerouteInputSchema>;
