import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  buildContextWhere,
  buildDateRangeWhere,
  type ListFilters,
} from '../../../schemas/filters.js';

export const speedtestRepository = {
  create: (data: Prisma.SpeedtestUncheckedCreateInput) => prisma.speedtest.create({ data }),

  findById: (id: string) => prisma.speedtest.findUnique({ where: { id } }),

  async list(filters: ListFilters) {
    const where: Prisma.SpeedtestWhereInput = buildContextWhere(filters);
    const dr = buildDateRangeWhere(filters);
    if (dr) where.measuredAt = dr;
    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.speedtest.findMany({
        where,
        orderBy: { measuredAt: 'desc' },
        skip,
        take: filters.pageSize,
      }),
      prisma.speedtest.count({ where }),
    ]);
    return { items, totalItems };
  },
};
