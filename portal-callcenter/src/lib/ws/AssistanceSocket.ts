// Singleton WebSocket de señalización.
// Reconexión con backoff exponencial, heartbeat periódico y re-suscripción automática.

import type { ClientMessage, ServerEvent } from '../../types/assistance';

type EventHandler = (event: ServerEvent) => void;

const WS_BASE = import.meta.env.VITE_WS_BASE_URL ?? 'ws://localhost:8080';
const WS_PATH = '/asistencia/v1/ws';
const HEARTBEAT_INTERVAL_MS = 45_000; // < 60s del servidor
const MAX_BACKOFF_MS = 30_000;

class AssistanceSocket {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private handlers = new Set<EventHandler>();

  // Suscripciones activas para re-enviar al reconectar
  private activeQueueSub = false;
  private activeSessionId: string | null = null;

  // ── API pública ─────────────────────────────────────────────────────────────

  connect(token: string): void {
    this.token = token;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  disconnect(): void {
    this.token = null;
    this.activeQueueSub = false;
    this.activeSessionId = null;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.onclose = null; // evitar reconexión al hacer logout
      this.ws.close(1000, 'Logout');
      this.ws = null;
    }
  }

  on(handler: EventHandler): void {
    this.handlers.add(handler);
  }

  off(handler: EventHandler): void {
    this.handlers.delete(handler);
  }

  subscribeQueue(): void {
    this.activeQueueSub = true;
    this.send({ type: 'SUBSCRIBE_QUEUE' });
  }

  joinSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.send({ type: 'JOIN_SESSION', sessionId });
  }

  leaveSession(): void {
    this.activeSessionId = null;
  }

  sendChat(sessionId: string, text: string): void {
    this.send({ type: 'CHAT_MESSAGE', sessionId, text });
  }

  sendHeartbeat(): void {
    this.send({ type: 'HEARTBEAT' });
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Internos ────────────────────────────────────────────────────────────────

  private openSocket(): void {
    if (!this.token) return;

    const url = `${WS_BASE}${WS_PATH}?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      // Re-suscribir suscripciones activas previas
      if (this.activeQueueSub) this.send({ type: 'SUBSCRIBE_QUEUE' });
      if (this.activeSessionId) this.send({ type: 'JOIN_SESSION', sessionId: this.activeSessionId });
    };

    ws.onmessage = (ev) => {
      this.handleMessage(ev.data as string);
    };

    ws.onerror = () => {
      // El evento 'close' se disparará inmediatamente después
    };

    ws.onclose = (ev) => {
      this.stopHeartbeat();
      this.ws = null;

      if (ev.code === 1008) {
        // JWT inválido o expirado → no reconectar, disparar logout
        window.dispatchEvent(new CustomEvent('wifix:unauthorized'));
        return;
      }
      if (ev.code === 1000) {
        // Cierre limpio (logout manual)
        return;
      }

      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      console.error('[WS] Mensaje no-JSON recibido:', raw);
      return;
    }
    this.handlers.forEach((h) => h(event));
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (!this.token) return;
    const delay = Math.min(1_000 * Math.pow(2, this.reconnectAttempts), MAX_BACKOFF_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// Singleton exportado
export const assistanceSocket = new AssistanceSocket();
