// Integración de Jitsi via External API (iframe + external_api.js dinámico).
// Carga el script desde el dominio Jitsi self-host; no usa paquete npm.

import { useEffect, useRef } from 'react';

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
      resolve();
      return;
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

export function JitsiFrame({ roomName, domain, jwt, displayName, onHangup }: JitsiFrameProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<JitsiMeetAPI | null>(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        await loadJitsiScript(domain);
        if (!mounted || !containerRef.current || !window.JitsiMeetExternalAPI) return;

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
        console.error('[Jitsi] Error al inicializar:', err);
      }
    }

    void init();

    return () => {
      mounted = false;
      apiRef.current?.dispose();
      apiRef.current = null;
    };
  }, [roomName, domain, jwt, displayName, onHangup]);

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
