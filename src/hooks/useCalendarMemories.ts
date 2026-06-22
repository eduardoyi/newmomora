import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { calendarMemoriesQueryKey } from '@/hooks/queryKeys';
import {
  fetchMemoriesInDateRange,
  fetchOldestMemoryDate,
  type MemoryWithTags,
} from '@/services/memories';
import { memoriesNeedEmotionPolling } from '@/utils/media-emotion-polling';

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

export function useOldestMemoryDate() {
  const { user } = useAuth();

  return useQuery({
    queryKey: [...calendarMemoriesQueryKey, 'oldest-date'],
    queryFn: async () => {
      const { data, error } = await fetchOldestMemoryDate();

      if (error) {
        throw toError(error, 'Could not load calendar range');
      }

      return data;
    },
    enabled: Boolean(user),
  });
}

export function useCalendarMemoriesInRange(range: CalendarMemoryRange | null) {
  const { user } = useAuth();

  return useQuery({
    queryKey: [...calendarMemoriesQueryKey, 'range', range?.startDate, range?.endDate],
    queryFn: async () => {
      if (!range) {
        return [];
      }

      const { data, error } = await fetchMemoriesInDateRange(range.startDate, range.endDate);

      if (error) {
        throw toError(error, 'Could not load calendar memories');
      }

      return data ?? [];
    },
    enabled: Boolean(user && range),
    placeholderData: keepPreviousData,
    refetchInterval: (queryState) => {
      const memories = (queryState.state.data ?? []) as MemoryWithTags[];
      const hasGenerating = memories.some(
        (memory) =>
          memory.illustration_status === 'pending' || memory.illustration_status === 'generating',
      );

      if (hasGenerating) {
        return 3000;
      }

      return memoriesNeedEmotionPolling(memories) ? 5000 : false;
    },
  });
}
