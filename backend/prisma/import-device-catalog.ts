// Importa el catálogo de equipos homologados desde la planilla
// "Velocidades por modelos de equipos GPON.xlsx" (primera hoja).
//
// Uso:
//   npm run device-catalog:import -- "<ruta.xlsx>" [--dry-run] [--write-json]
//
//   --dry-run     solo interpreta y muestra el resultado; no toca la base.
//   --write-json  además reescribe `prisma/catalogs/device-catalog.json` (el seed
//                 que usa `prisma/seed.ts` en el servidor, donde no está la
//                 planilla). Commitear ese JSON después de actualizar.
//
// Idempotente: upsert por MODELO. Solo entran los 'Moderno'; los 'Obsoleto'
// que ya existan quedan inactivos. Nunca borra filas.
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import {
  DeviceCatalogParseError,
  parseDeviceCatalogRows,
  upsertDeviceCatalog,
} from '../src/modules/device-validation/device-catalog.import.js';

const JSON_PATH = fileURLToPath(new URL('./catalogs/device-catalog.json', import.meta.url));

async function readSheetRows(file: string): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  if (!ws) throw new DeviceCatalogParseError('La planilla no tiene hojas.');
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // exceljs indexa desde 1: `values[0]` siempre está vacío.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    rows.push(values);
  });
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const writeJson = args.includes('--write-json');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Uso: npm run device-catalog:import -- "<planilla.xlsx>" [--dry-run] [--write-json]');
    process.exit(2);
  }

  const parsed = parseDeviceCatalogRows(await readSheetRows(file));
  console.log(
    `[device-catalog] Planilla: ${parsed.items.length} modelos 'Moderno', ` +
      `${parsed.obsoleteModels.length} 'Obsoleto', ${parsed.skipped.length} filas omitidas.`,
  );
  for (const s of parsed.skipped) console.warn(`[device-catalog]   fila ${s.row}: ${s.reason}`);
  for (const i of parsed.items) {
    console.log(
      `[device-catalog]   ${i.model} | eth ${i.ethernetMaxMbps} | wifi ${i.wifiMaxMbps ?? '-'} (${i.wifiStatus})` +
        ` | prefijos ${i.serialPrefixes.join(',') || '-'}`,
    );
  }
  if (parsed.items.length === 0) {
    console.error('[device-catalog] Ningún modelo Moderno: no se toca nada.');
    process.exit(1);
  }

  if (writeJson) {
    const payload = {
      source: "Velocidades por modelos de equipos GPON.xlsx (Hoja1), solo ESTADO_EQUIPO = 'Moderno'",
      generatedAt: new Date().toISOString().slice(0, 10),
      items: parsed.items,
    };
    await writeFile(JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`[device-catalog] Seed reescrito: ${JSON_PATH}`);
  }

  if (dryRun) {
    console.log('[device-catalog] --dry-run: la base no se modificó.');
    return;
  }

  const prisma = new PrismaClient();
  try {
    const result = await upsertDeviceCatalog(prisma, parsed.items, parsed.obsoleteModels);
    const active = await prisma.deviceModel.count({ where: { active: true } });
    console.log(
      `[device-catalog] Listo: ${result.created} creados, ${result.updated} actualizados, ` +
        `${result.deactivated} desactivados. Activos en catálogo: ${active}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[device-catalog] Falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
