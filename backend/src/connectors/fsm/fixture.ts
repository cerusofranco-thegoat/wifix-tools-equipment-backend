// ---------------------------------------------------------------------------
// Conector FSM en modo `fixture` — respuestas REALES de producción grabadas,
// servidas sin tocar la red.
//
// ¿Para qué? El VPS de la demo (Quasar) tiene IP autorizada para unas APIs de
// la operadora y bloqueada para otras, y el token Bearer de FSM vence cada 24 h.
// Para una demo no se puede depender de eso, pero el mock sembrado tampoco
// convence: los datos reales tienen la forma, los huecos y las rarezas que solo
// produce un sistema de 2015 en producción.
//
// Este conector sirve los JSON de `tests/fixtures/fsm/` (capturados con
// `scripts/probe-fsm-api.ts`, cuenta 35070291) pasándolos por el MISMO pipeline
// de `normalize.ts` que usa el modo real: lo que ve la app es exactamente lo que
// vería con token, sin una sola petición saliente.
//
// Reglas:
//
//   1. CERO red. Nada acá importa `http/fsm-api.ts` ni `http/fsm-token.ts`.
//   2. Los fixtures son la respuesta CRUDA de la operadora, con su envoltorio
//      `{ data, errorCode, message, … }`: se pasan tal cual a los `map*()` de
//      `normalize.ts`, que ya saben desenvolverlo.
//   3. Solo la cuenta del fixture (`FIXTURE_ACCOUNT`) sale de los JSON. Cualquier
//      otra cuenta, NAP u orden de trabajo se delega al conector mock, que es
//      determinista por semilla: la demo tiene UNA cuenta "real" y el resto de
//      la app sigue funcionando.
//   4. Los fixtures llevan la PII redactada (`«REDACTADO:97»`). Antes de
//      normalizar se hace una **rehidratación de presentación**: esos
//      marcadores se sustituyen por datos demo ecuatorianos verosímiles y
//      deterministas. No son datos de ninguna persona real: el nombre, el
//      teléfono y el correo son inventados y el correo usa el dominio reservado
//      `example.com`. NO se generan cédulas ni RUCs.
//   5. Los NÚMEROS DE CUENTA de terceros tampoco salen tal cual. Los puertos
//      ocupados de la NAP del fixture son de otros abonados reales de la
//      operadora (`chain-nap-accounts.json` no viene redactado en ese campo):
//      se sustituyen por cuentas demo deterministas. La única cuenta que se
//      conserva es la del fixture (`FIXTURE_ACCOUNT`), que es la que se demuestra.
//
// Los JSON se leen UNA vez (cache de módulo) la primera vez que se instancia el
// conector, y solo en modo `fixture`.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng } from '../_shared.js';
import type { Coordinates, NapPorts, NearbyNap } from '../tec/index.js';
import {
  isPlainObject,
  mapAccountProcess,
  mapAccountStatus,
  mapNapAccounts,
  mapNapNearest,
  mapStatusCode,
  mapWorkOrderTasks,
} from './normalize.js';
import {
  applyStatuses,
  buildPortGrid,
  buildVisits,
  dedupe,
  finishedOrdersDesc,
  orderToVisit,
  recallNap,
  rememberNap,
  statusFanOut,
  taskToClosedTask,
  truncatedDegraded,
  visitsDesc,
  type AccountOrder,
  type AccountOrders,
  type ClosedTask,
  type FsmConnector,
  type StatusBatchItem,
  type WorkOrderTask,
} from './shared.js';

/** Cuenta capturada en los fixtures. Es la cuenta "real" de la demo. */
export const FIXTURE_ACCOUNT = '35070291';

/** Radio alrededor del domicilio del fixture en el que se sirven sus NAPs. */
const FIXTURE_NAPS_RADIUS_METERS = 1500;

// ---------------------------------------------------------------------------
// Rehidratación de presentación de la PII redactada
// ---------------------------------------------------------------------------

/** `«REDACTADO:97»` — el número es la longitud del texto original. */
const PLACEHOLDER = /«REDACTADO:(\d+)»/g;

