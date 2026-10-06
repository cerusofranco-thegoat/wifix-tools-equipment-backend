// Ingreso alternativo a la cuenta: por cédula/RUC y por nº de orden (TYTAN
// SIMULADO — ver `resolveOrderAccount`).
//
// LOPDP: el documento es el CRITERIO de búsqueda, nunca parte de la respuesta.
// El repositorio ni siquiera lo selecciona. Tampoco se loguea: el servicio no
// escribe logs y la ruta redacta el query string (ver `app.ts`).

import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng } from '../../connectors/_shared.js';
import { normalizeWorkOrder } from '../orders/order-ids.js';
import {
  normalizeDocumentId,
  WHITELIST_STATUSES,
  type WhitelistStatusValue,
} from '../whitelist/whitelist.normalize.js';

/** Máximo de cuentas por documento. Un RUC empresarial puede tener muchas. */
export const LOOKUP_MAX_MATCHES = 50;

/** Largo mínimo del documento normalizado (evita barridos con 2-3 dígitos). */
const MIN_DOCUMENT_LENGTH = 6;

export interface LookupAccount {
  accountNumber: string;
  status: WhitelistStatusValue;
  city: string | null;
  node: string | null;
  businessType: string | null;
  accountType: string | null;
  accessType: string | null;
  /** Nombre según la planilla Xtrim; `null` si no lo trae. */
  fullName: string | null;
}

export interface AccountLookupRepository {
  /** Cuentas cuyo `documentId` coincide EXACTO. Nunca devuelve el documento. */
  findByDocument(documentId: string, take: number): Promise<LookupAccount[]>;
  latestImportAt(): Promise<Date | null>;
  /** Cuentas candidatas para la simulación por orden (`onlyActive`: solo ACTIVO). */
  countOrderCandidates(onlyActive: boolean): Promise<number>;
  /** Candidata en la posición `index` (orden estable por cuenta). Nunca devuelve el documento. */
  findOrderCandidateAt(index: number, onlyActive: boolean): Promise<LookupAccount | null>;
}

/** Columnas que pueden salir de la whitelist: documentId y cpartyId NO. */
const LOOKUP_SELECT = {
  accountNumber: true,
  status: true,
  city: true,
  node: true,
  businessType: true,
  accountType: true,
  accessType: true,
  fullName: true,
} as const;

export const prismaAccountLookupRepository: AccountLookupRepository = {
  async findByDocument(documentId, take) {
    return prisma.customerWhitelist.findMany({
      where: { documentId },
      // Lista explícita: documentId y cpartyId no salen de la base.
      select: LOOKUP_SELECT,
      orderBy: { accountNumber: 'asc' },
      take,
    });
  },
  async countOrderCandidates(onlyActive) {
    return prisma.customerWhitelist.count(onlyActive ? { where: { status: 'ACTIVO' } } : undefined);
  },
  async findOrderCandidateAt(index, onlyActive) {
    return prisma.customerWhitelist.findFirst({
      ...(onlyActive ? { where: { status: 'ACTIVO' as const } } : {}),
      select: LOOKUP_SELECT,
      orderBy: { accountNumber: 'asc' },
      skip: index,
    });
  },
  async latestImportAt() {
    const last = await prisma.whitelistImport.findFirst({
      orderBy: { importedAt: 'desc' },
      select: { importedAt: true },
    });
    return last?.importedAt ?? null;
  },
};

let repository: AccountLookupRepository = prismaAccountLookupRepository;

/** Solo para tests: reemplaza el acceso a datos. `null` restaura Prisma. */
export function setAccountLookupRepository(repo: AccountLookupRepository | null): void {
  repository = repo ?? prismaAccountLookupRepository;
}

export type DocumentKind = 'CEDULA' | 'RUC' | 'OTRO';

export interface DocumentLookupResult {
  by: 'document';
  /** CEDULA (10 dígitos), RUC (13) u OTRO (pasaporte u otro formato, se busca tal cual). */
  documentKind: DocumentKind;
  /** Activas primero (ACTIVO > SUSPENDIDO > ORDENADO > PENDIENTE), luego por cuenta. */
  matches: LookupAccount[];
  count: number;
  /** `true` si hay más de `LOOKUP_MAX_MATCHES` cuentas y se recortó la lista. */
  truncated: boolean;
  /** Fecha del último import de la whitelist; `null` si nunca se importó. */
  importedAt: string | null;
  /** Presente solo si la whitelist está vacía: no hay contra qué buscar. */
  reason?: 'WHITELIST_EMPTY';
}

const STATUS_ORDER = new Map<string, number>(WHITELIST_STATUSES.map((s, i) => [s, i]));

function byStatusThenAccount(a: LookupAccount, b: LookupAccount): number {
  const rank = (STATUS_ORDER.get(a.status) ?? 99) - (STATUS_ORDER.get(b.status) ?? 99);
  return rank !== 0 ? rank : a.accountNumber.localeCompare(b.accountNumber);
}

/**
 * Normaliza lo que teclea el técnico EXACTAMENTE como el import de la
 * whitelist (`normalizeDocumentId`): 9 → 10 y 12 → 13 dígitos restituyendo el
 * cero inicial; espacios, puntos y guiones fuera.
 */
export function normalizeLookupDocument(raw: string): { documentId: string; kind: DocumentKind } {
  const { documentId, documentNormalized } = normalizeDocumentId(raw);
  if (!documentId || documentId.length < MIN_DOCUMENT_LENGTH) {
    throw ApiError.validation('El documento es demasiado corto: ingresa la cédula (10) o el RUC (13).', [
      { field: 'document', issue: 'Documento inválido.' },
    ]);
  }
  const kind: DocumentKind = !documentNormalized
    ? 'OTRO'
    : documentId.length === 10
      ? 'CEDULA'
      : 'RUC';
  return { documentId, kind };
}

