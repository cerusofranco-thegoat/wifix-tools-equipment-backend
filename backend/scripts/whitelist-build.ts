// Construye el CSV MINIMIZADO de la whitelist a partir de las planillas de la
// operadora. Corre SOLO en local (las planillas tienen datos personales de
// ~300k clientes y nunca suben al servidor ni al repo).
//
// Uso:
//   npx tsx scripts/whitelist-build.ts <CLIENTESSALDOSAS.xlsx> <CLIENTESPRODUCTOSAS.xlsx> --out <whitelist.csv>
//
// - Lectura en STREAMING (exceljs WorkbookReader): las planillas pesan 30-54 MB.
// - Base = SALDOS (1 fila por cuenta). PRODUCTOS (1 fila por producto) aporta
//   TIPO_CUENTA y TIPO_ACCESO. Con varios productos, el estado es el de mayor
//   prioridad (ACTIVO > SUSPENDIDO > ORDENADO > PENDIENTE, contando también el
//   de SALDOS) y TIPO_CUENTA / TIPO_ACCESO salen del producto de mayor prioridad.
// - MINIMIZACIÓN (LOPDP): solo salen las columnas de WHITELIST_CSV_COLUMNS.
//   El nombre (FULLNAME de SALDOS, o de PRODUCTOS si falta) es lo único
//   personal además del documento: respaldo de client-profile cuando FSM no
//   trae identidad. Dirección, coordenadas, saldo, etc. ni se leen a memoria.
// - Por consola SOLO conteos agregados: nunca una fila.
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';
import {
  WHITELIST_STATUSES,
  cleanText,
  normalizeAccountNumber,
  normalizeDocumentId,
  outranks,
  parseStatus,
  pickStatus,
  whitelistCsvHeader,
  whitelistCsvMetaLine,
  whitelistRowToCsv,
  type WhitelistRow,
  type WhitelistStatusValue,
} from '../src/modules/whitelist/whitelist.normalize.js';

// ---------------------------------------------------------------------------
// Lectura de planillas
// ---------------------------------------------------------------------------

type CellPrimitive = string | number | boolean | null;

/** Valor de celda de exceljs → primitivo (rich text, fórmulas, fechas…). */
function cellToPrimitive(value: unknown): CellPrimitive {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: unknown }>)
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .join('');
    }
    if ('sharedString' in v) {
      // La hoja vino en el zip ANTES que sharedStrings.xml: exceljs no puede
      // resolver el texto en streaming. Excel no guarda así; otro exportador sí.
      throw new Error(
        'la planilla guarda las hojas antes de sharedStrings.xml y no se puede leer en ' +
          'streaming. Ábrela y guárdala de nuevo con Excel (o expórtala con strings inline).',
      );
    }
    if ('result' in v) return cellToPrimitive(v.result);
    if (typeof v.text === 'string') return v.text;
  }
  return null;
}

/**
 * Recorre la PRIMERA hoja del libro en streaming. Solo se entregan las columnas
 * pedidas (`wanted`); el resto de la fila se descarta al momento.
 */
