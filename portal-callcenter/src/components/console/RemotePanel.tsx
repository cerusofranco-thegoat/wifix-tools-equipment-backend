// Sesión remota — MVP Opción C (Fase E).
// No renderiza el HTML del router. Eje: apertura/cierre del túnel + ACS + estado en tiempo real.
// El iframe del proxy se incluye conforme al contrato (cookie httpOnly, sandbox requerido).

import { useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { openRemoteSession, closeRemoteSession } from '../../lib/api/assistance';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import { toast } from '../ui/Toast';
import { ApiError } from '../../lib/api/client';
import clsx from 'clsx';
import type { AssistanceSession } from '../../types/assistance';

interface RemotePanelProps {
  session: AssistanceSession;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    function update() {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) { setRemaining('Expirada'); return; }
      const mins = Math.floor(diff / 60_000);
      const secs = Math.floor((diff % 60_000) / 1_000);
      setRemaining(`${mins}:${String(secs).padStart(2, '0')}`);
    }
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return (
    <span
      aria-live="off"
      className={clsx(
        'font-mono text-sm font-bold',
        remaining === 'Expirada' ? 'text-red-600' :
        remaining.startsWith('0:') ? 'text-amber-600' : 'text-green-700',
      )}
    >
      {remaining}
    </span>
  );
}

