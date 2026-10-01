import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

/** Máximo de validaciones que devuelve la lectura por cuenta. */
export const ACCOUNT_VALIDATIONS_LIMIT = 50;

export interface DeviceValidationListFilters {
  /** Variantes de la cuenta (tal cual y normalizada). */
  accountNumbers?: string[];
  result?: Prisma.DeviceValidationWhereInput['result'];
  category?: Prisma.DeviceValidationWhereInput['category'];
  from?: Date;
  to?: Date;
  skip: number;
  take: number;
}

export const deviceCatalogRepository = {
  listActive: () =>
    prisma.deviceModel.findMany({
      where: { active: true },
      orderBy: [{ deviceType: 'asc' }, { brand: 'asc' }, { model: 'asc' }],
    }),
};

export const deviceValidationRepository = {
  // Append-only: solo create y lecturas. No hay update ni delete.
  create: (data: Prisma.DeviceValidationUncheckedCreateInput) => prisma.deviceValidation.create({ data }),

  listByAccount: (accountNumbers: string[], take = ACCOUNT_VALIDATIONS_LIMIT) =>
    prisma.deviceValidation.findMany({
      where: { accountNumber: { in: accountNumbers } },
      orderBy: { createdAt: 'desc' },
      take,
    }),

  async list(filters: DeviceValidationListFilters) {
    const where: Prisma.DeviceValidationWhereInput = {};
    if (filters.accountNumbers?.length) where.accountNumber = { in: filters.accountNumbers };
    if (filters.result) where.result = filters.result;
    if (filters.category) where.category = filters.category;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    const [items, totalItems] = await Promise.all([
      prisma.deviceValidation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filters.skip,
        take: filters.take,
      }),
      prisma.deviceValidation.count({ where }),
    ]);
    return { items, totalItems };
  },
};