async function* readSheetRows<C extends string>(
  path: string,
  wanted: readonly C[],
  label: string,
): AsyncGenerator<Record<C, CellPrimitive>> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, {
    worksheets: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    entries: 'emit',
  });
  // exceljs asume que `xl/workbook.xml` viene antes que las hojas dentro del
  // zip. Excel lo escribe así, pero otros generadores (el propio exceljs, que
  // usan los tests) no, y el lector revienta con "reading 'sheets'". Con un
  // modelo vacío de partida la hoja se lee igual (solo pierde el nombre, que no
  // usamos: se toma la primera hoja); si workbook.xml llega, lo reemplaza.
  Object.assign(reader, { model: { sheets: [] } });

  for await (const worksheet of reader) {
    let index: Map<C, number> | null = null;
    for await (const row of worksheet) {
      const values = row.values as unknown[];
      if (!index) {
        const headers = values.map((v) =>
          String(cellToPrimitive(v) ?? '')
            .trim()
            .toUpperCase(),
        );
        const map = new Map<C, number>();
        const missing: string[] = [];
        for (const col of wanted) {
          const i = headers.indexOf(col);
          if (i === -1) missing.push(col);
          else map.set(col, i);
        }
        if (missing.length > 0) {
          throw new Error(`${label}: faltan columnas ${missing.join(', ')}`);
        }
        index = map;
        continue;
      }
      const out = {} as Record<C, CellPrimitive>;
      for (const col of wanted) out[col] = cellToPrimitive(values[index.get(col) as number]);
      yield out;
    }
    // Solo la primera hoja.
    return;
  }
  throw new Error(`${label}: el libro no tiene hojas`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const SALDOS_COLUMNS = [
  'ACCOUNT_ID',
  'CEDULA_RUC',
  'CPARTY_ID',
  'ESTADO_PRODUCTO',
  'CIUDAD_MATRICES',
  'NODO',
  'TIPO_DE_NEGOCIO',
  'FULLNAME',
] as const;

const PRODUCTOS_COLUMNS = [
  'ACCOUNT_ID',
  'ESTADO_PRODUCTO',
  'TIPO_CUENTA',
  'TIPO_ACCESO',
  'FULLNAME',
] as const;

interface ProductAggregate {
  status: WhitelistStatusValue;
  accountType: string | null;
  accessType: string | null;
  /** Primer FULLNAME no vacío, prefiriendo el del producto de mayor prioridad. */
  fullName: string | null;
  distinctStatuses: Set<WhitelistStatusValue>;
}

export interface WhitelistBuildStats {
  accounts: number;
  byStatus: Record<WhitelistStatusValue, number>;
  documents: {
    normalized: number;
    notNormalized: number;
    paddedCedula: number;
    paddedRuc: number;
    empty: number;
  };
  saldos: { rows: number; skippedNoAccount: number; skippedBadStatus: number; duplicates: number };
  productos: {
    rows: number;
    accounts: number;
    skippedNoAccount: number;
    skippedBadStatus: number;
    accountsWithMultipleStatuses: number;
    accountsNotInSaldos: number;
  };
  accountsWithProducts: number;
  accountsWithoutProducts: number;
  statusUpgradedByProducts: number;
  fullName: { withName: number; withoutName: number; fromProductos: number };
}

export interface WhitelistBuildOptions {
  saldosPath: string;
  productosPath: string;
  outPath: string;
  now?: Date;
}

function emptyByStatus(): Record<WhitelistStatusValue, number> {
  return Object.fromEntries(WHITELIST_STATUSES.map((s) => [s, 0])) as Record<
    WhitelistStatusValue,
    number
  >;
}

export async function buildWhitelistCsv(
  options: WhitelistBuildOptions,
): Promise<WhitelistBuildStats> {
  const stats: WhitelistBuildStats = {
    accounts: 0,
    byStatus: emptyByStatus(),
    documents: { normalized: 0, notNormalized: 0, paddedCedula: 0, paddedRuc: 0, empty: 0 },
    saldos: { rows: 0, skippedNoAccount: 0, skippedBadStatus: 0, duplicates: 0 },
    productos: {
      rows: 0,
      accounts: 0,
      skippedNoAccount: 0,
      skippedBadStatus: 0,
      accountsWithMultipleStatuses: 0,
      accountsNotInSaldos: 0,
    },
    accountsWithProducts: 0,
    accountsWithoutProducts: 0,
    statusUpgradedByProducts: 0,
    fullName: { withName: 0, withoutName: 0, fromProductos: 0 },
  };

  // 1. PRODUCTOS → agregado por cuenta (solo estado y los dos tipos).
  const products = new Map<string, ProductAggregate>();
  for await (const r of readSheetRows(options.productosPath, PRODUCTOS_COLUMNS, 'PRODUCTOS')) {
    stats.productos.rows += 1;
    const account = normalizeAccountNumber(r.ACCOUNT_ID);
    if (!account) {
      stats.productos.skippedNoAccount += 1;
      continue;
    }
    const status = parseStatus(r.ESTADO_PRODUCTO);
    if (!status) {
      stats.productos.skippedBadStatus += 1;
      continue;
    }
    const accountType = cleanText(r.TIPO_CUENTA);
    const accessType = cleanText(r.TIPO_ACCESO);
    const fullName = cleanText(r.FULLNAME);
    const current = products.get(account);
    if (!current) {
      products.set(account, {
        status,
        accountType,
        accessType,
        fullName,
        distinctStatuses: new Set([status]),
      });
      continue;
    }
    current.distinctStatuses.add(status);
    if (outranks(status, current.status)) {
      current.status = status;
      current.accountType = accountType;
      current.accessType = accessType;
      current.fullName = fullName ?? current.fullName;
    } else if (status === current.status) {
      // Mismo estado: se completan huecos, sin pisar lo que ya había.
      current.accountType ??= accountType;
      current.accessType ??= accessType;
      current.fullName ??= fullName;
    } else {
      current.fullName ??= fullName;
    }
  }
  stats.productos.accounts = products.size;
  for (const p of products.values()) {
    if (p.distinctStatuses.size > 1) stats.productos.accountsWithMultipleStatuses += 1;
  }

  // 2. SALDOS → base. Se acumula en memoria (~300k filas chicas) para poder
  //    resolver duplicados antes de escribir.
  const rows = new Map<string, WhitelistRow>();
  const fromProductos = new Set<string>();
  for await (const r of readSheetRows(options.saldosPath, SALDOS_COLUMNS, 'SALDOS')) {
    stats.saldos.rows += 1;
    const account = normalizeAccountNumber(r.ACCOUNT_ID);
    if (!account) {
      stats.saldos.skippedNoAccount += 1;
      continue;
    }
    const saldoStatus = parseStatus(r.ESTADO_PRODUCTO);
    const product = products.get(account);
    const status = pickStatus(
      [saldoStatus, product?.status ?? null].filter((s): s is WhitelistStatusValue => s !== null),
    );
    if (!status) {
      stats.saldos.skippedBadStatus += 1;
      continue;
    }
    const doc = normalizeDocumentId(r.CEDULA_RUC);
    const saldoName = cleanText(r.FULLNAME);
    const row: WhitelistRow = {
      accountNumber: account,
      documentId: doc.documentId,
      documentNormalized: doc.documentNormalized,
      cpartyId: normalizeAccountNumber(r.CPARTY_ID),
      status,
      city: cleanText(r.CIUDAD_MATRICES),
      node: cleanText(r.NODO),
      businessType: cleanText(r.TIPO_DE_NEGOCIO),
      accountType: product?.accountType ?? null,
      accessType: product?.accessType ?? null,
      fullName: saldoName ?? product?.fullName ?? null,
    };
    const existing = rows.get(account);
    if (existing) {
      stats.saldos.duplicates += 1;
      if (!outranks(row.status, existing.status)) continue;
    }
    rows.set(account, row);
    if (!saldoName && row.fullName) fromProductos.add(account);
    else fromProductos.delete(account);
    if (product && saldoStatus && status !== saldoStatus && !existing) {
      stats.statusUpgradedByProducts += 1;
    }
  }

  for (const account of products.keys()) {
    if (!rows.has(account)) stats.productos.accountsNotInSaldos += 1;
  }

  // 3. CSV.
  const outPath = resolve(options.outPath);
  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  const write = async (chunk: string): Promise<void> => {
    if (!out.write(chunk)) await once(out, 'drain');
  };

  await write(
    `${whitelistCsvMetaLine([options.saldosPath, options.productosPath], options.now ?? new Date())}\n`,
  );
  await write(`${whitelistCsvHeader()}\n`);

  let buffer = '';
  for (const row of rows.values()) {
    stats.accounts += 1;
    stats.byStatus[row.status] += 1;
    if (row.documentNormalized) stats.documents.normalized += 1;
    else stats.documents.notNormalized += 1;
    if (!row.documentId) stats.documents.empty += 1;
    // Un documento de 10/13 que empieza con 0 solo pudo salir de un pad: los
    // enteros de la planilla no conservan ceros a la izquierda.
    if (row.documentNormalized && row.documentId.startsWith('0')) {
      if (row.documentId.length === 10) stats.documents.paddedCedula += 1;
      else stats.documents.paddedRuc += 1;
    }
    if (row.fullName) stats.fullName.withName += 1;
    else stats.fullName.withoutName += 1;
    if (row.fullName && fromProductos.has(row.accountNumber)) stats.fullName.fromProductos += 1;
    if (products.has(row.accountNumber)) stats.accountsWithProducts += 1;
    else stats.accountsWithoutProducts += 1;

    buffer += `${whitelistRowToCsv(row)}\n`;
    if (buffer.length > 1 << 16) {
      await write(buffer);
      buffer = '';
    }
  }
  if (buffer) await write(buffer);
  out.end();
  await once(out, 'finish');

  return stats;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): WhitelistBuildOptions {
  const positional: string[] = [];
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--out') {
      outPath = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith('--out=')) {
      outPath = a.slice('--out='.length);
    } else {
      positional.push(a);
    }
  }
  const [saldosPath, productosPath] = positional;
  if (!saldosPath || !productosPath || !outPath) {
    console.error(
      'Uso: npx tsx scripts/whitelist-build.ts <saldos.xlsx> <productos.xlsx> --out <whitelist.csv>',
    );
    process.exit(2);
  }
  return { saldosPath, productosPath, outPath };
}

async function cli(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const stats = await buildWhitelistCsv(options);
  // SOLO agregados.
  console.log(
    JSON.stringify(
      { ok: true, seconds: Math.round((Date.now() - started) / 1000), ...stats },
      null,
      2,
    ),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  cli().catch((err: unknown) => {
    console.error(`[whitelist-build] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
