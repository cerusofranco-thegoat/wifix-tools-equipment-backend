import { useState, type FormEvent } from 'react';
import { useActions } from '../../hooks/useActions';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { toast } from '../ui/Toast';
import { ApiError } from '../../lib/api/client';
import clsx from 'clsx';
import type { RemoteAction, RemoteActionType, AssistanceStatus } from '../../types/assistance';
import type { RequestActionBody } from '../../lib/api/assistance';

function FailedActionCard({ action: a }: { action: RemoteAction }) {
  const msg =
    a.result && typeof a.result['message'] === 'string'
      ? (a.result['message'] as string)
      : null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
      <span className="font-semibold text-red-700">{ACTION_LABELS[a.action]}</span>
      {msg && <p className="text-red-600 text-xs mt-0.5">{msg}</p>}
    </div>
  );
}

const ACTION_LABELS: Record<RemoteActionType, string> = {
  REBOOT: 'Reiniciar equipo',
  SET_WIFI: 'Configurar WiFi',
  SET_CHANNEL: 'Cambiar canal',
  FACTORY_RESET: 'Restaurar fábrica',
  REPROVISION: 'Reaprovisionar',
  RUN_DIAGNOSTIC: 'Diagnóstico',
};

interface AcsActionsPanelProps {
  sessionId: string;
  sessionStatus: AssistanceStatus;
}

function ActionForm({
  actionType,
  onSubmit,
  onCancel,
  loading,
}: {
  actionType: RemoteActionType;
  onSubmit: (body: RequestActionBody) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const [band, setBand] = useState<'2.4GHz' | '5GHz'>('2.4GHz');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [channel, setChannel] = useState(6);
  const [target, setTarget] = useState('8.8.8.8');
  const [kind, setKind] = useState<'ping' | 'traceroute'>('ping');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    let body: RequestActionBody;
    switch (actionType) {
      case 'SET_WIFI':
        body = { action: 'SET_WIFI', params: { ssid, password, band } };
        break;
      case 'SET_CHANNEL':
        body = { action: 'SET_CHANNEL', params: { band, channel } };
        break;
      case 'RUN_DIAGNOSTIC':
        body = { action: 'RUN_DIAGNOSTIC', params: { target, kind } };
        break;
      default:
        body = { action: actionType, params: {} };
    }
    onSubmit(body);
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-3 mt-2">
      {actionType === 'SET_WIFI' && (
        <>
          <div>
            <label htmlFor="wifi-ssid" className="block text-xs text-gray-600 mb-1">SSID</label>
            <input id="wifi-ssid" type="text" required value={ssid} onChange={(e) => setSsid(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label htmlFor="wifi-password" className="block text-xs text-gray-600 mb-1">Contraseña</label>
            <input id="wifi-password" type="text" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label htmlFor="wifi-band" className="block text-xs text-gray-600 mb-1">Banda</label>
            <select id="wifi-band" value={band} onChange={(e) => setBand(e.target.value as '2.4GHz' | '5GHz')}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option>2.4GHz</option>
              <option>5GHz</option>
            </select>
          </div>
        </>
      )}
      {actionType === 'SET_CHANNEL' && (
        <>
          <div>
            <label htmlFor="ch-band" className="block text-xs text-gray-600 mb-1">Banda</label>
            <select id="ch-band" value={band} onChange={(e) => setBand(e.target.value as '2.4GHz' | '5GHz')}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option>2.4GHz</option>
              <option>5GHz</option>
            </select>
          </div>
          <div>
            <label htmlFor="ch-channel" className="block text-xs text-gray-600 mb-1">Canal</label>
            <input id="ch-channel" type="number" min={1} max={177} required value={channel}
              onChange={(e) => setChannel(Number(e.target.value))}
              className="w-24 rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
        </>
      )}
      {actionType === 'RUN_DIAGNOSTIC' && (
        <>
          <div>
            <label htmlFor="diag-target" className="block text-xs text-gray-600 mb-1">Destino</label>
            <input id="diag-target" type="text" required value={target} onChange={(e) => setTarget(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          </div>
          <div>
            <label htmlFor="diag-kind" className="block text-xs text-gray-600 mb-1">Tipo</label>
            <select id="diag-kind" value={kind} onChange={(e) => setKind(e.target.value as 'ping' | 'traceroute')}
              className="rounded border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
              <option value="ping">Ping</option>
              <option value="traceroute">Traceroute</option>
            </select>
          </div>
        </>
      )}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" loading={loading}>Ejecutar</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={loading}>Cancelar</Button>
      </div>
    </form>
  );
}

export function AcsActionsPanel({ sessionId, sessionStatus }: AcsActionsPanelProps) {
  const { query, mutation } = useActions(sessionId);
  const { pendingActions, resolvedActions } = useSessionStore();
  const [selected, setSelected] = useState<RemoteActionType | null>(null);

  const isActive = sessionStatus === 'ACTIVE';
  const actions: RemoteActionType[] = [
    'REBOOT', 'SET_WIFI', 'SET_CHANNEL', 'FACTORY_RESET', 'REPROVISION', 'RUN_DIAGNOSTIC',
  ];

  function handleSubmit(body: RequestActionBody) {
    mutation.mutate(body, {
      onSuccess: () => setSelected(null),
      onError: (err) => {
        if (err instanceof ApiError) toast(err.message, 'error');
        else toast('Error al ejecutar la acción.', 'error');
      },
    });
  }

  return (
    <div className="space-y-4">
      {/* Acciones disponibles */}
      {!isActive && (
        <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2">
          Las acciones ACS solo están disponibles cuando la sesión está activa.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {actions.map((action) => {
          const isPending = pendingActions.some((a) => a.action === action);
          return (
            <button
              key={action}
              onClick={() => setSelected(selected === action ? null : action)}
              disabled={!isActive}
              aria-pressed={selected === action}
              aria-label={ACTION_LABELS[action]}
              className={clsx(
                'rounded-lg border px-3 py-2.5 text-sm font-medium text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                selected === action
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50',
              )}
            >
              <span className="flex items-center gap-2">
                {isPending && (
                  <Spinner size="sm" label="Ejecutando..." />
                )}
                {ACTION_LABELS[action]}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <p className="text-sm font-medium text-blue-800 mb-2">{ACTION_LABELS[selected]}</p>
          <ActionForm
            actionType={selected}
            onSubmit={handleSubmit}
            onCancel={() => setSelected(null)}
            loading={mutation.isPending}
          />
        </div>
      )}

      {/* Acciones con FAILED — error persistente */}
      {resolvedActions.filter((a) => a.status === 'FAILED').length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-red-700">Acciones fallidas</p>
          {resolvedActions
            .filter((a) => a.status === 'FAILED')
            .map((a) => (
              <FailedActionCard key={a.id} action={a} />
            ))}
        </div>
      )}

      {/* Historial de acciones */}
      {query.data && query.data.items.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 mb-2">Historial de acciones</p>
          <div className="space-y-1">
            {query.data.items.map((action) => (
              <div
                key={action.id}
                className="flex items-center justify-between text-xs bg-gray-50 rounded px-3 py-2"
              >
                <span className="text-gray-700">{ACTION_LABELS[action.action]}</span>
                <span className={clsx('font-semibold',
                  action.status === 'SUCCESS' ? 'text-green-600' :
                  action.status === 'FAILED' ? 'text-red-600' : 'text-gray-400'
                )}>
                  {action.status === 'SUCCESS' ? 'Exitosa' :
                   action.status === 'FAILED' ? 'Fallida' : 'Pendiente'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {query.isLoading && <Spinner size="sm" label="Cargando historial..." />}
    </div>
  );
}