/** Nombre demo del cliente del fixture. Inventado. */
const DEMO_NAME = 'María F. Zambrano C.';
/** Correo demo. `example.com` es un dominio reservado (RFC 2606). */
const DEMO_EMAIL = 'maria.zambrano@example.com';
/** Celular demo con prefijo ecuatoriano. Inventado. */
const DEMO_PHONE = '0991234567';

/** Direcciones demo de Guayaquil. Sin número de casa de nadie en particular. */
const DEMO_ADDRESSES = [
  'Cdla. La Alborada Etapa 3, Mz. 12 Villa 8, Guayaquil',
  'Urb. Villa España 2, Mz. 4 Villa 21, Guayaquil',
  'Av. Francisco de Orellana y Av. Plaza Dañín, Edif. Torre 1, Guayaquil',
  'Cdla. Sauces 4, Mz. 233 Villa 15, Guayaquil',
  'Km 8.5 vía a Daule, Cdla. Los Vergeles, Guayaquil',
];

/**
 * Notas de cierre demo. Se incluyen a propósito algunas con las palabras de
 * `FSM_UNSATISFACTORY_KEYWORDS` (reprogramada / reincidencia): así el campo 15
 * (visitas insatisfactorias) tiene algo que mostrar en la demo.
 */
const DEMO_NOTES = [
  'Se instaló el ONT y se certificó el servicio. Cliente conforme con las pruebas.',
  'Cliente reporta intermitencia: se reemplazó el patch cord y se recalibró la potencia óptica.',
  'Visita reprogramada: no había quien reciba en el domicilio.',
  'Reincidencia del daño reportado la semana anterior; se escaló a planta externa.',
  'Se configuró SSID y clave WiFi. Velocidad medida dentro del plan contratado.',
  'Sin novedad: el servicio quedó operativo al momento del cierre.',
  'Se cambió el equipo por daño físico en el puerto LAN.',
  'Se reubicó el router a pedido del cliente y se verificó cobertura en las dos plantas.',
];

/** Logins de técnicos demo (`lastModifyUser` en FSM es un usuario, no un nombre). */
const DEMO_USERS = ['jcevallos', 'mmendoza', 'asalazar', 'dyepez', 'rvillon'];

/** Códigos de NAP demo, coherentes con la red `AR7S` de los fixtures. */
const DEMO_NAP_CODES = ['AR7S1', 'AR7S2', 'AR7S3', 'AR7S4', 'AR7S5'];

/** Elección estable de un elemento a partir de una semilla textual. */
function pickStable<T>(pool: readonly T[], seed: string): T {
  return seededRng(`fsm:fixture:${seed}`).pick(pool);
}

// --- Pseudonimización de cuentas de terceros --------------------------------
//
// `chain-nap-accounts.json` NO viene redactado en los números de cuenta: los
// puertos ocupados de la NAP son de OTROS abonados reales de la operadora, y en
// la demo se verían en la rejilla del campo 8. Se sustituyen por cuentas demo.
//
// Igual que el resto de la rehidratación, esto es capa de PRESENTACIÓN: el JSON
// del fixture no se toca (lo usan los tests y `probe-fsm-api.ts`). La cuenta del
// propio fixture (35070291) se conserva: es la cuenta con la que se demuestra.

/** Rango de las cuentas demo. Elegido para NO chocar con 35070291. */
const DEMO_ACCOUNT_MIN = 40_000_000;
const DEMO_ACCOUNT_MAX = 79_999_999;

/** Claves cuyo valor es un número de cuenta de abonado. */
const ACCOUNT_KEYS = new Set(['accountid', 'account_id', 'accountnumber', 'cuenta']);

/**
 * Original → demo. Estable dentro del proceso y entre procesos: el candidato
 * sale de una semilla que es el propio número, así que el mismo id de entrada da
 * siempre el mismo id de salida. El mapa solo sirve para garantizar que dos
 * cuentas distintas nunca colapsen en la misma.
 */
const accountAliases = new Map<string, string>();
const accountAliasesUsed = new Set<string>([FIXTURE_ACCOUNT]);

