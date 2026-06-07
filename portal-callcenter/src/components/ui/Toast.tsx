/* eslint-disable react-refresh/only-export-components */
// Toast mínimo sin dependencias externas — estado global simple.
import { useEffect, useState, useCallback } from 'react';
import clsx from 'clsx';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastMessage {
  id: number;
  type: ToastType;
  message: string;
}

// Singleton de eventos de toast
const listeners = new Set<(msg: ToastMessage) => void>();
let counter = 0;

export function toast(message: string, type: ToastType = 'info') {
  const msg: ToastMessage = { id: ++counter, type, message };
  listeners.forEach((fn) => fn(msg));
}

const typeMap: Record<ToastType, string> = {
  success: 'bg-green-600 text-white',
  error: 'bg-red-600 text-white',
  warning: 'bg-amber-500 text-white',
  info: 'bg-blue-600 text-white',
};

const iconMap: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
};

export function ToastContainer() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const remove = useCallback((id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  useEffect(() => {
    const handler = (msg: ToastMessage) => {
      setMessages((prev) => [...prev.slice(-4), msg]); // máximo 5 toasts
      setTimeout(() => remove(msg.id), 5_000);
    };
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, [remove]);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full"
    >
      {messages.map((m) => (
        <div
          key={m.id}
          role="alert"
          className={clsx(
            'flex items-start gap-3 rounded-lg px-4 py-3 shadow-lg text-sm font-medium',
            typeMap[m.type],
          )}
        >
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold"
            aria-hidden="true"
          >
            {iconMap[m.type]}
          </span>
          <span className="flex-1">{m.message}</span>
          <button
            onClick={() => remove(m.id)}
            aria-label="Cerrar notificación"
            className="flex-shrink-0 text-white/70 hover:text-white transition-colors"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
