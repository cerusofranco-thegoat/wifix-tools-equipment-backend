// GET /accounts/:n/whitelist — ¿la cuenta está en la lista de clientes reales?
//
// La lista se REEMPLAZA completa con `prisma/import-whitelist.ts`. Esta capa
// solo lee, y NUNCA devuelve `documentId`: el repositorio ni siquiera lo trae.
// El nombre (`fullName`) tampoco sale por esta ruta: solo lo consume
// client-profile como respaldo (`findWhitelistFullName`).

import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { normalizeAccountNumber, type WhitelistStatusValue } from './whitelist.normalize.js';

export interface WhitelistEntry {
  accountNumber: string;
  status: WhitelistStatusValue;
  city: string | null;
  node: string | null;
  businessType: string | null;
  accountType: string | null;
  accessType: string | null;
  importedAt: Date;
}

export interface WhitelistRepository {
  findEntry(accountNumber: string): Promise<WhitelistEntry | null>;
  /** Fecha del último import; `null` si nunca se importó. */
  latestImportAt(): Promise<Date | null>;
  /** Nombre del cliente según la planilla; `null` si no está o no tiene. */
  findFullName(accountNumber: string): Promise<string | null>;
}

export const prismaWhitelistRepository: WhitelistRepository = {
  async findEntry(accountNumber) {
    return prisma.customerWhitelist.findUnique({
      where: { accountNumber },
      // Lista explícita: documentId y cpartyId no salen de la base.
      select: {
        accountNumber: true,
        status: true,
        city: true,
        node: true,
        businessType: true,
        accountType: true,
        accessType: true,
        importedAt: true,
      },
    });
  },
  async latestImportAt() {
    const last = await prisma.whitelistImport.findFirst({
      orderBy: { importedAt: 'desc' },
      select: { importedAt: true },
    });
    return last?.importedAt ?? null;
  },
  async findFullName(accountNumber) {
    const row = await prisma.customerWhitelist.findUnique({
      where: { accountNumber },
      select: { fullName: true },
    });
    return row?.fullName ?? null;
  },
};

let repository: WhitelistRepository = prismaWhitelistRepository;

/** Solo para tests: reemplaza el acceso a datos. `null` restaura Prisma. */
export function setWhitelistRepository(repo: WhitelistRepository | null): void {
  repository = repo ?? prismaWhitelistRepository;
}

export type WhitelistCheck =
  | {
      accountNumber: string;
      listed: true;
      source: 'IMPORT' | 'EXTRA';
      status: WhitelistStatusValue;
      city: string | null;
      node: string | null;
      businessType: string | null;
      accountType: string | null;
      accessType: string | null;
      importedAt: string | null;
      enforce: boolean;
    }
  | { accountNumber: string; listed: false; importedAt: string; enforce: boolean }
  | {
      accountNumber: string;
      listed: null;
      reason: 'WHITELIST_EMPTY';
      importedAt: null;
      enforce: false;
    };

/** Cuentas de `WHITELIST_EXTRA_ACCOUNTS`, normalizadas igual que la lista. */
export function extraAccounts(): Set<string> {
  const out = new Set<string>();
  for (const raw of env.WHITELIST_EXTRA_ACCOUNTS) {
    const account = normalizeAccountNumber(raw);
    if (account) out.add(account);
  }
  return out;
}

/**
 * `accountNumber` ya viene normalizado (ver `normalizeAccountNumber`).
 *
 * Orden: EXTRA (demo) → lista importada → no listada. Con la lista vacía (nunca
 * se importó) se responde `listed:null` y `enforce:false` pase lo que pase: sin
 * lista no hay contra qué bloquear.
 */
export async function checkWhitelist(accountNumber: string): Promise<WhitelistCheck> {
  const enforce = env.WHITELIST_ENFORCE;

  if (extraAccounts().has(accountNumber)) {
    const importedAt = await repository.latestImportAt();
    return {
      accountNumber,
      listed: true,
      source: 'EXTRA',
      status: 'ACTIVO',
      city: null,
      node: null,
      businessType: null,
      accountType: null,
      accessType: null,
      importedAt: importedAt?.toISOString() ?? null,
      enforce,
    };
  }

  const entry = await repository.findEntry(accountNumber);
  if (entry) {
    return {
      accountNumber: entry.accountNumber,
      listed: true,
      source: 'IMPORT',
      status: entry.status,
      city: entry.city,
      node: entry.node,
      businessType: entry.businessType,
      accountType: entry.accountType,
      accessType: entry.accessType,
      importedAt: entry.importedAt.toISOString(),
      enforce,
    };
  }

  const importedAt = await repository.latestImportAt();
  if (!importedAt) {
    return {
      accountNumber,
      listed: null,
      reason: 'WHITELIST_EMPTY',
      importedAt: null,
      enforce: false,
    };
  }
  return { accountNumber, listed: false, importedAt: importedAt.toISOString(), enforce };
}

/**
 * Nombre de respaldo para client-profile (FSM sin identidad). Normaliza la
 * cuenta igual que el import. Si la base falla devuelve `null`: el respaldo
 * nunca puede tumbar la pantalla de Datos Personales.
 */
export async function findWhitelistFullName(
  accountNumber: string,
  onError?: (err: unknown) => void,
): Promise<string | null> {
  const account = normalizeAccountNumber(accountNumber);
  if (!account) return null;
  try {
    const name = await repository.findFullName(account);
    return name && name.trim().length > 0 ? name.trim() : null;
  } catch (err) {
    onError?.(err);
    return null;
  }
}