/** Mapeo explícito: aunque el repositorio trajera más columnas, solo salen estas. */
function toLookupAccount(a: LookupAccount): LookupAccount {
  return {
    accountNumber: a.accountNumber,
    status: a.status,
    city: a.city,
    node: a.node,
    businessType: a.businessType,
    accountType: a.accountType,
    accessType: a.accessType,
    fullName: a.fullName && a.fullName.trim().length > 0 ? a.fullName.trim() : null,
  };
}

export async function lookupByDocument(rawDocument: string): Promise<DocumentLookupResult> {
  const { documentId, kind } = normalizeLookupDocument(rawDocument);

  const [found, importedAt] = await Promise.all([
    repository.findByDocument(documentId, LOOKUP_MAX_MATCHES + 1),
    repository.latestImportAt(),
  ]);

  if (!importedAt && found.length === 0) {
    return {
      by: 'document',
      documentKind: kind,
      matches: [],
      count: 0,
      truncated: false,
      importedAt: null,
      reason: 'WHITELIST_EMPTY',
    };
  }

  const truncated = found.length > LOOKUP_MAX_MATCHES;
  const matches = found
    .slice(0, LOOKUP_MAX_MATCHES)
    .map(toLookupAccount)
    .sort(byStatusThenAccount);

  return {
    by: 'document',
    documentKind: kind,
    matches,
    count: matches.length,
    truncated,
    importedAt: importedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ingreso por nº de orden — TYTAN SIMULADO
// ---------------------------------------------------------------------------
//
// FSM (`fsm-data-ms`) no expone orden → cuenta (`/workorder/tasks` no trae la
// cuenta) y barrer cuentas contra producción está vetado por la operadora. La
// fuente real será TYTAN; mientras tanto la cuenta se elige de forma
// DETERMINÍSTICA de la whitelist a partir del nº de orden: misma orden → misma
// cuenta (mientras no se reimporte la lista), y la cuenta pasa el bloqueo de
// whitelist aguas abajo. Se prefieren cuentas ACTIVO; si no hay, cualquiera.
//
// La comparten `/accounts/lookup` (by order) y `/orders/context`: el contexto
// de la orden SIEMPRE habla de la misma cuenta que devolvió el lookup.
//
// TODO(tytan-real): reemplazar por la consulta de la orden en TYTAN
// (orden → cuenta) cuando la operadora entregue el endpoint y credenciales.

/** Cuenta demo cuando la whitelist está vacía (nunca importada). */
export const ORDER_DEMO_ACCOUNT = '40123456';

export interface OrderAccountResolution {
  workOrder: string;
  account: LookupAccount;
  importedAt: Date | null;
  reason?: 'WHITELIST_EMPTY';
}

/** Conteo de candidatas por import: evita un COUNT sobre ~300k filas por petición. */
let candidateCountCache: { importedAtMs: number; onlyActive: boolean; count: number } | null = null;

/** Solo para tests. */
export function resetOrderCandidateCache(): void {
  candidateCountCache = null;
}

async function candidateCount(importedAt: Date | null): Promise<{ count: number; onlyActive: boolean }> {
  const importedAtMs = importedAt?.getTime() ?? null;
  if (candidateCountCache && importedAtMs !== null && candidateCountCache.importedAtMs === importedAtMs) {
    return { count: candidateCountCache.count, onlyActive: candidateCountCache.onlyActive };
  }
  let onlyActive = true;
  let count = await repository.countOrderCandidates(true);
  if (count === 0) {
    onlyActive = false;
    count = await repository.countOrderCandidates(false);
  }
  // Sin import no se cachea: la lista puede llenarse en cualquier momento.
  candidateCountCache = importedAtMs !== null ? { importedAtMs, onlyActive, count } : null;
  return { count, onlyActive };
}

/**
 * Cuenta de la orden YA normalizada (`ORDER/<n>/<año>`). Determinística: el
 * índice sale de un hash del nº de orden sobre las candidatas de la whitelist.
 */
export async function resolveOrderAccount(workOrder: string): Promise<OrderAccountResolution> {
  const importedAt = await repository.latestImportAt();
  const { count, onlyActive } = await candidateCount(importedAt);

  if (count > 0) {
    const index = seededRng(`tytan:order-account:${workOrder}`).intBetween(0, count - 1);
    const found = await repository.findOrderCandidateAt(index, onlyActive);
    if (found) return { workOrder, account: toLookupAccount(found), importedAt };
  }

  return {
    workOrder,
    account: {
      accountNumber: ORDER_DEMO_ACCOUNT,
      status: 'ACTIVO',
      city: null,
      node: null,
      businessType: null,
      accountType: null,
      accessType: null,
      fullName: null,
    },
    importedAt,
    reason: 'WHITELIST_EMPTY',
  };
}

export interface OrderLookupResult {
  by: 'order';
  workOrder: string;
  simulated: true;
  source: 'TYTAN';
  /** Exactamente 1: mismo shape que el lookup por documento. */
  matches: LookupAccount[];
  count: 1;
  truncated: false;
  importedAt: string | null;
  reason?: 'WHITELIST_EMPTY';
}

/** Ingreso por nº de orden (`ORDER/463158/2026` o `463158`). Formato inválido → 400. */
export async function lookupByOrder(rawOrder: string): Promise<OrderLookupResult> {
  const workOrder = normalizeWorkOrder(rawOrder, 'order');
  const resolved = await resolveOrderAccount(workOrder);
  return {
    by: 'order',
    workOrder,
    simulated: true,
    source: 'TYTAN',
    matches: [resolved.account],
    count: 1,
    truncated: false,
    importedAt: resolved.importedAt?.toISOString() ?? null,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
  };
}
