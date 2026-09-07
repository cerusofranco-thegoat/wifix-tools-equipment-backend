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
  // Modo global por defecto para todos los conectores externos.
  CONNECTOR_MODE: z.enum(['mock', 'real']).default('mock'),
  // Overrides por conector: hoy solo TEC e ISP Monitor tienen credenciales
  // reales, el resto (Comarch, FSM, ACS, RMS) sigue en mock.
  CONNECTOR_MODE_TEC: z.enum(['mock', 'real']).optional(),
  CONNECTOR_MODE_ISPMONITOR: z.enum(['mock', 'real']).optional(),
  CONNECTOR_MODE_FSM: z.enum(['mock', 'real']).optional(),
  // --- API de TEC / ISP Monitor (Grupo TVCable) ---
  // Base de la API real de operadora. Autenticación HTTP Digest.
  TEC_API_BASE_URL: z.string().url().default('https://tec-api.grupotvcable.com'),
  TEC_API_USERNAME: z.string().default(''),
  TEC_API_PASSWORD: z.string().default(''),
  TEC_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // La operadora no impone un tope de peticiones, pero pidió no abusar y todo
  // va contra producción: se limita la concurrencia y se cachea corto.
  TEC_API_MAX_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  TEC_API_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60000),
  // --- FSM (fsm-data-ms, Grupo TVCable) ---
  // Microservicio de órdenes, tareas, NAPs GPON y estado de cuenta.
  // Autenticación Bearer por marca (realm de Keycloak). Ver connectors/http/fsm-token.ts.
  FSM_API_BASE_URL: z
    .string()
    .url()
    .default('https://apix.grupotvcable.com/rest/fsm-data-api/v1.0'),
  FSM_API_CHANNEL: z.string().default('FSM'),
  FSM_API_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // Semáforo propio, separado del de TEC: son dos hosts distintos.
  FSM_API_MAX_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  FSM_API_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(60000),
  // El estado de una cuenta no cambia minuto a minuto: cache más largo.
  FSM_STATUS_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(300000),
  // Tope de cuentas por lote en POST /accounts/status-batch.
  FSM_STATUS_BATCH_LIMIT: z.coerce.number().int().positive().max(50).default(12),
  // Órdenes finalizadas más recientes que se abren para leer sus notas (campo 15).
  FSM_ORDERS_MAX_FANOUT: z.coerce.number().int().positive().max(10).default(5),
  // Heurístico provisional para clasificar una tarea como INSATISFACTORIA.
  FSM_UNSATISFACTORY_KEYWORDS: z
    .string()
    .default('insatisfactoria,no conforme,rechazada,reincidencia,reprogramada')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // Marcas / realms. La marca por defecto se usa si la petición no manda X-Wifix-Brand.
  FSM_BRANDS: z
    .string()
    .default('telenews,seteinfo')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  FSM_DEFAULT_BRAND: z
    .string()
    .default('telenews')
    .transform((val) => val.trim().toLowerCase()),
  FSM_BRAND_STRATEGY: z.enum(['fixed', 'probe']).default('fixed'),
  // Token estático (24 h, pegado a mano). Vacío = la marca no está disponible.
  FSM_API_TOKEN_TELENEWS: z.string().default(''),
  FSM_API_TOKEN_SETEINFO: z.string().default(''),
  // Gancho client_credentials: si están los tres, tienen prioridad sobre el estático.
  FSM_TOKEN_SKEW_MS: z.coerce.number().int().nonnegative().default(60000),
  FSM_TOKEN_URL_TELENEWS: z.string().default(''),
  FSM_CLIENT_ID_TELENEWS: z.string().default(''),
  FSM_CLIENT_SECRET_TELENEWS: z.string().default(''),
  FSM_TOKEN_URL_SETEINFO: z.string().default(''),
  FSM_CLIENT_ID_SETEINFO: z.string().default(''),
  FSM_CLIENT_SECRET_SETEINFO: z.string().default(''),
  // Fuente primaria de NAPs para el campo 6 (ver ADR-04). Hoy: tec.
  NAPS_PRIMARY_SOURCE: z.enum(['fsm', 'tec']).default('tec'),
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

const tecLikeIsReal =
  (parsed.data.CONNECTOR_MODE_TEC ?? parsed.data.CONNECTOR_MODE) === 'real' ||
  (parsed.data.CONNECTOR_MODE_ISPMONITOR ?? parsed.data.CONNECTOR_MODE) === 'real';

if (tecLikeIsReal) {
  const missing: string[] = [];
  if (!parsed.data.TEC_API_USERNAME) missing.push('TEC_API_USERNAME');
  if (!parsed.data.TEC_API_PASSWORD) missing.push('TEC_API_PASSWORD');
  if (missing.length > 0) {
    console.error(
      `[CONFIG] CONNECTOR_MODE=real requiere credenciales de la API de operadora.`,
    );
    console.error(`Faltan estas variables de entorno: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// FSM: a diferencia de TEC, la falta de token NO aborta el arranque.
// Las credenciales Digest de TEC son permanentes; el token FSM vence cada 24 h
// y un backend que se niega a arrancar porque un token de un tercero caducó de
// madrugada tumbaría también Herramientas y Equipos Retirados (Fase 1), que
// viven en la BD propia y no dependen de FSM. Solo se avisa.
// ---------------------------------------------------------------------------
if ((parsed.data.CONNECTOR_MODE_FSM ?? parsed.data.CONNECTOR_MODE) === 'real') {
  const sinAcceso = parsed.data.FSM_BRANDS.filter((brand) => {
    const suffix = brand.toUpperCase();
    const staticToken = process.env[`FSM_API_TOKEN_${suffix}`] ?? '';
    const tokenUrl = process.env[`FSM_TOKEN_URL_${suffix}`] ?? '';
    const clientId = process.env[`FSM_CLIENT_ID_${suffix}`] ?? '';
    const clientSecret = process.env[`FSM_CLIENT_SECRET_${suffix}`] ?? '';
    return !staticToken && !(tokenUrl && clientId && clientSecret);
  });
  if (sinAcceso.length > 0) {
    console.warn(
      `[CONFIG] CONNECTOR_MODE_FSM=real pero estas marcas no tienen acceso configurado: ` +
        `${sinAcceso.join(', ')}. El servidor arranca igual: las rutas de FSM devolverán ` +
        `503 UPSTREAM_AUTH_ERROR (reason MISSING) y el resto de la app funciona con normalidad.`,
    );
  }
}

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

/** Modo efectivo de un conector: su override si existe, si no el global. */
export function connectorMode(connector: 'tec' | 'ispmonitor' | 'fsm'): 'mock' | 'real' {
  const override =
    connector === 'tec'
      ? env.CONNECTOR_MODE_TEC
      : connector === 'ispmonitor'
        ? env.CONNECTOR_MODE_ISPMONITOR
        : env.CONNECTOR_MODE_FSM;
  return override ?? env.CONNECTOR_MODE;
}
