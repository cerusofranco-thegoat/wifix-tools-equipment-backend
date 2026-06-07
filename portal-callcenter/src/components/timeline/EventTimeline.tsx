import { useState, type FormEvent } from 'react';
import { useEvents } from '../../hooks/useEvents';
import { useSessionStore } from '../../stores/session.store';
import { useAuthStore } from '../../stores/auth.store';
import { assistanceSocket } from '../../lib/ws/AssistanceSocket';
import { Spinner } from '../ui/Spinner';
import { ErrorMessage } from '../ui/ErrorMessage';
import { Button } from '../ui/Button';
import clsx from 'clsx';
import type { AssistanceEvent, AssistanceEventType } from '../../types/assistance';

const EVENT_ICONS: Record<AssistanceEventType, string> = {
  STATE_CHANGE: '→',
  NOTE: '📝',
  ACTION: '⚡',
  REMOTE_SESSION: '🔌',
  CHAT: '💬',
  CONSENT: '✓',
};

const EVENT_COLORS: Record<AssistanceEventType, string> = {
  STATE_CHANGE: 'bg-blue-100 text-blue-700',
  NOTE: 'bg-gray-100 text-gray-600',
  ACTION: 'bg-purple-100 text-purple-700',
  REMOTE_SESSION: 'bg-orange-100 text-orange-700',
  CHAT: 'bg-green-100 text-green-700',
  CONSENT: 'bg-emerald-100 text-emerald-700',
};

const EVENT_LABELS: Record<AssistanceEventType, string> = {
  STATE_CHANGE: 'Cambio de estado',
  NOTE: 'Nota',
  ACTION: 'Acción ACS',
  REMOTE_SESSION: 'Sesión remota',
  CHAT: 'Chat',
  CONSENT: 'Consentimiento',
};

function formatPayload(event: AssistanceEvent): string {
  if (!event.payload) return '';
  if (event.type === 'STATE_CHANGE') {
    const from = event.payload['from'] as string | undefined;
    const to = event.payload['to'] as string | undefined;
    return from && to ? `${from} → ${to}` : JSON.stringify(event.payload);
  }
  if (event.type === 'NOTE') {
    const note = event.payload['note'] as string | undefined;
    return note ?? '';
  }
  if (event.type === 'CHAT') {
    const text = event.payload['text'] as string | undefined;
    return text ?? '';
  }
  if (event.type === 'ACTION') {
    const action = event.payload['action'] as string | undefined;
    const status = event.payload['status'] as string | undefined;
    return [action, status].filter(Boolean).join(' — ');
  }
  return JSON.stringify(event.payload);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('es-EC', { dateStyle: 'short', timeStyle: 'short' });
}

interface EventTimelineProps {
  sessionId: string;
}

export function EventTimeline({ sessionId }: EventTimelineProps) {
  const [page, setPage] = useState(1);
  const [chatText, setChatText] = useState('');
  const { data, isLoading, error } = useEvents(sessionId, page);
  const { chatMessages } = useSessionStore();
  const { user } = useAuthStore();

  function handleSendChat(e: FormEvent) {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    assistanceSocket.sendChat(sessionId, text);
    // Agregar el mensaje propio al store optimistamente
    useSessionStore.getState().addChatMessage({
      id: `own-${Date.now()}`,
      from: user?.name ?? 'Agente',
      text,
      at: new Date().toISOString(),
      own: true,
    });
    setChatText('');
  }

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;

  return (
    <div className="space-y-5">
      {/* Chat en tiempo real */}
      <section aria-labelledby="chat-heading" className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <h2 id="chat-heading" className="text-sm font-semibold text-gray-900">Chat con el técnico</h2>

        {chatMessages.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-4">
            Aún no hay mensajes en esta sesión.
          </p>
        ) : (
          <div
            className="space-y-2 max-h-48 overflow-y-auto"
            aria-live="polite"
            aria-label="Mensajes del chat"
          >
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={clsx('flex', msg.own ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={clsx(
                    'rounded-lg px-3 py-2 text-sm max-w-xs',
                    msg.own
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-800',
                  )}
                >
                  {!msg.own && (
                    <p className="text-xs font-semibold mb-0.5 opacity-70">{msg.from}</p>
                  )}
                  <p>{msg.text}</p>
                  <p className={clsx('text-xs mt-0.5 opacity-60')}>
                    {formatTime(msg.at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(e) => { void handleSendChat(e); }}
          className="flex gap-2"
          aria-label="Enviar mensaje al técnico"
        >
          <label htmlFor="chat-input" className="sr-only">Mensaje</label>
          <input
            id="chat-input"
            type="text"
            value={chatText}
            onChange={(e) => setChatText(e.target.value)}
            placeholder="Escribe un mensaje..."
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm
                       placeholder-gray-400 focus:border-blue-500 focus:outline-none
                       focus:ring-2 focus:ring-blue-500/20"
          />
          <Button type="submit" size="sm" disabled={!chatText.trim()} aria-label="Enviar mensaje">
            Enviar
          </Button>
        </form>
      </section>

      {/* Timeline de auditoría */}
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading" className="text-sm font-semibold text-gray-900 mb-3">
          Historial de la sesión
        </h2>

        {isLoading && (
          <div className="py-8 flex justify-center">
            <Spinner label="Cargando historial..." />
          </div>
        )}

        {error && <ErrorMessage error={error} fallback="Error al cargar el historial." />}

        {data && data.items.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No hay eventos aún.</p>
        )}

        {data && data.items.length > 0 && (
          <ol className="relative border-l border-gray-200 ml-3 space-y-4" aria-label="Historial cronológico">
            {data.items.map((event) => (
              <li key={event.id} className="ml-6">
                <span
                  className={clsx(
                    'absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full text-xs',
                    EVENT_COLORS[event.type],
                  )}
                  aria-hidden="true"
                >
                  {EVENT_ICONS[event.type]}
                </span>
                <div className="bg-white rounded-lg border border-gray-100 px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-gray-700">
                      {EVENT_LABELS[event.type]}
                    </span>
                    <time
                      dateTime={event.createdAt}
                      className="text-xs text-gray-400 whitespace-nowrap"
                    >
                      {formatTime(event.createdAt)}
                    </time>
                  </div>
                  {formatPayload(event) && (
                    <p className="text-sm text-gray-600 mt-1">{formatPayload(event)}</p>
                  )}
                  {event.actorId && (
                    <p className="text-xs text-gray-400 mt-0.5 font-mono">{event.actorId}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {totalPages > 1 && (
          <div className="flex gap-2 justify-center mt-4">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Ver eventos anteriores"
            >
              Anteriores
            </Button>
            <span className="text-sm text-gray-500 self-center">
              Pág. {page} de {totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Ver eventos siguientes"
            >
              Siguientes
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