/** Cuenta demo determinista para una cuenta de tercero. */
export function demoAccountNumber(original: string): string {
  const key = original.trim();
  if (!key || key === FIXTURE_ACCOUNT) return key;
  const cached = accountAliases.get(key);
  if (cached) return cached;

  const span = DEMO_ACCOUNT_MAX - DEMO_ACCOUNT_MIN;
  const rng = seededRng(`fsm:fixture:account:${key}`);
  let candidate = String(DEMO_ACCOUNT_MIN + rng.intBetween(0, span));
  // Colisión (astronómicamente improbable con 4 cuentas en 40 millones): se
  // avanza de uno en uno, que es reproducible.
  while (accountAliasesUsed.has(candidate)) {
    candidate = String(Math.min(DEMO_ACCOUNT_MAX, Number(candidate) + 1));
  }
  accountAliasesUsed.add(candidate);
  accountAliases.set(key, candidate);
  return candidate;
}

/** Solo para pruebas: olvida las cuentas demo ya asignadas. */
export function resetDemoAccountAliases(): void {
  accountAliases.clear();
  accountAliasesUsed.clear();
  accountAliasesUsed.add(FIXTURE_ACCOUNT);
}

/**
 * Valor demo para un marcador de PII.
 *
 * - Identidad (`names`, `email`, `phoneNumber`): un único valor, para que el
 *   cliente sea la MISMA persona en las 30+ órdenes del fixture.
 * - Texto libre (`address`, `note`, `content`): se elige por la longitud
 *   original. Dos campos redactados con la misma longitud eran el mismo texto,
 *   así que quedan con el mismo valor demo — la coherencia se conserva.
 * - Códigos de NAP (`name`): por número de aparición, para que las tres NAPs
 *   del fixture no queden con el mismo código.
 */
function demoValue(key: string, length: number, occurrence: number): string {
  switch (key.toLowerCase()) {
    case 'names':
    case 'nombres':
    case 'clientname':
      return DEMO_NAME;
    case 'email':
    case 'correo':
      return DEMO_EMAIL;
    case 'phonenumber':
    case 'phone':
    case 'telefono':
    case 'celular':
      return DEMO_PHONE;
    case 'address':
    case 'direccion':
      return pickStable(DEMO_ADDRESSES, `address:${length}`);
    case 'note':
    case 'nota':
    case 'content':
    case 'contenido':
    case 'observacion':
      return pickStable(DEMO_NOTES, `note:${length}`);
    case 'lastmodifyuser':
    case 'lastmodifieduser':
      return pickStable(DEMO_USERS, `user:${length}`);
    case 'name':
    case 'nombre':
      return DEMO_NAP_CODES[occurrence % DEMO_NAP_CODES.length] as string;
    default:
      return 'Dato de demostración';
  }
}

/**
 * Copia profunda del fixture con los marcadores `«REDACTADO:n»` sustituidos y
 * las cuentas de terceros pseudonimizadas.
 *
 * Es de PRESENTACIÓN: no altera fechas, coordenadas, estados, ids de NAP ni
 * seriales de equipo — todo lo que la app interpreta como dato técnico sigue
 * siendo el de producción.
 */
export function rehydrateFixture<T>(raw: T, counters = new Map<string, number>()): T {
  const walk = (value: unknown, key: string): unknown => {
    // Cuenta de abonado: el número real de un tercero no puede salir a pantalla.
    // Se respeta el tipo original (la operadora la manda como número).
    if (
      ACCOUNT_KEYS.has(key.toLowerCase()) &&
      (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())))
    ) {
      const alias = demoAccountNumber(String(value).trim());
      return typeof value === 'number' ? Number(alias) : alias;
    }
    if (typeof value === 'string') {
      if (!value.includes('«REDACTADO:')) return value;
      const occurrence = counters.get(key) ?? 0;
      counters.set(key, occurrence + 1);
      return value.replace(PLACEHOLDER, (_match, len: string) =>
        demoValue(key, Number(len), occurrence),
      );
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        out[childKey] = walk(childValue, childKey);
      }
      return out;
    }
    return value;
  };
  return walk(raw, '') as T;
}

