// Whitelist de clientes reales — validación de "Confirmar cuenta".
//
// Autenticada como el resto de /herramientas/v1 (hook global). La decisión de
// bloquear o solo avisar la toma la app según `enforce` (env WHITELIST_ENFORCE).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseParams } from '../../lib/validation.js';
import { normalizeAccountNumber } from './whitelist.normalize.js';
import { checkWhitelist } from './whitelist.service.js';

const paramsSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .min(1, 'accountNumber es obligatorio.')
    .max(64, 'accountNumber no puede superar 64 caracteres.'),
});

export async function registerWhitelistRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/:accountNumber/whitelist', async (request) => {
    const { accountNumber } = parseParams(paramsSchema, request.params);
    // `min(1)` tras `trim` garantiza que no queda vacía.
    const normalized = normalizeAccountNumber(accountNumber) as string;
    return checkWhitelist(normalized);
  });
}
