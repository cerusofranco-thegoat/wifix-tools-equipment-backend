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
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  // Origen del portal del Call Center (usado en CSP frame-ancestors del proxy HTTP).
  // En producción debe ser el origen HTTPS del portal (p.ej. https://portal.wifix.internal).
  // En desarrollo apunta al servidor de desarrollo del portal (Vite, port 5174 por convención).
  PORTAL_ORIGIN: z.string().default('http://localhost:5174'),
  // --- Jitsi self-host (Fase D) ---
  JITSI_DOMAIN: z.string().default('meet.wifix.internal'),
  JITSI_APP_ID: z.string().default('wifix'),
  JITSI_SUB: z.string().default('meet.wifix.internal'),
  JITSI_APP_SECRET: z
    .string()
    .min(16, 'JITSI_APP_SECRET debe tener al menos 16 caracteres')
    .default('dev-jitsi-secret-change-me-please-32chars'),
  JITSI_JWT_TTL: z.coerce.number().int().positive().default(1800),
  // --- Broker WSS (Fase D) ---
  BROKER_TOKEN_SECRET: z
    .string()
    .min(16, 'BROKER_TOKEN_SECRET debe tener al menos 16 caracteres')
    .default('dev-broker-secret-change-me-please-32chars'),
  // TTL máximo absoluto del broker permitido si el cliente no especifica
  BROKER_DEFAULT_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  // Habilitar grabación de sesiones remotas a MediaFile
  BROKER_RECORDING_ENABLED: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  // URL pública del endpoint WSS del broker que se entrega al agente (B-3).
  // En producción debe apuntar al hostname público del servidor.
  // En desarrollo apunta a localhost por defecto.
  BROKER_PUBLIC_WS_URL: z
    .string()
    .url('BROKER_PUBLIC_WS_URL debe ser una URL válida (wss:// o ws://)')
    .default('ws://localhost:8080/asistencia/v1/broker/connect'),
  // --- Rate-limiting del broker (Fase D hardening) ---
  // Máximo de requests de emisión de token (POST /remote-sessions) por agente por ventana.
  BROKER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // Ventana de tiempo en milisegundos para el rate-limit del broker.
  BROKER_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Máximo de conexiones WS (túnel/agente) por IP por ventana.
  BROKER_WS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  // Máx. requests al proxy HTTP del broker por IP por ventana (Fase E).
  // Default: 120 / 60 000 ms (navegación del panel del router).
  PROXY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  // [MEDIO-2] Controla el atributo Secure de la cookie de proxy.
  // Default: true (la cookie solo viaja por HTTPS).
  // Establecer a false ÚNICAMENTE en entornos de desarrollo local sobre HTTP.
  // No usar false en staging ni producción.
  COOKIE_SECURE: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
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
  BROKER_TOKEN_SECRET: 'dev-broker-secret-change-me-please-32chars',
  JITSI_APP_SECRET: 'dev-jitsi-secret-change-me-please-32chars',
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
