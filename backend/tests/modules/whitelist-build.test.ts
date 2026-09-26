// Build xlsx → CSV minimizado. Las planillas se GENERAN en el test con datos
// sintéticos (mismas columnas que las de la operadora, valores inventados).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { buildWhitelistCsv, type WhitelistBuildStats } from '../../scripts/whitelist-build.js';
import { parseWhitelistCsv } from '../../src/modules/whitelist/whitelist.import.js';
import {
  WHITELIST_CSV_COLUMNS,
  type WhitelistRow,
} from '../../src/modules/whitelist/whitelist.normalize.js';

const SALDOS_HEADERS = [
  'TIPO_DE_NEGOCIO',
  'CEDULA_RUC',
  'CPARTY_ID',
  'ACCOUNT_ID',
  'CIUDAD_MATRICES',
  'NODO',
  'SAT',
  'FECHA_MIN_CONTRATACION',
  'ESTADO_PRODUCTO',
  'SALDO',
  'COMBINACION',
  'SERVICIOS',
  'FULLNAME',
];
const PRODUCTOS_HEADERS = [
  'CPARTY_ID',
  'ACCOUNT_ID',
  'TIPO_DE_NEGOCIO',
  'CEDULA_RUC',
  'CIUDAD_MATRICES',
  'NODO',
  'ESTADO_PRODUCTO',
  'COMBINACION',
  'SERVICIOS',
  'FULLNAME',
  'VARIANTE_PRODUCTO',
  'TIPO_ACCESO',
  'ADICIONAL_SALINAS',
  'TIPO_CUENTA',
  'DIRECCION_INSTALACION',
  'COORDENADA_Y',
  'COORDENADA_X',
];

// Marcadores de PII sintética: NINGUNO puede aparecer en el CSV.
const FAKE_NAME = 'PERSONA SINTETICA UNO';
const FAKE_ADDRESS = 'CALLE FICTICIA 123';
const FAKE_SALDO = 98765.43;
const FAKE_COORD = -2.123456;
/** U+FFFD: el caracter de reemplazo que deja un encoding roto. */
const BROKEN = String.fromCharCode(0xfffd);

type Cell = string | number | null;

async function writeXlsx(
  path: string,
  sheet: string,
  headers: string[],
  rows: Cell[][],
): Promise<void> {
  // Strings inline: exceljs escribe las hojas antes que sharedStrings.xml y su
  // propio lector streaming no podría resolverlas (Excel sí las ordena bien).
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: path,
    useSharedStrings: false,
    useStyles: false,
  });
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers).commit();
  for (const r of rows) ws.addRow(r).commit();
  ws.commit();
  await wb.commit();
}

function saldo(o: {
  account: number;
  doc: Cell;
  status: string;
  negocio?: string;
  city?: string;
  node?: Cell;
}): Cell[] {
  return [
    o.negocio ?? 'Internet CM',
    o.doc,
    5000 + (o.account % 1000),
    o.account,
    o.city ?? 'CIUDAD X',
    o.node ?? 'N1',
    'SAT1',
    '2020-01-01',
    o.status,
    FAKE_SALDO,
    'Simple',
    'INTERNET',
    FAKE_NAME,
  ];
}

function producto(o: { account: number; status: string; access?: string; tipo?: string }): Cell[] {
  return [
    1,
    o.account,
    'Internet CM',
    900000001,
    'CIUDAD X',
    'N1',
    o.status,
    'Simple',
    'INTERNET',
    FAKE_NAME,
    'VAR',
    o.access ?? 'Acceso Completo',
    'NO',
    o.tipo ?? 'Residencial',
    FAKE_ADDRESS,
    FAKE_COORD,
    -79.5,
  ];
}

