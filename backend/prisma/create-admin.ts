// Crea (o actualiza) un usuario "admin" con credenciales fijas.
// Uso: npx tsx prisma/create-admin.ts
//
// El sistema actual no tiene roles — todos los usuarios autenticados pueden
// hacer todo en la API. Este "admin" es semánticamente un técnico privilegiado.
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const ADMIN_EMAIL = 'admin@wifix.local';
const ADMIN_PASSWORD = 'WifixAdmin2026!';
const ADMIN_NAME = 'Administrador Wifix';

async function main() {
  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { name: ADMIN_NAME, passwordHash, active: true },
    create: { email: ADMIN_EMAIL, name: ADMIN_NAME, passwordHash, active: true },
  });
  console.log('Usuario admin listo:');
  console.log('  email:    ', ADMIN_EMAIL);
  console.log('  password: ', ADMIN_PASSWORD);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
