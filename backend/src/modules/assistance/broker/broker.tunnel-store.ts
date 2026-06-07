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
 *
 * ---------------------------------------------------------------------------
 * LIMITACIÓN MULTI-INSTANCIA — sticky routing requerido (ADR-0008)
 * ---------------------------------------------------------------------------
 * Este store NO puede ir a Redis ni a ningún almacén externo porque los
 * WebSockets (socket: WebSocket) son objetos vivos ligados al proceso.
 * Un socket abierto en la instancia A no puede ser serializado ni transferido
 * a la instancia B.
 *
 * En un despliegue multi-instancia (varias réplicas detrás de un balanceador),
 * el túnel del técnico vive en UNA instancia específica. Si el request del
 * proxy HTTP del agente cae en UNA INSTANCIA DISTINTA, el lookup de este
 * store devolverá undefined aunque el técnico esté conectado — la sesión
 * parecerá "sin túnel" desde esa instancia.
 *
 * Soluciones posibles (ninguna implementada aún — ver ADR-0008):
 *   1. **Sticky routing en el balanceador**: afinidad por sessionId garantiza
 *      que todas las requests de una sesión llegan a la instancia que tiene el
 *      túnel. Es la solución más sencilla (configuración de nginx/Traefik/HAProxy).
 *   2. **Pub/sub entre instancias**: la instancia receptora del proxy publica
 *      la trama en un canal Redis; la instancia con el túnel se suscribe y la
 *      reenvía al técnico. Más complejo pero sin necesidad de sticky routing.
 *
 * El adaptador Redis introducido en ADR-0008 resuelve la **atomicidad de tokens
 * y cookies de proxy** (instancias múltiples pueden verificar/invalidar sin
 * condición de carrera). La **afinidad del túnel** queda pendiente hasta que
 * se implemente sticky routing o pub/sub.
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
