import { useQuery } from '@tanstack/react-query';
import { getEvents } from '../lib/api/assistance';

export function useEvents(sessionId: string, page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['events', sessionId, page, pageSize],
    queryFn: () => getEvents(sessionId, { page, pageSize }),
    enabled: Boolean(sessionId),
    placeholderData: (prev) => prev,
  });
}
