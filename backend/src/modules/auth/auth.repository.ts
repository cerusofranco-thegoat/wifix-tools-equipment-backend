import { prisma } from '../../db/prisma.js';

export const authRepository = {
  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  },

  async findById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  },
};
