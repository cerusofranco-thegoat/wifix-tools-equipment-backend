import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  buildContextWhere,
  buildDateRangeWhere,
  type ListFilters,
} from '../../../schemas/filters.js';

export const pingRepository = {
  create: (data: Prisma.PingTestUncheckedCreateInput) => prisma.pingTest.create({ data }),

  findById: (id: string) => prisma.pingTest.findUnique({ where: { id } }),

  heatmapExists: async (id: string) =>
    (await prisma.wifiHeatmap.findUnique({ where: { id }, select: { id: true } })) !== null,

  async list(filters: ListFilters) {
    const where: Prisma.PingTestWhereInput = buildContextWhere(filters);
    const dr = buildDateRangeWhere(filters);
    if (dr) where.measuredAt = dr;
    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.pingTest.findMany({
        where,
        orderBy: { measuredAt: 'desc' },
        skip,
        take: filters.pageSize,
      }),
      prisma.pingTest.count({ where }),
    ]);
    return { items, totalItems };
  },
};
