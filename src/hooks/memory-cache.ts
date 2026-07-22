import type { InfiniteData, QueryClient } from '@tanstack/react-query';

import {
  calendarMemoriesQueryKeyBase,
  memoriesQueryKeyBase,
  memoryDetailQueryKey,
} from '@/hooks/queryKeys';
import type { MemoriesPage, MemoryWithTags } from '@/services/memories';

// Shared cache-shape logic for every memories list/detail query
// (docs/plans/performance-optimizations.md Workstream A0/A3/A4b). Extracted
// out of useMemories.ts so useGenerationStatusPolling (A5) and the pending
// media-upload queue (A4b) can patch the same caches without reimplementing
// shape detection -- InfiniteData is the ONLY list shape produced by the
// hooks in this app; keep it that way rather than re-adding a flat-array
// branch here.

export type MemoryPatch =
  | Partial<MemoryWithTags>
  | ((memory: MemoryWithTags) => Partial<MemoryWithTags>);

// Matches every memories-list query (the unfiltered timeline AND the
// member-filtered variant from useMemberMemories, which is deliberately
// nested under the same [memoriesQueryKeyBase, familyId, ...] prefix so it
// keeps receiving these patches) while excluding the single-memory detail
// query and the unrelated 'memories-search' key.
export function isMemoriesListQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === memoriesQueryKeyBase && queryKey[2] !== 'detail';
}

function isInfiniteMemoriesData(value: unknown): value is InfiniteData<MemoriesPage> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as InfiniteData<MemoriesPage>).pages)
  );
}

function resolvePatch(memory: MemoryWithTags, patch: MemoryPatch): Partial<MemoryWithTags> {
  return typeof patch === 'function' ? patch(memory) : patch;
}

// The timeline list cache already holds the full MemoryWithTags (tags +
// media) for every memory it has loaded, so the detail screen can paint from
// it immediately while the fresh fetch runs in the background. Scoped to the
// active family so another family's cache never leaks into the detail view.
export function findMemoryInListCache(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memoryId: string | undefined,
): MemoryWithTags | undefined {
  if (!memoryId) {
    return undefined;
  }

  const listEntries = queryClient.getQueriesData<InfiniteData<MemoriesPage>>({
    predicate: (query) =>
      isMemoriesListQueryKey(query.queryKey) && query.queryKey[1] === familyId,
  });

  for (const [, data] of listEntries) {
    if (!isInfiniteMemoriesData(data)) {
      continue;
    }

    for (const page of data.pages) {
      const memory = page.memories.find((candidate) => candidate.id === memoryId);
      if (memory) {
        return memory;
      }
    }
  }

  return undefined;
}

export function patchMemoryInCaches(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memoryId: string,
  patch: MemoryPatch,
): void {
  const patchMemory = (memory: MemoryWithTags): MemoryWithTags =>
    memory.id === memoryId ? { ...memory, ...resolvePatch(memory, patch) } : memory;

  queryClient.setQueriesData<InfiniteData<MemoriesPage>>(
    { predicate: (query) => isMemoriesListQueryKey(query.queryKey) },
    (current) => {
      if (!isInfiniteMemoriesData(current)) {
        return current;
      }

      return {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          memories: page.memories.map(patchMemory),
        })),
      };
    },
  );

  // Calendar range caches hold the same memory rows in a plain array; the
  // base key also matches the 'oldest-date' entry (a string), which the
  // Array.isArray guard leaves untouched.
  queryClient.setQueriesData<MemoryWithTags[]>(
    { queryKey: [calendarMemoriesQueryKeyBase] },
    (current) => (Array.isArray(current) ? current.map(patchMemory) : current),
  );

  queryClient.setQueryData<MemoryWithTags | null>(
    memoryDetailQueryKey(familyId, memoryId),
    (current) => (current ? patchMemory(current) : current),
  );
}

export function setMemoryIllustrationPendingInCache(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memoryId: string,
): void {
  // This is an optimistic UI-only patch, never a database write. Do not alter
  // updated_at (which may reflect unrelated work); mirror the expected server
  // generation clock so a successfully dispatched recovery does not loop
  // before realtime/status polling observes the authoritative value.
  patchMemoryInCaches(queryClient, familyId, memoryId, {
    illustration_status: 'pending',
    illustration_generation_started_at: new Date().toISOString(),
  });
}

export function setMemoryEmotionInCache(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memoryId: string,
  emotion: string,
): void {
  patchMemoryInCaches(queryClient, familyId, memoryId, { emotion });
}

