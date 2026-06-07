import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { assignSession } from '../../lib/api/assistance';
import { useAuthStore } from '../../stores/auth.store';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { ApiError } from '../../lib/api/client';
import type { AssistanceSession } from '../../types/assistance';

interface QueueRowProps {
  session: AssistanceSession;
  isNew?: boolean;
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `hace ${hrs} h`;
}

export function QueueRow({ session, isNew = false }: QueueRowProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuthStore();
  const [justTaken, setJustTaken] = useState(false);

  const canAssign = user?.role === 'AGENT' && session.status === 'QUEUED';

  const mutation = useMutation({
    mutationFn: () => assignSession(session.id),
    onSuccess: () => {
      setJustTaken(true);
      queryClient.invalidateQueries({ queryKey: ['queue'] });
      navigate(`/sessions/${session.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast('La sesión ya fue tomada por otro agente.', 'warning');
        queryClient.invalidateQueries({ queryKey: ['queue'] });
      } else if (err instanceof ApiError) {
        toast(err.message, 'error');
      } else {
        toast('Error al tomar la sesión.', 'error');
      }
    },
  });

  return (
    <tr
      className={`border-b border-gray-100 transition-colors ${
        isNew ? 'bg-blue-50 animate-pulse-once' : 'hover:bg-gray-50'
      }`}
    >
      <td className="px-4 py-3 font-mono text-sm text-gray-900">{session.accountNumber}</td>
      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate">
        {session.reason ?? <span className="text-gray-400 italic">Sin motivo</span>}
      </td>
      <td className="px-4 py-3">
        <StatusBadge
          status={session.status}
          pulse={session.status === 'QUEUED' || session.status === 'ACTIVE'}
        />
      </td>
      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
        {formatRelative(session.requestedAt)}
      </td>
      <td className="px-4 py-3 text-right">
        {canAssign && !justTaken && (
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            aria-label={`Tomar sesión de la cuenta ${session.accountNumber}`}
          >
            Tomar
          </Button>
        )}
        {(session.status === 'ASSIGNED' || session.status === 'ACTIVE') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/sessions/${session.id}`)}
            aria-label={`Ver sesión de la cuenta ${session.accountNumber}`}
          >
            Ver
          </Button>
        )}
      </td>
    </tr>
  );
}
