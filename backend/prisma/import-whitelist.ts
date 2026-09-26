// Importa la whitelist de clientes REEMPLAZANDO la lista completa.
//
// Uso:
//   npx tsx prisma/import-whitelist.ts <whitelist.csv> [--force]
//   npx tsx prisma/import-whitelist.ts - [--force]          (CSV por stdin)
//
// En el servidor corre en el contenedor `migrate` (perfil tools); el CSV entra
// por stdin para no tener que montarlo (ver DEPLOY.md, "Whitelist de clientes").
//
// El CSV lo genera `scripts/whitelist-build.ts` en local. Se valida COMPLETO
// antes de tocar la base; luego DELETE + INSERT por lotes + registro en
// `whitelist_imports`, todo en una transacción. Idempotente.
//
// Salvaguarda: si la lista nueva tiene menos de la mitad de cuentas que la del
// último import, se aborta (un CSV truncado dejaría fuera a clientes reales con
// WHITELIST_ENFORCE=true). `--force` la salta.
//
// Solo imprime conteos agregados: nunca una fila.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  WhitelistCsvError,
  parseWhitelistCsv,
  readWhitelistCsvFile,
  replaceWhitelist,
} from '../src/modules/whitelist/whitelist.import.js';

const SHRINK_GUARD_RATIO = 0.5;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Uso: npx tsx prisma/import-whitelist.ts <whitelist.csv | -> [--force]');
    process.exit(2);
  }

  const started = Date.now();
  const parsed =
    file === '-' ? await parseWhitelistCsv(process.stdin) : await readWhitelistCsvFile(file);
  console.log(
    `[whitelist] CSV válido: ${parsed.dataLines} filas, ${parsed.rows.length} cuentas ` +
      `(origen: ${parsed.sourceFiles.join(', ') || 'sin metadatos'}).`,
  );
  if (parsed.rows.length === 0) {
    console.error('[whitelist] El CSV no tiene cuentas: no se reemplaza la lista.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const previous = await prisma.whitelistImport.findFirst({
      orderBy: { importedAt: 'desc' },
      select: { accounts: true, importedAt: true },
    });
    if (previous && !force && parsed.rows.length < previous.accounts * SHRINK_GUARD_RATIO) {
      console.error(
        `[whitelist] ABORTADO: la lista nueva (${parsed.rows.length}) tiene menos de la mitad ` +
          `de cuentas que la vigente (${previous.accounts}, ${previous.importedAt.toISOString()}). ` +
          `Si es correcto, repite con --force.`,
      );
      process.exit(1);
    }

    const result = await prisma.$transaction(
      (tx) =>
        replaceWhitelist(tx, parsed, {
          onProgress: (n) => {
            if (n % 50_000 < 5000 || n === parsed.rows.length) {
              console.log(`[whitelist] insertadas ${n}/${parsed.rows.length}`);
            }
          },
        }),
      { maxWait: 30_000, timeout: 15 * 60_000 },
    );

    // Estadísticas frescas para el planner tras reemplazar ~300k filas.
    await prisma.$executeRawUnsafe('ANALYZE customer_whitelist');

    console.log(
      `[whitelist] OK en ${((Date.now() - started) / 1000).toFixed(1)} s — ` +
        `import ${result.importId}, ${result.accounts} cuentas, ` +
        `por estado ${JSON.stringify(result.byStatus)}, importedAt ${result.importedAt.toISOString()}.`,
    );
    if (previous) console.log(`[whitelist] Lista anterior: ${previous.accounts} cuentas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof WhitelistCsvError) {
    console.error(`[whitelist] CSV inválido: ${err.message}`);
  } else {
    // Solo el mensaje: un error de Prisma podría arrastrar valores de la fila.
    console.error(
      `[whitelist] Error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }
  process.exit(1);
});
