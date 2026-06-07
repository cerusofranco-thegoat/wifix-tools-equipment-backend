// Conector hacia ISP Monitor — campos 9, 10, 11, 12, 13 (métricas de red).
// Fase F: extensión con telemetría de planta (onuRxPower, snr, cablemodem*).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export type Technology = 'GPON' | 'HFC';

export interface SignalLevels {
  rxDbm: number;
  txDbm: number;
}

export interface NetworkMetrics {
  accountNumber: string;
  technology: Technology;
  signalLevels: SignalLevels;
  signalToNoiseDb?: number;
  fecCorrectedPercent?: number;
  fecUncorrectedPercent?: number;
  outagesLast24h: number;
  trafficMbpsIn: number;
  trafficMbpsOut: number;
  measuredAt: string;
}

// ---------------------------------------------------------------------------
// Nuevos tipos para telemetría de planta (Fase F — para /study)
// ---------------------------------------------------------------------------

/**
 * Telemetría de planta óptica / HFC.
 * Para GPON: onuRxPower (dBm) y snr (dB) son los campos clave.
 * Para HFC/cablemodem: se añaden campos de downstream/upstream.
 */
export interface PlantTelemetry {
  accountNumber: string;
  technology: Technology;
  /** Potencia de recepción en la ONU (dBm). Rango saludable GPON: -8 a -28 dBm. */
  onuRxPower: number;
  /** Señal/ruido (dB). GPON ref >30 dB; HFC ref >33 dB. */
  snr: number;
  /** Fuente de la lectura (ej. "ispmonitor", "acs"). */
  source: string;
  /** Solo HFC: potencia downstream (dBmV). Rango saludable: 0 a +15 dBmV. */
  cablemodemDownstreamPower?: number;
  /** Solo HFC: potencia upstream (dBmV). */
  cablemodemUpstreamPower?: number;
  /** Solo HFC: MER (Modulation Error Ratio) en dB. */
  cablemodemMer?: number;
  measuredAt: string;
}

// ---------------------------------------------------------------------------
// Interfaz del conector
// ---------------------------------------------------------------------------

export interface IspMonitorConnector {
  getNetworkMetrics(accountNumber: string): Promise<NetworkMetrics>;
  /** Telemetría de planta óptica/HFC necesaria para el estudio agregado. */
  getPlantTelemetry(accountNumber: string): Promise<PlantTelemetry>;
}

// ---------------------------------------------------------------------------
// Mock determinista
// ---------------------------------------------------------------------------

export const ispMonitorMock: IspMonitorConnector = {
  async getNetworkMetrics(accountNumber) {
    const rng = seededRng(`ispmonitor:metrics:${accountNumber}`);
    const technology: Technology = rng.bool(0.7) ? 'GPON' : 'HFC';
    // measuredAt: fecha base fija para no depender de Date.now() en datos comparados
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const measuredAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();
    const base: NetworkMetrics = {
      accountNumber,
      technology,
      signalLevels: {
        rxDbm: rng.floatBetween(-28, -8, 2),
        txDbm: rng.floatBetween(0, 5, 2),
      },
      outagesLast24h: rng.intBetween(0, 3),
      trafficMbpsIn: rng.floatBetween(0.5, 350, 2),
      trafficMbpsOut: rng.floatBetween(0.2, 180, 2),
      measuredAt,
    };
    if (technology === 'HFC') {
      base.signalToNoiseDb = rng.floatBetween(28, 42, 1);
      base.fecCorrectedPercent = rng.floatBetween(0, 5, 2);
      base.fecUncorrectedPercent = rng.floatBetween(0, 1, 3);
    }
    return base;
  },

  async getPlantTelemetry(accountNumber) {
    const rng = seededRng(`ispmonitor:plant:${accountNumber}`);
    const technology: Technology = rng.bool(0.7) ? 'GPON' : 'HFC';
    // onuRxPower: GPON saludable -8 a -28 dBm; introducimos algunos fuera de rango
    const onuRxPower = rng.floatBetween(-32, -5, 2);
    // snr: GPON saludable >30 dB
    const snr = rng.floatBetween(22, 42, 1);
    const BASE_EPOCH_MS = 1_735_689_600_000;
    const measuredAt = new Date(BASE_EPOCH_MS + rng.intBetween(0, 86_400_000)).toISOString();

    const base: PlantTelemetry = {
      accountNumber,
      technology,
      onuRxPower,
      snr,
      source: 'ispmonitor',
      measuredAt,
    };

    if (technology === 'HFC') {
      // HFC: downstream 0..+15 dBmV; upstream -15..+55 dBmV
      base.cablemodemDownstreamPower = rng.floatBetween(-5, 20, 1);
      base.cablemodemUpstreamPower = rng.floatBetween(35, 55, 1);
      base.cablemodemMer = rng.floatBetween(28, 40, 1);
      // Para HFC el snr se deriva de MER
      base.snr = base.cablemodemMer;
    }

    return base;
  },
};

// ---------------------------------------------------------------------------
// Esqueleto real
// ---------------------------------------------------------------------------

export const ispMonitorReal: IspMonitorConnector = {
  async getNetworkMetrics(_accountNumber) {
    notImplemented('ispmonitor.getNetworkMetrics');
  },
  async getPlantTelemetry(_accountNumber) {
    notImplemented('ispmonitor.getPlantTelemetry');
  },
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getIspMonitorConnector(): IspMonitorConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return ispMonitorMock;
    case 'real':
      return ispMonitorReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
