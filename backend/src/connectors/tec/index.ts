// Conector hacia TEC / registro GPON — campos 6 (NAPs cercanas) y 8 (puertos por NAP).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export interface NearbyNap {
  napCode: string;
  distanceMeters: number;
  occupiedPorts: number;
  totalPorts: number;
}

export interface NapPort {
  portNumber: number;
  occupied: boolean;
  clientAccountNumber?: string;
  clientStatus?: 'A' | 'S';
}

export interface NapPorts {
  napCode: string;
  ports: NapPort[];
}

export interface TecConnector {
  getNearbyNaps(accountNumber: string): Promise<NearbyNap[]>;
  getNapPorts(napCode: string): Promise<NapPorts>;
}

function makeNapCode(rng: ReturnType<typeof seededRng>): string {
  const cluster = rng.intBetween(1, 30);
  const card = rng.intBetween(1, 16);
  const port = rng.intBetween(1, 8);
  return `NAP-${cluster.toString().padStart(2, '0')}-${card.toString().padStart(2, '0')}-${port}`;
}

export const tecMock: TecConnector = {
  async getNearbyNaps(accountNumber) {
    const rng = seededRng(`tec:nearby:${accountNumber}`);
    const n = rng.intBetween(2, 5);
    const naps: NearbyNap[] = [];
    for (let i = 0; i < n; i++) {
      const total = rng.pick([8, 16] as const);
      const occupied = rng.intBetween(0, total);
      naps.push({
        napCode: makeNapCode(rng),
        distanceMeters: rng.floatBetween(20, 320, 1),
        occupiedPorts: occupied,
        totalPorts: total,
      });
    }
    return naps.sort((a, b) => a.distanceMeters - b.distanceMeters);
  },

  async getNapPorts(napCode) {
    const rng = seededRng(`tec:napports:${napCode}`);
    const total = rng.pick([8, 16] as const);
    const ports: NapPort[] = [];
    for (let i = 1; i <= total; i++) {
      const occupied = rng.bool(0.7);
      const port: NapPort = { portNumber: i, occupied };
      if (occupied) {
        port.clientAccountNumber = `WX-${rng.intBetween(100000, 999999)}`;
        port.clientStatus = rng.bool(0.85) ? 'A' : 'S';
      }
      ports.push(port);
    }
    return { napCode, ports };
  },
};

export const tecReal: TecConnector = {
  async getNearbyNaps(_accountNumber) {
    notImplemented('tec.getNearbyNaps');
  },
  async getNapPorts(_napCode) {
    notImplemented('tec.getNapPorts');
  },
};

export function getTecConnector(): TecConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return tecMock;
    case 'real':
      return tecReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
