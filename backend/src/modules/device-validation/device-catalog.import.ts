// Catálogo de equipos homologados: parseo de la planilla y carga en Postgres.
//
// Lo usan:
//   - `prisma/import-device-catalog.ts` (lee el .xlsx y hace upsert),
//   - `prisma/seed.ts` (siembra desde `prisma/catalogs/device-catalog.json`, para que
//     el servidor funcione sin la planilla).
//
// Solo entran los equipos con ESTADO_EQUIPO = 'Moderno'. Los 'Obsoleto' NO se
// importan; si ya estaban en la base (porque antes fueron 'Moderno') quedan
// `active = false`: fuera del catálogo = no homologado = bloqueo.

import type { PrismaClient } from '@prisma/client';
import type { DeviceCatalogItem, DeviceWifiStatusValue } from './device-validation.rules.js';
import { normalizeModelKey } from './device-validation.rules.js';
import { toPrismaWifiStatus } from './device-validation.mappers.js';

/** Encabezados de la planilla (sin tildes, en mayúsculas, espacios simples). */
export const CATALOG_HEADERS = {
  model: 'MODELO',
  displayName: 'MODELO_DISPLAY',
  brand: 'MARCA',
  deviceType: 'TIPO_EQUIPO',
  category: 'CATEGORIA',
  wifiTech: 'TECNOLOGIA WIFI',
  status: 'ESTADO_EQUIPO',
  ethernet: 'VELOCIDAD MAXIMA DE ENLACE ETHERNET MBPS',
  wifi: 'VELOCIDAD MAXIMA DE ENLACE WIFI MBPS',
} as const;

export class DeviceCatalogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceCatalogParseError';
  }
}

/** Fila cruda: encabezado normalizado → valor de la celda. */
export type CatalogSheetRow = Record<string, unknown>;

export interface ParsedDeviceCatalog {
  /** Equipos 'Moderno' listos para upsert. */
  items: DeviceCatalogItem[];
  /** Modelos marcados 'Obsoleto' en la planilla (se desactivan si existen). */
  obsoleteModels: string[];
  /** Filas que no se pudieron interpretar (fila 1-based de la hoja + motivo). */
  skipped: Array<{ row: number; reason: string }>;
}

/** Encabezado comparable: sin tildes, mayúsculas, espacios simples. */
export function normalizeHeader(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'result' in value) {
    // Celda con fórmula (exceljs): se usa el resultado.
    return text((value as { result: unknown }).result);
  }
  if (typeof value === 'object' && value !== null && 'richText' in value) {
    const parts = (value as { richText: Array<{ text: string }> }).richText;
    return text(parts.map((p) => p.text).join(''));
  }
  const s = String(value).trim().replace(/\s+/g, ' ');
  return s ? s : null;
}

function positiveInt(value: unknown): number | null {
  const raw = typeof value === 'number' ? value : Number(text(value)?.replace(',', '.'));
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
}

/**
 * Columna WIFI → estado + velocidad.
 *   'N/A' (o vacío / 'SIN WIFI') → none, null
 *   '300 DESACTIVADO'            → disabled, 300 (informativo)
 *   numérico                     → enabled, n
 */
export function parseWifiCell(value: unknown): { wifiStatus: DeviceWifiStatusValue; wifiMaxMbps: number | null } | null {
  const raw = text(value);
  if (raw === null || /^(N\/?A|SIN WIFI|-)$/i.test(raw)) return { wifiStatus: 'none', wifiMaxMbps: null };
  const disabled = /DESACTIVAD/i.test(raw);
  const n = positiveInt(raw.replace(/[^\d.,]/g, ''));
  if (disabled) return { wifiStatus: 'disabled', wifiMaxMbps: n };
  if (n === null) return null;
  return { wifiStatus: 'enabled', wifiMaxMbps: n };
}

/**
 * Prefijos de serial por modelo: PISTA de marca para filtrar la lista en la app
 * (un prefijo no identifica el modelo exacto). Coinciden con los patrones que
 * usa Equipos Retirados en la webapp:
 *   ONT ZTE `ZTEG`+8 · Router ZTE `ZTEL`+12 · ONT Huawei `HWTC`+8 ·
 *   Router Huawei 16 alfanum. (ej. `BWH7S22607002277`, `BWH` es pista débil) ·
 *   ONU300G / ONU HUR / ONT HUR `STGU`+8 · ONU B2000 `XPON`+8.
 */
export function serialPrefixesFor(item: Pick<DeviceCatalogItem, 'model' | 'brand' | 'deviceType'>): string[] {
  const model = normalizeModelKey(item.model);
  const brand = normalizeModelKey(item.brand);
  const type = normalizeModelKey(item.deviceType);
  if (/ONU300G|\bHUR\b|HUR\d/.test(model)) return ['STGU'];
  if (/B2000/.test(model)) return ['XPON'];
  if (brand === 'ZTE') return type === 'ROUTER' ? ['ZTEL'] : type === 'ONT' ? ['ZTEG'] : [];
  if (brand === 'HUAWEI') return type === 'ROUTER' ? ['BWH'] : type === 'ONT' ? ['HWTC'] : [];
  return [];
}

