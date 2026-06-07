import { useRef } from 'react';
import { Spinner } from '../ui/Spinner';
import { ErrorMessage, EmptyState } from '../ui/ErrorMessage';
import { QueueRow } from './QueueRow';
import { Button } from '../ui/Button';
import type { Paginated, AssistanceSession } from '../../types/assistance';

interface QueueTableProps {
  data: Paginated<AssistanceSession> | undefined;
  isLoading: boolean;
  error: unknown;
  page: number;
  onPageChange: (page: number) => void;
  newIds: Set<string>;
}

export function QueueTable({
  data,
  isLoading,
  error,
  page,
  onPageChange,
  newIds,
}: QueueTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);

  if (isLoading) {
    return (
      <div className="py-16 flex justify-center">
        <Spinner label="Cargando cola de solicitudes..." />
      </div>
    );
  }

  if (error) {
    return <ErrorMessage error={error} fallback="Error al cargar la cola de solicitudes." />;
  }

  if (!data || data.items.length === 0) {
    return <EmptyState message="No hay solicitudes en este momento." />;
  }

  const totalPages = Math.ceil(data.total / data.pageSize);

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table
          ref={tableRef}
          className="min-w-full"
          aria-label="Cola de solicitudes de asistencia"
          aria-rowcount={data.total}
        >
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Cuenta
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Motivo
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Estado
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Tiempo
              </th>
              <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Acción
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((session) => (
              <QueueRow
                key={session.id}
                session={session}
                isNew={newIds.has(session.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div
          className="flex items-center justify-between mt-4 text-sm text-gray-600"
          aria-label="Paginación"
        >
          <span>
            Mostrando {(page - 1) * data.pageSize + 1}–
            {Math.min(page * data.pageSize, data.total)} de {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              aria-label="Página anterior"
            >
              Anterior
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              aria-label="Página siguiente"
            >
              Siguiente
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
