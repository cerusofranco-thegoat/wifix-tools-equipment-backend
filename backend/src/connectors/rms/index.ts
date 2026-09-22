// Conector hacia RMS — campo 14 (eventos/daños de la red de acceso).
//
// El tipo, el endpoint y el método conservan el nombre `NodeEvent` /
// `node-events` / `getNodeEvents`: es el contrato ya publicado en el OpenAPI y
// el término del Excel original. Lo que cambia es el texto que lee el técnico:
// la operadora aclaró (2026-08-27) que "nodo" no es un concepto de su red — los
// datos salen de tarjetas de CMTS o de puertos de OLT. RMS sigue en mock, así
// que cuando haya credenciales habrá que confirmar qué agrupa realmente.

import { connectorMode } from '../../config/env.js';
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
  'Mantenimiento de red',
  'Daño físico',
  'Pico de tráfico',
];

const DESCRIPTIONS = [
  'Generador entró en línea y se restituyó el servicio.',
  'Se detectó atenuación en troncal — cuadrilla en sitio.',
  'Corte por trabajo planificado de la empresa eléctrica.',
  'Reemplazo de splitter y limpieza de conectores.',
  'Reset general de la red y validación post-mantenimiento.',
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
  // Override propio (CONNECTOR_MODE_RMS): el real es un esqueleto y un
  // `CONNECTOR_MODE=real` global lo dejaría devolviendo 502.
  const mode = connectorMode('rms');
  switch (mode) {
    case 'mock':
      return rmsMock;
    case 'real':
      return rmsReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${mode}`);
  }
}
