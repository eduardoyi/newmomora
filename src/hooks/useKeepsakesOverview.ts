// Keepsakes tab overview query (docs/plans/keepsakes-redesign.md B2): the
// `keepsakes_overview` RPC. 30 s stale time, no polling. The tab never
// unmounts, so the caller passes its real focus state and the query refetches
// on each focus once stale; the AppState focusManager (app-providers.tsx)
// also refetches on returning from the browser, which is how order badges
// update after paying on the web. An RPC error (e.g. the migration is not
// deployed yet) yields `overview: null` -- the UI degrades, never crashes.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { keepsakesOverviewQueryKey } from '@/hooks/queryKeys';
import { fetchKeepsakesOverview, type KeepsakesOverview } from '@/services/keepsakes';

export const KEEPSAKES_OVERVIEW_STALE_TIME = 30_000;

export function useKeepsakesOverview(
  familyId: string | null | undefined,
  options: { enabled?: boolean; isFocused?: boolean } = {},
) {
  const isFocused = options.isFocused ?? true;
  const isEnabled = Boolean(familyId) && (options.enabled ?? true);
  const queryClient = useQueryClient();
  const queryKey = keepsakesOverviewQueryKey(familyId);

  const query = useQuery({
    queryKey,
    queryFn: () => fetchKeepsakesOverview(familyId!),
    enabled: isEnabled,
    staleTime: KEEPSAKES_OVERVIEW_STALE_TIME,
    refetchOnWindowFocus: true,
  });

  // Staleness is read from the cache only when focus changes: depending on
  // `query.isStale` would turn the 30 s stale timer into polling while the tab
  // stays focused.
  const { refetch } = query;
  useEffect(() => {
    if (!isEnabled || !isFocused) return;
    const state = queryClient.getQueryState(queryKey);
    const isStale =
      !state || state.isInvalidated || Date.now() - state.dataUpdatedAt > KEEPSAKES_OVERVIEW_STALE_TIME;
    if (isStale) void refetch({ cancelRefetch: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey is derived from familyId
  }, [isEnabled, isFocused, familyId, queryClient, refetch]);

  return {
    /** Null: not loaded yet, disabled, or the RPC failed. */
    overview: (query.data ?? null) as KeepsakesOverview | null,
    isLoading: query.isLoading,
    refetch,
  };
}
