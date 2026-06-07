/**
 * Máquina de estados de AssistanceSession.
 *
 * Única fuente de verdad de transiciones válidas.
 * No tiene efectos secundarios: solo valida y devuelve booleano.
 *
 * Transiciones según contrato §2:
 *   ASSIGNED  → ACTIVE
 *   ACTIVE    ⇄ ON_HOLD
 *   ACTIVE    → RESOLVED | UNRESOLVED
 *   {REQUESTED|QUEUED|ASSIGNED|ACTIVE|ON_HOLD} → CANCELLED
 *
 * EXPIRED lo setea el sistema por timeout (fuera de Fase B); no hay endpoint.
 */

import type { AssistanceStatus } from './assistance.mappers.js';

type ChangeableStatus = 'ACTIVE' | 'ON_HOLD' | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED';

/** Transiciones válidas: from → Set<to> */
const VALID_TRANSITIONS: Readonly<Record<AssistanceStatus, ReadonlyArray<ChangeableStatus>>> = {
  REQUESTED: ['CANCELLED'],
  QUEUED: ['CANCELLED'],
  ASSIGNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'RESOLVED', 'UNRESOLVED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  RESOLVED: [],
  UNRESOLVED: [],
  CANCELLED: [],
  EXPIRED: [],
};

/** Estados terminales que requieren nota obligatoria */
const REQUIRES_NOTE: ReadonlySet<ChangeableStatus> = new Set([
  'RESOLVED',
  'UNRESOLVED',
  'CANCELLED',
]);

/**
 * Valida si la transición `from → to` es permitida por la máquina de estados.
 * Devuelve `true` si es válida, `false` si es inválida.
 */
export function isValidTransition(from: AssistanceStatus, to: ChangeableStatus): boolean {
  return (VALID_TRANSITIONS[from] as ReadonlyArray<string>).includes(to);
}

/**
 * Devuelve `true` si el estado destino requiere nota obligatoria.
 */
export function requiresNote(to: ChangeableStatus): boolean {
  return REQUIRES_NOTE.has(to);
}

/**
 * Lista de estados terminales (no se puede transicionar desde ellos).
 */
export const TERMINAL_STATUSES: ReadonlySet<AssistanceStatus> = new Set([
  'RESOLVED',
  'UNRESOLVED',
  'CANCELLED',
  'EXPIRED',
]);
