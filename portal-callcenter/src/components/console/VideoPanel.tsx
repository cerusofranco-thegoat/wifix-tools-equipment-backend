import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { provisionVideo } from '../../lib/api/assistance';
import { JitsiFrame } from '../../lib/jitsi/JitsiFrame';
import { useAuthStore } from '../../stores/auth.store';
import { Button } from '../ui/Button';
import { ErrorMessage } from '../ui/ErrorMessage';
import type { VideoRoom } from '../../types/assistance';
import type { AssistanceStatus } from '../../types/assistance';

interface VideoPanelProps {
  sessionId: string;
  sessionStatus: AssistanceStatus;
}

export function VideoPanel({ sessionId, sessionStatus }: VideoPanelProps) {
  const { user } = useAuthStore();
  const [room, setRoom] = useState<VideoRoom | null>(null);
  const [disposed, setDisposed] = useState(false);

  const canStartVideo = sessionStatus === 'ACTIVE' || sessionStatus === 'ON_HOLD';

  const mutation = useMutation({
    mutationFn: () => provisionVideo(sessionId),
    onSuccess: (data) => {
      setRoom(data);
      setDisposed(false);
    },
  });

  function handleHangup() {
    setRoom(null);
    setDisposed(true);
  }

  if (room && !disposed) {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">
          <Button variant="danger" size="sm" onClick={handleHangup} aria-label="Colgar videollamada">
            Colgar
          </Button>
        </div>
        <JitsiFrame
          roomName={room.roomName}
          domain={room.domain}
          jwt={room.jwt}
          displayName={user?.name ?? 'Agente'}
          onHangup={handleHangup}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-gray-700">Video con el técnico</p>
        <p className="text-xs text-gray-400">
          {canStartVideo
            ? 'Inicia la videollamada para comunicarte con el técnico en campo.'
            : 'La sesión debe estar activa para iniciar el video.'}
        </p>
      </div>

      {mutation.error && (
        <ErrorMessage error={mutation.error} fallback="Error al conectar con la sala de video." />
      )}

      <Button
        onClick={() => mutation.mutate()}
        loading={mutation.isPending}
        disabled={!canStartVideo}
        aria-label="Iniciar videollamada con el técnico"
      >
        {disposed ? 'Reconectar video' : 'Iniciar video'}
      </Button>
    </div>
  );
}
