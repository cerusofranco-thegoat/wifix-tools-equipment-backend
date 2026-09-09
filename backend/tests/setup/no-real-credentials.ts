// ---------------------------------------------------------------------------
// Blindaje de la suite: NINGÚN test puede usar credenciales reales.
//
// `src/config/env.ts` carga el `.env` del servidor con dotenv, y desde el
// 2026-09-09 ese archivo tiene la key real de FSM (`FSM_TOKEN_KEY_TELENEWS`).
// Sin este setup, un test que olvide poner su propio doble de `fetch` podría
// negociar un token contra el API manager de la operadora — que es producción y
// pidió expresamente que no se consulte de más.
//
// Se ejecuta ANTES de cada archivo de test: carga el `.env` y VACÍA las
// credenciales de FSM. No se hace `delete`: dotenv solo rellena las claves que
// NO existen en `process.env`, así que dejarlas en `''` sobrevive a cualquier
// `import 'dotenv/config'` posterior. Un valor vacío equivale a "no configurado"
// para `fsm-token.ts`. Cada test que necesita una credencial la pone a mano.
// ---------------------------------------------------------------------------
import 'dotenv/config';

const SECRET_PATTERNS = [/^FSM_TOKEN_KEY_/, /^FSM_TOKEN_URL_/, /^FSM_API_TOKEN_/];

for (const key of Object.keys(process.env)) {
  if (SECRET_PATTERNS.some((re) => re.test(key))) process.env[key] = '';
}

// Y por si el .env del servidor incorpora mañana una marca nueva.
for (const brand of ['TELENEWS', 'SETEINFO']) {
  process.env[`FSM_TOKEN_KEY_${brand}`] = '';
  process.env[`FSM_TOKEN_URL_${brand}`] = '';
  process.env[`FSM_API_TOKEN_${brand}`] = '';
}

// El conector FSM arranca siempre en mock: los tests que quieren el modo real
// lo encienden explícitamente sobre `env`.
process.env.CONNECTOR_MODE_FSM = 'mock';
