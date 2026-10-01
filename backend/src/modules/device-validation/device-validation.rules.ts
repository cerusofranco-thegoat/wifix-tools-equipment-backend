// Validación de equipo vs plan contratado — funciones PURAS, sin dependencias.
//
// El servidor es la fuente de verdad: `POST /accounts/{n}/device-validations`
// decide con `evaluateDeviceValidation`. La webapp replica esta misma función
// para dar feedback inmediato antes del POST; si cambia la regla, cambia en los
// dos lados.
//
// Regla (decidida por Franco, 2026-10-01):
//   1. Modelo fuera del catálogo homologado → BLOCKED `not_in_catalog`
//      (se evalúa primero: un equipo no homologado se bloquea aunque no haya plan).
//   2. Sin plan contratado → UNKNOWN_PLAN (no bloquea; queda como alerta "sin plan").
//   3. ethernetMaxMbps < planMbps → BLOCKED `ethernet`.
//   4. wifiStatus 'enabled' y wifiMaxMbps < planMbps → BLOCKED `wifi`.
//      Con 'none' / 'disabled' solo cuenta Ethernet.
//   Ethernet y WiFi se reportan juntos si fallan los dos. Sin override.

export type DeviceWifiStatusValue = 'enabled' | 'none' | 'disabled';

/** Ítem del catálogo tal como sale en `GET /device-catalog`. */
export interface DeviceCatalogItem {
  model: string;
  displayName: string;
  brand: string;
  deviceType: string;
  category: string;
  wifiTech: string | null;
  ethernetMaxMbps: number;
  wifiMaxMbps: number | null;
  wifiStatus: DeviceWifiStatusValue;
  serialPrefixes: string[];
}

export type DeviceValidationResultValue = 'ok' | 'blocked' | 'unknown_plan';

export type DeviceValidationReason =
  | { kind: 'ethernet'; deviceMbps: number; planMbps: number }
  | { kind: 'wifi'; deviceMbps: number; planMbps: number }
  | { kind: 'not_in_catalog'; planMbps?: number };

export interface DeviceValidationVerdict {
  result: DeviceValidationResultValue;
  reasons: DeviceValidationReason[];
  /** Texto en español para mostrar al técnico. */
  message: string;
}

/** Clave de comparación de modelos: mayúsculas, sin espacios repetidos. */
export function normalizeModelKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Plan utilizable: entero positivo; cualquier otra cosa cuenta como "sin plan". */
function usablePlan(planMbps: number | null | undefined): number | null {
  return typeof planMbps === 'number' && Number.isFinite(planMbps) && planMbps > 0 ? planMbps : null;
}

function blockedMessage(planMbps: number, reasons: DeviceValidationReason[]): string {
  const base =
    'Advertencia: el dispositivo que usted está instalando no es el correcto, ya que no ' +
    `permite la máxima capacidad del plan contratado (${planMbps} Mbps) y, por lo tanto, ` +
    'no le va a dar un buen servicio al cliente.';
  const ethernet = reasons.find((r) => r.kind === 'ethernet');
  const wifi = reasons.find((r) => r.kind === 'wifi');
  if (ethernet && wifi && 'deviceMbps' in ethernet && 'deviceMbps' in wifi) {
    return `${base} Velocidad máxima del equipo: Ethernet ${ethernet.deviceMbps} Mbps y WiFi ${wifi.deviceMbps} Mbps.`;
  }
  if (ethernet && 'deviceMbps' in ethernet) {
    return `${base} Velocidad máxima del equipo por Ethernet: ${ethernet.deviceMbps} Mbps.`;
  }
  if (wifi && 'deviceMbps' in wifi) {
    return `${base} Velocidad máxima del equipo por WiFi: ${wifi.deviceMbps} Mbps.`;
  }
  return base;
}

function notInCatalogMessage(model: string, planMbps: number | null): string {
  const label = model.trim() ? `«${model.trim()}» ` : '';
  return (
    'Advertencia: el dispositivo que usted está instalando no es el correcto: el modelo ' +
    `${label}no está en el catálogo de equipos homologados` +
    (planMbps !== null
      ? `, por lo que no se garantiza la máxima capacidad del plan contratado (${planMbps} Mbps).`
      : '.')
  );
}

/**
 * Veredicto de la validación. `device` es el ítem del catálogo que coincidió
 * con el modelo escaneado, o `null` si no está homologado (incluye obsoletos).
 */
export function evaluateDeviceValidation(
  device: DeviceCatalogItem | null,
  planMbps: number | null,
  model = device?.model ?? '',
): DeviceValidationVerdict {
  const plan = usablePlan(planMbps);

  if (!device) {
    return {
      result: 'blocked',
      reasons: [plan !== null ? { kind: 'not_in_catalog', planMbps: plan } : { kind: 'not_in_catalog' }],
      message: notInCatalogMessage(model, plan),
    };
  }

  if (plan === null) {
    return {
      result: 'unknown_plan',
      reasons: [],
      message:
        'No se pudo obtener el plan contratado del cliente: no se validó la capacidad del ' +
        'equipo. Se registró una alerta para el gerente.',
    };
  }

  const reasons: DeviceValidationReason[] = [];
  if (device.ethernetMaxMbps < plan) {
    reasons.push({ kind: 'ethernet', deviceMbps: device.ethernetMaxMbps, planMbps: plan });
  }
  if (device.wifiStatus === 'enabled' && device.wifiMaxMbps !== null && device.wifiMaxMbps < plan) {
    reasons.push({ kind: 'wifi', deviceMbps: device.wifiMaxMbps, planMbps: plan });
  }

  if (reasons.length > 0) {
    return { result: 'blocked', reasons, message: blockedMessage(plan, reasons) };
  }
  return {
    result: 'ok',
    reasons: [],
    message: `Equipo correcto: soporta la máxima capacidad del plan contratado (${plan} Mbps).`,
  };
}

/** Busca el modelo en el catálogo (por `model` o `displayName`, sin distinguir mayúsculas). */
export function findCatalogItem<T extends Pick<DeviceCatalogItem, 'model' | 'displayName'>>(
  catalog: readonly T[],
  model: string,
): T | null {
  const key = normalizeModelKey(model);
  if (!key) return null;
  return (
    catalog.find((d) => normalizeModelKey(d.model) === key) ??
    catalog.find((d) => normalizeModelKey(d.displayName) === key) ??
    null
  );
}
