/**
 * Motor de auto-asistencia — reglas de detección puras.
 *
 * Estas funciones son PURAS (input: métricas → output: causas + propuestas).
 * No tienen efectos secundarios, no leen BD, no llaman conectores.
 * Son fácilmente testeables con Vitest sin infraestructura.
 */

import type { PlantTelemetry } from '../../connectors/ispmonitor/index.js';

// ---------------------------------------------------------------------------
// Tipos de dominio
// ---------------------------------------------------------------------------

export type CauseCode =
  | 'WIFI_SIGNAL_LOW'
  | 'SNR_DEGRADED'
  | 'CHANNEL_SATURATED'
  | 'ONU_RX_POWER_OUT_OF_RANGE'
  | 'CABLEMODEM_DOWNSTREAM_LOW'
  | 'CABLEMODEM_MER_LOW';

export type RemediationAction =
  | 'SET_CHANNEL'
  | 'REPROVISION'
  | 'REBOOT'
  | 'FACTORY_RESET';

export interface DetectedCause {
  code: CauseCode;
  description: string;
  /** Valor medido que disparó la causa. */
  measuredValue: number;
  /** Umbral que define el límite saludable. */
  threshold: number;
}

export interface ProposedRemediation {
  /** ID único propuesto (determinista: basado en causa). */
  id: string;
  cause: CauseCode;
  action: RemediationAction;
  description: string;
  /** Parámetros específicos para la acción (ej. canal a aplicar). */
  params: Record<string, unknown>;
  /**
   * Estado previo que se debe guardar antes de aplicar para permitir reversión.
   * Rellenado por el servicio antes de aplicar; aquí siempre null (es propuesta).
   */
  previousState: null;
  /** Indica si esta remediación es reversible. */
  reversible: boolean;
}

// ---------------------------------------------------------------------------
// Métricas de entrada
// ---------------------------------------------------------------------------

export interface AutoAssistMetrics {
  plant: PlantTelemetry | null;
  /** Dispositivos WiFi conectados (de ACS). Null si no disponible. */
  wifiDeviceCount: number | null;
  /** Canal WiFi 2.4GHz actualmente configurado. Null si no disponible. */
  wifiChannel24: number | null;
  /** Canal WiFi 5GHz actualmente configurado. Null si no disponible. */
  wifiChannel5: number | null;
  /** Señal promedio de los dispositivos WiFi (dBm). Null si no disponible. */
  avgWifiSignalDbm: number | null;
}

// ---------------------------------------------------------------------------
// Umbrales de diagnóstico (exportados para que los tests los puedan importar)
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Potencia de recepción ONU mínima aceptable (dBm). Por debajo = problema. */
  ONU_RX_POWER_MIN_DBM: -27,
  /** Potencia de recepción ONU máxima aceptable (dBm). Por encima = saturación. */
  ONU_RX_POWER_MAX_DBM: -8,
  /** SNR mínimo aceptable (dB). Por debajo = degradación. */
  SNR_MIN_DB: 28,
  /** Señal WiFi mínima aceptable en dispositivos conectados (dBm). */
  WIFI_SIGNAL_MIN_DBM: -70,
  /** Número de dispositivos WiFi en 2.4GHz que indica canal potencialmente saturado. */
  WIFI_CHANNEL_SATURATION_DEVICES: 6,
  /** Potencia downstream HFC mínima (dBmV). */
  CABLEMODEM_DOWNSTREAM_MIN_DBMV: -5,
  /** MER mínimo HFC (dB). */
  CABLEMODEM_MER_MIN_DB: 30,
} as const;

// ---------------------------------------------------------------------------
// Canales WiFi libres (sugeridos como alternativa cuando hay saturación)
// ---------------------------------------------------------------------------

/** Canales no solapados de 2.4GHz recomendados. */
const FREE_CHANNELS_24GHZ = [1, 6, 11] as const;
/** Canales no solapados de 5GHz recomendados (UNII-1 y UNII-3). */
const FREE_CHANNELS_5GHZ = [36, 40, 44, 48, 149, 153, 157, 161] as const;

