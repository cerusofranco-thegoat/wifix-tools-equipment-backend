// Normalización de la whitelist de clientes — funciones PURAS, sin dependencias.
//
// Las usan tres piezas que tienen que coincidir al carácter:
//   - `scripts/whitelist-build.ts`  (local: xlsx → CSV minimizado)
//   - `prisma/import-whitelist.ts`  (servidor: CSV → Postgres)
//   - la ruta GET /accounts/:n/whitelist (normaliza lo que teclea el técnico)
//
// Si la cuenta se normaliza distinto al importar que al consultar, una cuenta
// real sale `listed:false`. Por eso todo vive acá y los tres lo importan.

export const WHITELIST_STATUSES = ['ACTIVO', 'SUSPENDIDO', 'ORDENADO', 'PENDIENTE'] as const;
export type WhitelistStatusValue = (typeof WHITELIST_STATUSES)[number];

/** Menor índice = mayor prioridad. ACTIVO > SUSPENDIDO > ORDENADO > PENDIENTE. */
const STATUS_RANK: Record<WhitelistStatusValue, number> = {
  ACTIVO: 0,
  SUSPENDIDO: 1,
  ORDENADO: 2,
  PENDIENTE: 3,
};

export function parseStatus(raw: unknown): WhitelistStatusValue | null {
  const value = cleanText(raw)?.toUpperCase() ?? '';
  return (WHITELIST_STATUSES as readonly string[]).includes(value)
    ? (value as WhitelistStatusValue)
    : null;
}

/** `true` si `a` tiene más prioridad que `b`. */
export function outranks(a: WhitelistStatusValue, b: WhitelistStatusValue): boolean {
  return STATUS_RANK[a] < STATUS_RANK[b];
}

/** Estado de mayor prioridad de la lista; `null` si está vacía. */
export function pickStatus(
  statuses: ReadonlyArray<WhitelistStatusValue>,
): WhitelistStatusValue | null {
  let best: WhitelistStatusValue | null = null;
  for (const s of statuses) {
    if (best === null || outranks(s, best)) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/**
 * Reparación del mojibake más común: UTF-8 leído como Latin-1 ("TelefonÃ­a").
 * Solo se aplica si el resultado es UTF-8 válido y deja de tener la marca.
 */
function repairMojibake(value: string): string {
  // "Ã" o "Â" seguidos de un carácter Latin-1 alto: firma del mojibake.
  if (!/[\xC3\xC2][\x80-\xFF]/.test(value)) return value;
  // Solo si todo el texto cabe en Latin-1 (si no, no es este mojibake).
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\xFF]/.test(value)) return value;
  const repaired = Buffer.from(value, 'latin1').toString('utf8');
  return repaired.includes(REPLACEMENT_CHAR) ? value : repaired;
}

/** U+FFFD, el "�" que deja un decodificador ante bytes inválidos. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * Limpia un valor de texto de la planilla:
 *  - números → string; null/undefined/'' → null
 *  - repara mojibake Latin-1, quita el carácter de reemplazo U+FFFD y los
 *    caracteres de control, normaliza a NFC y colapsa espacios.
 */
export function cleanText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let value: string;
  if (typeof raw === 'string') value = raw;
  else if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean')
    value = String(raw);
  else return null;

  value = repairMojibake(value)
    .split(REPLACEMENT_CHAR)
    .join('')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > 0 ? value : null;
}

/** Entero de Excel (number) → string de dígitos, sin notación científica. */
function integerToString(raw: number): string | null {
  if (!Number.isFinite(raw)) return null;
  if (Number.isInteger(raw)) return BigInt(raw).toString();
  return String(raw);
}

// ---------------------------------------------------------------------------
// Número de cuenta
// ---------------------------------------------------------------------------

