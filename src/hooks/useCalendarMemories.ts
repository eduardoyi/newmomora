import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useGenerationStatusPolling } from '@/hooks/useGenerationStatusPolling';
import { calendarMemoriesQueryKey } from '@/hooks/queryKeys';
import { fetchMemoriesInDateRange } from '@/services/memories';

export interface CalendarMemoryRange {
  startDate: string;
  endDate: string;
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) {
    return error;
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

export function useCalendarMemoriesInRange(range: CalendarMemoryRange | null) {
  const { user } = useAuth();
  const { familyId } = useFamily();

  // Shared status poll (Workstream A5) -- replaces this query's own
  // refetchInterval. Mounting it here (as well as from useMemories) means
  // the Timeline list and its Calendar view (docs/plans/timeline-calendar-keepsakes.md)
  // dedupe onto ONE poll loop instead of double-polling.
  useGenerationStatusPolling();

  return useQuery({
    queryKey: [...calendarMemoriesQueryKey(familyId), 'range', range?.startDate, range?.endDate],
    queryFn: async () => {
      if (!range || !familyId) {
        return [];
      }

      const { data, error } = await fetchMemoriesInDateRange(familyId, range.startDate, range.endDate);

      if (error) {
        throw toError(error, 'Could not load calendar memories');
      }

      return data ?? [];
    },
    enabled: Boolean(user && familyId && range),
    placeholderData: keepPreviousData,
  });
}
