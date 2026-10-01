import type {
  Prisma,
  DeviceModel,
  DeviceValidation,
  DeviceValidationCategory,
  DeviceValidationResult,
  DeviceWifiStatus,
} from '@prisma/client';
import type {
  DeviceCatalogItem,
  DeviceValidationReason,
  DeviceValidationResultValue,
  DeviceWifiStatusValue,
} from './device-validation.rules.js';

export type DeviceValidationCategoryValue = 'instalaciones' | 'migraciones' | 'visitas';
export type SerialSourceValue = 'barcode' | 'ocr' | 'manual';
export type PlanSource = 'simulated' | 'real';

const WIFI_STATUS_TO_API: Record<DeviceWifiStatus, DeviceWifiStatusValue> = {
  ENABLED: 'enabled',
  NONE: 'none',
  DISABLED: 'disabled',
};

const WIFI_STATUS_TO_DB: Record<DeviceWifiStatusValue, DeviceWifiStatus> = {
  enabled: 'ENABLED',
  none: 'NONE',
  disabled: 'DISABLED',
};

const RESULT_TO_API: Record<DeviceValidationResult, DeviceValidationResultValue> = {
  OK: 'ok',
  BLOCKED: 'blocked',
  UNKNOWN_PLAN: 'unknown_plan',
};

const RESULT_TO_DB: Record<DeviceValidationResultValue, DeviceValidationResult> = {
  ok: 'OK',
  blocked: 'BLOCKED',
  unknown_plan: 'UNKNOWN_PLAN',
};

const CATEGORY_TO_API: Record<DeviceValidationCategory, DeviceValidationCategoryValue> = {
  INSTALACIONES: 'instalaciones',
  MIGRACIONES: 'migraciones',
  VISITAS: 'visitas',
};

const CATEGORY_TO_DB: Record<DeviceValidationCategoryValue, DeviceValidationCategory> = {
  instalaciones: 'INSTALACIONES',
  migraciones: 'MIGRACIONES',
  visitas: 'VISITAS',
};

export const toPrismaWifiStatus = (v: DeviceWifiStatusValue): DeviceWifiStatus => WIFI_STATUS_TO_DB[v];
export const toPrismaResult = (v: DeviceValidationResultValue): DeviceValidationResult => RESULT_TO_DB[v];
export const toPrismaCategory = (v: DeviceValidationCategoryValue): DeviceValidationCategory =>
  CATEGORY_TO_DB[v];

export function toCatalogItem(row: DeviceModel): DeviceCatalogItem {
  return {
    model: row.model,
    displayName: row.displayName,
    brand: row.brand,
    deviceType: row.deviceType,
    category: row.category,
    wifiTech: row.wifiTech,
    ethernetMaxMbps: row.ethernetMaxMbps,
    wifiMaxMbps: row.wifiMaxMbps,
    wifiStatus: WIFI_STATUS_TO_API[row.wifiStatus],
    serialPrefixes: row.serialPrefixes,
  };
}

export interface DeviceValidationDto {
  id: string;
  accountNumber: string;
  category: DeviceValidationCategoryValue;
  taskId: string | null;
  serial: string;
  serialSource: SerialSourceValue | null;
  /** Modelo tal como lo envió la app. */
  model: string;
  result: DeviceValidationResultValue;
  planMbps: number | null;
  planSource: PlanSource;
  /** Foto del ítem del catálogo al validar; `null` si no estaba homologado. */
  device: DeviceCatalogItem | null;
  reasons: DeviceValidationReason[];
  message: string;
  createdAt: string;
  technician: { id: string; email: string; name: string | null };
}

/**
 * Foto del equipo guardada en JSONB → ítem del catálogo con el orden de claves
 * del contrato (JSONB no conserva el orden).
 */
function snapshotToCatalogItem(value: Prisma.JsonValue): DeviceCatalogItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as unknown as DeviceCatalogItem;
  return {
    model: d.model,
    displayName: d.displayName,
    brand: d.brand,
    deviceType: d.deviceType,
    category: d.category,
    wifiTech: d.wifiTech ?? null,
    ethernetMaxMbps: d.ethernetMaxMbps,
    wifiMaxMbps: d.wifiMaxMbps ?? null,
    wifiStatus: d.wifiStatus,
    serialPrefixes: Array.isArray(d.serialPrefixes) ? d.serialPrefixes : [],
  };
}

function snapshotToReasons(value: Prisma.JsonValue): DeviceValidationReason[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown as DeviceValidationReason[]).map((r) =>
    r.kind === 'not_in_catalog'
      ? r.planMbps !== undefined
        ? { kind: r.kind, planMbps: r.planMbps }
        : { kind: r.kind }
      : { kind: r.kind, deviceMbps: r.deviceMbps, planMbps: r.planMbps },
  );
}

function toSerialSource(value: string | null): SerialSourceValue | null {
  return value === 'barcode' || value === 'ocr' || value === 'manual' ? value : null;
}

export function toDeviceValidationDto(row: DeviceValidation): DeviceValidationDto {
  return {
    id: row.id,
    accountNumber: row.accountNumber,
    category: CATEGORY_TO_API[row.category],
    taskId: row.taskId,
    serial: row.serial,
    serialSource: toSerialSource(row.serialSource),
    model: row.model,
    result: RESULT_TO_API[row.result],
    planMbps: row.planMbps,
    planSource: row.planSource === 'real' ? 'real' : 'simulated',
    // Columnas JSON escritas solo por este módulo con estas mismas formas.
    device: snapshotToCatalogItem(row.device),
    reasons: snapshotToReasons(row.reasons),
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    technician: { id: row.validatedById, email: row.validatedByEmail, name: row.validatedByName },
  };
}
