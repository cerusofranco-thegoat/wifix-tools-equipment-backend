import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { buildContextWhere, buildDateRangeWhere } from '../../schemas/filters.js';
import type { RetiredEquipmentFilters } from './retired-equipment.schemas.js';

export const retiredEquipmentRepository = {
  create: (data: Prisma.RetiredEquipmentUncheckedCreateInput) =>
    prisma.retiredEquipment.create({ data, include: { barcodePhoto: true } }),

  findById: (id: string) =>
    prisma.retiredEquipment.findUnique({ where: { id }, include: { barcodePhoto: true } }),

  equipmentModelById: (id: string) =>
    prisma.equipmentModel.findUnique({ where: { id } }),

  removalReasonByCode: (code: Prisma.RemovalReasonCreateInput['code']) =>
    prisma.removalReason.findUnique({ where: { code } }),

  mediaExists: async (id: string) =>
    (await prisma.mediaFile.findUnique({ where: { id }, select: { id: true } })) !== null,

  async list(filters: RetiredEquipmentFilters) {
    const where: Prisma.RetiredEquipmentWhereInput = buildContextWhere(filters);
    if (filters.removalReasonCode) where.removalReasonCode = filters.removalReasonCode;
    if (filters.serialValue)
      where.serialValue = { contains: filters.serialValue, mode: 'insensitive' };
    const dr = buildDateRangeWhere(filters);
    if (dr) where.retiredAt = dr;

    const skip = (filters.page - 1) * filters.pageSize;
    const [items, totalItems] = await Promise.all([
      prisma.retiredEquipment.findMany({
        where,
        orderBy: { retiredAt: 'desc' },
        skip,
        take: filters.pageSize,
        include: { barcodePhoto: true },
      }),
      prisma.retiredEquipment.count({ where }),
    ]);
    return { items, totalItems };
  },
};
