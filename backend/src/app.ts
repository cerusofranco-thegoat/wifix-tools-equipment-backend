import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { registerErrorHandler } from './middleware/error-handler.js';

const API_PREFIX = '/herramientas/v1';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
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
    },
    { prefix: API_PREFIX },
  );

  return app;
}

export { API_PREFIX };
