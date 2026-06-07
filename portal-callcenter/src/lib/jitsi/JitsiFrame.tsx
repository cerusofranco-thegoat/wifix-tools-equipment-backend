// Integración de Jitsi via External API (iframe + external_api.js dinámico).
// Carga el script desde el dominio Jitsi self-host; no usa paquete npm.

import { useEffect, useRef, useState, useCallback } from 'react';
import { Button } from '../../components/ui/Button';

interface JitsiFrameProps {
  roomName: string;
  domain: string;
  jwt: string;
  displayName: string;
  onHangup?: () => void;
}

// Tipo mínimo de la API Jitsi que usamos
interface JitsiMeetAPI {
  dispose: () => void;
  addEventListeners: (listeners: Record<string, () => void>) => void;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: Record<string, unknown>,
    ) => JitsiMeetAPI;
  }
}

function loadJitsiScript(domain: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-jitsi-domain="${domain}"]`,
    );
    if (existing) {
      // Si el script ya existe pero la API no está disponible, significa que
      // falló en una carga previa — eliminar el tag para intentar de nuevo.
      if (!window.JitsiMeetExternalAPI) {
        existing.remove();
      } else {
        resolve();
        return;
      }
    }
    const script = document.createElement('script');
    script.src = `https://${domain}/external_api.js`;
    script.async = true;
    script.setAttribute('data-jitsi-domain', domain);
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error(`No se pudo cargar Jitsi desde https://${domain}/external_api.js`));
    document.head.appendChild(script);
  });
}

// ── Estado de error de video — accesible y aislado del resto de la consola ──

interface JitsiErrorBannerProps {
  onRetry: () => void;
}

function JitsiErrorBanner({ onRetry }: JitsiErrorBannerProps) {
  const retryRef = useRef<HTMLButtonElement>(null);

  // Llevar el foco al botón Reintentar cuando aparece el banner
  useEffect(() => {
    retryRef.current?.focus();
  }, []);

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col items-center gap-4 rounded-lg border border-red-200 bg-red-50 px-6 py-8 text-center"
    >
      <p className="text-sm font-medium text-red-800">
        No se pudo conectar con el servidor de video.
      </p>
      <p className="text-xs text-red-600">
        Verifica el acceso al servidor Jitsi e intenta nuevamente.
        El resto de las funciones de la consola sigue disponible.
      </p>
      <Button
        ref={retryRef}
        variant="secondary"
        size="sm"
        onClick={onRetry}
        aria-label="Reintentar conexión con el servidor de video"
      >
        Reintentar
      </Button>
    </div>
  );
}

export function JitsiFrame({ roomName, domain, jwt, displayName, onHangup }: JitsiFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<JitsiMeetAPI | null>(null);
  const [jitsiError, setJitsiError] = useState<string | null>(null);
  // Contador de intentos para forzar re-ejecución del useEffect al reintentar
  const [retryCount, setRetryCount] = useState(0);

  const handleRetry = useCallback(() => {
    setJitsiError(null);
    setRetryCount((c) => c + 1);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        await loadJitsiScript(domain);

        if (!mounted) return;

        if (!window.JitsiMeetExternalAPI) {
          throw new Error('JitsiMeetExternalAPI no está disponible tras cargar el script.');
        }

        if (!containerRef.current) return;

        // Disponer de una instancia previa si existe
        apiRef.current?.dispose();

        apiRef.current = new window.JitsiMeetExternalAPI(domain, {
          roomName,
          jwt,
          parentNode: containerRef.current,
          userInfo: { displayName },
          configOverwrite: {
            startWithAudioMuted: false,
            startWithVideoMuted: true,
            prejoinPageEnabled: false,
          },
          interfaceConfigOverwrite: {
            SHOW_JITSI_WATERMARK: false,
            TOOLBAR_BUTTONS: ['microphone', 'camera', 'hangup', 'chat', 'tileview'],
          },
        });

        apiRef.current.addEventListeners({
          videoConferenceLeft: () => onHangup?.(),
          videoConferenceJoined: () => {/* sala lista */},
        });
      } catch (err) {
        if (!mounted) return;
        const message =
          err instanceof Error ? err.message : 'Error desconocido al inicializar el video.';
        console.error('[Jitsi] Error al inicializar:', err);
        setJitsiError(message);
      }
    }

    void init();

    return () => {
      mounted = false;
      apiRef.current?.dispose();
      apiRef.current = null;
    };
    // retryCount se incluye para reforzar re-ejecución al reintentar
  }, [roomName, domain, jwt, displayName, onHangup, retryCount]);

  if (jitsiError) {
    return <JitsiErrorBanner onRetry={handleRetry} />;
  }

  return (
    <div
      ref={containerRef}
      className="jitsi-container w-full rounded-lg overflow-hidden bg-gray-900"
      style={{ minHeight: '400px' }}
      aria-label="Videollamada con el técnico"
      role="region"
    />
  );
}