/**
 * Número de cuenta canónico. ACCOUNT_ID viene como entero en la planilla, así
 * que una cuenta numérica se guarda SIN ceros a la izquierda; lo mismo se hace
 * con lo que teclea el técnico ("035070291" → "35070291"). Las no numéricas se
 * devuelven recortadas y en mayúsculas. `null` si queda vacía.
 */
export function normalizeAccountNumber(raw: unknown): string | null {
  const value =
    typeof raw === 'number' ? integerToString(raw) : (cleanText(raw)?.replace(/\s+/g, '') ?? null);
  if (!value) return null;
  if (/^\d+$/.test(value)) return value.replace(/^0+(?=\d)/, '');
  return value.toUpperCase();
}

// ---------------------------------------------------------------------------
// Cédula / RUC
// ---------------------------------------------------------------------------

export interface NormalizedDocument {
  documentId: string;
  /** `true` si quedó como cédula (10) o RUC (13). */
  documentNormalized: boolean;
}

/**
 * CEDULA_RUC llega como entero y perdió el cero inicial:
 *  - 9 dígitos  → pad a 10 (cédula)       · normalizado
 *  - 12 dígitos → pad a 13 (RUC)          · normalizado
 *  - 10 / 13    → tal cual                · normalizado
 *  - cualquier otra cosa (7-8 dígitos, pasaporte, vacío) → tal cual, NO normalizado
 *
 * No se valida el dígito verificador: la planilla es la fuente y el objetivo
 * es restituir el formato, no juzgar el documento.
 */
export function normalizeDocumentId(raw: unknown): NormalizedDocument {
  const text = typeof raw === 'number' ? integerToString(raw) : cleanText(raw);
  if (!text) return { documentId: '', documentNormalized: false };

  const compact = text.replace(/[\s.-]/g, '');
  if (/^\d+$/.test(compact)) {
    switch (compact.length) {
      case 9:
        return { documentId: compact.padStart(10, '0'), documentNormalized: true };
      case 12:
        return { documentId: compact.padStart(13, '0'), documentNormalized: true };
      case 10:
      case 13:
        return { documentId: compact, documentNormalized: true };
      default:
        return { documentId: compact, documentNormalized: false };
    }
  }
  return { documentId: text.toUpperCase(), documentNormalized: false };
}

// ---------------------------------------------------------------------------
// CSV minimizado (formato de intercambio build → import)
// ---------------------------------------------------------------------------

/**
 * Columnas del formato v1 (sin nombre). El import lo sigue aceptando: esas
 * cuentas quedan con `fullName` null.
 */
export const WHITELIST_CSV_COLUMNS_V1 = [
  'accountNumber',
  'documentId',
  'documentNormalized',
  'cpartyId',
  'status',
  'city',
  'node',
  'businessType',
  'accountType',
  'accessType',
] as const;

/**
 * Columnas permitidas del formato vigente (v2), en orden. NADA más sale de la
 * planilla: v2 solo agrega el nombre (respaldo de client-profile cuando FSM no
 * trae identidad). Ni dirección, ni coordenadas, ni saldo.
 */
export const WHITELIST_CSV_COLUMNS = [...WHITELIST_CSV_COLUMNS_V1, 'fullName'] as const;

export type WhitelistCsvColumn = (typeof WHITELIST_CSV_COLUMNS)[number];
export type WhitelistCsvVersion = 1 | 2;

export interface WhitelistRow {
  accountNumber: string;
  documentId: string;
  documentNormalized: boolean;
  cpartyId: string | null;
  status: WhitelistStatusValue;
  city: string | null;
  node: string | null;
  businessType: string | null;
  accountType: string | null;
  accessType: string | null;
  /** FULLNAME de la planilla (v2). `null` si no vino o el CSV es v1. */
  fullName: string | null;
}

/** Prefijo de la línea de metadatos (primera línea del CSV). */
export const WHITELIST_CSV_META_PREFIX = '#wifix-whitelist v2';
/** Reconoce la línea de metadatos de cualquier versión. */
export const WHITELIST_CSV_META_RE = /^#wifix-whitelist v\d+/;

