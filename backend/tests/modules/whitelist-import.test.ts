// Reemplazo de la whitelist contra Postgres (requiere `docker compose up -d`).
//
// Todo corre DENTRO de una transacción que se revierte al final: el test nunca
// toca la lista que haya importada en la base local. Datos sintéticos.
import { describe, it, expect, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { prisma } from '../../src/db/prisma.js';
import {
  WhitelistCsvError,
  parseWhitelistCsv,
  replaceWhitelist,
} from '../../src/modules/whitelist/whitelist.import.js';
import {
  whitelistCsvHeader,
  whitelistCsvMetaLine,
  whitelistRowToCsv,
  type WhitelistRow,
} from '../../src/modules/whitelist/whitelist.normalize.js';

class Rollback extends Error {}

function row(n: number, status: WhitelistRow['status'] = 'ACTIVO'): WhitelistRow {
  return {
    accountNumber: String(99_000_000 + n),
    documentId: '0900000001',
    documentNormalized: true,
    cpartyId: null,
    status,
    city: 'CIUDAD X',
    node: null,
    businessType: 'Internet CM',
    accountType: null,
    accessType: null,
    fullName: n % 2 === 0 ? `NOMBRE SINTETICO ${n}` : null,
  };
}

function csvOf(rows: WhitelistRow[]): Readable {
  const lines = [
    whitelistCsvMetaLine(['/ruta/privada/SALDOS.xlsx', 'C:\\x\\PRODUCTOS.xlsx'], new Date()),
    whitelistCsvHeader(),
    ...rows.map(whitelistRowToCsv),
  ];
  return Readable.from([`\uFEFF${lines.join('\r\n')}\r\n`]);
}

/** Ejecuta `fn` en una transacción y la revierte siempre. */
async function inRollback(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<void>,
): Promise<void> {
  await expect(
    prisma.$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback();
      },
      { timeout: 60_000 },
    ),
  ).rejects.toBeInstanceOf(Rollback);
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('parseWhitelistCsv', () => {
  it('lee BOM/CRLF, metadatos (solo nombres de archivo) y filas', async () => {
    const parsed = await parseWhitelistCsv(csvOf([row(1), row(2, 'PENDIENTE')]));
    expect(parsed.dataLines).toBe(2);
    expect(parsed.rows.map((r) => r.accountNumber)).toEqual(['99000001', '99000002']);
    expect(parsed.sourceFiles).toEqual(['SALDOS.xlsx', 'PRODUCTOS.xlsx']);
  });

  it('rechaza cuentas duplicadas y cabecera distinta, sin volcar el contenido', async () => {
    const dup = parseWhitelistCsv(csvOf([row(1), row(1)]));
    await expect(dup).rejects.toBeInstanceOf(WhitelistCsvError);
    await expect(parseWhitelistCsv(csvOf([row(1), row(1)]))).rejects.toThrow(
      /línea 4: accountNumber duplicado/,
    );
    await expect(parseWhitelistCsv(csvOf([row(1), row(1)]))).rejects.not.toThrow(/99000001/);
    await expect(
      parseWhitelistCsv(Readable.from(['accountNumber,nombre\n"1","X"\n'])),
    ).rejects.toThrow(/Cabecera inesperada/);
  });
});

describe('replaceWhitelist (transacción revertida)', () => {
  it('reemplaza la lista completa, registra el import y es idempotente', async () => {
    const parsed = await parseWhitelistCsv(
      csvOf([
        row(1),
        row(2, 'SUSPENDIDO'),
        row(3, 'ORDENADO'),
        ...Array.from({ length: 5200 }, (_, i) => row(10 + i)),
      ]),
    );

    await inRollback(async (tx) => {
      const first = await replaceWhitelist(tx, parsed);
      expect(first.accounts).toBe(5203); // > IMPORT_BATCH_SIZE: dos lotes
      expect(first.byStatus).toEqual({ ACTIVO: 5201, SUSPENDIDO: 1, ORDENADO: 1, PENDIENTE: 0 });

      const second = await replaceWhitelist(tx, parsed);
      expect(second.accounts).toBe(5203);
      expect(await tx.customerWhitelist.count()).toBe(5203);

      const entry = await tx.customerWhitelist.findUnique({ where: { accountNumber: '99000002' } });
      expect(entry).toMatchObject({
        status: 'SUSPENDIDO',
        documentId: '0900000001',
        documentNormalized: true,
      });

      const record = await tx.whitelistImport.findUnique({ where: { id: second.importId } });
      expect(record).toMatchObject({
        rows: 5203,
        accounts: 5203,
        sourceFiles: ['SALDOS.xlsx', 'PRODUCTOS.xlsx'],
      });

      // Un import más chico borra lo que ya no está.
      const smaller = await parseWhitelistCsv(csvOf([row(1)]));
      await replaceWhitelist(tx, smaller);
      expect(await tx.customerWhitelist.count()).toBe(1);
    });
  }, 60_000);
});
