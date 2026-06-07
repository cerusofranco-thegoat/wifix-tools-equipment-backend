import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActions, requestAction, type RequestActionBody } from '../lib/api/assistance';
import { useSessionStore } from '../stores/session.store';

export function useActions(sessionId: string) {
  const queryClient = useQueryClient();
  const { addPendingAction } = useSessionStore();

  const query = useQuery({
    queryKey: ['actions', sessionId],
    queryFn: () => getActions(sessionId, { pageSize: 50 }),
    enabled: Boolean(sessionId),
  });

  const mutation = useMutation({
    mutationFn: (body: RequestActionBody) => requestAction(sessionId, body),
    onSuccess: (data) => {
      addPendingAction(data.action);
      queryClient.invalidateQueries({ queryKey: ['actions', sessionId] });
    },
  });

  return { query, mutation };
}
