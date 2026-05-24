import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerCatalogsRoutes } from './modules/catalogs/catalogs.routes.js';
import { registerMediaRoutes } from './modules/media/media.routes.js';
import { registerDistanceRoutes } from './modules/tools/distance/distance.routes.js';
import { registerSpeedtestRoutes } from './modules/tools/speedtest/speedtest.routes.js';
import { registerHeatmapRoutes } from './modules/tools/heatmap/heatmap.routes.js';
import { registerPingRoutes } from './modules/tools/ping/ping.routes.js';
import { registerTracerouteRoutes } from './modules/tools/traceroute/traceroute.routes.js';
import { registerRetiredEquipmentRoutes } from './modules/retired-equipment/retired-equipment.routes.js';
import { registerAccountHistoryRoutes } from './modules/account-history/account-history.routes.js';

const API_PREFIX = '/herramientas/v1';

export interface BuildAppOptions {
  /** Si es `false`, desactiva el logger (útil en pruebas). */
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { logger = true } = options;

  const loggerConfig: FastifyServerOptions['logger'] = logger
    ? {
        level: env.LOG_LEVEL,
        ...(env.NODE_ENV === 'development'
          ? {
              transport: {
                target: 'pino-pretty',
                options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
              },
            }
          : {}),
      }
    : false;

  const app = Fastify({
    logger: loggerConfig,
    ajv: {
      customOptions: {
        allErrors: true,
        removeAdditional: 'all',
      },
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  registerErrorHandler(app);

  app.get('/health', async () => ({
    status: 'ok',
    service: 'wifix-tools-equipment-backend',
    timestamp: new Date().toISOString(),
  }));

  await app.register(
    async (api) => {
      api.get('/health', async () => ({
        status: 'ok',
        scope: 'api',
        timestamp: new Date().toISOString(),
      }));

      await registerCatalogsRoutes(api);
      await registerMediaRoutes(api);
      await registerDistanceRoutes(api);
      await registerSpeedtestRoutes(api);
      await registerHeatmapRoutes(api);
      await registerPingRoutes(api);
      await registerTracerouteRoutes(api);
      await registerRetiredEquipmentRoutes(api);
      await registerAccountHistoryRoutes(api);
    },
    { prefix: API_PREFIX },
  );

  return app;
}

export { API_PREFIX };
