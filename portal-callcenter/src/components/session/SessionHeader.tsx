import { useState, useRef, useCallback, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { changeStatus, type ChangeStatusBody } from '../../lib/api/assistance';
import { useAuthStore } from '../../stores/auth.store';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { ApiError } from '../../lib/api/client';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { AssistanceSession, AssistanceStatus } from '../../types/assistance';

type TransitionStatus = 'ACTIVE' | 'ON_HOLD' | 'RESOLVED' | 'UNRESOLVED' | 'CANCELLED';

const TRANSITIONS: Record<AssistanceStatus, TransitionStatus[]> = {
  ASSIGNED: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['ON_HOLD', 'RESOLVED', 'UNRESOLVED', 'CANCELLED'],
  ON_HOLD: ['ACTIVE', 'CANCELLED'],
  REQUESTED: ['CANCELLED'],
  QUEUED: ['CANCELLED'],
  RESOLVED: [],
  UNRESOLVED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const TRANSITION_LABELS: Record<TransitionStatus, string> = {
  ACTIVE: 'Activar',
  ON_HOLD: 'Pausar',
  RESOLVED: 'Marcar resuelta',
  UNRESOLVED: 'Marcar sin resolver',
  CANCELLED: 'Cancelar',
};

const TRANSITION_VARIANTS: Record<
  TransitionStatus,
  'primary' | 'secondary' | 'danger'
> = {
  ACTIVE: 'primary',
  ON_HOLD: 'secondary',
  RESOLVED: 'primary',
  UNRESOLVED: 'secondary',
  CANCELLED: 'danger',
};

const REQUIRES_NOTE: TransitionStatus[] = ['RESOLVED', 'UNRESOLVED', 'CANCELLED'];

interface SessionHeaderProps {
  session: AssistanceSession;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-EC', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function SessionHeader({ session }: SessionHeaderProps) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [noteModal, setNoteModal] = useState<TransitionStatus | null>(null);
  const [noteText, setNoteText] = useState('');
  const modalRef = useRef<HTMLDivElement>(null);

  const isAgent = user?.role === 'AGENT';
  const isSupervisor = user?.role === 'SUPERVISOR';
  const isAssigned = session.agentId === user?.id;
  const canTransition = isAssigned || isSupervisor;

  const transitions = TRANSITIONS[session.status] ?? [];

  const mutation = useMutation({
    mutationFn: (body: ChangeStatusBody) => changeStatus(session.id, body),
    onSuccess: () => {
      setNoteModal(null);
      setNoteText('');
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
      queryClient.invalidateQueries({ queryKey: ['events', session.id] });
      toast('Estado actualizado.', 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast('Transición no permitida en el estado actual.', 'warning');
      } else if (err instanceof ApiError && err.status === 400) {
        toast(err.message, 'warning');
      } else {
        toast('Error al cambiar el estado.', 'error');
      }
    },
  });

  const closeModal = useCallback(() => {
    setNoteModal(null);
    setNoteText('');
  }, []);

  useFocusTrap(modalRef, {
    active: noteModal !== null,
    onEscape: closeModal,
  });

  function handleTransition(status: TransitionStatus) {
    if (REQUIRES_NOTE.includes(status)) {
      setNoteModal(status);
    } else {
      mutation.mutate({ status });
    }
  }

  function handleNoteSubmit(e: FormEvent) {
    e.preventDefault();
    if (!noteModal) return;
    mutation.mutate({ status: noteModal, note: noteText.trim() || undefined });
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      {/* Primera fila: cuenta y estado */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Número de cuenta</p>
          <p className="text-2xl font-bold text-gray-900 font-mono">{session.accountNumber}</p>
        </div>
        <StatusBadge
          status={session.status}
          pulse={session.status === 'ACTIVE' || session.status === 'QUEUED'}
        />
      </div>

      {/* Datos de la sesión */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-gray-400 text-xs">Solicitada</p>
          <p className="text-gray-700">{formatDate(session.requestedAt)}</p>
        </div>
        {session.reason && (
          <div className="col-span-2 sm:col-span-1">
            <p className="text-gray-400 text-xs">Motivo</p>
            <p className="text-gray-700">{session.reason}</p>
          </div>
        )}
        {session.consentAt && (
          <div>
            <p className="text-gray-400 text-xs">Consentimiento</p>
            <p className="text-green-700">Otorgado</p>
          </div>
        )}
        {session.agentId && (
          <div>
            <p className="text-gray-400 text-xs">Agente asignado</p>
            <p className="text-gray-700 font-mono text-xs">{session.agentId}</p>
          </div>
        )}
        {session.resolutionNote && (
          <div className="col-span-full">
            <p className="text-gray-400 text-xs">Nota de resolución</p>
            <p className="text-gray-700">{session.resolutionNote}</p>
          </div>
        )}
      </div>

      {/* Botones de transición */}
      {canTransition && transitions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-100">
          {transitions.map((status) => (
            <Button
              key={status}
              variant={TRANSITION_VARIANTS[status]}
              size="sm"
              onClick={() => handleTransition(status)}
              loading={mutation.isPending && noteModal === status}
              disabled={mutation.isPending}
              aria-label={`${TRANSITION_LABELS[status]} la sesión`}
            >
              {TRANSITION_LABELS[status]}
            </Button>
          ))}
        </div>
      )}

      {/* Solo lectura para SUPERVISOR sin asignación directa */}
      {isSupervisor && !isAssigned && (
        <p className="text-xs text-gray-400 italic">
          Modo observación — puedes cambiar estados como supervisor.
        </p>
      )}

      {/* Modal de nota para transiciones que la requieren */}
      {noteModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="note-modal-title"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
        >
          <div ref={modalRef} className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <h2 id="note-modal-title" className="font-semibold text-gray-900">
              {TRANSITION_LABELS[noteModal]} — nota requerida
            </h2>
            <form
              onSubmit={(e) => { void handleNoteSubmit(e); }}
              className="space-y-3"
            >
              <div>
                <label htmlFor="transition-note" className="sr-only">
                  Nota de resolución
                </label>
                <textarea
                  id="transition-note"
                  rows={4}
                  required
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="Describe el resultado o motivo..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                             placeholder-gray-400 focus:border-blue-500 focus:outline-none
                             focus:ring-2 focus:ring-blue-500/20 resize-none"
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={closeModal}
                  disabled={mutation.isPending}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant={TRANSITION_VARIANTS[noteModal]}
                  size="sm"
                  loading={mutation.isPending}
                  disabled={!noteText.trim()}
                >
                  Confirmar
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Advertencia solo-lectura para AGENT no asignado */}
      {isAgent && !isAssigned && !isSupervisor && (
        <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-1.5">
          No eres el agente asignado a esta sesión.
        </p>
      )}
    </div>
  );
}
