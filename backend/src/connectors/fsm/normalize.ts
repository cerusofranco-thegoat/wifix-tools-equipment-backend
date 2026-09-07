// ---------------------------------------------------------------------------
// Normalización tolerante de las respuestas de `fsm-data-ms`.
//
// La operadora no publica esquema y NO tenemos ni una respuesta real de
// muestra: todos los parsers están escritos a ciegas contra la documentación.
// Por eso, igual que en `tec/index.ts`, nunca se confía en el nombre exacto de
// una clave: se prueban varias candidatas (`pick()`), se acepta el envoltorio
// `{ data: … }` o el array desnudo, y todo campo ausente cae en `null`.
//
// Calibrar con la salida de `scripts/probe-fsm-api.ts` antes de dar por buena
// cualquiera de estas funciones.
// ---------------------------------------------------------------------------

import { env } from '../../config/env.js';
import type { AccountStatusCode, AccountStatusName } from '../_shared.js';
import { toIsoDate, toNumber } from '../ispmonitor/normalize.js';

// --- Modelo interno crudo ---------------------------------------------------

/** Estado de cuenta tal como lo devuelve la operadora (A/S/T/O/P). */
export type FsmStatusCode = AccountStatusCode;

export type { AccountStatusName };

export type TaskResult = 'SATISFACTORIA' | 'INSATISFACTORIA' | 'PENDIENTE';