// ---------------------------------------------------------------------------
// Carga de los JSON
// ---------------------------------------------------------------------------

const FIXTURE_FILES = {
  process: 'chain-process.json',
  tasks: 'chain-tasks.json',
  naps: 'chain-naps.json',
  napAccounts: 'chain-nap-accounts.json',
  status: 'status.json',
} as const;

type FixtureName = keyof typeof FIXTURE_FILES;

/**
 * Directorio de los fixtures.
 *
 * Se busca hacia arriba desde este módulo, así que funciona igual con `tsx`
 * (`src/connectors/fsm/`) y con el build (`dist/src/connectors/fsm/`) siempre
 * que la imagen incluya `tests/fixtures/` (el Dockerfile la copia).
 */
function findFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'tests', 'fixtures', 'fsm');
    try {
      readFileSync(join(candidate, FIXTURE_FILES.process));
      return candidate;
    } catch {
      /* seguir subiendo */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw ApiError.connectorError(
    `CONNECTOR_MODE_FSM=fixture pero no se encontró el directorio ` +
      `tests/fixtures/fsm (buscado desde ${here}). La imagen de despliegue debe ` +
      `incluir esos JSON o el conector debe volver a 'mock'.`,
  );
}

let cache: Record<FixtureName, unknown> | null = null;

