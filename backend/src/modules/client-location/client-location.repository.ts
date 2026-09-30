import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

/** Máximo de capturas que devuelve la lectura por cuenta. */
export const ACCOUNT_LOCATIONS_LIMIT = 50;

export interface ClientLocationListFilters {
  /** Variantes de la cuenta (tal cual y normalizada). */
  accountNumbers?: string[];
  from?: Date;
  to?: Date;
  skip: number;
  take: number;
}

export const clientLocationRepository = {
  // Append-only: solo create y lecturas. No hay update ni delete.
  create: (data: Prisma.ClientLocationUncheckedCreateInput) => prisma.clientLocation.create({ data }),

  listByAccount: (accountNumbers: string[], take = ACCOUNT_LOCATIONS_LIMIT) =>
    prisma.clientLocation.findMany({
      where: { accountNumber: { in: accountNumbers } },
      orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
      take,
    }),

  async list(filters: ClientLocationListFilters) {
    const where: Prisma.ClientLocationWhereInput = {};
    if (filters.accountNumbers?.length) where.accountNumber = { in: filters.accountNumbers };
    if (filters.from || filters.to) {
      where.capturedAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to ? { lte: filters.to } : {}),
      };
    }
    const [items, totalItems] = await Promise.all([
      prisma.clientLocation.findMany({
        where,
        orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
        skip: filters.skip,
        take: filters.take,
      }),
      prisma.clientLocation.count({ where }),
    ]);
    return { items, totalItems };
  },
};
