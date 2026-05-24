import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';

export const heatmapRoomInputSchema = z.object({
  roomName: z.string().min(1, 'roomName es obligatorio.'),
  floor: z.number().int().positive().default(1),
  signalDbm: z
    .number()
    .min(-120, 'signalDbm fuera de rango: debe estar entre -120 y 0.')
    .max(0, 'signalDbm fuera de rango: debe estar entre -120 y 0.'),
  measuredAt: z.coerce.date(),
  notes: z.string().optional(),
});

export type HeatmapRoomInput = z.infer<typeof heatmapRoomInputSchema>;

export const heatmapInputSchema = serviceContextSchema.extend({
  label: z.string().optional(),
  rooms: z.array(heatmapRoomInputSchema).min(1, 'rooms debe contener al menos una habitación.'),
  notes: z.string().optional(),
});

export type HeatmapInput = z.infer<typeof heatmapInputSchema>;
