// Ingreso a la cuenta por cédula/RUC o por nº de orden FSM.
//
//   GET  /accounts/lookup?document=0912345678
//   POST /accounts/lookup   { "document": "0912345678" }   ← preferido: el
//        documento no viaja en la URL (logs de proxies intermedios).
//   ...?order=ORDER/424900/2026  → 501 NOT_IMPLEMENTED (ver el servicio).
//
// Autenticada como el resto de /herramientas/v1 (hook global).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody, parseQuery } from '../../lib/validation.js';
import { lookupByDocument, lookupByOrder } from './account-lookup.service.js';

const blankAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const accountLookupSchema = z
  .object({
    document: z.preprocess(
      blankAsUndefined,
      z.string().trim().max(32, 'document no puede superar 32 caracteres.').optional(),
    ),
    order: z.preprocess(
      blankAsUndefined,
      z.string().trim().max(120, 'order no puede superar 120 caracteres.').optional(),
    ),
  })
  .refine((q) => (q.document === undefined) !== (q.order === undefined), {
    message: 'Envía exactamente uno: document (cédula/RUC) u order (nº de orden FSM).',
    path: ['document'],
  });

type LookupInput = z.infer<typeof accountLookupSchema>;

function resolve(input: LookupInput) {
  if (input.order !== undefined) return lookupByOrder(input.order);
  return lookupByDocument(input.document as string);
}

export async function registerAccountLookupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts/lookup', async (request) => {
    return resolve(parseQuery(accountLookupSchema, request.query));
  });

  app.post('/accounts/lookup', async (request) => {
    return resolve(parseBody(accountLookupSchema, request.body ?? {}));
  });
}
