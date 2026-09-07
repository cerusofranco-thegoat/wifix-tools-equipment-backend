// Resolución de la marca (realm de FSM) de una petición.
//
// La marca viaja en el header interno `X-Wifix-Brand`, con override opcional
// por query `?brand=` (para el script de sondeo y soporte). Si no viene, se usa
// `FSM_DEFAULT_BRAND`. El técnico nunca ve la cadena `realm-…`: ver ADR-01.

import type { FastifyRequest } from 'fastify';
import { resolveBrand, type FsmBrand } from '../connectors/http/fsm-token.js';

export const BRAND_HEADER = 'x-wifix-brand';

/** Marca efectiva de la petición: query > header > FSM_DEFAULT_BRAND. */
export function brandFromRequest(request: FastifyRequest, queryBrand?: string): FsmBrand {
  const header = request.headers[BRAND_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return resolveBrand(queryBrand ?? fromHeader ?? null);
}
