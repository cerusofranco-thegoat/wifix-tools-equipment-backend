// Reemplazo completo de la whitelist — lo usa `prisma/import-whitelist.ts`.
//
// Todo ocurre en UNA transacción: DELETE + INSERT por lotes + registro del
// import. Mientras dura, las lecturas de la ruta siguen viendo la lista anterior
// (MVCC; por eso DELETE y no TRUNCATE, que bloquearía las lecturas). Si algo
// falla, rollback y la lista anterior queda intacta. Re-correr con el mismo CSV
// deja exactamente el mismo contenido: idempotente.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import {
  WHITELIST_CSV_COLUMNS,
  WHITELIST_CSV_META_PREFIX,
  WHITELIST_STATUSES,
  csvLineToWhitelistRow,
  type WhitelistRow,
  type WhitelistStatusValue,
} from './whitelist.normalize.js';

/** 5.000 filas × 11 columnas = 55.000 parámetros (< 65.535 de Postgres). */
export const IMPORT_BATCH_SIZE = 5000;

export interface ParsedWhitelistCsv {
  rows: WhitelistRow[];
  /** Filas de datos leídas (sin cabecera ni metadatos). */
  dataLines: number;
  sourceFiles: string[];
}

export class WhitelistCsvError extends Error {}

/**
 * Lee y valida TODO el CSV antes de tocar la base. Los errores dicen la línea y
 * el motivo, nunca el contenido (es dato personal).
 */
export async function parseWhitelistCsv(input: Readable): Promise<ParsedWhitelistCsv> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const rows: WhitelistRow[] = [];
  const seen = new Set<string>();
  let sourceFiles: string[] = [];
  let headerSeen = false;
  let lineNo = 0;
  let dataLines = 0;
  const errors: string[] = [];

  for await (const rawLine of rl) {
    lineNo += 1;
    // BOM (U+FEFF) al inicio si el CSV pasó por un editor de Windows.
    const line = lineNo === 1 && rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
    if (line.trim() === '') continue;
    if (line.startsWith('#')) {
      if (line.startsWith(WHITELIST_CSV_META_PREFIX)) {
        const match = /sources=([^;]*)/.exec(line);
        if (match?.[1]) sourceFiles = match[1].split('|').filter((s) => s.length > 0);
      }
      continue;
    }
    if (!headerSeen) {
      if (line.trim() !== WHITELIST_CSV_COLUMNS.join(',')) {
        throw new WhitelistCsvError(
          `Cabecera inesperada en la línea ${lineNo}. Se esperaba: ${WHITELIST_CSV_COLUMNS.join(',')}`,
        );
      }
      headerSeen = true;
      continue;
    }
    dataLines += 1;
    try {
      const row = csvLineToWhitelistRow(line);
      if (seen.has(row.accountNumber)) throw new Error('accountNumber duplicado');
      seen.add(row.accountNumber);
      rows.push(row);
    } catch (err) {
      if (errors.length < 20) errors.push(`línea ${lineNo}: ${(err as Error).message}`);
      else if (errors.length === 20) errors.push('…');
    }
  }

  if (!headerSeen) throw new WhitelistCsvError('El CSV no tiene cabecera.');
  if (errors.length > 0) {
    throw new WhitelistCsvError(`El CSV tiene filas inválidas:\n  ${errors.join('\n  ')}`);
  }
  return { rows, dataLines, sourceFiles };
}

export function readWhitelistCsvFile(path: string): Promise<ParsedWhitelistCsv> {
  return parseWhitelistCsv(createReadStream(path, { encoding: 'utf8' }));
}

export function countByStatus(
  rows: ReadonlyArray<WhitelistRow>,
): Record<WhitelistStatusValue, number> {
  const out = Object.fromEntries(WHITELIST_STATUSES.map((s) => [s, 0])) as Record<
    WhitelistStatusValue,
    number
  >;
  for (const r of rows) out[r.status] += 1;
  return out;
}

export interface ReplaceWhitelistResult {
  importId: string;
  importedAt: Date;
  accounts: number;
  byStatus: Record<WhitelistStatusValue, number>;
}

/**
 * Reemplaza la whitelist completa. Debe llamarse DENTRO de una transacción
 * (`prisma.$transaction(async (tx) => replaceWhitelist(tx, …))`).
 */
export async function replaceWhitelist(
  tx: Prisma.TransactionClient,
  parsed: ParsedWhitelistCsv,
  options: { importedAt?: Date; onProgress?: (inserted: number) => void } = {},
): Promise<ReplaceWhitelistResult> {
  const importedAt = options.importedAt ?? new Date();

  await tx.customerWhitelist.deleteMany({});

  let inserted = 0;
  for (let i = 0; i < parsed.rows.length; i += IMPORT_BATCH_SIZE) {
    const batch = parsed.rows.slice(i, i + IMPORT_BATCH_SIZE);
    const res = await tx.customerWhitelist.createMany({
      data: batch.map((r) => ({ ...r, importedAt })),
    });
    inserted += res.count;
    options.onProgress?.(inserted);
  }

  const byStatus = countByStatus(parsed.rows);
  const record = await tx.whitelistImport.create({
    data: {
      importedAt,
      sourceFiles: parsed.sourceFiles,
      rows: parsed.dataLines,
      accounts: inserted,
      byStatus,
    },
    select: { id: true },
  });

  return { importId: record.id, importedAt, accounts: inserted, byStatus };
}
