import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseParams } from '../../lib/validation.js';
import { getAuthUser } from '../../middleware/authenticate.js';
import {
  getAcsConnector,
  getIspMonitorConnector,
  getRmsConnector,
  getTecConnector,
} from '../../connectors/index.js';

const accountParamsSchema = z.object({
  accountNumber: z.string().min(1, 'accountNumber es obligatorio.'),
});

const napParamsSchema = z.object({
  napCode: z.string().min(1, 'napCode es obligatorio.'),
});

const wifiBandUpdateSchema = z.object({
  band: z.enum(['2.4GHz', '5GHz']),
  ssid: z.string().min(1, 'El SSID es obligatorio.').max(32, 'El SSID excede 32 caracteres.'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres.')
    .max(63, 'La contraseña excede 63 caracteres.')
    .optional(),
});

const wifiConfigUpdateSchema = z.object({
  bands: z
    .array(wifiBandUpdateSchema)
    .min(1, 'Indica al menos una banda a actualizar.')
    .refine(
      (bands) => new Set(bands.map((b) => b.band)).size === bands.length,
      { message: 'No repitas la misma banda dos veces.' },
    ),
});

export async function registerNetworkDiagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/nearby-naps', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getTecConnector().getNearbyNaps(accountNumber);
  });

  app.get('/naps/:napCode/ports', async (request) => {
    const { napCode } = parseParams(napParamsSchema, request.params);
    return getTecConnector().getNapPorts(napCode);
  });

  app.get('/accounts/:accountNumber/network-metrics', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getIspMonitorConnector().getNetworkMetrics(accountNumber);
  });

  app.get('/accounts/:accountNumber/node-events', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getRmsConnector().getNodeEvents(accountNumber);
  });

  app.get('/accounts/:accountNumber/lan-devices', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getLanDevices(accountNumber);
  });

  app.get('/accounts/:accountNumber/wifi-devices', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getWifiDevices(accountNumber);
  });

  app.get('/accounts/:accountNumber/wifi-config', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    return getAcsConnector().getWifiConfig(accountNumber);
  });

  app.put('/accounts/:accountNumber/wifi-config', async (request) => {
    const { accountNumber } = parseParams(accountParamsSchema, request.params);
    const body = parseBody(wifiConfigUpdateSchema, request.body);
    const user = getAuthUser(request);
    request.log.info(
      {
        user: user.id,
        accountNumber,
        action: 'updateWifiConfig',
        bands: body.bands.map((b) => b.band),
      },
      'PUT wifi-config',
    );
    return getAcsConnector().updateWifiConfig(accountNumber, body);
  });
}
