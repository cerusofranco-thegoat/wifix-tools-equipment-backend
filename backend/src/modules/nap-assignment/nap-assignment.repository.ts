import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

/** Máximo de elecciones que devuelve la lectura por cuenta. */
export const ACCOUNT_NAP_ASSIGNMENTS_LIMIT = 50;

const NEWEST_FIRST: Prisma.NapAssignmentOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

export const napAssignmentRepository = {
  // Append-only: solo create y lecturas. No hay update ni delete.
  create: (data: Prisma.NapAssignmentUncheckedCreateInput) => prisma.napAssignment.create({ data }),

  listByAccount: (accountNumbers: string[], take = ACCOUNT_NAP_ASSIGNMENTS_LIMIT) =>
    prisma.napAssignment.findMany({
      where: { accountNumber: { in: accountNumbers } },
      orderBy: NEWEST_FIRST,
      take,
    }),

  /** Página por cursor (id de la última fila de la página anterior). Trae `take` filas. */
  listPage: (opts: { accountNumbers?: string[]; cursor?: string; take: number }) =>
    prisma.napAssignment.findMany({
      ...(opts.accountNumbers?.length ? { where: { accountNumber: { in: opts.accountNumbers } } } : {}),
      orderBy: NEWEST_FIRST,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      take: opts.take,
    }),
};