export function RemotePanel({ session }: RemotePanelProps) {
  const queryClient = useQueryClient();
  const { remoteSession, peerPresence, clearRemoteSession } = useSessionStore();
  const [targetHost, setTargetHost] = useState('192.168.1.1');
  const [ttl, setTtl] = useState(600);
  const [showIframe, setShowIframe] = useState(false);

  const canOpen =
    session.status === 'ACTIVE' && session.consentAt !== null && !remoteSession;

  const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
  const proxyUrl = remoteSession
    ? `${API_BASE}/asistencia/v1/broker/proxy/${remoteSession.id}/`
    : '';

  const openMutation = useMutation({
    mutationFn: () =>
      openRemoteSession(session.id, {
        channel: 'BROKER_TUNNEL',
        targetHost: targetHost.trim(),
        ttlSeconds: ttl,
      }),
    onSuccess: (data) => {
      useSessionStore.getState().setRemoteSession(data.remoteSession, data.connect);
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
      toast('Sesión remota abierta.', 'success');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast('Ya hay una sesión remota abierta o la sesión no está activa.', 'warning');
      } else if (err instanceof ApiError) {
        toast(err.message, 'error');
      } else {
        toast('Error al abrir la sesión remota.', 'error');
      }
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => closeRemoteSession(remoteSession!.id),
    onSuccess: () => {
      clearRemoteSession();
      setShowIframe(false);
      queryClient.invalidateQueries({ queryKey: ['session', session.id] });
      toast('Sesión remota cerrada.', 'info');
    },
    onError: (err) => {
      if (err instanceof ApiError) toast(err.message, 'error');
      else toast('Error al cerrar la sesión remota.', 'error');
    },
  });

  function handleOpen(e: FormEvent) {
    e.preventDefault();
    openMutation.mutate();
  }

  const techPresence = remoteSession ? peerPresence[remoteSession.id] : undefined;
  const techOnline = techPresence?.online ?? false;

  // Banner de alcance
  const scopeBanner = (
    <div
      role="note"
      className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700"
    >
      <span className="font-semibold block mb-1">Fase E — Sesión remota controlada</span>
      La operación directa del panel del router (Opción A) estará disponible en la siguiente
      versión. Usa las <span className="font-semibold">Acciones ACS</span> para configurar
      el equipo remotamente.
    </div>
  );

  // Sin sesión activa: mostrar formulario de apertura
  if (!remoteSession || remoteSession.status !== 'OPEN') {
    return (
      <div className="space-y-4">
        {scopeBanner}

        {!canOpen && session.status === 'ACTIVE' && !session.consentAt && (
          <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2" role="alert">
            Se requiere el consentimiento del cliente antes de abrir la sesión remota.
          </p>
        )}

        {!canOpen && session.status !== 'ACTIVE' && (
          <p className="text-xs text-amber-600 bg-amber-50 rounded px-3 py-2" role="alert">
            La sesión debe estar activa para abrir el canal remoto.
          </p>
        )}

        <form
          onSubmit={(e) => { void handleOpen(e); }}
          className="space-y-3 bg-white rounded-xl border border-gray-200 p-5"
          aria-label="Abrir sesión remota"
        >
          <h3 className="font-semibold text-gray-900 text-sm">Nueva sesión remota</h3>

          <div>
            <label htmlFor="target-host" className="block text-xs font-medium text-gray-600 mb-1">
              IP del CPE (panel del router)
            </label>
            <input
              id="target-host"
              type="text"
              required
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
              placeholder="192.168.1.1"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono
                         placeholder-gray-400 focus:border-blue-500 focus:outline-none
                         focus:ring-2 focus:ring-blue-500/20"
              aria-required="true"
            />
          </div>

          <div>
            <label htmlFor="ttl-seconds" className="block text-xs font-medium text-gray-600 mb-1">
              TTL (segundos)
            </label>
            <input
              id="ttl-seconds"
              type="number"
              min={60}
              max={1800}
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              className="w-28 rounded-md border border-gray-300 px-3 py-2 text-sm
                         focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          {openMutation.error && (
            <ErrorMessage error={openMutation.error} />
          )}

          <Button
            type="submit"
            loading={openMutation.isPending}
            disabled={!canOpen}
            aria-label="Abrir sesión remota con el equipo del cliente"
          >
            Abrir sesión remota
          </Button>
        </form>
      </div>
    );
  }

  // Sesión remota abierta
  return (
    <div className="space-y-4">
      {scopeBanner}

      {/* Estado del túnel */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs text-gray-400">Canal remoto activo</p>
            <p className="font-mono text-sm font-bold text-gray-900 mt-0.5">
              {targetHost || remoteSession.id}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">Expira en</p>
            <Countdown expiresAt={remoteSession.expiresAt} />
          </div>
        </div>

        {/* Presencia del técnico */}
        <div className="flex items-center gap-2 text-sm">
          <span
            className={clsx('h-2.5 w-2.5 rounded-full', techOnline ? 'bg-green-500' : 'bg-gray-300')}
            aria-hidden="true"
          />
          <span className="text-gray-600">
            Técnico:{' '}
            <span className={clsx('font-medium', techOnline ? 'text-green-700' : 'text-gray-400')}>
              {techOnline ? 'Conectado' : 'Sin conexión'}
            </span>
          </span>
        </div>

        <div className="flex gap-2 flex-wrap">
          {/* Botón para mostrar/ocultar iframe del proxy */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowIframe((v) => !v)}
            disabled={!techOnline}
            aria-expanded={showIframe}
            aria-controls="router-proxy-iframe"
            aria-label={showIframe ? 'Ocultar panel del router' : 'Abrir panel del router'}
          >
            {showIframe ? 'Ocultar panel del router' : 'Abrir panel del router'}
          </Button>

          <Button
            variant="danger"
            size="sm"
            onClick={() => closeMutation.mutate()}
            loading={closeMutation.isPending}
            aria-label="Cerrar sesión remota"
          >
            Cerrar sesión remota
          </Button>
        </div>

        {closeMutation.error && (
          <ErrorMessage error={closeMutation.error} />
        )}
      </div>

      {/* CRÍTICO: iframe del proxy HTTP del broker.
          sandbox="allow-scripts allow-forms allow-same-origin" obligatorio (requisito de seguridad del backend).
          referrerpolicy="no-referrer" obligatorio.
          La cookie wifix_proxy_session se envía automáticamente por el navegador (httpOnly, SameSite=Strict).
      */}
      {showIframe && techOnline && (
        <div id="router-proxy-iframe" className="rounded-xl overflow-hidden border border-gray-300 bg-gray-100">
          <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500 flex-shrink-0" aria-hidden="true" />
            Panel del router — {proxyUrl}
          </div>
          <iframe
            src={proxyUrl}
            title="Panel de administración del router"
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            className="w-full bg-white"
            style={{ height: '500px', border: 'none' }}
          />
        </div>
      )}
    </div>
  );
}
