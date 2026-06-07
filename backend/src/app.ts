import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { env } from './config/env.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { registerAuthenticate } from './middleware/authenticate.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerCatalogsRoutes } from './modules/catalogs/catalogs.routes.js';
import { registerMediaRoutes } from './modules/media/media.routes.js';
import { registerDistanceRoutes } from './modules/tools/distance/distance.routes.js';
import { registerSpeedtestRoutes } from './modules/tools/speedtest/speedtest.routes.js';
import { registerHeatmapRoutes } from './modules/tools/heatmap/heatmap.routes.js';
import { registerAccessPointsRoutes } from './modules/tools/access-points/access-points.routes.js';
import { registerPingRoutes } from './modules/tools/ping/ping.routes.js';
import { registerTracerouteRoutes } from './modules/tools/traceroute/traceroute.routes.js';
import { registerRetiredEquipmentRoutes } from './modules/retired-equipment/retired-equipment.routes.js';
import { registerAccountHistoryRoutes } from './modules/account-history/account-history.routes.js';
import { registerClientDataRoutes } from './modules/client-data/client-data.routes.js';
import { registerNetworkDiagnosticsRoutes } from './modules/network-diagnostics/network-diagnostics.routes.js';
import { registerTasksVisitsRoutes } from './modules/tasks-visits/tasks-visits.routes.js';
import { registerAssistanceRoutes } from './modules/assistance/assistance.routes.js';
import { registerAssistanceWs } from './modules/assistance/assistance.ws.js';
import { registerBrokerTunnelWs } from './modules/assistance/broker/broker.ws.js';
import { registerBrokerAgentWs } from './modules/assistance/broker/broker.agent-ws.js';
import { startExpirySweep, stopExpirySweep } from './modules/assistance/broker/broker.expiry.js';

const API_PREFIX = '/herramientas/v1';
const ASSISTANCE_PREFIX = '/asistencia/v1';

const AUTH_EXCLUDED_PATHS: Array<string | RegExp> = [
  '/health',
  `${API_PREFIX}/health`,
  `${API_PREFIX}/auth/login`,
  `${ASSISTANCE_PREFIX}/health`,
];

export interface BuildAppOptions {
  /** Si es `false`, desactiva el logger (útil en pruebas). */
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { logger = true } = options;

  const loggerConfig: FastifyServerOptions['logger'] = logger
    ? {
        level: env.LOG_LEVEL,
        // M-1: Redactar el parámetro sessionToken de las URLs loggeadas por pino.
        // El agente conecta con ?sessionToken=<jwt>; pino loggea req.url completa.
        // El serializer lo enmascara antes de escribir al destino de logs.
        serializers: {
          req(req) {
            const url = typeof req.url === 'string'
              ? req.url.replace(/([?&]sessionToken=)[^&]*/gi, '$1[REDACTED]')
              : req.url;
            return {
              method: req.method,
              url,
              hostname: req.hostname,
              remoteAddress: req.ip,
              remotePort: req.socket?.remotePort,
            };
          },
        },
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
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // WebSocket plugin — debe registrarse antes de los plugins que lo usan
  await app.register(websocketPlugin);

  registerErrorHandler(app);

  await registerAuthenticate(app, { excludePaths: AUTH_EXCLUDED_PATHS });

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

      await registerAuthRoutes(api);
      await registerCatalogsRoutes(api);
      await registerMediaRoutes(api);
      await registerDistanceRoutes(api);
      await registerSpeedtestRoutes(api);
      await registerHeatmapRoutes(api);
      await registerAccessPointsRoutes(api);
      await registerPingRoutes(api);
      await registerTracerouteRoutes(api);
      await registerRetiredEquipmentRoutes(api);
      await registerAccountHistoryRoutes(api);
      await registerClientDataRoutes(api);
      await registerNetworkDiagnosticsRoutes(api);
      await registerTasksVisitsRoutes(api);
    },
    { prefix: API_PREFIX },
  );

  // ---------------------------------------------------------------------------
  // Módulo Asistencia Técnica — /asistencia/v1
  // Registrado como segundo grupo de rutas, independiente de herramientas.
  // ---------------------------------------------------------------------------
  await app.register(
    async (assistanceApi) => {
      await registerAssistanceRoutes(assistanceApi);
      await registerAssistanceWs(assistanceApi);
      // Broker WSS (Fase D): túnel del técnico y conexión del agente
      await registerBrokerTunnelWs(assistanceApi);
      await registerBrokerAgentWs(assistanceApi);
    },
    { prefix: ASSISTANCE_PREFIX },
  );

  // Iniciar barrido periódico de tokens expirados
  startExpirySweep(60_000);
  app.addHook('onClose', () => {
    stopExpirySweep();
  });

  return app;
}

export { API_PREFIX, ASSISTANCE_PREFIX };
