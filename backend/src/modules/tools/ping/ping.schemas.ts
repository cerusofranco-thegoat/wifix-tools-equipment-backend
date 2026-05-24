import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';

export const pingInputSchema = serviceContextSchema
  .extend({
    target: z.string().min(1, 'target es obligatorio.'),
    serverId: z.string().min(1).optional(),
    packetsSent: z.number().int().nonnegative().optional(),
    packetsReceived: z.number().int().nonnegative().optional(),
    packetLossPercent: z.number().min(0).max(100).optional(),
    minLatencyMs: z.number().nonnegative().optional(),
    avgLatencyMs: z.number().nonnegative().optional(),
    maxLatencyMs: z.number().nonnegative().optional(),
    continuous: z.boolean().default(false),
    heatmapId: z.string().uuid().optional(),
    roomName: z.string().optional(),
    measuredAt: z.coerce.date(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.packetsSent !== undefined &&
      data.packetsReceived !== undefined &&
      data.packetsReceived > data.packetsSent
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['packetsReceived'],
        message: 'packetsReceived no puede ser mayor que packetsSent.',
      });
    }
  });

export type PingInput = z.infer<typeof pingInputSchema>;