export interface FsmClient {
  names: string | null;
  phoneNumber: string | null;
  email: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface FsmOrder {
  workOrder: string;
  task: string | null;
  state: string | null;
  externalProcess: string | null;
  cpartyId: string | null;
  createdAt: string | null;
  endedAt: string | null;
  finished: boolean;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}

export interface FsmAccountProcess {
  client: FsmClient | null;
  orders: FsmOrder[];
}

export interface FsmNote {
  createdAt: string | null;
  content: string;
}

export interface FsmTask {
  taskId: string;
  status: string | null;
  businessKey: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  result: TaskResult;
  notes: FsmNote[];
}

export interface FsmAccountStatus {
  accountNumber: string | null;
  statusCode: FsmStatusCode | null;
  statusDescription: string | null;
}

export interface FsmNapRow {
  napId: number | null;
  napCode: string;
  networkName: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number;
  occupiedPorts: number;
  totalPorts: number;
}

export interface FsmNapAccountRow {
  /** Número de puerto dentro de la NAP. */
  portNumber: number | null;
  accountNumber: string | null;
  equipmentId: string | null;
}

// --- Helpers ----------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Primer valor no nulo entre varias claves candidatas (comparación laxa). */
export function pick(row: Record<string, unknown>, keys: string[]): unknown {
  const lower = new Map<string, string>();
  for (const key of Object.keys(row)) lower.set(key.toLowerCase(), key);
  for (const key of keys) {
    const match = lower.get(key.toLowerCase());
    if (match !== undefined && row[match] !== null && row[match] !== undefined) {
      return row[match];
    }
  }
  return undefined;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | null {
  const value = pick(row, keys);
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * Fecha a ISO-8601 UTC. Las fechas sin zona horaria se interpretan como UTC
 * (la operadora no documenta el huso; se asume UTC y se deja constancia acá).
 */
export function toIsoUtc(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(:(\d{2}))?(\.\d+)?$/.exec(
      value.trim(),
    );
    if (naive) {
      const iso = `${value.trim().replace(' ', 'T')}Z`;
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
  }
  return toIsoDate(value);
}

/** Quita acentos y mayúsculas para comparar texto de la operadora. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Desenvuelve `{ data: … }` (o `result`/`items`) y devuelve el contenido. */
export function unwrapData(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  for (const key of ['data', 'Data', 'result', 'results', 'items', 'rows']) {
    if (key in raw && raw[key] !== null && raw[key] !== undefined) return raw[key];
  }
  return raw;
}

/** Normaliza el contenido a un array de filas. */
export function toRows(raw: unknown): Record<string, unknown>[] {
  const data = unwrapData(raw);
  if (Array.isArray(data)) return data.filter(isPlainObject);
  if (isPlainObject(data)) return [data];
  return [];
}

// --- Mapeos -----------------------------------------------------------------

/** Tabla única A/S/T/O/P → nombre interno (§4 del contrato). */
export function mapStatusCode(raw: unknown): {
  statusCode: FsmStatusCode | null;
  status: AccountStatusName;
} {
  const code = String(raw ?? '').trim().toUpperCase();
  switch (code) {
    case 'A':
      return { statusCode: 'A', status: 'ACTIVA' };
    case 'S':
      return { statusCode: 'S', status: 'SUSPENDIDA' };
    case 'T':
      return { statusCode: 'T', status: 'TERMINADA' };
    case 'O':
      return { statusCode: 'O', status: 'ORDENADA' };
    case 'P':
      return { statusCode: 'P', status: 'PENDIENTE' };
    default:
      return { statusCode: null, status: 'DESCONOCIDA' };
  }
}

/** `POST /account/process` → cliente + órdenes ordenadas por fecha descendente. */
export function mapAccountProcess(raw: unknown): FsmAccountProcess {
  const rows = toRows(raw);
  const orders: FsmOrder[] = [];

  for (const row of rows) {
    const workOrder = pickString(row, ['workOrder', 'work_order', 'orden', 'order']);
    if (!workOrder) continue;
    const createdAt = toIsoUtc(pick(row, ['creationDate', 'createDate', 'created_at', 'fechaCreacion']));
    const endedAt = toIsoUtc(pick(row, ['endDate', 'finishDate', 'finish_date', 'fechaFin']));
    orders.push({
      workOrder,
      task: pickString(row, ['task', 'tarea', 'taskName']),
      state: pickString(row, ['state', 'estado', 'status']),
      externalProcess: pickString(row, ['externalProcess', 'external_process', 'proceso']),
      cpartyId: pickString(row, ['cpartyId', 'cparty_id', 'cparty']),
      createdAt,
      endedAt,
      finished: endedAt !== null,
      note: pickString(row, ['note', 'nota', 'observacion', 'observation']),
      latitude: toNumber(pick(row, ['latitude', 'lat', 'latitud'])),
      longitude: toNumber(pick(row, ['longitude', 'lng', 'lon', 'long', 'longitud'])),
      address: pickString(row, ['address', 'direccion', 'domicilio']),
    });
  }

  orders.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));

  // El cliente sale de la orden más reciente que traiga datos de identidad.
  let client: FsmClient | null = null;
  for (const row of rows) {
    const names = pickString(row, ['names', 'nombres', 'clientName', 'nombre']);
    const phone = pickString(row, ['phoneNumber', 'phone', 'telefono', 'celular']);
    const email = pickString(row, ['email', 'correo', 'mail']);
    const address = pickString(row, ['address', 'direccion', 'domicilio']);
    if (!names && !phone && !email && !address) continue;
    client = {
      names,
      phoneNumber: phone,
      email,
      address,
      latitude: toNumber(pick(row, ['latitude', 'lat', 'latitud'])),
      longitude: toNumber(pick(row, ['longitude', 'lng', 'lon', 'long', 'longitud'])),
    };
    break;
  }

  return { client, orders };
}

/** Notas de una tarea, ordenadas por fecha ascendente. */
function mapNotes(raw: unknown): FsmNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: FsmNote[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const content = item.trim();
      if (content) notes.push({ createdAt: null, content });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const content = pickString(item, ['content', 'contenido', 'note', 'nota', 'text', 'texto']);
    notes.push({
      createdAt: toIsoUtc(pick(item, ['createDate', 'createdAt', 'creationDate', 'fecha'])),
      content: content ?? '',
    });
  }
  return notes.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
}

/**
 * Clasifica el resultado de una tarea.
 *
 * ⚠ HEURÍSTICO PROVISIONAL. La documentación de `/workorder/tasks` **no
 * enumera los valores de `status`** ni expone un campo de resultado
 * satisfactoria/insatisfactoria. Se infiere del `status` y del contenido de las
 * notas con la lista `FSM_UNSATISFACTORY_KEYWORDS`. Debe recalibrarse con la
 * salida real de `scripts/probe-fsm-api.ts` antes de darse por buena; es una
 * pregunta abierta con la operadora.
 */
