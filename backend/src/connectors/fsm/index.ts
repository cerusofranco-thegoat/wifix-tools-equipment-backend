// Conector hacia FSM — campos 15 (tareas insatisfactorias) y 16 (visitas).

import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error-handler.js';
import { seededRng, notImplemented } from '../_shared.js';

export type TaskResult = 'SATISFACTORIA' | 'INSATISFACTORIA' | 'PENDIENTE';

export interface ClosedTask {
  taskId: string;
  occurredAt: string;
  reason: string;
  closingNotes: string;
  technician: string;
  result: TaskResult;
}

export interface FsmConnector {
  getUnsatisfactoryTasks(accountNumber: string): Promise<ClosedTask[]>;
  getPreviousVisits(accountNumber: string): Promise<ClosedTask[]>;
}

const REASONS = [
  'Sin servicio',
  'Lentitud de navegación',
  'No carga el plan contratado',
  'WiFi débil en habitaciones',
  'Cambio de equipo solicitado',
  'Reconfiguración de red',
  'Instalación inicial',
  'Mantenimiento preventivo',
];

const CLOSING_NOTES = [
  'Cliente reporta intermitencia, se reinició ONT.',
  'Se cambió cable de patch y mejoró señal.',
  'Configuración de SSID y contraseña aplicada.',
  'Equipo retirado por daño físico.',
  'Cliente no se encontraba en sitio, se reprogramó.',
  'Sin novedades, servicio operando con normalidad.',
  'Se elevó a soporte nivel 2 — pendiente seguimiento.',
];

const TECHNICIANS = [
  'Andrés Cevallos',
  'Pamela Yépez',
  'Marco Pinto',
  'Lorena Castillo',
  'Iván Ramírez',
];

function buildTask(seedKey: string, alwaysUnsatisfactory: boolean): ClosedTask {
  const rng = seededRng(seedKey);
  const monthsAgo = rng.intBetween(0, 8);
  const daysOffset = rng.intBetween(0, 27);
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  d.setDate(d.getDate() - daysOffset);
  d.setHours(rng.intBetween(8, 18), rng.intBetween(0, 59), 0, 0);
  const result: TaskResult = alwaysUnsatisfactory
    ? 'INSATISFACTORIA'
    : rng.pick(['SATISFACTORIA', 'SATISFACTORIA', 'PENDIENTE'] as const);
  return {
    taskId: `TASK/${rng.intBetween(100000, 999999)}/${d.getFullYear()}`,
    occurredAt: d.toISOString(),
    reason: rng.pick(REASONS),
    closingNotes: rng.pick(CLOSING_NOTES),
    technician: rng.pick(TECHNICIANS),
    result,
  };
}

export const fsmMock: FsmConnector = {
  async getUnsatisfactoryTasks(accountNumber) {
    const rng = seededRng(`fsm:unsat:${accountNumber}`);
    const n = rng.intBetween(0, 3);
    const tasks: ClosedTask[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(buildTask(`fsm:unsat:${accountNumber}:${i}`, true));
    }
    return tasks.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },

  async getPreviousVisits(accountNumber) {
    const rng = seededRng(`fsm:visits:${accountNumber}`);
    const n = rng.intBetween(1, 5);
    const tasks: ClosedTask[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(buildTask(`fsm:visits:${accountNumber}:${i}`, false));
    }
    return tasks.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  },
};

export const fsmReal: FsmConnector = {
  async getUnsatisfactoryTasks(_accountNumber) {
    notImplemented('fsm.getUnsatisfactoryTasks');
  },
  async getPreviousVisits(_accountNumber) {
    notImplemented('fsm.getPreviousVisits');
  },
};

export function getFsmConnector(): FsmConnector {
  switch (env.CONNECTOR_MODE) {
    case 'mock':
      return fsmMock;
    case 'real':
      return fsmReal;
    default:
      throw ApiError.connectorError(`CONNECTOR_MODE desconocido: ${env.CONNECTOR_MODE}`);
  }
}
