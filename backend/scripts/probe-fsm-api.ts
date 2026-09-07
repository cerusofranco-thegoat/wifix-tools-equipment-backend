/**
 * Sonda de `fsm-data-ms` (Grupo TVCable).
 *
 * ⚠ TODO ES PRODUCCIÓN. No hay ambiente de pruebas y la operadora pidió no
 * consultar de más: cada comando de este script hace el mínimo de llamadas
 * posible y `chain` está acotado a 4.
 *
 * Uso:
 *   npx tsx scripts/probe-fsm-api.ts token
 *   npx tsx scripts/probe-fsm-api.ts process <cuenta> [Todas|Pendientes]
 *   npx tsx scripts/probe-fsm-api.ts tasks <workOrder>
 *   npx tsx scripts/probe-fsm-api.ts status <cuenta>
 *   npx tsx scripts/probe-fsm-api.ts naps <lat> <lng> [meters] [maxRows]
 *   npx tsx scripts/probe-fsm-api.ts nap-accounts <napId>
 *   npx tsx scripts/probe-fsm-api.ts chain <cuenta>
 *
 * Flags globales:
 *   --brand=telenews|seteinfo   marca (realm) a usar. Default: FSM_DEFAULT_BRAND.
 *   --save                      guarda la salida cruda en
 *                               tests/fixtures/fsm/<comando>.json, para que los
 *                               tests usen datos reales sin volver a pegarle a
 *                               la operadora.
 *
 * `token` funciona SIN RED y sin token configurado: informa MISSING.
 * Imprime el JSON crudo y la lista de claves de cada respuesta: es la única
 * forma de calibrar los parsers de `connectors/fsm/normalize.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { ApiError } from '../src/middleware/error-handler.js';
import {
  activeAccountStatusKey,
  fetchAccountProcess,
  fetchAccountStatus,
  fetchNapAccounts,
  fetchNapsNearest,
  fetchWorkOrderTasks,
} from '../src/connectors/http/fsm-api.js';
import {
  brandClientId,
  brandRealm,
  configuredBrands,
  decodeJwtClaims,
  fsmTokenStatus,
  resolveBrand,
  type FsmBrand,
} from '../src/connectors/http/fsm-token.js';

const FIXTURES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../tests/fixtures/fsm',
);

let saveEnabled = false;
let saveName = '';

function show(label: string, data: unknown): void {
  console.log(`\n===== ${label} =====`);
  if (data === null) {
    console.log('(204 / sin datos)');
    return;
  }
  const json = JSON.stringify(data, null, 2);
  console.log(json.length > 4000 ? `${json.slice(0, 4000)}\n… (truncado, ${json.length} chars)` : json);
  if (Array.isArray(data)) {
    console.log(
      `-- array de ${data.length} elementos; claves del primero:`,
      data.length > 0 && typeof data[0] === 'object' && data[0] !== null
        ? Object.keys(data[0] as object)
        : '(escalares)',
    );
  } else if (typeof data === 'object') {
    console.log('-- claves:', Object.keys(data as object));
    const inner = (data as Record<string, unknown>).data;
    if (Array.isArray(inner) && inner.length > 0 && typeof inner[0] === 'object' && inner[0]) {
      console.log('-- claves de data[0]:', Object.keys(inner[0] as object));
    }
  }
}

/** Guarda la respuesta cruda como fixture reutilizable por los tests. */
function save(suffix: string, data: unknown): void {
  if (!saveEnabled) return;
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = resolve(FIXTURES_DIR, `${saveName}${suffix}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`-- guardado en ${file}`);
}

/** `token`: decodifica lo configurado. CERO llamadas de red. */
function showToken(brand: FsmBrand): void {
  console.log(`\n===== token (marca ${brand}) =====`);
  console.log(`realm:  ${brandRealm(brand)}`);
  console.log(`client: ${brandClientId(brand)}`);
  console.log(`marcas configuradas: ${configuredBrands().join(', ') || '(ninguna)'}`);
  console.log(`modo NAPs: ${env.NAPS_PRIMARY_SOURCE}`);

  for (const health of fsmTokenStatus()) {
    const restante =
      health.expiresInSeconds === null
        ? '—'
        : health.expiresInSeconds >= 0
          ? `${Math.floor(health.expiresInSeconds / 3600)} h ${Math.floor((health.expiresInSeconds % 3600) / 60)} min`
          : `VENCIDO hace ${Math.floor(-health.expiresInSeconds / 3600)} h`;
    console.log(
      `\n  [${health.brand}] disponible=${health.available} motivo=${health.reason ?? '—'} ` +
        `fuente=${health.tokenSource ?? '—'}\n` +
        `            exp=${health.expiresAt ?? '—'} restante=${restante}`,
    );
    const raw = (process.env[`FSM_API_TOKEN_${health.brand.toUpperCase()}`] ?? '').trim();
    if (raw) {
      const claims = decodeJwtClaims(raw);
      // Nunca se imprime el token: solo azp / iss / iat / exp.
      console.log(
        `            azp=${claims?.azp ?? '—'} iss=${claims?.iss ?? '—'} ` +
          `iat=${claims?.iat ? new Date(claims.iat * 1000).toISOString() : '—'}`,
      );
    }
  }
  console.log(
    '\n(Ninguna de estas líneas salió a la red: el estado se calcula decodificando el JWT.)',
  );
}

function parseFlags(argv: string[]): { args: string[]; brandFlag: string | null } {
  const args: string[] = [];
  let brandFlag: string | null = null;
  for (const arg of argv) {
    if (arg === '--save') {
      saveEnabled = true;
      continue;
    }
    if (arg.startsWith('--brand=')) {
      brandFlag = arg.slice('--brand='.length);
      continue;
    }
    args.push(arg);
  }
  return { args, brandFlag };
}

async function main(): Promise<void> {
  const { args, brandFlag } = parseFlags(process.argv.slice(2));
  const [command, ...rest] = args;
  const brand = resolveBrand(brandFlag);
  saveName = command ?? 'probe';

  if (command === 'token') {
    showToken(brand);
    return;
  }

  if (command === 'process') {
    const account = rest[0];
    if (!account) throw new Error('Uso: probe-fsm-api.ts process <cuenta> [Todas|Pendientes]');
    const estado = (rest[1] === 'Pendientes' ? 'Pendientes' : 'Todas') as 'Todas' | 'Pendientes';
    const data = await fetchAccountProcess(brand, account, estado);
    show(`account/process ${account} (${estado}, marca ${brand})`, data);
    save('', data);
    return;
  }

  if (command === 'tasks') {
    const workOrder = rest[0];
    if (!workOrder) throw new Error('Uso: probe-fsm-api.ts tasks <workOrder>');
    const data = await fetchWorkOrderTasks(brand, workOrder);
    show(`workorder/tasks ${workOrder} (marca ${brand})`, data);
    save('', data);
    return;
  }

  if (command === 'status') {
    const account = rest[0];
    if (!account) throw new Error('Uso: probe-fsm-api.ts status <cuenta>');
    // fetchAccountStatus prueba `account_id` y, ante un 400, `accountId`.
    const data = await fetchAccountStatus(brand, account);
    show(`account/status ${account} (marca ${brand})`, data);
    console.log(`-- clave aceptada por /account/status: ${activeAccountStatusKey() ?? '(ninguna)'}`);
    save('', data);
    return;
  }

  if (command === 'naps') {
    const lat = Number(rest[0]);
    const lng = Number(rest[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error('Uso: probe-fsm-api.ts naps <lat> <lng> [meters] [maxRows]');
    }
    const meters = Number(rest[2] ?? 100) || 100;
    const maxRows = Number(rest[3] ?? 5) || 5;
    const data = await fetchNapsNearest(brand, lat, lng, meters, maxRows);
    show(`naps/nearest ${lat},${lng} (${meters} m, ${maxRows} filas, marca ${brand})`, data);
    save('', data);
    return;
  }

  if (command === 'nap-accounts') {
    const napId = Number(rest[0]);
    if (!Number.isFinite(napId)) throw new Error('Uso: probe-fsm-api.ts nap-accounts <napId>');
    const data = await fetchNapAccounts(brand, napId);
    show(`naps/accounts id=${napId} (marca ${brand})`, data);
    save('', data);
    return;
  }

  if (command === 'chain') {
    const account = rest[0];
    if (!account) throw new Error('Uso: probe-fsm-api.ts chain <cuenta>');
    console.log(
      '\n(chain está acotado a 4 llamadas: process → naps/nearest → naps/accounts → ' +
        'workorder/tasks de UNA orden. Es producción.)',
    );

    // 1/4
    const process1 = await fetchAccountProcess(brand, account, 'Todas');
    show(`1/4 account/process ${account}`, process1);
    save('-process', process1);

    const rows = Array.isArray(process1)
      ? process1
      : Array.isArray((process1 as { data?: unknown } | null)?.data)
        ? ((process1 as { data: unknown[] }).data)
        : [];
    const first = rows.find((r) => typeof r === 'object' && r !== null) as
      | Record<string, unknown>
      | undefined;
    const lat = Number(first?.latitude ?? first?.lat);
    const lng = Number(first?.longitude ?? first?.lng);
    const workOrder = String(first?.workOrder ?? '');

    // 2/4
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const naps = await fetchNapsNearest(brand, lat, lng, 100, 5);
      show(`2/4 naps/nearest ${lat},${lng}`, naps);
      save('-naps', naps);

      const napRows = Array.isArray(naps)
        ? naps
        : Array.isArray((naps as { data?: unknown } | null)?.data)
          ? ((naps as { data: unknown[] }).data)
          : [];
      const firstNap = napRows.find((r) => typeof r === 'object' && r !== null) as
        | Record<string, unknown>
        | undefined;
      const napId = Number(firstNap?.id);
      // 3/4
      if (Number.isFinite(napId)) {
        const accounts = await fetchNapAccounts(brand, napId);
        show(`3/4 naps/accounts id=${napId}`, accounts);
        save('-nap-accounts', accounts);
      } else {
        console.log('\n3/4 omitido: la primera NAP no trae `id`.');
      }
    } else {
      console.log('\n2/4 y 3/4 omitidos: la orden no trae latitude/longitude.');
    }

    // 4/4
    if (workOrder) {
      const tasks = await fetchWorkOrderTasks(brand, workOrder);
      show(`4/4 workorder/tasks ${workOrder}`, tasks);
      save('-tasks', tasks);
    } else {
      console.log('\n4/4 omitido: la primera orden no trae `workOrder`.');
    }
    return;
  }

  console.log(
    'Uso:\n' +
      '  npx tsx scripts/probe-fsm-api.ts token\n' +
      '  npx tsx scripts/probe-fsm-api.ts process <cuenta> [Todas|Pendientes]\n' +
      '  npx tsx scripts/probe-fsm-api.ts tasks <workOrder>\n' +
      '  npx tsx scripts/probe-fsm-api.ts status <cuenta>\n' +
      '  npx tsx scripts/probe-fsm-api.ts naps <lat> <lng> [meters] [maxRows]\n' +
      '  npx tsx scripts/probe-fsm-api.ts nap-accounts <napId>\n' +
      '  npx tsx scripts/probe-fsm-api.ts chain <cuenta>   (máx. 4 llamadas)\n' +
      '\nFlags: --brand=telenews|seteinfo  --save',
  );
  process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof ApiError) {
    console.error(`\n[${err.code}] ${err.message}`);
    if (err.meta) console.error(err.meta);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
