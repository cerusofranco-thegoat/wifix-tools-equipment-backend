import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSession } from '../lib/api/assistance';
import { assistanceSocket } from '../lib/ws/AssistanceSocket';
import { useSessionStore } from '../stores/session.store';
import type { ServerEvent, SessionDetail } from '../types/assistance';

export function useSession(sessionId: string) {
  const queryClient = useQueryClient();
  const queryKey = ['session', sessionId] as const;
  const { setRemoteSession, resolveAction, setPeerPresence, addChatMessage } = useSessionStore();

  const query = useQuery({
    queryKey,
    queryFn: () => getSession(sessionId),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    assistanceSocket.joinSession(sessionId);

    const handler = (event: ServerEvent) => {
      switch (event.type) {
        case 'SESSION_STATE_CHANGED':
          if (event.session.id === sessionId) {
            queryClient.setQueryData<SessionDetail>(queryKey, (old) =>
              old ? { ...old, session: event.session } : old,
            );
          }
          break;

        case 'ACTION_RESULT':
          if (event.action.sessionId === sessionId) {
            queryClient.invalidateQueries({ queryKey: ['actions', sessionId] });
            resolveAction(event.action);
          }
          break;

        case 'REMOTE_SESSION_READY':
          if (event.remoteSession.sessionId === sessionId) {
            setRemoteSession(event.remoteSession, event.connect);
            queryClient.setQueryData<SessionDetail>(queryKey, (old) =>
              old ? { ...old, activeRemoteSession: event.remoteSession } : old,
            );
          }
          break;

        case 'PEER_PRESENCE':
          if (event.sessionId === sessionId) {
            setPeerPresence(event.sessionId, event.role, event.online);
          }
          break;

        case 'CHAT_MESSAGE':
          if (event.sessionId === sessionId) {
            queryClient.invalidateQueries({ queryKey: ['events', sessionId] });
            addChatMessage({
              id: `${event.from}-${event.at}`,
              from: event.from,
              text: event.text,
              at: event.at,
              own: false,
            });
          }
          break;
      }
    };

    assistanceSocket.on(handler);
    return () => {
      assistanceSocket.off(handler);
      assistanceSocket.leaveSession();
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return query;
}
