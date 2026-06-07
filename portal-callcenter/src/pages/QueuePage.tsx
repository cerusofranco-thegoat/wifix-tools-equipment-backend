import { useState, useRef } from 'react';
import { useQueue } from '../hooks/useQueue';
import { QueueTable } from '../components/queue/QueueTable';
import type { AssistanceStatus } from '../types/assistance';

const STATUS_OPTIONS: { value: '' | AssistanceStatus; label: string }[] = [
  { value: '', label: 'Todos los estados' },
  { value: 'QUEUED', label: 'En cola' },
  { value: 'ASSIGNED', label: 'Asignadas' },
  { value: 'ACTIVE', label: 'Activas' },
  { value: 'ON_HOLD', label: 'En pausa' },
  { value: 'RESOLVED', label: 'Resueltas' },
  { value: 'UNRESOLVED', label: 'Sin resolver' },
  { value: 'CANCELLED', label: 'Canceladas' },
];

export function QueuePage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<'' | AssistanceStatus>('');
  const [accountFilter, setAccountFilter] = useState('');
  const newIds = useRef(new Set<string>()).current;

  const params = {
    page,
    pageSize: 20,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(accountFilter.trim() ? { accountNumber: accountFilter.trim() } : {}),
  };

  const { data, isLoading, error } = useQueue(params);

  function handleFilterChange() {
    setPage(1);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Cola de solicitudes</h1>
        {data && (
          <p className="text-sm text-gray-500" aria-live="polite" aria-atomic="true">
            {data.total} solicitud{data.total !== 1 ? 'es' : ''} en total
          </p>
        )}
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <label htmlFor="account-filter" className="sr-only">
            Filtrar por número de cuenta
          </label>
          <input
            id="account-filter"
            type="text"
            placeholder="Buscar por número de cuenta..."
            value={accountFilter}
            onChange={(e) => {
              setAccountFilter(e.target.value);
              handleFilterChange();
            }}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                       placeholder-gray-400 focus:border-blue-500 focus:outline-none
                       focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
        <div>
          <label htmlFor="status-filter" className="sr-only">
            Filtrar por estado
          </label>
          <select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as '' | AssistanceStatus);
              handleFilterChange();
            }}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm
                       focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <QueueTable
        data={data}
        isLoading={isLoading}
        error={error}
        page={page}
        onPageChange={setPage}
        newIds={newIds}
      />
    </div>
  );
}
