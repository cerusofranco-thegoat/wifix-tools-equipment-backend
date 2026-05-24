import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  buildContextWhere,
  buildDateRangeWhere,
  type ListFilters,
} from '../../../schemas/filters.js';

export const heatmapRepository = {
  create: (data: Prisma.WifiHeatmapCreateInput) =>
    prisma.wifiHeatmap.create({ data, include: { rooms: true } }),

  findById: (id: string) =>
    prisma.wifiHeatmap.findUnique({ where: { id }, include: { rooms: true } }),

  async list(filters: ListFilters) {
    const where: Prisma.WifiHeatmapWhereInput = buildContextWhere(filters);
    const dr = buildDateRangeWhere(filters);
    if (dr) where.createdAt = dr;
    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.wifiHeatmap.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filters.pageSize,
        include: { rooms: true },
      }),
      prisma.wifiHeatmap.count({ where }),
    ]);
    return { items, totalItems };
  },
};
