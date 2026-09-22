// Crea (o actualiza) un usuario administrador.
// Uso: npx tsx prisma/create-admin.ts
//
// El sistema actual no tiene roles — todos los usuarios autenticados pueden
// hacer todo en la API. Este "admin" es semánticamente un técnico privilegiado.
//
// Credenciales: `ADMIN_EMAIL`, `ADMIN_PASSWORD` y (opcional) `ADMIN_NAME` del
// entorno. En un servidor son OBLIGATORIAS: un usuario con contraseña escrita en
// el repositorio es una puerta abierta en cuanto la demo queda publicada. En
// desarrollo (`NODE_ENV` distinto de `production`) se cae a los valores de
// siempre para no romper el flujo local.
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

/** Valores de conveniencia SOLO para desarrollo local. */
const DEV_DEFAULTS = {
  email: 'admin@wifix.local',
  password: 'WifixAdmin2026!',
  name: 'Administrador Wifix',
} as const;

const MIN_PASSWORD_LENGTH = 8;

interface AdminCredentials {
  email: string;
  password: string;
  name: string;
  fromEnv: boolean;
}

function resolveCredentials(): AdminCredentials {
  const email = (process.env.ADMIN_EMAIL ?? '').trim();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const name = (process.env.ADMIN_NAME ?? '').trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (email && password) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(
        `ADMIN_PASSWORD debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      );
      process.exit(1);
    }
    return { email, password, name: name || DEV_DEFAULTS.name, fromEnv: true };
  }

  if (isProduction) {
    const faltan = [!email ? 'ADMIN_EMAIL' : null, !password ? 'ADMIN_PASSWORD' : null]
      .filter((v): v is string => v !== null)
      .join(', ');
    console.error(
      `[SEGURIDAD] No se puede crear el usuario admin en producción sin credenciales propias.\n` +
        `Faltan estas variables de entorno: ${faltan}.\n` +
        `Ejemplo:\n` +
        `  ADMIN_EMAIL=admin@tudominio.com ADMIN_PASSWORD='<contraseña-larga>' \\\n` +
        `    npx tsx prisma/create-admin.ts\n` +
        `Las credenciales por defecto del repositorio NO se usan en producción.`,
    );
    process.exit(1);
  }

  console.warn(
    `[DEV] ADMIN_EMAIL / ADMIN_PASSWORD no definidas: se usan las credenciales ` +
      `de desarrollo (${DEV_DEFAULTS.email}). En un servidor esto aborta.`,
  );
  return { ...DEV_DEFAULTS, fromEnv: false };
}

async function main(): Promise<void> {
  const { email, password, name, fromEnv } = resolveCredentials();
  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash, active: true },
    create: { email, name, passwordHash, active: true },
  });
  console.log('Usuario admin listo:');
  console.log('  email:    ', email);
  // La contraseña solo se imprime cuando es la de desarrollo (ya está en el
  // repositorio); la que viene del entorno no se vuelca a los logs del servidor.
  console.log('  password: ', fromEnv ? '(la de ADMIN_PASSWORD)' : password);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
