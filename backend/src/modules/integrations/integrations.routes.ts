// Diagnóstico de la integración con FSM y consulta de estados en lote.
//
//   GET  /integrations/fsm/health   → CERO llamadas a la operadora. Solo dice qué
//        marcas tienen token, cuándo vence y cuánto le queda. Es lo que permite a
//        la UI pintar el banner correcto sin gastar una consulta a producción.
//
//   POST /accounts/status-batch     → paso 2 del campo 8. Se dispara SOLO por
//        acción explícita del técnico ("Consultar estado de N clientes"), nunca
//        automáticamente. Máximo `FSM_STATUS_BATCH_LIMIT` cuentas por lote.
//
// ⚠ `/accounts/status-batch` convive con `/accounts/:accountNumber/...`.
// find-my-way prioriza los segmentos estáticos sobre los paramétricos, así que
// no colisionan; hay un test explícito que lo cubre.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../lib/validation.js';
import { brandFromRequest } from '../../lib/brand.js';
import { connectorMode, env } from '../../config/env.js';
import { getFsmConnector } from '../../connectors/index.js';
import { FIXTURE_ACCOUNT } from '../../connectors/fsm/fixture.js';
import { fsmTokenStatus } from '../../connectors/http/fsm-token.js';

function statusBatchSchema(): z.ZodTypeAny {
  const limit = env.FSM_STATUS_BATCH_LIMIT;
  return z.object({
    accounts: z
      .array(z.string().min(1, 'Cada cuenta debe ser un texto no vacío.'))
      .min(1, 'Indica al menos una cuenta.')
      .max(limit, `No se pueden consultar más de ${limit} cuentas por lote.`),
  });
}

export async function registerIntegrationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/integrations/fsm/health', async () => {
    const mode = connectorMode('fsm');
    return {
      mode,
      defaultBrand: env.FSM_DEFAULT_BRAND,
      brands: fsmTokenStatus(),
      napsPrimarySource: env.NAPS_PRIMARY_SOURCE,
      // `brands[].available` habla SOLO del token de la operadora. En `mock` y
      // en `fixture` no hace falta ninguno, así que un `available: false` ahí no
      // significa que las pantallas de FSM estén caídas: la UI debe mirar este
      // campo antes de pintar el aviso de "integración no disponible".
      requiresToken: mode === 'real',
      // En modo `fixture` esta es la cuenta que devuelve datos reales grabados;
      // cualquier otra responde con el mock. `null` en los demás modos.
      fixtureAccount: mode === 'fixture' ? FIXTURE_ACCOUNT : null,
    };
  });

  app.post('/accounts/status-batch', async (request) => {
    const body = parseBody(statusBatchSchema(), request.body) as { accounts: string[] };
    return getFsmConnector().getAccountsStatusBatch(body.accounts, {
      brand: brandFromRequest(request),
    });
  });
}
