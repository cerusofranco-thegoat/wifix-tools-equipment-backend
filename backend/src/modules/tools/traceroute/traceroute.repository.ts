import type { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import {
  buildContextWhere,
  buildDateRangeWhere,
  type ListFilters,
} from '../../../schemas/filters.js';

export const tracerouteRepository = {
  create: (data: Prisma.TracerouteTestCreateInput) =>
    prisma.tracerouteTest.create({ data, include: { hops: true } }),

  findById: (id: string) =>
    prisma.tracerouteTest.findUnique({ where: { id }, include: { hops: true } }),

  async list(filters: ListFilters) {
    const where: Prisma.TracerouteTestWhereInput = buildContextWhere(filters);
    const dr = buildDateRangeWhere(filters);
    if (dr) where.measuredAt = dr;
    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.tracerouteTest.findMany({
        where,
        orderBy: { measuredAt: 'desc' },
        skip,
        take: filters.pageSize,
        include: { hops: true },
      }),
      prisma.tracerouteTest.count({ where }),
    ]);
    return { items, totalItems };
  },
};
