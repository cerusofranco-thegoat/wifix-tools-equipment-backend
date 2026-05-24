import { prisma } from '../../db/prisma.js';

export const catalogsRepository = {
  listEquipmentModels: () =>
    prisma.equipmentModel.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] }),

  listRemovalReasons: () =>
    prisma.removalReason.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),

  listSpeedtestServers: () =>
    prisma.speedtestServer.findMany({ orderBy: { name: 'asc' } }),

  listNetworkServers: () =>
    prisma.networkServer.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
};
