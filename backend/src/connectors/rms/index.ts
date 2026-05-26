// Conector hacia RMS — campo 14 (eventos/daños del nodo).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export type NodeEventStatus = 'RESUELTO' | 'PENDIENTE' | 'FALLA';

export interface NodeEvent {
  type: string;
  description: string;
  status: NodeEventStatus;
  occurredAt: string;
}

export interface RmsConnector {
  getNodeEvents(accountNumber: string): Promise<NodeEvent[]>;
}

const EVENT_TYPES = [
  'Caída de potencia',
  'Fluctuación de voltaje',
  'Pérdida de fibra',
  'Corte programado',
  'Mantenimiento de nodo',
  'Daño físico',
  'Pico de tráfico',
];

const DESCRIPTIONS = [
  'Generador entró en línea y se restituyó el servicio.',
  'Se detectó atenuación en troncal — cuadrilla en sitio.',
  'Corte por trabajo planificado de la empresa eléctrica.',
  'Reemplazo de splitter y limpieza de conectores.',
  'Reset general del nodo y validación post-mantenimiento.',
  'Equipo fuera de servicio — diagnóstico en curso.',
];

const STATUSES: NodeEventStatus[] = ['RESUELTO', 'RESUELTO', 'RESUELTO', 'PENDIENTE', 'FALLA'];

export const rmsMock: RmsConnector = {
  async getNodeEvents(accountNumber) {
    const rng = seededRng(`rms:events:${accountNumber}`);
    const n = rng.intBetween(0, 4);
    const events: NodeEvent[] = [];
    for (let i = 0; i < n; i++) {
      const hoursAgo = rng.intBetween(1, 24 * 30);
      const d = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
      events.push({
        type: rng.pick(EVENT_TYPES),
        description: rng.pick(DESCRIPTIONS),
        status: rng.pick(STATUSES),
        occurredAt: d.toISOString(),
      });
    }
    return events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },
};

export const rmsReal: RmsConnector = {
  async getNodeEvents(_accountNumber) {
    notImplemented('rms.getNodeEvents');
  },
};

export function getRmsConnector(): RmsConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return rmsMock;
    case 'real':
      return rmsReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
