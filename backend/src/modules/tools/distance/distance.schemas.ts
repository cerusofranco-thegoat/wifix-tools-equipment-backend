import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';
import { geoPointSchema } from '../../../schemas/geo.js';

export const distanceInputSchema = serviceContextSchema.extend({
  distanceMeters: z.number().nonnegative('distanceMeters debe ser >= 0.'),
  startPoint: geoPointSchema.optional(),
  endPoint: geoPointSchema.optional(),
  measuredAt: z.coerce.date(),
  notes: z.string().optional(),
});

export type DistanceInput = z.infer<typeof distanceInputSchema>;
