import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { memoryMonthCountsQueryKey } from '@/hooks/queryKeys';
import { fetchMemoryMonthDates, type MemoryMonthDateRow } from '@/services/memories';
import { buildMonthCounts, type MonthCounts } from '@/utils/timeline-anchor';

/**
 * Per-month memory counts for the Timeline month picker
 * (docs/plans/timeline-calendar-keepsakes.md A4): one narrow dates-only
 * query for the whole family, grouped client-side. Blocked accounts are
 * filtered here (not in the cached rows) so a block/unblock recounts without
 * a refetch.
 *
 * Freshness: invalidated (refetchType 'none', i.e. marked stale only) when a
 * memory is added, removed, or re-dated -- see memory-cache.ts -- and the
 * picker calls `refreshIfStale` when it opens. Illustration/emotion updates
 * never touch it.
 */
export function useMemoryMonthCounts(isUserBlocked: (userId: string) => boolean) {
  const { user } = useAuth();
  const { familyId } = useFamily();

  const query = useQuery({
    queryKey: memoryMonthCountsQueryKey(familyId),
    queryFn: async (): Promise<MemoryMonthDateRow[]> => {
      if (!familyId) {
        return [];
      }
      const { data, error } = await fetchMemoryMonthDates(familyId);
      if (error) {
        throw new Error(error.message);
      }
      return data ?? [];
    },
    enabled: Boolean(user && familyId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const counts = useMemo<MonthCounts>(
    () => buildMonthCounts(query.data ?? [], isUserBlocked),
    [isUserBlocked, query.data],
  );

  const { isStale, refetch } = query;
  const refreshIfStale = useMemo(
    () => () => {
      if (isStale) {
        void refetch();
      }
    },
    [isStale, refetch],
  );

  return {
    counts,
    isLoaded: query.data !== undefined,
    refreshIfStale,
  };
}
