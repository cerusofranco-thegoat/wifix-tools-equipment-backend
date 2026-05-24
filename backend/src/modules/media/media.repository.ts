import { prisma } from '../../db/prisma.js';
import type { MediaFile } from '@prisma/client';

export const mediaRepository = {
  create: (data: Omit<MediaFile, 'id' | 'createdAt'>) =>
    prisma.mediaFile.create({ data }),

  findById: (id: string) => prisma.mediaFile.findUnique({ where: { id } }),
};
