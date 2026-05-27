import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';
import { bssidSchema, WIFI_BAND_VALUES } from '../access-points/access-points.schemas.js';

export const roomApMeasurementInputSchema = z.object({
  bssid: bssidSchema,
  accessPointId: z.string().uuid().optional(),
  apLabelSnapshot: z.string().optional(),
  signalDbm: z
    .number()
    .min(-120, 'signalDbm fuera de rango: debe estar entre -120 y 0.')
    .max(0, 'signalDbm fuera de rango: debe estar entre -120 y 0.'),
  band: z.enum(WIFI_BAND_VALUES).default('unknown'),
  channel: z.number().int().min(1).max(200).optional(),
  isConnected: z.boolean().default(false),
});
export type RoomApMeasurementInput = z.infer<typeof roomApMeasurementInputSchema>;

// HeatmapRoomInput acepta ambos formatos para soportar la transición:
//   - Nuevo: `measurements: RoomApMeasurement[]` (al menos 1)
//   - Legacy: `signalDbm: number` (deprecated; el servicio lo migra
//     internamente a una entrada sintética en measurements).
// Si no llega ninguno → error.
export const heatmapRoomInputSchema = z
  .object({
    roomName: z.string().min(1, 'roomName es obligatorio.'),
    floor: z.number().int().positive().default(1),
    measurements: z.array(roomApMeasurementInputSchema).min(1).optional(),
    signalDbm: z
      .number()
      .min(-120, 'signalDbm fuera de rango: debe estar entre -120 y 0.')
      .max(0, 'signalDbm fuera de rango: debe estar entre -120 y 0.')
      .optional(),
    measuredAt: z.coerce.date(),
    notes: z.string().optional(),
  })
  .refine((v) => (v.measurements && v.measurements.length > 0) || typeof v.signalDbm === 'number', {
    message: 'Cada habitación debe traer `measurements[]` (formato nuevo) o `signalDbm` (legacy).',
    path: ['measurements'],
  });

export type HeatmapRoomInput = z.infer<typeof heatmapRoomInputSchema>;

export const heatmapInputSchema = serviceContextSchema.extend({
  label: z.string().optional(),
  rooms: z.array(heatmapRoomInputSchema).min(1, 'rooms debe contener al menos una habitación.'),
  notes: z.string().optional(),
});

export type HeatmapInput = z.infer<typeof heatmapInputSchema>;
