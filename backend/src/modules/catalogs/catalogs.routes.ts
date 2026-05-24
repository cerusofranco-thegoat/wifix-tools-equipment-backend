import type { FastifyInstance } from 'fastify';
import { catalogsService } from './catalogs.service.js';

export async function registerCatalogsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/catalogs/equipment-models', async () => catalogsService.listEquipmentModels());
  app.get('/catalogs/removal-reasons', async () => catalogsService.listRemovalReasons());
  app.get('/catalogs/speedtest-servers', async () => catalogsService.listSpeedtestServers());
  app.get('/catalogs/network-servers', async () => catalogsService.listNetworkServers());
}
