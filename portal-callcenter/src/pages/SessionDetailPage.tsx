import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import { useSessionStore } from '../stores/session.store';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { SessionHeader } from '../components/session/SessionHeader';
import { NoteForm } from '../components/session/NoteForm';
import { StudyPanel } from '../components/study/StudyPanel';
import { VideoPanel } from '../components/console/VideoPanel';
import { AcsActionsPanel } from '../components/console/AcsActionsPanel';
import { RemotePanel } from '../components/console/RemotePanel';
import { EventTimeline } from '../components/timeline/EventTimeline';
import { Spinner } from '../components/ui/Spinner';
import { ErrorMessage } from '../components/ui/ErrorMessage';
import { Button } from '../components/ui/Button';
import clsx from 'clsx';

type Tab = 'study' | 'console' | 'timeline';

const TABS: { id: Tab; label: string }[] = [
  { id: 'study', label: 'Estudio WiFi' },
  { id: 'console', label: 'Consola en vivo' },
  { id: 'timeline', label: 'Historial' },
];

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setActiveSession, clearSession } = useSessionStore();

  const sessionId = id ?? '';
  const activeTab = (searchParams.get('tab') as Tab | null) ?? 'study';
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { data, isLoading, error } = useSession(sessionId);

  useEffect(() => {
    setActiveSession(sessionId);
    return () => clearSession();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  function setTab(tab: Tab) {
    setSearchParams({ tab }, { replace: true });
  }

  function handleTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = tabRefs.current[(idx + 1) % TABS.length];
      next?.focus();
      setTab(TABS[(idx + 1) % TABS.length]!.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = tabRefs.current[(idx - 1 + TABS.length) % TABS.length];
      prev?.focus();
      setTab(TABS[(idx - 1 + TABS.length) % TABS.length]!.id);
    }
  }

  if (!sessionId) {
    return <ErrorMessage error={null} fallback="ID de sesión no válido." />;
  }

  if (isLoading) {
    return (
      <div className="py-16 flex justify-center">
        <Spinner label="Cargando sesión..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorMessage error={error} fallback="Error al cargar la sesión." />
        <Button variant="ghost" size="sm" onClick={() => navigate('/queue')}>
          Volver a la cola
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const { session } = data;

  return (
    <div className="space-y-5">
      {/* Encabezado + notas */}
      <SessionHeader session={session} />

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <NoteForm sessionId={sessionId} />
      </div>

      {/* Tabs */}
      <div>
        <div
          role="tablist"
          aria-label="Secciones de la sesión"
          className="flex border-b border-gray-200"
        >
          {TABS.map((tab, idx) => (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[idx] = el; }}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-t',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Panel de estudio */}
        <div
          role="tabpanel"
          id="panel-study"
          aria-labelledby="tab-study"
          hidden={activeTab !== 'study'}
          className="pt-5"
        >
          {activeTab === 'study' && <StudyPanel sessionId={sessionId} />}
        </div>

        {/* Panel consola */}
        <div
          role="tabpanel"
          id="panel-console"
          aria-labelledby="tab-console"
          hidden={activeTab !== 'console'}
          className="pt-5"
        >
          {activeTab === 'console' && (
            <div className="space-y-6">
              {/* Video */}
              <section aria-labelledby="video-section-heading" className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 id="video-section-heading" className="text-sm font-semibold text-gray-900 mb-4">
                  Video
                </h2>
                <VideoPanel sessionId={sessionId} sessionStatus={session.status} />
              </section>

              {/* ACS */}
              <section aria-labelledby="acs-section-heading" className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 id="acs-section-heading" className="text-sm font-semibold text-gray-900 mb-4">
                  Acciones ACS
                </h2>
                <AcsActionsPanel sessionId={sessionId} sessionStatus={session.status} />
              </section>

              {/* Sesión remota */}
              <section aria-labelledby="remote-section-heading" className="bg-white rounded-xl border border-gray-200 p-5">
                <h2 id="remote-section-heading" className="text-sm font-semibold text-gray-900 mb-4">
                  Sesión remota
                </h2>
                <RemotePanel session={session} />
              </section>
            </div>
          )}
        </div>

        {/* Panel timeline */}
        <div
          role="tabpanel"
          id="panel-timeline"
          aria-labelledby="tab-timeline"
          hidden={activeTab !== 'timeline'}
          className="pt-5"
        >
          {activeTab === 'timeline' && <EventTimeline sessionId={sessionId} />}
        </div>
      </div>

      {/* Volver */}
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/queue')}
          aria-label="Volver a la cola de solicitudes"
        >
          ← Volver a la cola
        </Button>
      </div>
    </div>
  );
}
