import { useQuery } from '@tanstack/react-query';

import { deriveWaitingOutcome, type WaitingOutcome } from '@/utils/invites';
import { fetchMyRedeemedInviteStatus } from '@/services/invites';

export const redeemedInviteStatusQueryKey = ['my-redeemed-invite-status'] as const;

const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Polls `get_my_redeemed_invite_status` (definer RPC) for the waiting screen
 * (docs/plans/family-sharing.md §9). Polling stops once the outcome is
 * terminal; callers gate `enabled` on screen focus. Before the first
 * response lands the outcome reads as 'waiting' -- 'unavailable' (the
 * terminal no-row branch) is only derived from an actual RPC result.
 */
export function useRedeemedInviteStatus(options?: {
  enabled?: boolean;
  pollIntervalMs?: number;
}) {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const query = useQuery({
    queryKey: redeemedInviteStatusQueryKey,
    queryFn: async () => {
      const { data, error } = await fetchMyRedeemedInviteStatus();

      if (error) {
        throw new Error(error.message);
      }

      return data;
    },
    enabled: options?.enabled ?? true,
    gcTime: 0,
    refetchInterval: (queryState) => {
      const row = queryState.state.data;

      if (row === undefined) {
        return pollIntervalMs;
      }

      const outcome = deriveWaitingOutcome(row);
      return outcome.kind === 'waiting' ? pollIntervalMs : false;
    },
  });

  const outcome: WaitingOutcome =
    query.data === undefined
      ? { kind: 'waiting', familyName: null }
      : deriveWaitingOutcome(query.data);

  return {
    outcome,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
