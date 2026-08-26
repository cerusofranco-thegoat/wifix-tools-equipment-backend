// ---------------------------------------------------------------------------
// Normalización tolerante de las respuestas de ISP Monitor.
//
// La API de operadora no publica esquema y cada endpoint puede devolver la
// serie de 24 h con nombres distintos (`date`/`fecha`/`timestamp`, `value`/
// `snr`/`corrected`…). En vez de acoplarnos a un shape concreto, detectamos:
//
//   - la clave temporal (por nombre o por parseabilidad como fecha),
//   - las claves numéricas → series graficables,
//   - el resto → metadatos.
//
// Siempre se conserva `raw` para que el cliente pueda mostrar los datos crudos
// si aparece un formato no contemplado.
// ---------------------------------------------------------------------------

/** Claves candidatas a "instante de la muestra", en orden de preferencia. */
const TIME_KEYS = [
  'datetime', 'dateTime', 'fechahora', 'fechaHora', 'timestamp', 'time',
  'date', 'fecha', 'hora', 'ts', 'x', 'label', 'periodo', 'period',
];

/** Claves candidatas a "array de muestras" dentro de un objeto contenedor. */
const CONTAINER_KEYS = [
  'data', 'items', 'values', 'series', 'result', 'results', 'rows', 'list', 'points',
];

export interface SeriesPoint {
  /** Instante de la muestra en ISO-8601, o el texto original si no se pudo parsear. */
  t: string | null;
  /** Métricas numéricas de la muestra, por nombre de clave. */
  values: Record<string, number>;
  /** Campos no numéricos de la muestra (estado, descripción…). */
  meta?: Record<string, string>;
}

/** Claves candidatas a "array de muestras" dentro de un objeto de canal. */
const CHANNEL_DATA_KEYS = ['data', 'values', 'points', 'series'];

/** Claves candidatas al nombre legible de un canal. */
const CHANNEL_LABEL_KEYS = ['desc', 'description', 'descripcion', 'name', 'nombre', 'label', 'canal', 'channel'];

/**
 * Un canal de una métrica multicanal. Los endpoints DOCSIS de SNR y codewords
 * devuelven una entrada por canal upstream, cada una con su propia serie:
 *
 *   [ { "ifIndex": 5000018, "network": "2G-2 v",
 *       "desc": "Logical Upstream Channel 0/1.1/0",
 *       "data": [[1787772828, 35.6], …] }, … ]
 */
export interface SeriesChannel {
  /** Nombre legible del canal (`desc` de la API). */
  label: string;
  /** Segmento/nodo al que pertenece el canal. */
  network: string | null;
  ifIndex: number | null;
  keys: string[];
  points: SeriesPoint[];
}

function pickChannelData(obj: Record<string, unknown>): unknown[] | null {
  for (const candidate of CHANNEL_DATA_KEYS) {
    const match = Object.keys(obj).find((k) => k.toLowerCase() === candidate);
    if (match !== undefined && Array.isArray(obj[match])) return obj[match] as unknown[];
  }
  return null;
}

function pickChannelLabel(obj: Record<string, unknown>, index: number): string {
  for (const candidate of CHANNEL_LABEL_KEYS) {
    const match = Object.keys(obj).find((k) => k.toLowerCase() === candidate);
    const value = match === undefined ? undefined : obj[match];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const ifIndex = Object.keys(obj).find((k) => k.toLowerCase() === 'ifindex');
  if (ifIndex !== undefined && obj[ifIndex] !== null && obj[ifIndex] !== undefined) {
    return `ifIndex ${String(obj[ifIndex])}`;
  }
  return `Canal ${index + 1}`;
}

/**
 * Detecta el formato multicanal: array de objetos donde cada uno contiene su
 * propia serie anidada. Devuelve null si no es ese formato.
 */
function readChannels(samples: unknown[], valueNames: string[]): SeriesChannel[] | null {
  const channels: SeriesChannel[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!isPlainObject(sample)) return null;
    const data = pickChannelData(sample);
    if (data === null) return null;

    // Cada canal se normaliza con la misma lógica que una serie suelta.
    const inner = normalizeSeries(data, valueNames);
    if (!inner.recognized) return null;

    const networkKey = Object.keys(sample).find((k) => k.toLowerCase() === 'network');
    const ifIndexKey = Object.keys(sample).find((k) => k.toLowerCase() === 'ifindex');

    channels.push({
      label: pickChannelLabel(sample, i),
      network:
        networkKey !== undefined && sample[networkKey] !== null && sample[networkKey] !== undefined
          ? String(sample[networkKey])
          : null,
      ifIndex: ifIndexKey === undefined ? null : toNumber(sample[ifIndexKey]),
      keys: inner.keys,
      points: inner.points,
    });
  }
  return channels.length > 0 ? channels : null;
}

