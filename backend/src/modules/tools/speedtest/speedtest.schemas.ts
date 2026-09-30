import { z } from 'zod';
import { serviceContextSchema } from '../../../schemas/service-context.js';

/** Techo físico del dispositivo externo del técnico (puerto de 10 Gb/s). */
export const EXTERNAL_DEVICE_MAX_MBPS = 10_000;

export const SPEEDTEST_SOURCES = ['app', 'external-device'] as const;
export type SpeedtestSourceValue = (typeof SPEEDTEST_SOURCES)[number];

export const speedtestInputSchema = serviceContextSchema
  .extend({
    downloadMbps: z.number().nonnegative('downloadMbps debe ser >= 0.'),
    uploadMbps: z.number().nonnegative('uploadMbps debe ser >= 0.'),
    latencyMs: z.number().nonnegative().optional(),
    jitterMs: z.number().nonnegative().optional(),
    packetLossPercent: z.number().min(0).max(100).optional(),
    serverId: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    ispName: z.string().min(1).optional(),
    /** Instante de la medición. `timestamp` es alias (lo envía el dispositivo externo). */
    measuredAt: z.coerce.date().optional(),
    timestamp: z.coerce.date().optional(),
    notes: z.string().optional(),
    /**
     * `app` (default): medido por la app. `external-device`: medido por el
     * dispositivo Android del técnico (hasta 10 Gb/s) y subido a la app.
     */
    source: z.enum(SPEEDTEST_SOURCES).default('app'),
    deviceName: z.string().trim().min(1).max(120).optional(),
    deviceId: z.string().trim().min(1).max(120).optional(),
    /** `true` si el resultado es simulado (hoy el externo se simula en el frontend). */
    simulated: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (!v.measuredAt && !v.timestamp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['measuredAt'],
        message: 'measuredAt (o timestamp) es obligatorio.',
      });
    }
    if (v.source === 'external-device') {
      if (!v.deviceName && !v.deviceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['deviceId'],
          message: 'Un speedtest de dispositivo externo requiere deviceName o deviceId.',
        });
      }
      for (const field of ['downloadMbps', 'uploadMbps'] as const) {
        if (v[field] > EXTERNAL_DEVICE_MAX_MBPS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} supera el máximo del dispositivo externo (${EXTERNAL_DEVICE_MAX_MBPS} Mbps).`,
          });
        }
      }
    }
  })
  .transform(({ timestamp, measuredAt, ...rest }) => ({
    ...rest,
    measuredAt: (measuredAt ?? timestamp) as Date,
  }));

export type SpeedtestInput = z.infer<typeof speedtestInputSchema>;
