import { create } from 'zustand';
import { assistanceSocket } from '../lib/ws/AssistanceSocket';
import type { AuthUser } from '../types/auth';

const TOKEN_KEY = 'wifix_token';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setAuth: (token: string, user: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  // Recuperar token de localStorage para sobrevivir recargas
  token: localStorage.getItem(TOKEN_KEY),
  user: (() => {
    const raw = localStorage.getItem('wifix_user');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      return null;
    }
  })(),

  setAuth: (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('wifix_user', JSON.stringify(user));
    assistanceSocket.connect(token);
    set({ token, user });
  },

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem('wifix_user');
    assistanceSocket.disconnect();
    set({ token: null, user: null });
  },
}));
