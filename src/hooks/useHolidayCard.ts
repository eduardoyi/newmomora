// Holiday card summary + create (docs/plans/holiday-cards-p2.md Step 6). One
// query (`holiday_card_summary`, the switch plus the family's newest card) and
// one create mutation that refreshes it. The Keepsakes tab never unmounts, so
// the caller passes its real focus state: the summary refetches on focus and
// app foreground, and polls every 10 s only while a card is generating AND
// the screen is focused (every 60 s while only the QR film is still rendering,
// readiness 'film' -- the shop and the push notification take over from there).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { holidayCardQueryKey, keepsakesOverviewQueryKey } from '@/hooks/queryKeys';
import {
  createHolidayCard,
  fetchHolidayCardSummary,
  type CreateHolidayCardFailure,
  type CreateHolidayCardResult,
  type HolidayCardGreeting,
  type HolidayCardSummary,
} from '@/services/holiday-cards';

const SUMMARY_STALE_TIME = 60 * 1000;
export const HOLIDAY_CARD_POLL_MS = 10 * 1000;
export const HOLIDAY_CARD_FILM_POLL_MS = 60 * 1000;

/**
 * How often to poll the summary: fast while the artwork generates, slow while
 * the film renders (~15-20 min), never otherwise. An older backend sends no
 * `readiness`: fall back to `status` (fast poll while generating).
 */
export function holidayCardPollInterval(summary: HolidayCardSummary | null | undefined): number | false {
  if (!summary) return false;
  if (summary.readiness === 'film') return HOLIDAY_CARD_FILM_POLL_MS;
  if (summary.readiness === 'generating') return HOLIDAY_CARD_POLL_MS;
  if (summary.readiness === null && summary.status === 'generating') return HOLIDAY_CARD_POLL_MS;
  return false;
}

export type CreateHolidayCardOutcome =
  | { ok: true; result: CreateHolidayCardResult }
  | { ok: false; error: CreateHolidayCardFailure };

export function useHolidayCard(
  familyId: string | null | undefined,
  options: { enabled?: boolean; isFocused?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const isFocused = options.isFocused ?? true;
  const queryKey = holidayCardQueryKey(familyId);

  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<HolidayCardSummary | null> => {
      const { data, error } = await fetchHolidayCardSummary(familyId!);
      if (error) throw new Error(error.message);
      return data;
    },
    enabled: Boolean(familyId) && (options.enabled ?? true),
    staleTime: SUMMARY_STALE_TIME,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (isFocused ? holidayCardPollInterval(q.state.data) : false),
  });

  const mutation = useMutation({
    mutationFn: async (greeting: HolidayCardGreeting): Promise<CreateHolidayCardOutcome> => {
      const { data, error } = await createHolidayCard(familyId!, greeting);
      if (error || !data) {
        return { ok: false, error: error ?? { code: 'unknown', message: 'Unexpected response' } };
      }
      return { ok: true, result: data };
    },
    // A slot-used / disabled answer also means the cached summary is stale.
    // Not awaited: the caller gets the outcome (and can show its error)
    // without waiting for the refetch, which may already hide the tile.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      // A new card adds an order-less card to the Keepsakes overview.
      void queryClient.invalidateQueries({ queryKey: keepsakesOverviewQueryKey(familyId) });
    },
  });

  const { mutateAsync } = mutation;
  const create = useCallback(
    async (greeting: HolidayCardGreeting): Promise<CreateHolidayCardOutcome> => {
      if (!familyId) return { ok: false, error: { code: 'unknown', message: 'No family' } };
      return mutateAsync(greeting);
    },
    [familyId, mutateAsync],
  );

  return {
    /** Null: not loaded yet, not an owner/manager (zero rows), or the load failed. */
    summary: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
    create,
    isCreating: mutation.isPending,
  };
}