export interface NormalizedSeries {
  /** Nombres de las series numéricas presentes (para leyenda y gráfico). */
  keys: string[];
  points: SeriesPoint[];
  /**
   * Canales cuando la métrica viene desglosada (SNR y codewords DOCSIS traen
   * una serie por canal upstream). Vacío si la métrica es de un solo canal;
   * en ese caso `keys`/`points` son la serie. Cuando hay canales, `keys` y
   * `points` reflejan el primero, para consumidores que no los manejen.
   */
  channels: SeriesChannel[];
  /** true si la normalización reconoció el formato; false → usar `raw`. */
  recognized: boolean;
  /** Payload original tal cual lo devolvió la API de operadora. */
  raw: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Convierte a número si el valor es numérico (acepta strings "12,5" y "12.5"). */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/\s/g, '').replace(',', '.');
    if (!cleaned || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Intenta interpretar el valor como instante; devuelve ISO-8601 o null. */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    // Epoch en segundos o milisegundos.
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  // /Date(1712345678000)/ — formato clásico de ASP.NET.
  const aspNet = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(s);
  if (aspNet) {
    const d = new Date(Number(aspNet[1]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // "dd/MM/yyyy HH:mm" o "dd-MM-yyyy HH:mm[:ss]" — formato local EC.
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (dmy) {
    const [, dd, mm, yyyy, hh = '0', mi = '0', ss = '0'] = dmy;
    const d = new Date(
      Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss),
    );
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // ISO u otro formato que Date entienda. Se exige que tenga pinta de fecha
  // para no convertir "8" o "PL2KD9" en un instante.
  if (!/\d{4}|:/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Localiza el array de muestras dentro de un payload contenedor. */
function findSampleArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (!isPlainObject(raw)) return null;
  for (const key of CONTAINER_KEYS) {
    const candidate = raw[key];
    if (Array.isArray(candidate)) return candidate;
  }
  // Cualquier propiedad que sea un array de objetos también sirve.
  for (const value of Object.values(raw)) {
    if (Array.isArray(value) && value.length > 0 && isPlainObject(value[0])) return value;
  }
  return null;
}

/** Elige la clave temporal de una muestra: por nombre conocido, si no por contenido. */
function pickTimeKey(sample: Record<string, unknown>): string | null {
  const keys = Object.keys(sample);
  for (const candidate of TIME_KEYS) {
    const found = keys.find((k) => k.toLowerCase() === candidate.toLowerCase());
    if (found && toIsoDate(sample[found]) !== null) return found;
  }
  for (const k of keys) {
    if (toNumber(sample[k]) !== null) continue; // un número puro no es la marca de tiempo
    if (toIsoDate(sample[k]) !== null) return k;
  }
  return null;
}

/**
 * Ordena las muestras de más antigua a más reciente. Solo se aplica si TODAS
 * traen un instante parseable: si no, se respeta el orden del payload.
 */
function sortChronologically(points: SeriesPoint[]): void {
  const sortable = points.every((p) => p.t !== null && !Number.isNaN(Date.parse(p.t)));
  if (!sortable) return;
  points.sort((a, b) => Date.parse(a.t as string) - Date.parse(b.t as string));
}

/**
 * Normaliza la respuesta de un endpoint de serie de 24 h a `{ keys, points }`.
 * Nunca lanza: ante un formato desconocido devuelve `recognized: false` con el
 * payload original intacto.
 */
export function normalizeSeries(raw: unknown, valueNames: string[] = []): NormalizedSeries {
  const empty: NormalizedSeries = { keys: [], points: [], channels: [], recognized: false, raw };
  if (raw === null || raw === undefined) return { ...empty, recognized: true };

  const samples = findSampleArray(raw);
  if (!samples) return empty;
  if (samples.length === 0) return { ...empty, recognized: true };

  // Caso 1: array de tuplas `[epoch, v1, v2, …]` — es lo que devuelve ISP
  // Monitor: 288 muestras de 5 minutos con el instante en epoch/segundos.
  if (Array.isArray(samples[0])) {
    const points: SeriesPoint[] = [];
    const keySet = new Set<string>();
    for (const sample of samples) {
      if (!Array.isArray(sample) || sample.length === 0) continue;
      const t = toIsoDate(sample[0]);
      // Si la primera columna no es un instante, todas son valores.
      const columns = t === null ? sample : sample.slice(1);
      const values: Record<string, number> = {};
      columns.forEach((column, i) => {
        const n = toNumber(column);
        if (n === null) return;
        const key = valueNames[i] ?? (i === 0 ? 'value' : `value${i + 1}`);
        values[key] = n;
        keySet.add(key);
      });
      if (Object.keys(values).length === 0) continue;
      points.push({ t, values });
    }
    if (points.length === 0) return empty;
    sortChronologically(points);
    return { keys: [...keySet], points, channels: [], recognized: true, raw };
  }

  // Caso 2: array de escalares → una sola serie, indexada por posición.
  if (!isPlainObject(samples[0])) {
    const points: SeriesPoint[] = [];
    for (const sample of samples) {
      const n = toNumber(sample);
      if (n === null) continue;
      points.push({ t: null, values: { value: n } });
    }
    if (points.length === 0) return empty;
    const key = valueNames[0] ?? 'value';
    if (key !== 'value') {
      points.forEach((p) => {
        p.values[key] = p.values.value as number;
        delete p.values.value;
      });
    }
    return { keys: [key], points, channels: [], recognized: true, raw };
  }

  // Caso 3: array de canales — cada objeto trae su propia serie anidada.
  // Es lo que devuelven los endpoints DOCSIS de SNR y codewords: una entrada
  // por canal upstream del cablemódem.
  const channels = readChannels(samples, valueNames);
  if (channels) {
    const primary = channels[0] as SeriesChannel;
    return {
      keys: primary.keys,
      points: primary.points,
      channels,
      recognized: true,
      raw,
    };
  }

  // Caso 4: array de objetos planos (una muestra por objeto).
  const first = samples[0] as Record<string, unknown>;
  const timeKey = pickTimeKey(first);

  const keySet = new Set<string>();
  const points: SeriesPoint[] = [];

  for (const sample of samples) {
    if (!isPlainObject(sample)) continue;
    const values: Record<string, number> = {};
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(sample)) {
      if (k === timeKey) continue;
      const n = toNumber(v);
      if (n !== null) {
        values[k] = n;
        keySet.add(k);
      } else if (v !== null && v !== undefined && typeof v !== 'object') {
        meta[k] = String(v);
      }
    }
    const point: SeriesPoint = {
      t: timeKey ? (toIsoDate(sample[timeKey]) ?? String(sample[timeKey] ?? '')) : null,
      values,
    };
    if (Object.keys(meta).length > 0) point.meta = meta;
    points.push(point);
  }

  if (points.length === 0) return empty;
  sortChronologically(points);

  return { keys: [...keySet], points, channels: [], recognized: true, raw };
}

// --- Aplanado de objetos para la ficha del terminal -------------------------

export interface FlatField {
  key: string;
  /** Ruta completa cuando el campo venía anidado (`evento.descripcion`). */
  path: string;
  value: string | number | boolean | null;
}

/** Aplana un objeto (hasta 3 niveles) a una lista de campos mostrables. */
export function flattenFields(raw: unknown, prefix = '', depth = 0): FlatField[] {
  if (!isPlainObject(raw) || depth > 2) return [];
  const out: FlatField[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) {
      out.push({ key: k, path, value: null });
    } else if (typeof v === 'object') {
      if (Array.isArray(v)) {
        const scalars = v.filter((x) => typeof x !== 'object');
        if (scalars.length === v.length && v.length > 0) {
          out.push({ key: k, path, value: scalars.join(', ') });
        } else {
          v.forEach((item, i) => out.push(...flattenFields(item, `${path}[${i}]`, depth + 1)));
        }
      } else {
        out.push(...flattenFields(v, path, depth + 1));
      }
    } else {
      out.push({ key: k, path, value: v as string | number | boolean });
    }
  }
  return out;
}

/** Comparación laxa de nombres: sin acentos, sin separadores, minúsculas. */
function normKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/** Busca el primer campo cuyo nombre coincida con alguno de los alias. */
export function findField(fields: FlatField[], aliases: string[]): FlatField | null {
  const wanted = aliases.map(normKey);
  for (const alias of wanted) {
    const exact = fields.find((f) => normKey(f.key) === alias);
    if (exact) return exact;
  }
  for (const alias of wanted) {
    const partial = fields.find((f) => normKey(f.key).includes(alias));
    if (partial) return partial;
  }
  return null;
}

/** Interpreta un valor como booleano de estado (online/activo/1/true/"UP"). */
export function toBoolish(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = toNumber(value);
  if (n !== null) return n > 0;
  if (typeof value !== 'string') return null;
  const s = normKey(value);
  if (['online', 'up', 'activo', 'active', 'si', 'yes', 'ok', 'conectado', 'enlinea'].includes(s)) {
    return true;
  }
  if (['offline', 'down', 'inactivo', 'inactive', 'no', 'caido', 'desconectado'].includes(s)) {
    return false;
  }
  return null;
}
