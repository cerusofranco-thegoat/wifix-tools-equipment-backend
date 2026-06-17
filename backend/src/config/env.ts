import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  // --- Autenticación (Fase 2) ---
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET debe tener al menos 16 caracteres')
    .default('dev-secret-change-me-please-32-chars-min'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  SEED_USER_EMAIL: z.string().email().default('franco@tulpasolutions.com'),
  SEED_USER_PASSWORD: z.string().min(6).default('wifix-dev-2026'),
  SEED_USER_NAME: z.string().default('Franco Ceruso'),
  // --- Conectores (Fase 2) ---
  CONNECTOR_MODE: z.enum(['mock', 'real']).default('mock'),
  // --- Almacenamiento ---
  STORAGE_ENDPOINT: z.string().url().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('wifix-media'),
  STORAGE_ACCESS_KEY: z.string().default('wifixminio'),
  STORAGE_SECRET_KEY: z.string().default('wifixminio123'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  // Lista de orígenes permitidos en CORS, separada por comas.
  // Ejemplo: http://localhost:5173,https://callcenter.wifix.app
  // Un solo origen también es válido (retrocompatible).
  // El valor especial '*' desactiva la verificación de origen (solo desarrollo local).
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // Reportar y abortar el arranque si la configuración es inválida.
  console.error(`Configuración de entorno inválida:\n${issues}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validación post-parse: secretos inseguros en producción
// Los defaults hardcodeados son convenientes en desarrollo/test pero NUNCA
// deben llegar a producción. Si NODE_ENV=production y algún secreto coincide
// con su valor por defecto, el servidor aborta con mensaje claro.
// ---------------------------------------------------------------------------
const SECRET_DEFAULTS = {
  JWT_SECRET: 'dev-secret-change-me-please-32-chars-min',
} as const;

if (parsed.data.NODE_ENV === 'production') {
  const insecure: string[] = [];
  for (const [key, defaultValue] of Object.entries(SECRET_DEFAULTS)) {
    const actual = parsed.data[key as keyof typeof SECRET_DEFAULTS];
    if (actual === defaultValue) {
      insecure.push(key);
    }
  }
  if (insecure.length > 0) {
    console.error(
      `[SEGURIDAD] El servidor no puede arrancar en producción con secretos por defecto.\n` +
      `Las siguientes variables de entorno usan su valor hardcodeado por defecto y DEBEN ser sobreescritas:\n` +
      insecure.map((k) => `  - ${k}`).join('\n') +
      `\nDefine estas variables con valores aleatorios y seguros (mín. 32 caracteres) antes de desplegar.`,
    );
    process.exit(1);
  }
}

export const env = parsed.data;
export type Env = typeof env;
