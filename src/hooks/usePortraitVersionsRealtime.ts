import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { portraitVersionsQueryKey } from '@/hooks/queryKeys';
import { clearPortraitRealtimeStatus, setPortraitRealtimeLive } from '@/hooks/realtime-status';
import { invalidatePortraitConsumers } from '@/hooks/portrait-invalidation';
import type { FamilyMemberPortraitVersion } from '@/utils/portrait-versions';
import { shouldPollPortraitVersions } from '@/utils/portrait-versions';

// Push-based portrait-version updates (docs/features/portrait-timeline.md,
// "Realtime"). Mirrors useMemoriesRealtime: the 3s poll in
// useFamilyPortraitVersions stays as the fallback and only runs while this
// channel is NOT SUBSCRIBED.
//
// The payload is used ONLY as a signal (plus the non-sensitive status column
// to detect a terminal transition, and the motion_status/motion_key pair to
// detect a living-portrait sheet landing). Row data is never patched into the cache:
// the table also carries generation_token / generation_output_key /
// deletion_token, and the refetched `select *` stays the single source of
// truth for the row shape.

function isTerminal(status: FamilyMemberPortraitVersion['illustrated_profile_status'] | undefined): boolean {
  return status === 'ready' || status === 'failed';
}

// A living-portrait sheet landing (or being replaced/cleared) changes the
// resolved version's motion fields, which family-members consumers read, so it
// gets the same fan-out as a still turning ready. Null-normalised on both
// sides: a cached row from before the motion columns has them undefined.
function didMotionChange(
  row: Partial<FamilyMemberPortraitVersion>,
  previous: FamilyMemberPortraitVersion | undefined,
): boolean {
  if (row.motion_status === 'ready' && row.motion_status !== (previous?.motion_status ?? null)) {
    return true;
  }
  return row.motion_key !== undefined && row.motion_key !== (previous?.motion_key ?? null);
}

/**
 * Mounted once at the family-provider level (FamilyProvider in
 * src/hooks/use-family.tsx), next to useMemoriesRealtime -- not per consumer
 * of useFamilyPortraitVersions, which is mounted by many screens/components
 * at once. Resubscribes on family change; removes its channel on unmount.
 */
export function usePortraitVersionsRealtime(familyId: string | null | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!familyId) {
      return;
    }

    let cancelled = false;
    let hasSubscribedBefore = false;
    const queryKey = portraitVersionsQueryKey(familyId);
    const filter = `family_id=eq.${familyId}`;

    const channel = supabase
      .channel(`portrait-versions-realtime-${familyId}`)
      .on<Partial<FamilyMemberPortraitVersion>>(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'family_member_portrait_versions', filter },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            // A removed portrait can change a member's selected portrait and
            // the memories that embed it. (Postgres Realtime cannot apply a
            // non-key filter to DELETE under default REPLICA IDENTITY, so this
            // may not arrive; the UPDATE that sets deletion_token before the
            // row is removed is the dependable signal.)
            invalidatePortraitConsumers(queryClient);
            return;
          }

          const row = payload.new;
          if (!row?.id) {
            return;
          }

          const cached = queryClient.getQueryData<FamilyMemberPortraitVersion[]>(queryKey);
          const previous = cached?.find((version) => version.id === row.id);
          const previousStatus = previous?.illustrated_profile_status;
          const status = row.illustrated_profile_status;

          if ((isTerminal(status) && status !== previousStatus) || didMotionChange(row, previous)) {
            // Same fan-out generatePortraitVersion's .finally performs:
            // refresh the timeline, family members (current portrait) and
            // memories (illustrations embed the portrait).
            invalidatePortraitConsumers(queryClient);
            return;
          }

          queryClient.invalidateQueries({ queryKey });
        },
      )
      .subscribe((status) => {
        if (cancelled) {
          return;
        }

        if (status === 'SUBSCRIBED') {
          setPortraitRealtimeLive(familyId, true);
          // Realtime does not replay events missed while disconnected. After a
          // rejoin, or when the cache already holds an active version (its
          // completion may have landed between the initial fetch and the join),
          // reconcile once. Skipped otherwise so a cold start does not
          // double-fetch the query it is already loading.
          const cached = queryClient.getQueryData<FamilyMemberPortraitVersion[]>(queryKey);
          if (hasSubscribedBefore || (cached && shouldPollPortraitVersions(cached))) {
            queryClient.invalidateQueries({ queryKey });
          }
          hasSubscribedBefore = true;
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setPortraitRealtimeLive(familyId, false);
        }
      });

    return () => {
      cancelled = true;
      clearPortraitRealtimeStatus(familyId);
      void supabase.removeChannel(channel);
    };
  }, [familyId, queryClient]);
}
