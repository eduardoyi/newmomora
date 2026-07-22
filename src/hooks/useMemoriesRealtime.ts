import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';
import {
  findMemoryInListCache,
  patchMemoryInCaches,
  prependMemoryToListCaches,
  removeMemoryFromListCaches,
} from '@/hooks/memory-cache';
import { clearRealtimeStatus, setRealtimeLive } from '@/hooks/realtime-status';
import { fetchMemoryById, type Memory } from '@/services/memories';

// Workstream D2 (docs/plans/performance-optimizations.md): push-based
// generation-status/insert/delete updates to complement (not replace) A5's
// poll, which stays as the fallback whenever realtime is disconnected or
// missing in an environment (D3 handles the suppression).

// INSERT rows race their own tag/media inserts (createMemory writes the
// memories row THEN tags; the media RPC likewise -- see memories.ts). Delay
// the enrichment fetch so the common case doesn't have to retry at all.
const INSERT_ENRICHMENT_DELAY_MS = 1500;
// One retry if the delayed fetch still raced a memory type that requires
// media assets (a `media` memory always has >=1 asset once fully written;
// tags are never required for any type, so they're not used as a retry
// signal -- a legitimately zero-tag memory is a valid steady state).
const INSERT_ENRICHMENT_RETRY_DELAY_MS = 1500;

function isMemoryGenerating(status: Memory['illustration_status']): boolean {
  return status === 'pending' || status === 'generating';
}

async function fetchAndPrependInsertedMemory(
  queryClient: QueryClient,
  familyId: string,
  memoryId: string,
  isCancelled: () => boolean,
): Promise<void> {
  const first = await fetchMemoryById(memoryId);
  if (isCancelled()) {
    return;
  }
  if (first.error || !first.data) {
    return;
  }

  const needsRetry = first.data.memory_type === 'media' && first.data.mediaAssets.length === 0;
  if (!needsRetry) {
    prependMemoryToListCaches(queryClient, familyId, first.data);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, INSERT_ENRICHMENT_RETRY_DELAY_MS));
  if (isCancelled()) {
    return;
  }

  const retry = await fetchMemoryById(memoryId);
  if (isCancelled()) {
    return;
  }

  // Fail-open: prepend whatever the retry returned, even if media is still
  // empty -- a memory missing from the timeline entirely is worse than one
  // that briefly renders without its media (pull-to-refresh/foreground
  // reconcile picks up the rest).
  const resolved = retry.error || !retry.data ? first.data : retry.data;
  prependMemoryToListCaches(queryClient, familyId, resolved);
}

/**
 * Mounted once (app layout / family-provider level -- see FamilyProvider in
 * src/hooks/use-family.tsx) for the whole authenticated session. Subscribes
 * to postgres_changes on `memories` filtered to the active family and keeps
 * the shared list/detail caches (memory-cache.ts) live for cross-device
 * inserts, deletes, and generation-status updates, instead of relying
 * entirely on A5's poll. Resubscribes whenever `familyId` changes (family
 * switch); cleans up its channel on unmount.
 */
export function useMemoriesRealtime(familyId: string | null | undefined): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!familyId) {
      return;
    }

    let cancelled = false;
    const pendingInsertTimers = new Set<ReturnType<typeof setTimeout>>();

    const channel = supabase
      .channel(`memories-realtime-${familyId}`)
      .on<Memory>(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'memories', filter: `family_id=eq.${familyId}` },
        (payload) => {
          const row = payload.new;
          if (!row?.id) {
            return;
          }

          // Default REPLICA IDENTITY only guarantees the primary key on
          // `payload.old` -- read the prior status from the cache (already
          // populated by the initial page fetch/poll) rather than the
          // payload, mirroring how A5's applyStatusPatches detects a
          // ready-transition.
          const previous = findMemoryInListCache(queryClient, familyId, row.id);
          const wasGenerating = previous ? isMemoryGenerating(previous.illustration_status) : false;

          // Only the generation-relevant fields, plus the two fields A4b
          // calls out as needing their own patch path (link_previews,
          // content) so a realtime UPDATE doesn't clobber other in-flight
          // client-side patches to unrelated columns.
          patchMemoryInCaches(queryClient, familyId, row.id, {
            illustration_status: row.illustration_status,
            illustration_key: row.illustration_key,
            illustration_generation_id: row.illustration_generation_id,
            illustration_generation_started_at: row.illustration_generation_started_at,
            emotion: row.emotion,
            updated_at: row.updated_at,
            link_previews: row.link_previews,
            content: row.content,
          });

          if (row.illustration_status === 'ready' && wasGenerating) {
            queryClient.invalidateQueries({ queryKey: ['media-urls'] });
            queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
          }
        },
      )
      .on<Memory>(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'memories', filter: `family_id=eq.${familyId}` },
        (payload) => {
          const row = payload.new;
          if (!row?.id) {
            return;
          }

          // The creating device's own mutation (or the media-upload queue)
          // already prepended this row via A4b -- this event is for OTHER
          // devices' inserts. insertMemorySorted also no-ops on an id
          // that's already present, so this is a fast-path skip, not the
          // only guard.
          if (findMemoryInListCache(queryClient, familyId, row.id)) {
            return;
          }

          const timer = setTimeout(() => {
            pendingInsertTimers.delete(timer);
            void fetchAndPrependInsertedMemory(queryClient, familyId, row.id, () => cancelled);
          }, INSERT_ENRICHMENT_DELAY_MS);
          pendingInsertTimers.add(timer);
        },
      )
      .on<Memory>(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'memories', filter: `family_id=eq.${familyId}` },
        (payload) => {
          const row = payload.old;
          if (!row?.id) {
            return;
          }
          removeMemoryFromListCaches(queryClient, familyId, row.id);
        },
      )
      .subscribe((status) => {
        if (cancelled) {
          return;
        }

        if (status === 'SUBSCRIBED') {
          setRealtimeLive(familyId, true);
          // Realtime does not replay events missed while disconnected (e.g.
          // iOS suspending the socket while backgrounded) -- reconcile on
          // EVERY SUBSCRIBED transition, initial AND rejoin, by forcing one
          // tick of A5's status query. Without this, an illustration that
          // finished while disconnected stays 'pending' in cache, and A7's
          // recovery effect would re-pin it to pending in a loop. A no-op
          // (cheap) when nothing is currently pending.
          queryClient.invalidateQueries({ queryKey: ['generation-status', familyId] });
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeLive(familyId, false);
        }
      });

    return () => {
      cancelled = true;
      for (const timer of pendingInsertTimers) {
        clearTimeout(timer);
      }
      pendingInsertTimers.clear();
      clearRealtimeStatus(familyId);
      void supabase.removeChannel(channel);
    };
  }, [familyId, queryClient]);
}