function suggestAlternativeChannel(currentChannel: number | null, band: '2.4GHz' | '5GHz'): number {
  const pool = band === '2.4GHz' ? FREE_CHANNELS_24GHZ : FREE_CHANNELS_5GHZ;
  // Elegir el primer canal del pool que no sea el actual
  return pool.find((ch) => ch !== currentChannel) ?? pool[0];
}

// ---------------------------------------------------------------------------
// Función de detección pura
// ---------------------------------------------------------------------------

/**
 * Analiza métricas y devuelve causas detectadas + remediaciones propuestas.
 *
 * @pure No produce efectos secundarios.
 */
export function detectCausesAndProposals(metrics: AutoAssistMetrics): {
  causes: DetectedCause[];
  proposals: ProposedRemediation[];
} {
  const causes: DetectedCause[] = [];
  const proposals: ProposedRemediation[] = [];

  // --- 1. Señal WiFi baja ---
  if (
    metrics.avgWifiSignalDbm !== null &&
    metrics.avgWifiSignalDbm < THRESHOLDS.WIFI_SIGNAL_MIN_DBM
  ) {
    causes.push({
      code: 'WIFI_SIGNAL_LOW',
      description: `Señal WiFi promedio demasiado baja (${metrics.avgWifiSignalDbm} dBm). Umbral: ${THRESHOLDS.WIFI_SIGNAL_MIN_DBM} dBm.`,
      measuredValue: metrics.avgWifiSignalDbm,
      threshold: THRESHOLDS.WIFI_SIGNAL_MIN_DBM,
    });
    proposals.push({
      id: 'remediation:SET_CHANNEL:WIFI_SIGNAL_LOW',
      cause: 'WIFI_SIGNAL_LOW',
      action: 'SET_CHANNEL',
      description: 'Cambiar el canal WiFi 2.4GHz a uno menos congestionado puede mejorar la cobertura.',
      params: {
        band: '2.4GHz',
        channel: suggestAlternativeChannel(metrics.wifiChannel24, '2.4GHz'),
      },
      previousState: null,
      reversible: true,
    });
  }

  // --- 2. SNR degradado ---
  if (metrics.plant !== null && metrics.plant.snr < THRESHOLDS.SNR_MIN_DB) {
    causes.push({
      code: 'SNR_DEGRADED',
      description: `SNR de planta degradado (${metrics.plant.snr} dB). Umbral mínimo: ${THRESHOLDS.SNR_MIN_DB} dB.`,
      measuredValue: metrics.plant.snr,
      threshold: THRESHOLDS.SNR_MIN_DB,
    });
    proposals.push({
      id: 'remediation:REPROVISION:SNR_DEGRADED',
      cause: 'SNR_DEGRADED',
      action: 'REPROVISION',
      description: 'Reaprovisionar el equipo puede restablecer los parámetros de señal óptimos.',
      params: {},
      previousState: null,
      reversible: false,
    });
  }

  // --- 3. Canal saturado (muchos dispositivos en 2.4GHz) ---
  if (
    metrics.wifiDeviceCount !== null &&
    metrics.wifiDeviceCount >= THRESHOLDS.WIFI_CHANNEL_SATURATION_DEVICES
  ) {
    causes.push({
      code: 'CHANNEL_SATURATED',
      description: `Canal WiFi posiblemente saturado: ${metrics.wifiDeviceCount} dispositivos conectados (umbral: ${THRESHOLDS.WIFI_CHANNEL_SATURATION_DEVICES}).`,
      measuredValue: metrics.wifiDeviceCount,
      threshold: THRESHOLDS.WIFI_CHANNEL_SATURATION_DEVICES,
    });
    proposals.push(
      {
        id: 'remediation:SET_CHANNEL_24:CHANNEL_SATURATED',
        cause: 'CHANNEL_SATURATED',
        action: 'SET_CHANNEL',
        description: 'Cambiar el canal 2.4GHz a uno libre puede reducir la interferencia.',
        params: {
          band: '2.4GHz',
          channel: suggestAlternativeChannel(metrics.wifiChannel24, '2.4GHz'),
        },
        previousState: null,
        reversible: true,
      },
      {
        id: 'remediation:SET_CHANNEL_5:CHANNEL_SATURATED',
        cause: 'CHANNEL_SATURATED',
        action: 'SET_CHANNEL',
        description: 'Cambiar el canal 5GHz a uno libre puede redistribuir la carga.',
        params: {
          band: '5GHz',
          channel: suggestAlternativeChannel(metrics.wifiChannel5, '5GHz'),
        },
        previousState: null,
        reversible: true,
      },
    );
  }

  // --- 4. ONU RxPower fuera de rango ---
  if (metrics.plant !== null) {
    const { onuRxPower } = metrics.plant;
    if (
      onuRxPower < THRESHOLDS.ONU_RX_POWER_MIN_DBM ||
      onuRxPower > THRESHOLDS.ONU_RX_POWER_MAX_DBM
    ) {
      causes.push({
        code: 'ONU_RX_POWER_OUT_OF_RANGE',
        description:
          `Potencia de recepción ONU fuera de rango (${onuRxPower} dBm). ` +
          `Rango saludable: ${THRESHOLDS.ONU_RX_POWER_MAX_DBM} a ${THRESHOLDS.ONU_RX_POWER_MIN_DBM} dBm.`,
        measuredValue: onuRxPower,
        threshold: THRESHOLDS.ONU_RX_POWER_MIN_DBM,
      });
      proposals.push({
        id: 'remediation:REBOOT:ONU_RX_POWER_OUT_OF_RANGE',
        cause: 'ONU_RX_POWER_OUT_OF_RANGE',
        action: 'REBOOT',
        description: 'Reiniciar el equipo puede restablecer la potencia óptica dentro del rango.',
        params: {},
        previousState: null,
        reversible: true,
      });
    }
  }

  // --- 5. HFC: downstream bajo ---
  if (
    metrics.plant !== null &&
    metrics.plant.technology === 'HFC' &&
    metrics.plant.cablemodemDownstreamPower !== undefined &&
    metrics.plant.cablemodemDownstreamPower < THRESHOLDS.CABLEMODEM_DOWNSTREAM_MIN_DBMV
  ) {
    causes.push({
      code: 'CABLEMODEM_DOWNSTREAM_LOW',
      description: `Potencia downstream HFC baja (${metrics.plant.cablemodemDownstreamPower} dBmV). Umbral: ${THRESHOLDS.CABLEMODEM_DOWNSTREAM_MIN_DBMV} dBmV.`,
      measuredValue: metrics.plant.cablemodemDownstreamPower,
      threshold: THRESHOLDS.CABLEMODEM_DOWNSTREAM_MIN_DBMV,
    });
    proposals.push({
      id: 'remediation:REPROVISION:CABLEMODEM_DOWNSTREAM_LOW',
      cause: 'CABLEMODEM_DOWNSTREAM_LOW',
      action: 'REPROVISION',
      description: 'Reaprovisionar el cablemodem puede corregir los niveles de señal downstream.',
      params: {},
      previousState: null,
      reversible: false,
    });
  }

  // --- 6. HFC: MER bajo ---
  if (
    metrics.plant !== null &&
    metrics.plant.technology === 'HFC' &&
    metrics.plant.cablemodemMer !== undefined &&
    metrics.plant.cablemodemMer < THRESHOLDS.CABLEMODEM_MER_MIN_DB
  ) {
    causes.push({
      code: 'CABLEMODEM_MER_LOW',
      description: `MER HFC bajo (${metrics.plant.cablemodemMer} dB). Umbral mínimo: ${THRESHOLDS.CABLEMODEM_MER_MIN_DB} dB.`,
      measuredValue: metrics.plant.cablemodemMer,
      threshold: THRESHOLDS.CABLEMODEM_MER_MIN_DB,
    });
    proposals.push({
      id: 'remediation:REBOOT:CABLEMODEM_MER_LOW',
      cause: 'CABLEMODEM_MER_LOW',
      action: 'REBOOT',
      description: 'Reiniciar el cablemodem puede mejorar la calidad de modulación.',
      params: {},
      previousState: null,
      reversible: true,
    });
  }

  return { causes, proposals };
}
