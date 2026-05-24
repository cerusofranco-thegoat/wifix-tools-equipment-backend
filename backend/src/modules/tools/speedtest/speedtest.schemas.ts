import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';

export const speedtestInputSchema = serviceContextSchema.extend({
  downloadMbps: z.number().nonnegative('downloadMbps debe ser >= 0.'),
  uploadMbps: z.number().nonnegative('uploadMbps debe ser >= 0.'),
  latencyMs: z.number().nonnegative().optional(),
  jitterMs: z.number().nonnegative().optional(),
  packetLossPercent: z.number().min(0).max(100).optional(),
  serverId: z.string().min(1).optional(),
  serverName: z.string().min(1).optional(),
  ispName: z.string().min(1).optional(),
  measuredAt: z.coerce.date(),
  notes: z.string().optional(),
});

export type SpeedtestInput = z.infer<typeof speedtestInputSchema>;
