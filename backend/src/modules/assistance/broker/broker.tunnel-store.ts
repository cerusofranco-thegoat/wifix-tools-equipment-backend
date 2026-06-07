/**
 * Store en memoria de túneles activos del técnico.
 *
 * Cuando el técnico envía REGISTER_TECHNICIAN por el WS de señalización,
 * el broker lo asocia a la sesión. Si el técnico tiene un túnel WSS abierto
 * en el broker (conexión separada al endpoint /asistencia/v1/broker/tunnel),
 * ese socket se registra aquí indexado por sessionId.
 *
 * El agente, al conectarse al broker con su sessionToken, busca el túnel
 * correspondiente a su sessionId y usa ese socket para enviar tramas al técnico.
 *
 * Módulo sin I/O → testeable sin BD.
 */

import type { WebSocket } from '@fastify/websocket';

export interface TunnelEntry {
  sessionId: string;
  technicianId: string;
  socket: WebSocket;
  registeredAt: number; // epoch ms
}

const tunnelStore = new Map<string, TunnelEntry>();

// ---------------------------------------------------------------------------
// Registro y baja
// ---------------------------------------------------------------------------

/** Registra el túnel WSS del técnico para una sesión. Reemplaza si ya existía. */
export function registerTunnel(entry: TunnelEntry): void {
  tunnelStore.set(entry.sessionId, entry);
}

/** Elimina el túnel de una sesión (cuando el técnico desconecta). */
export function removeTunnel(sessionId: string): void {
  tunnelStore.delete(sessionId);
}

/** Devuelve el túnel activo de una sesión, o undefined si no existe. */
export function getTunnel(sessionId: string): TunnelEntry | undefined {
  return tunnelStore.get(sessionId);
}

/** True si hay un túnel activo para la sesión y el socket está abierto. */
export function isTunnelAlive(sessionId: string): boolean {
  const entry = tunnelStore.get(sessionId);
  if (!entry) return false;
  return entry.socket.readyState === 1; // 1 = OPEN
}

/** Devuelve el número de túneles activos (para tests/observabilidad). */
export function tunnelCount(): number {
  return tunnelStore.size;
}

/** Limpia todo el store (solo para tests). */
export function clearTunnelStore(): void {
  tunnelStore.clear();
}
