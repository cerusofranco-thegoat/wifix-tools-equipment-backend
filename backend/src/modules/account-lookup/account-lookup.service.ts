// Ingreso alternativo a la cuenta: por cédula/RUC (hoy) y por nº de orden FSM
// (reconocido, todavía no resoluble — ver `lookupByOrder`).
//
// LOPDP: el documento es el CRITERIO de búsqueda, nunca parte de la respuesta.
// El repositorio ni siquiera lo selecciona. Tampoco se loguea: el servicio no
// escribe logs y la ruta redacta el query string (ver `app.ts`).

import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../middleware/error-handler.js';
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
}

export const prismaAccountLookupRepository: AccountLookupRepository = {
  async findByDocument(documentId, take) {
    return prisma.customerWhitelist.findMany({
      where: { documentId },
      // Lista explícita: documentId y cpartyId no salen de la base.
      select: {
        accountNumber: true,
        status: true,
        city: true,
        node: true,
        businessType: true,
        accountType: true,
        accessType: true,
        fullName: true,
      },
      orderBy: { accountNumber: 'asc' },
      take,
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
    // Mapeo explícito: aunque el repositorio trajera más columnas, solo salen estas.
    .map((a) => ({
      accountNumber: a.accountNumber,
      status: a.status,
      city: a.city,
      node: a.node,
      businessType: a.businessType,
      accountType: a.accountType,
      accessType: a.accessType,
      fullName: a.fullName && a.fullName.trim().length > 0 ? a.fullName.trim() : null,
    }))
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

/**
 * Ingreso por nº de orden FSM (`ORDER/424900/2026` o `424900`).
 *
 * NO es resoluble hoy: `fsm-data-ms` solo expone
 *   - `POST /account/process` (entrada: cuenta → salida: órdenes),
 *   - `POST /workorder/tasks` (entrada: orden → salida: tareas y notas, SIN
 *     cuenta ni cpartyId — verificado con el fixture real `chain-tasks.json`),
 *   - `/account/status`, `/naps/nearest`, `/naps/accounts`.
 * Ninguno va de orden → cuenta, y la whitelist no guarda órdenes. Hacer la
 * búsqueda inversa exigiría barrer cuentas contra producción, algo que la
 * operadora pidió expresamente no hacer.
 */
export function lookupByOrder(order: string): never {
  throw ApiError.notImplemented(
    'El ingreso por número de orden todavía no está disponible: FSM no expone una ' +
      'consulta de orden a cuenta. Ingresa con el número de cuenta o la cédula.',
    { lookup: 'order', order, requires: 'Endpoint FSM orden→cuenta (pendiente con la operadora).' },
  );
}
