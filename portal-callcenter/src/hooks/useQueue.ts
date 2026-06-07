import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getQueue, type GetQueueParams } from '../lib/api/assistance';
import { assistanceSocket } from '../lib/ws/AssistanceSocket';
import type { ServerEvent, Paginated, AssistanceSession } from '../types/assistance';

export function useQueue(params?: GetQueueParams) {
  const queryClient = useQueryClient();
  const queryKey = ['queue', params] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => getQueue(params),
    refetchInterval: 30_000, // fallback polling si WS falla
  });

  useEffect(() => {
    assistanceSocket.subscribeQueue();

    const handler = (event: ServerEvent) => {
      if (event.type === 'QUEUE_UPDATED') {
        queryClient.setQueryData<Paginated<AssistanceSession>>(queryKey, (old) => {
          if (!old) return old;
          const exists = old.items.some((s) => s.id === event.session.id);
          const items = exists
            ? old.items.map((s) => (s.id === event.session.id ? event.session : s))
            : [event.session, ...old.items];
          return { ...old, items, total: exists ? old.total : old.total + 1 };
        });
      }
    };

    assistanceSocket.on(handler);
    return () => assistanceSocket.off(handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)]);

  return query;
}