function csvField(value: string | null): string {
  if (value === null) return '';
  return `"${value.replace(/"/g, '""')}"`;
}

export function whitelistRowToCsv(row: WhitelistRow): string {
  return [
    csvField(row.accountNumber),
    csvField(row.documentId),
    row.documentNormalized ? 'true' : 'false',
    csvField(row.cpartyId),
    row.status,
    csvField(row.city),
    csvField(row.node),
    csvField(row.businessType),
    csvField(row.accountType),
    csvField(row.accessType),
    csvField(row.fullName),
  ].join(',');
}

export function whitelistCsvHeader(): string {
  return WHITELIST_CSV_COLUMNS.join(',');
}

export function whitelistCsvMetaLine(sourceFiles: string[], builtAt: Date): string {
  // Solo nombres de archivo: nunca rutas (pueden llevar el usuario del equipo).
  const names = sourceFiles.map((f) => f.split(/[\\/]/).pop() ?? f);
  return `${WHITELIST_CSV_META_PREFIX}; sources=${names.join('|')}; builtAt=${builtAt.toISOString()}`;
}

/**
 * Parte una línea CSV (RFC 4180, sin saltos de línea dentro de campos: el build
 * los elimina en `cleanText`). Un campo vacío sin comillas es `null`; `""` es ''.
 */
export function parseCsvLine(line: string): Array<string | null> {
  const out: Array<string | null> = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    if (i >= n) {
      out.push(null);
      break;
    }
    if (line[i] === '"') {
      let value = '';
      i += 1;
      for (;;) {
        if (i >= n) throw new Error('comillas sin cerrar');
        const ch = line[i];
        if (ch === '"') {
          if (line[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      out.push(value);
      if (i >= n) break;
      if (line[i] !== ',') throw new Error('se esperaba una coma tras un campo entre comillas');
      i += 1;
    } else {
      const next = line.indexOf(',', i);
      const raw = next === -1 ? line.slice(i) : line.slice(i, next);
      out.push(raw.length > 0 ? raw : null);
      if (next === -1) break;
      i = next + 1;
    }
  }
  return out;
}

/**
 * CSV → fila validada. Lanza `Error` con un mensaje SIN el contenido de la
 * fila (los mensajes terminan en logs del servidor).
 */
export function csvLineToWhitelistRow(
  line: string,
  version: WhitelistCsvVersion = 2,
): WhitelistRow {
  const fields = parseCsvLine(line);
  const expected = version === 1 ? WHITELIST_CSV_COLUMNS_V1.length : WHITELIST_CSV_COLUMNS.length;
  if (fields.length !== expected) {
    throw new Error(`se esperaban ${expected} columnas y hay ${fields.length}`);
  }
  const [
    accountNumber,
    documentId,
    documentNormalized,
    cpartyId,
    status,
    city,
    node,
    businessType,
    accountType,
    accessType,
    fullName,
  ] = fields;

  const account = normalizeAccountNumber(accountNumber);
  if (!account) throw new Error('accountNumber vacío');
  if (account !== accountNumber) throw new Error('accountNumber no está normalizado');
  const parsedStatus = parseStatus(status);
  if (!parsedStatus) throw new Error('status desconocido');
  if (documentNormalized !== 'true' && documentNormalized !== 'false') {
    throw new Error('documentNormalized debe ser true/false');
  }

  return {
    accountNumber: account,
    documentId: documentId ?? '',
    documentNormalized: documentNormalized === 'true',
    cpartyId: cpartyId ?? null,
    status: parsedStatus,
    city: city ?? null,
    node: node ?? null,
    businessType: businessType ?? null,
    accountType: accountType ?? null,
    accessType: accessType ?? null,
    fullName: version === 1 ? null : cleanText(fullName),
  };
}
