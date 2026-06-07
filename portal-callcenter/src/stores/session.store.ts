import { create } from 'zustand';
import type { RemoteAction, RemoteSession, BrokerConnect, Role } from '../types/assistance';

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  at: string;
  own: boolean; // true si el mensaje es del agente actual
}

interface PeerPresence {
  role: Role;
  online: boolean;
}

interface SessionState {
  activeSessionId: string | null;
  remoteSession: RemoteSession | null;
  brokerConnect: BrokerConnect | null;
  pendingActions: RemoteAction[];
  resolvedActions: RemoteAction[];
  chatMessages: ChatMessage[];
  peerPresence: Record<string, PeerPresence>;

  setActiveSession: (id: string | null) => void;
  setRemoteSession: (rs: RemoteSession, connect?: BrokerConnect) => void;
  clearRemoteSession: () => void;
  addPendingAction: (action: RemoteAction) => void;
  resolveAction: (action: RemoteAction) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setPeerPresence: (sessionId: string, role: Role, online: boolean) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  activeSessionId: null,
  remoteSession: null,
  brokerConnect: null,
  pendingActions: [],
  resolvedActions: [],
  chatMessages: [],
  peerPresence: {},

  setActiveSession: (id) => set({ activeSessionId: id }),

  setRemoteSession: (rs, connect) =>
    set({ remoteSession: rs, brokerConnect: connect ?? null }),

  clearRemoteSession: () => set({ remoteSession: null, brokerConnect: null }),

  addPendingAction: (action) =>
    set((s) => ({ pendingActions: [...s.pendingActions, action] })),

  resolveAction: (action) =>
    set((s) => ({
      pendingActions: s.pendingActions.filter((a) => a.id !== action.id),
      resolvedActions: [action, ...s.resolvedActions],
    })),

  addChatMessage: (msg) =>
    set((s) => ({ chatMessages: [...s.chatMessages, msg] })),

  setPeerPresence: (sessionId, role, online) =>
    set((s) => ({
      peerPresence: { ...s.peerPresence, [sessionId]: { role, online } },
    })),

  clearSession: () =>
    set({
      activeSessionId: null,
      remoteSession: null,
      brokerConnect: null,
      pendingActions: [],
      resolvedActions: [],
      chatMessages: [],
      peerPresence: {},
    }),
}));