let dir: string;
let csv: string;
let stats: WhitelistBuildStats;
let rows: Map<string, WhitelistRow>;
let sourceFiles: string[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wifix-whitelist-'));
  const saldos = join(dir, 'SALDOS_SINTETICO.xlsx');
  const productos = join(dir, 'PRODUCTOS_SINTETICO.xlsx');
  const out = join(dir, 'out', 'whitelist.csv');

  await writeXlsx(saldos, 'CLIENTESSALDOSAS', SALDOS_HEADERS, [
    // Cédula de 9 dígitos (perdió el 0) — un producto ACTIVO.
    saldo({ account: 90000001, doc: 912345678, status: 'ACTIVO' }),
    // Estado de SALDOS SUSPENDIDO, pero tiene un producto ACTIVO → ACTIVO.
    saldo({ account: 90000002, doc: 990000000001, status: 'SUSPENDIDO' }),
    // Sin productos; documento de 8 dígitos → no normalizado; encoding roto.
    saldo({
      account: 90000003,
      doc: 12345678,
      status: 'ORDENADO',
      negocio: `Telefon${BROKEN}a Locutorio`,
      node: 4321,
    }),
    // Estado desconocido y sin productos → se descarta.
    saldo({ account: 90000004, doc: 1712345678, status: 'RARO' }),
    // Sin número de cuenta → se descarta.
    saldo({ account: 0, doc: 1712345678, status: 'ACTIVO' }).map((c, i) => (i === 3 ? null : c)),
  ]);
  await writeXlsx(productos, 'CLIENTESPRODUCTOSAS', PRODUCTOS_HEADERS, [
    producto({
      account: 90000001,
      status: 'ACTIVO',
      access: 'Acceso Completo',
      tipo: 'Residencial',
    }),
    producto({
      account: 90000002,
      status: 'PENDIENTE',
      access: 'Sin Registro',
      tipo: 'Empresarial',
    }),
    producto({ account: 90000002, status: 'ACTIVO', access: 'Mora Dia 31', tipo: 'Hoteles' }),
    producto({ account: 90000002, status: 'SUSPENDIDO', access: 'Suspendido', tipo: 'TDD' }),
  ]);

  stats = await buildWhitelistCsv({
    saldosPath: saldos,
    productosPath: productos,
    outPath: out,
    now: new Date('2026-01-01T00:00:00Z'),
  });
  csv = await readFile(out, 'utf8');
  const parsed = await parseWhitelistCsv(createReadStream(out, { encoding: 'utf8' }));
  rows = new Map(parsed.rows.map((r) => [r.accountNumber, r]));
  sourceFiles = parsed.sourceFiles;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('whitelist-build', () => {
  it('cabecera = exactamente las columnas permitidas; metadatos solo con nombres de archivo', () => {
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toMatch(
      /^#wifix-whitelist v1; sources=SALDOS_SINTETICO\.xlsx\|PRODUCTOS_SINTETICO\.xlsx; builtAt=2026-01-01T00:00:00\.000Z$/,
    );
    expect(lines[1]).toBe(WHITELIST_CSV_COLUMNS.join(','));
    expect(csv).not.toContain(dir); // nunca rutas locales
    expect(sourceFiles).toEqual(['SALDOS_SINTETICO.xlsx', 'PRODUCTOS_SINTETICO.xlsx']);
  });

  it('MINIMIZACIÓN: ni nombre, ni dirección, ni saldo, ni coordenadas', () => {
    expect(csv).not.toContain(FAKE_NAME);
    expect(csv).not.toContain(FAKE_ADDRESS);
    expect(csv).not.toContain(String(FAKE_SALDO));
    expect(csv).not.toContain(String(FAKE_COORD));
  });

  it('cuenta con un producto: cédula rellenada y tipos del producto', () => {
    expect(rows.get('90000001')).toEqual({
      accountNumber: '90000001',
      documentId: '0912345678',
      documentNormalized: true,
      cpartyId: '5001',
      status: 'ACTIVO',
      city: 'CIUDAD X',
      node: 'N1',
      businessType: 'Internet CM',
      accountType: 'Residencial',
      accessType: 'Acceso Completo',
    });
  });

  it('varios productos: estado por prioridad y tipos del producto de mayor prioridad', () => {
    const r = rows.get('90000002');
    expect(r?.status).toBe('ACTIVO');
    expect(r?.documentId).toBe('0990000000001');
    expect(r?.accessType).toBe('Mora Dia 31');
    expect(r?.accountType).toBe('Hoteles');
  });

  it('sin productos: tipos null, documento corto sin normalizar, texto limpio, nodo numérico', () => {
    const r = rows.get('90000003');
    expect(r).toMatchObject({
      status: 'ORDENADO',
      documentId: '12345678',
      documentNormalized: false,
      businessType: 'Telefona Locutorio',
      node: '4321',
      accountType: null,
      accessType: null,
    });
  });

  it('conteos agregados', () => {
    expect(rows.size).toBe(3);
    expect(stats.accounts).toBe(3);
    expect(stats.byStatus).toEqual({ ACTIVO: 2, SUSPENDIDO: 0, ORDENADO: 1, PENDIENTE: 0 });
    expect(stats.documents).toMatchObject({
      normalized: 2,
      notNormalized: 1,
      paddedCedula: 1,
      paddedRuc: 1,
    });
    expect(stats.saldos).toEqual({
      rows: 5,
      skippedNoAccount: 1,
      skippedBadStatus: 1,
      duplicates: 0,
    });
    expect(stats.productos).toMatchObject({
      rows: 4,
      accounts: 2,
      accountsWithMultipleStatuses: 1,
    });
    expect(stats.accountsWithProducts).toBe(2);
    expect(stats.accountsWithoutProducts).toBe(1);
    expect(stats.statusUpgradedByProducts).toBe(1);
  });
});
