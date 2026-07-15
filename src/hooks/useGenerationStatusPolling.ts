import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { calendarMemoriesQueryKeyBase } from '@/hooks/queryKeys';
import { isMemoriesListQueryKey, patchMemoryInCaches } from '@/hooks/memory-cache';
import { useIsRealtimeLive } from '@/hooks/realtime-status';
import {
  fetchMemoryGenerationStatuses,
  type MemoryGenerationStatusRow,
  type MemoryWithTags,
} from '@/services/memories';
import { memoriesNeedEmotionPolling, shouldPollForEmotion } from '@/utils/media-emotion-polling';

// Workstream A5: a single shared poll for illustration/emotion status,
// replacing the per-list-hook `refetchInterval`s that used to double-poll
// when the timeline and calendar tabs were both mounted (Expo Router's Tabs
// navigator keeps every tab screen mounted). Keyed only by familyId (no
// memories param) so useMemories and useCalendarMemoriesInRange mounting
// this concurrently dedupe onto one query/poll loop. The detail hook
// (useMemory) keeps its own single-row refetchInterval -- cheap and
// self-contained, not worth folding in here.

function isMemoryGenerating(memory: Pick<MemoryWithTags, 'illustration_status'>): boolean {
  return memory.illustration_status === 'pending' || memory.illustration_status === 'generating';
}

// Walks every cached list (the unfiltered timeline + any cached
// member-filtered queries, both InfiniteData) and calendar-range (plain
// array) query for this family and returns the union of memory rows they
// currently hold, deduped by id. This is what the poll uses both to decide
// its own interval and to build the set of ids to re-check.
function collectTrackedMemories(
  queryClient: QueryClient,
  familyId: string | null | undefined,
): MemoryWithTags[] {
  const byId = new Map<string, MemoryWithTags>();

  const listEntries = queryClient.getQueriesData<{ pages: { memories: MemoryWithTags[] }[] }>({
    predicate: (query) => isMemoriesListQueryKey(query.queryKey) && query.queryKey[1] === familyId,
  });

  for (const [, data] of listEntries) {
    if (!data || !Array.isArray(data.pages)) {
      continue;
    }
    for (const page of data.pages) {
      for (const memory of page.memories) {
        byId.set(memory.id, memory);
      }
    }
  }

  const calendarEntries = queryClient.getQueriesData<MemoryWithTags[]>({
    queryKey: [calendarMemoriesQueryKeyBase, familyId],
  });

  for (const [, data] of calendarEntries) {
    if (!Array.isArray(data)) {
      // Guards the 'oldest-date' entry (a string), which shares the base key.
      continue;
    }
    for (const memory of data) {
      byId.set(memory.id, memory);
    }
  }

  return [...byId.values()];
}

function collectPendingIds(tracked: MemoryWithTags[]): string[] {
  const ids = new Set<string>();

  for (const memory of tracked) {
    if (isMemoryGenerating(memory) || shouldPollForEmotion(memory)) {
      ids.add(memory.id);
    }
  }

  return [...ids];
}

function applyStatusPatches(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  previouslyTracked: MemoryWithTags[],
  statuses: MemoryGenerationStatusRow[],
): void {
  const previousById = new Map(previouslyTracked.map((memory) => [memory.id, memory]));

  for (const status of statuses) {
    const previous = previousById.get(status.id);
    if (!previous) {
      continue;
    }

    const changed =
      previous.illustration_status !== status.illustration_status ||
      previous.illustration_key !== status.illustration_key ||
      previous.emotion !== status.emotion;

    if (!changed) {
      continue;
    }

    patchMemoryInCaches(queryClient, familyId, status.id, {
      illustration_status: status.illustration_status,
      illustration_key: status.illustration_key,
      emotion: status.emotion,
      updated_at: status.updated_at,
    });

    // Mirrors the transition handling in useMemory (useMemories.ts): a
    // memory's illustration just finished, so signed media URLs and the
    // calendar's cached rows for it need a fresh look.
    if (status.illustration_status === 'ready' && isMemoryGenerating(previous)) {
      queryClient.invalidateQueries({ queryKey: ['media-urls'] });
      queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
    }
  }
}

export function useGenerationStatusPolling() {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  // D3: reactive suppression -- while useMemoriesRealtime's channel for this
  // family is SUBSCRIBED, push updates cover generation status and the poll
  // idles. useIsRealtimeLive is backed by useSyncExternalStore (NOT a plain
  // ref), so a status flip re-renders this hook and makes react-query
  // re-evaluate refetchInterval below -- a ref alone would leave the poll
  // idle forever once CHANNEL_ERROR/TIMED_OUT/CLOSED fires, since
  // refetchInterval callbacks are otherwise only re-evaluated on the query's
  // own update or an observer re-render.
  const isRealtimeLive = useIsRealtimeLive(familyId);

  return useQuery({
    queryKey: ['generation-status', familyId],
    queryFn: async () => {
      const tracked = collectTrackedMemories(queryClient, familyId);
      const pendingIds = collectPendingIds(tracked);

      if (pendingIds.length === 0) {
        return null;
      }

      const { data, error } = await fetchMemoryGenerationStatuses(pendingIds);

      if (error) {
        throw new Error(error.message);
      }

      applyStatusPatches(queryClient, familyId, tracked, data ?? []);
      return null;
    },
    // Stays enabled (not gated on isRealtimeLive) even while realtime covers
    // status pushes: useMemoriesRealtime forces one tick of this query via
    // invalidateQueries on every SUBSCRIBED transition (reconciling anything
    // missed while disconnected), which only refetches an ACTIVE query.
    enabled: Boolean(user && familyId),
    staleTime: 0,
    // Re-derives pending ids from the list/calendar caches on every tick
    // (and on every re-render of whichever hook mounted this, via
    // setOptions -- see the comment in useMemories.ts) rather than from this
    // query's own data, since the ids to poll live in OTHER queries' caches.
    refetchInterval: () => {
      if (!familyId || isRealtimeLive) {
        return false;
      }

      const tracked = collectTrackedMemories(queryClient, familyId);

      if (tracked.some(isMemoryGenerating)) {
        return 3000;
      }

      return memoriesNeedEmotionPolling(tracked) ? 5000 : false;
    },
  });
}
