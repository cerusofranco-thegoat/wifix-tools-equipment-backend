import bcrypt from 'bcrypt';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { signAuthToken } from '../../src/auth/jwt.js';
import type { FastifyInstance } from 'fastify';

export interface TestAppContext {
  app: FastifyInstance;
  authHeaders: Record<string, string>;
}

const TEST_USER_EMAIL = 'tester@wifix.test';
const TEST_USER_NAME = 'Test User';
const TEST_USER_PASSWORD = 'tester-pass-123';

async function ensureTestUser(): Promise<{ id: string; email: string; name: string }> {
  const passwordHash = await bcrypt.hash(TEST_USER_PASSWORD, 4);
  return prisma.user.upsert({
    where: { email: TEST_USER_EMAIL },
    update: { passwordHash, name: TEST_USER_NAME, active: true },
    create: { email: TEST_USER_EMAIL, passwordHash, name: TEST_USER_NAME, active: true },
    select: { id: true, email: true, name: true },
  });
}

export async function buildTestApp(): Promise<TestAppContext> {
  const app = await buildApp({ logger: false });
  await app.ready();
  const user = await ensureTestUser();
  const token = await signAuthToken({ sub: user.id, email: user.email, name: user.name });
  return {
    app,
    authHeaders: { authorization: `Bearer ${token}` },
  };
}
