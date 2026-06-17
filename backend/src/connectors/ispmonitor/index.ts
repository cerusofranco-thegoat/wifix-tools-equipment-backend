// Conector hacia ISP Monitor — campos 9, 10, 11, 12, 13 (métricas de red).

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

export interface IspMonitorConnector {
  getNetworkMetrics(accountNumber: string): Promise<NetworkMetrics>;
}

export const ispMonitorMock: IspMonitorConnector = {
  async getNetworkMetrics(accountNumber) {
    const rng = seededRng(`ispmonitor:metrics:${accountNumber}`);
    const technology: Technology = rng.bool(0.7) ? 'GPON' : 'HFC';
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
      measuredAt: new Date().toISOString(),
    };
    if (technology === 'HFC') {
      base.signalToNoiseDb = rng.floatBetween(28, 42, 1);
      base.fecCorrectedPercent = rng.floatBetween(0, 5, 2);
      base.fecUncorrectedPercent = rng.floatBetween(0, 1, 3);
    }
    return base;
  },
};

export const ispMonitorReal: IspMonitorConnector = {
  async getNetworkMetrics(_accountNumber) {
    notImplemented('ispmonitor.getNetworkMetrics');
  },
};

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