/** Lee y rehidrata los cinco fixtures. Una sola vez por proceso. */
function fixtures(): Record<FixtureName, unknown> {
  if (cache) return cache;
  const dir = findFixturesDir();
  const loaded = {} as Record<FixtureName, unknown>;
  for (const [name, file] of Object.entries(FIXTURE_FILES) as Array<[FixtureName, string]>) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown;
    } catch (err) {
      throw ApiError.connectorError(
        `No se pudo leer el fixture de FSM ${file}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    loaded[name] = rehydrateFixture(parsed);
  }
  cache = loaded;
  return cache;
}

/** Solo para pruebas: fuerza una relectura de los JSON. */
export function resetFsmFixtureCache(): void {
  cache = null;
  resetDemoAccountAliases();
}

/** Filas crudas de un fixture (para leer campos que `normalize.ts` descarta). */
function rawRows(raw: unknown): Record<string, unknown>[] {
  if (!isPlainObject(raw)) return [];
  const data = raw.data;
  if (Array.isArray(data)) return data.filter(isPlainObject);
  return isPlainObject(data) ? [data] : [];
}

/** Distancia en metros entre dos coordenadas (Haversine). */
function distanceMeters(a: Coordinates, b: Coordinates): number {
  const R = 6371000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Conector
// ---------------------------------------------------------------------------

/**
 * Conector FSM en modo fixture.
 *
 * @param fallback conector al que se delega todo lo que no está en los
 *        fixtures (otras cuentas, otras NAPs, otras órdenes). En producción es
 *        `fsmMock`, que es determinista por semilla.
 */
export function createFsmFixtureConnector(fallback: FsmConnector): FsmConnector {
  /** Órdenes + cliente del fixture, ya normalizados. */
  function fixtureProcess(): { client: AccountOrders['client']; orders: AccountOrder[] } {
    const parsed = mapAccountProcess(fixtures().process);
    return {
      client: parsed.client === null ? null : { ...parsed.client },
      orders: parsed.orders.map((order) => ({ ...order })),
    };
  }

  /** Tareas del fixture, ya normalizadas. */
  function fixtureTasks(): WorkOrderTask[] {
    return mapWorkOrderTasks(fixtures().tasks).map((task) => ({
      taskId: task.taskId,
      status: task.status,
      businessKey: task.businessKey,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      result: task.result,
      closedBy: task.closedBy,
      notes: task.notes.map((note) => ({ createdAt: note.createdAt, content: note.content })),
    }));
  }

  /**
   * Orden de trabajo a la que pertenecen las tareas del fixture.
   *
   * No está escrita a mano: se deduce cruzando el `businessKey` de la tarea
   * (`TASK/90932/2019`) con el campo `task` de las órdenes de
   * `/account/process`. Si se vuelven a capturar los fixtures con otra cuenta,
   * esto se sigue resolviendo solo.
   */
  function fixtureWorkOrder(): string | null {
    const keys = new Set(
      fixtureTasks()
        .map((task) => task.businessKey)
        .filter((key): key is string => Boolean(key)),
    );
    if (keys.size === 0) return null;
    const match = fixtureProcess().orders.find((order) => order.task && keys.has(order.task));
    return match?.workOrder ?? null;
  }

  /** Id de la NAP cuyos puertos están en el fixture (`/naps/accounts`). */
  function fixtureNapId(): number | null {
    const rows = rawRows(fixtures().napAccounts);
    for (const row of rows) {
      const id = Number(row.id);
      if (Number.isFinite(id) && id > 0) return id;
    }
    return null;
  }

  /** Domicilio del cliente del fixture: centro del área con NAPs grabadas. */
  function fixtureCenter(): Coordinates | null {
    const { client, orders } = fixtureProcess();
    const latitude = client?.latitude ?? orders.find((o) => o.latitude !== null)?.latitude ?? null;
    const longitude =
      client?.longitude ?? orders.find((o) => o.longitude !== null)?.longitude ?? null;
    if (latitude === null || longitude === null) return null;
    return { latitude, longitude };
  }

  function isFixtureAccount(accountNumber: string): boolean {
    return accountNumber.trim() === FIXTURE_ACCOUNT;
  }

  const connector: FsmConnector = {
    async getAccountOrders(accountNumber, opts) {
      if (!isFixtureAccount(accountNumber)) return fallback.getAccountOrders(accountNumber, opts);
      const { client, orders } = fixtureProcess();
      const filtered = opts.estado === 'Pendientes' ? orders.filter((o) => !o.finished) : orders;
      return { accountNumber, brand: opts.brand, client, orders: filtered };
    },

    async getPreviousVisits(accountNumber, opts) {
      if (!isFixtureAccount(accountNumber)) return fallback.getPreviousVisits(accountNumber, opts);
      const { orders } = await this.getAccountOrders(accountNumber, {
        brand: opts.brand,
        estado: 'Todas',
      });
      return {
        items: visitsDesc(orders.map(orderToVisit)),
        totalOrders: orders.length,
        brand: opts.brand,
      };
    },

    async getUnsatisfactoryTasks(accountNumber, opts) {
      if (!isFixtureAccount(accountNumber)) {
        return fallback.getUnsatisfactoryTasks(accountNumber, opts);
      }
      const { orders } = await this.getAccountOrders(accountNumber, {
        brand: opts.brand,
        estado: 'Todas',
      });
      const slice = finishedOrdersDesc(orders).slice(0, opts.limit);

      // Mismo recorrido que el modo real, sin red ni semáforo: la única orden
      // con tareas grabadas devuelve las reales; las demás caen al mock (la
      // operadora solo capturó las tareas de UNA orden).
      const items: ClosedTask[] = [];
      for (const order of slice) {
        const { tasks } = await this.getWorkOrderTasks(order.workOrder, { brand: opts.brand });
        for (const task of tasks) {
          if (task.result === 'INSATISFACTORIA') items.push(taskToClosedTask(order.workOrder, task));
        }
      }
      items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

      const scanned = slice.length;
      const truncated = orders.length > scanned;
      return {
        items,
        scanned,
        totalOrders: orders.length,
        truncated,
        brand: opts.brand,
        ...(truncated ? { degraded: truncatedDegraded(scanned, orders.length) } : {}),
      };
    },

    async getVisits(accountNumber, opts) {
      if (!isFixtureAccount(accountNumber)) return fallback.getVisits(accountNumber, opts);
      const { orders } = await this.getAccountOrders(accountNumber, {
        brand: opts.brand,
        estado: 'Todas',
      });
      // Igual que getUnsatisfactoryTasks: la orden con tareas grabadas devuelve
      // las reales; las demás caen al mock. Sin red ni semáforo.
      return buildVisits(accountNumber, orders, opts, (workOrder) =>
        this.getWorkOrderTasks(workOrder, { brand: opts.brand }),
      );
    },

    async getWorkOrderTasks(workOrder, opts) {
      if (workOrder !== fixtureWorkOrder()) return fallback.getWorkOrderTasks(workOrder, opts);
      return { workOrder, brand: opts.brand, tasks: fixtureTasks() };
    },

    async getAccountStatus(accountNumber, opts) {
      if (!isFixtureAccount(accountNumber)) return fallback.getAccountStatus(accountNumber, opts);
      const parsed = mapAccountStatus(fixtures().status);
      const { status } = mapStatusCode(parsed?.statusCode ?? null);
      return {
        accountNumber,
        brand: opts.brand,
        status: parsed?.statusCode === undefined || parsed?.statusCode === null ? null : status,
        statusCode: parsed?.statusCode ?? null,
        statusDescription: parsed?.statusDescription ?? null,
      };
    },

    async getAccountsStatusBatch(accounts, opts) {
      // Sin red: el "lote" es cuenta por cuenta, igual que en real (la operadora
      // confirmó que no existe endpoint de estado en lote).
      const unique = dedupe(accounts);
      const items: StatusBatchItem[] = [];
      for (const accountNumber of unique) {
        const one = await this.getAccountStatus(accountNumber, { brand: opts.brand });
        items.push({
          accountNumber,
          status: one.status,
          statusCode: one.statusCode,
          statusDescription: one.statusDescription,
          error: one.status === null ? 'FSM no devolvió estado para esta cuenta.' : null,
        });
      }
      const resolved = items.filter((i) => i.status !== null).length;
      return {
        brand: opts.brand,
        items,
        requested: items.length,
        resolved,
        failed: items.length - resolved,
      };
    },

    async getNearbyNaps(coords, opts) {
      const center = fixtureCenter();
      // Las NAPs grabadas son las del domicilio del cliente del fixture: solo
      // se sirven si la consulta cae cerca. Fuera de ese radio manda el mock.
      if (center === null || distanceMeters(coords, center) > FIXTURE_NAPS_RADIUS_METERS) {
        return fallback.getNearbyNaps(coords, opts);
      }
      const naps: NearbyNap[] = mapNapNearest(fixtures().naps).map((row) => {
        rememberNap(row.napId, row.napCode, row.totalPorts);
        return {
          napId: row.napId,
          napCode: row.napCode,
          networkName: row.networkName,
          latitude: row.latitude,
          longitude: row.longitude,
          distanceMeters: row.distanceMeters,
          occupiedPorts: row.occupiedPorts,
          totalPorts: row.totalPorts,
          freePorts: Math.max(0, row.totalPorts - row.occupiedPorts),
          source: 'FSM' as const,
        };
      });
      return naps.slice(0, opts.maxRows);
    },

    async getNapPorts(napId, opts): Promise<NapPorts> {
      if (napId !== fixtureNapId()) return fallback.getNapPorts(napId, opts);

      const rows = mapNapAccounts(fixtures().napAccounts);
      const remembered = recallNap(napId);
      const grid = buildPortGrid(rows, remembered?.totalPorts ?? null);
      const pending = grid.ports.filter((p) => p.statusPending);

      if (opts.withStatus && pending.length > 0) {
        // Mismo tope que en real, aunque acá no cueste una llamada a producción.
        const accounts = pending
          .slice(0, env.FSM_STATUS_BATCH_LIMIT)
          .map((p) => p.clientAccountNumber as string);
        const batch = await this.getAccountsStatusBatch(accounts, { brand: opts.brand });
        applyStatuses(grid.ports, batch);
      }

      return {
        napRef: String(napId),
        napId,
        napCode: remembered?.napCode ?? null,
        ports: grid.ports,
        detailAvailable: true,
        occupiedPorts: grid.occupied,
        totalPorts: grid.total,
        statusFanOut: statusFanOut(grid.ports),
        source: 'FSM',
      };
    },
  };

  return connector;
}