// Invalidates every family's cached list/detail data (React Query
// prefix-matches array keys, so passing just the base string covers every
// `[base, familyId, ...]` variant). Simpler and safer than tracking the
// current familyId here -- stale entries for other families just refetch
// lazily the next time they're viewed.
//
// The memories list is now InfiniteData: a refetching invalidation would
// sequentially re-run every loaded page's enrichment round-trips (v5
// behavior for infinite queries), which is exactly the cost Workstream A
// removes. refetchType: 'none' only marks the cache stale as a
// reconciliation backstop (next natural mount/reset refetches it); mutations
// are responsible for patching in the data they already have (see
// prependMemoryToListCaches / removeMemoryFromListCaches / patchMemoryInCaches
// below and their call sites in useMemories.ts and use-pending-memory-uploads.tsx).
// Calendar invalidation stays as the default 'active' refetchType -- it's
// array-shaped, windowed to the visible range, and cheap.
export function invalidateMemoryQueries(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase], refetchType: 'none' });
  queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
}

function compareMemoriesDesc(
  a: Pick<MemoryWithTags, 'memory_date' | 'created_at'>,
  b: Pick<MemoryWithTags, 'memory_date' | 'created_at'>,
): number {
  if (a.memory_date !== b.memory_date) {
    return a.memory_date > b.memory_date ? -1 : 1;
  }
  if (a.created_at !== b.created_at) {
    return a.created_at > b.created_at ? -1 : 1;
  }
  return 0;
}

// True for the base timeline key ([memoriesQueryKeyBase, familyId]) and for
// a member-filtered key ([memoriesQueryKeyBase, familyId, 'member',
// memberId]) whose member is tagged on this memory. Any other nested shape
// under the same prefix is treated conservatively (not a match) rather than
// guessed at.
function memoryBelongsToListKey(memory: MemoryWithTags, queryKey: readonly unknown[]): boolean {
  if (queryKey.length === 2) {
    return true;
  }

  if (queryKey[2] === 'member') {
    const memberId = queryKey[3];
    return memory.taggedMembers.some((member) => member.id === memberId);
  }

  return false;
}

function insertMemorySorted(
  data: InfiniteData<MemoriesPage>,
  memory: MemoryWithTags,
): InfiniteData<MemoriesPage> {
  // Already present -- skip. A mutation's own onSuccess and a realtime
  // INSERT (Workstream D) can otherwise race and duplicate the row.
  if (data.pages.some((page) => page.memories.some((candidate) => candidate.id === memory.id))) {
    return data;
  }

  const pages = data.pages.map((page) => ({ ...page, memories: [...page.memories] }));

  for (const page of pages) {
    const insertIndex = page.memories.findIndex(
      (candidate) => compareMemoriesDesc(memory, candidate) <= 0,
    );
    if (insertIndex !== -1) {
      page.memories.splice(insertIndex, 0, memory);
      return { ...data, pages };
    }
  }

  // Sorts after everything currently loaded (a backdated memory older than
  // every loaded page). Only safe to append if there is no next page left to
  // fetch -- otherwise it belongs on a page we haven't loaded yet, and
  // appending it here would misorder the boundary once that page loads.
  const lastPage = pages[pages.length - 1];
  if (!lastPage || lastPage.nextCursor) {
    return data;
  }

  lastPage.memories.push(memory);
  return { ...data, pages };
}

// Inserts a newly created/uploaded memory at its sorted position
// (memory_date desc, created_at desc) within already-loaded pages of every
// matching list cache -- the base timeline and any cached member-filtered
// queries this memory tags. Used instead of a raw unshift because media
// memories are routinely backdated (EXIF capture-date prefill), and with no
// reconciling refetch (see invalidateMemoryQueries above) a literal prepend
// would misorder those rows until the next pull-to-refresh.
export function prependMemoryToListCaches(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memory: MemoryWithTags,
): void {
  const matches = queryClient.getQueryCache().findAll({
    predicate: (query) => isMemoriesListQueryKey(query.queryKey) && query.queryKey[1] === familyId,
  });

  for (const query of matches) {
    if (!memoryBelongsToListKey(memory, query.queryKey)) {
      continue;
    }

    queryClient.setQueryData<InfiniteData<MemoriesPage>>(query.queryKey, (current) =>
      isInfiniteMemoriesData(current) ? insertMemorySorted(current, memory) : current,
    );
  }
}

export function removeMemoryFromListCaches(
  queryClient: QueryClient,
  familyId: string | null | undefined,
  memoryId: string,
): void {
  queryClient.setQueriesData<InfiniteData<MemoriesPage>>(
    {
      predicate: (query) =>
        isMemoriesListQueryKey(query.queryKey) && query.queryKey[1] === familyId,
    },
    (current) => {
      if (!isInfiniteMemoriesData(current)) {
        return current;
      }

      return {
        ...current,
        pages: current.pages.map((page) => ({
          ...page,
          memories: page.memories.filter((candidate) => candidate.id !== memoryId),
        })),
      };
    },
  );
}
