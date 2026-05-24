import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  buildContextWhere,
  buildDateRangeWhere,
  type ListFilters,
} from '../../../schemas/filters.js';

export const distanceRepository = {
  create: (data: Prisma.DistanceMeasurementUncheckedCreateInput) =>
    prisma.distanceMeasurement.create({ data }),

  findById: (id: string) => prisma.distanceMeasurement.findUnique({ where: { id } }),

  async list(filters: ListFilters) {
    const where: Prisma.DistanceMeasurementWhereInput = buildContextWhere(filters);
    const dateRange = buildDateRangeWhere(filters);
    if (dateRange) where.measuredAt = dateRange;

    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.distanceMeasurement.findMany({
        where,
        orderBy: { measuredAt: 'desc' },
        skip,
        take: filters.pageSize,
      }),
      prisma.distanceMeasurement.count({ where }),
    ]);
    return { items, totalItems };
  },
};