/**
 * Interpreta las filas de la hoja. `rows[0]` debe ser el encabezado; las celdas
 * vacías se ignoran. Lanza si falta una columna obligatoria.
 */
export function parseDeviceCatalogRows(rows: unknown[][]): ParsedDeviceCatalog {
  const headerRowIndex = rows.findIndex((r) =>
    r.some((c) => normalizeHeader(c) === CATALOG_HEADERS.model),
  );
  if (headerRowIndex === -1) {
    throw new DeviceCatalogParseError(`No se encontró la columna ${CATALOG_HEADERS.model}.`);
  }
  const header = (rows[headerRowIndex] ?? []).map(normalizeHeader);
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i === -1) throw new DeviceCatalogParseError(`Falta la columna "${name}" en la planilla.`);
    return i;
  };
  const idx = {
    model: col(CATALOG_HEADERS.model),
    displayName: header.indexOf(CATALOG_HEADERS.displayName),
    brand: col(CATALOG_HEADERS.brand),
    deviceType: col(CATALOG_HEADERS.deviceType),
    category: col(CATALOG_HEADERS.category),
    wifiTech: header.indexOf(CATALOG_HEADERS.wifiTech),
    status: col(CATALOG_HEADERS.status),
    ethernet: col(CATALOG_HEADERS.ethernet),
    wifi: col(CATALOG_HEADERS.wifi),
  };

  const items: DeviceCatalogItem[] = [];
  const obsoleteModels: string[] = [];
  const skipped: ParsedDeviceCatalog['skipped'] = [];
  const seen = new Set<string>();

  rows.slice(headerRowIndex + 1).forEach((row, i) => {
    const rowNumber = headerRowIndex + i + 2;
    const model = text(row[idx.model]);
    if (!model) return;
    const status = normalizeHeader(row[idx.status]);
    if (status === 'OBSOLETO') {
      obsoleteModels.push(model);
      return;
    }
    if (status !== 'MODERNO') {
      skipped.push({ row: rowNumber, reason: `ESTADO_EQUIPO desconocido: "${text(row[idx.status]) ?? ''}"` });
      return;
    }
    const ethernetMaxMbps = positiveInt(row[idx.ethernet]);
    if (ethernetMaxMbps === null) {
      skipped.push({ row: rowNumber, reason: `${model}: velocidad Ethernet inválida` });
      return;
    }
    const wifi = parseWifiCell(row[idx.wifi]);
    if (wifi === null) {
      skipped.push({ row: rowNumber, reason: `${model}: velocidad WiFi inválida` });
      return;
    }
    const key = normalizeModelKey(model);
    if (seen.has(key)) {
      skipped.push({ row: rowNumber, reason: `${model}: modelo repetido` });
      return;
    }
    seen.add(key);
    const base = {
      model,
      displayName: (idx.displayName !== -1 ? text(row[idx.displayName]) : null) ?? model,
      brand: text(row[idx.brand]) ?? '',
      deviceType: text(row[idx.deviceType]) ?? '',
      category: text(row[idx.category]) ?? '',
      wifiTech: idx.wifiTech !== -1 ? text(row[idx.wifiTech]) : null,
      ethernetMaxMbps,
      wifiMaxMbps: wifi.wifiMaxMbps,
      wifiStatus: wifi.wifiStatus,
    };
    items.push({ ...base, serialPrefixes: serialPrefixesFor(base) });
  });

  return { items, obsoleteModels, skipped };
}

export interface UpsertCatalogResult {
  created: number;
  updated: number;
  deactivated: number;
}

/**
 * Upsert por `model` (idempotente). Lo que viene marca `active = true`; los
 * `obsoleteModels` que existan quedan `active = false`. No borra nada.
 */
export async function upsertDeviceCatalog(
  prisma: PrismaClient,
  items: DeviceCatalogItem[],
  obsoleteModels: string[] = [],
): Promise<UpsertCatalogResult> {
  return prisma.$transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    for (const item of items) {
      const data = {
        displayName: item.displayName,
        brand: item.brand,
        deviceType: item.deviceType,
        category: item.category,
        wifiTech: item.wifiTech,
        ethernetMaxMbps: item.ethernetMaxMbps,
        wifiMaxMbps: item.wifiMaxMbps,
        wifiStatus: toPrismaWifiStatus(item.wifiStatus),
        serialPrefixes: item.serialPrefixes,
        active: true,
      };
      const existing = await tx.deviceModel.findUnique({ where: { model: item.model }, select: { id: true } });
      if (existing) {
        await tx.deviceModel.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await tx.deviceModel.create({ data: { model: item.model, ...data } });
        created += 1;
      }
    }
    const { count: deactivated } = obsoleteModels.length
      ? await tx.deviceModel.updateMany({
          where: { model: { in: obsoleteModels }, active: true },
          data: { active: false },
        })
      : { count: 0 };
    return { created, updated, deactivated };
  });
}