export function classifyTaskResult(task: {
  status?: string | null;
  finishedAt?: string | null;
  notes?: Array<{ content?: string | null }>;
}): TaskResult {
  if (!task.finishedAt) return 'PENDIENTE';

  const haystack = normalizeText(
    [task.status ?? '', ...(task.notes ?? []).map((n) => n?.content ?? '')].join(' '),
  );
  for (const keyword of env.FSM_UNSATISFACTORY_KEYWORDS) {
    const needle = normalizeText(keyword);
    if (needle && haystack.includes(needle)) return 'INSATISFACTORIA';
  }
  return 'SATISFACTORIA';
}

/** `POST /workorder/tasks` → tareas con sus notas y resultado inferido. */
export function mapWorkOrderTasks(raw: unknown): FsmTask[] {
  const rows = toRows(raw);
  const tasks: FsmTask[] = [];

  for (const row of rows) {
    const taskId = pickString(row, ['taskId', 'task_id', 'id', 'tarea']);
    if (!taskId) continue;
    const notes = mapNotes(pick(row, ['notes', 'notas', 'observaciones']));
    const status = pickString(row, ['status', 'estado', 'state']);
    const finishedAt = toIsoUtc(pick(row, ['finishDate', 'finishedAt', 'finish_date', 'endDate']));
    tasks.push({
      taskId,
      status,
      businessKey: pickString(row, ['businessKey', 'business_key', 'clave']),
      createdAt: toIsoUtc(pick(row, ['createDate', 'createdAt', 'creationDate', 'fecha'])),
      finishedAt,
      result: classifyTaskResult({ status, finishedAt, notes }),
      notes,
    });
  }

  return tasks;
}

/** `POST /account/status` → código y descripción de estado. */
export function mapAccountStatus(raw: unknown): FsmAccountStatus | null {
  const data = unwrapData(raw);
  const row = Array.isArray(data) ? data.find(isPlainObject) : data;
  if (!isPlainObject(row)) return null;

  const { statusCode } = mapStatusCode(pick(row, ['status', 'estado', 'statusCode', 'codigo']));
  return {
    accountNumber: pickString(row, ['accountId', 'account_id', 'cuenta', 'accountNumber']),
    statusCode,
    statusDescription: pickString(row, ['description', 'descripcion', 'statusDescription', 'detalle']),
  };
}

/** `GET /naps/nearest` → NAPs cercanas ordenadas por distancia ascendente. */
export function mapNapNearest(raw: unknown): FsmNapRow[] {
  const rows = toRows(raw);
  const naps: FsmNapRow[] = [];

  for (const row of rows) {
    const code = pickString(row, ['name', 'nombre', 'nap', 'napCode', 'code', 'codigo']);
    const napId = toNumber(pick(row, ['id', 'napId', 'idNap']));
    if (!code && napId === null) continue;
    const total = toNumber(pick(row, ['ports', 'totalPorts', 'puertos', 'capacidad'])) ?? 0;
    const used = toNumber(pick(row, ['used', 'occupiedPorts', 'ocupados', 'usados'])) ?? 0;
    naps.push({
      napId,
      napCode: code ?? String(napId),
      networkName: pickString(row, ['network', 'red', 'networkName', 'olt']),
      latitude: toNumber(pick(row, ['lat', 'latitude', 'latitud'])),
      longitude: toNumber(pick(row, ['lng', 'lon', 'long', 'longitude', 'longitud'])),
      distanceMeters: toNumber(pick(row, ['distance', 'distanceMeters', 'distancia'])) ?? 0,
      occupiedPorts: used,
      totalPorts: total,
    });
  }

  return naps.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

/** `GET /naps/accounts` → cuentas/equipos por puerto de la NAP. */
export function mapNapAccounts(raw: unknown): FsmNapAccountRow[] {
  const rows = toRows(raw);
  const out: FsmNapAccountRow[] = [];

  for (const row of rows) {
    // `id` es el id de la NAP, no el del registro: no se usa acá.
    const account = pickString(row, ['accountId', 'account_id', 'cuenta', 'accountNumber']);
    const equipment = pickString(row, ['equipmentId', 'equipment_id', 'equipo', 'serial']);
    const portNumber = toNumber(pick(row, ['number', 'port', 'puerto', 'portNumber']));
    if (account === null && equipment === null && portNumber === null) continue;
    out.push({ portNumber, accountNumber: account, equipmentId: equipment });
  }

  return out;
}
