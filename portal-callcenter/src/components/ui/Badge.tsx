import clsx from 'clsx';
import type { AssistanceStatus } from '../../types/assistance';

const statusConfig: Record<
  AssistanceStatus,
  { label: string; className: string }
> = {
  REQUESTED: { label: 'Solicitada', className: 'bg-gray-100 text-gray-700' },
  QUEUED: { label: 'En cola', className: 'bg-yellow-100 text-yellow-800' },
  ASSIGNED: { label: 'Asignada', className: 'bg-blue-100 text-blue-800' },
  ACTIVE: { label: 'Activa', className: 'bg-green-100 text-green-800' },
  ON_HOLD: { label: 'En pausa', className: 'bg-orange-100 text-orange-800' },
  RESOLVED: { label: 'Resuelta', className: 'bg-emerald-100 text-emerald-800' },
  UNRESOLVED: { label: 'Sin resolver', className: 'bg-red-100 text-red-800' },
  CANCELLED: { label: 'Cancelada', className: 'bg-gray-100 text-gray-500' },
  EXPIRED: { label: 'Expirada', className: 'bg-gray-100 text-gray-400' },
};

interface StatusBadgeProps {
  status: AssistanceStatus;
  pulse?: boolean;
}

export function StatusBadge({ status, pulse = false }: StatusBadgeProps) {
  const config = statusConfig[status];
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        config.className,
      )}
    >
      {pulse && (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-current" />
        </span>
      )}
      {config.label}
    </span>
  );
}
