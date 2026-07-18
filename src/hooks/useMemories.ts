import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import { useGenerationStatusPolling } from '@/hooks/useGenerationStatusPolling';
import {
  calendarMemoriesQueryKeyBase,
  familyMembersQueryKeyBase,
  memoriesQueryKey,
  memoriesSearchQueryKey,
  memoryDetailQueryKey,
} from '@/hooks/queryKeys';
import {
  findMemoryInListCache,
  invalidateMemoryQueries,
  patchMemoryInCaches,
  prependMemoryToListCaches,
  removeMemoryFromListCaches,
  setMemoryEmotionInCache,
  setMemoryIllustrationPendingInCache,
} from '@/hooks/memory-cache';
import { canEditFamilyContent } from '@/utils/roles';
import { fetchLinkPreviews } from '@/services/ai';
import {
  createMemory,
  deleteMemory,
  fetchMemoriesPage,
  fetchMemoriesPageForMember,
  fetchMemoryById,
  regenerateMemoryIllustration,
  retryMemoryIllustration,
  runMediaPhotoEmotionAnalysis,
  runTextOnlyEmotionAnalysis,
  searchMemories,
  updateMemory,
  MEMORIES_PAGE_SIZE,
  type MemoriesPage,
  type MemoriesPageCursor,
  type MemoryWithTags,
} from '@/services/memories';
import { deleteStorageObject } from '@/services/media';
import {
  hasImageMediaAsset,
  notifyFamilyActivityFireAndForget,
  uploadMemoryMediaAssets,
  type MemoryMediaMutationAsset,
} from '@/services/memory-posting';
import { extractUrls } from '@/utils/links';
import {
  needsIllustrationRecovery,
  type MemoryType,
} from '@/utils/memories';
import {
  isEmotionAnalyzable,
  shouldPollForEmotion,
} from '@/utils/media-emotion-polling';
import {
  groupPortraitVersionsByMember,
  resolveMemberPortraitFields,
  type FamilyMemberPortraitVersion,
} from '@/utils/portrait-versions';

export type { MemoryMediaMutationAsset } from '@/services/memory-posting';

// Family members are ordered by how often they're tagged in memories, so any
// mutation that can change tags must refresh that ordering too.
function invalidateFamilyMemberTagOrdering(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
}

function dedupeMemoriesById(memories: MemoryWithTags[]): MemoryWithTags[] {
  const seen = new Set<string>();
  const deduped: MemoryWithTags[] = [];

  for (const memory of memories) {
    if (seen.has(memory.id)) {
      continue;
    }
    seen.add(memory.id);
    deduped.push(memory);
  }

  return deduped;
}

// Trims a cached infinite memories query down to its first page. Used ahead
// of a single-page refetch() (pull-to-refresh / app-foreground reconcile) --
// refetch() on an infinite query sequentially refetches every currently
// loaded page (each with its own enrichment round-trips), so trimming first
// keeps that reconciliation to one page's cost instead of N.
function trimListCacheToFirstPage(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
): void {
  queryClient.setQueryData<InfiniteData<MemoriesPage>>(memoriesQueryKey(familyId), (current) => {
    if (!current || current.pages.length <= 1) {
      return current;
    }

    return {
      pages: current.pages.slice(0, 1),
      pageParams: current.pageParams.slice(0, 1),
    };
  });
}

// Inline links (docs/plans/inline-links.md §7): fire-and-forget, same slot
// as notifyFamilyActivityFireAndForget -- never awaited on the save path,
// and a failure just leaves links rendered with their domain fallback.
// fetch-link-previews already returns the resolved linkPreviews map in its
// response, so patch it straight into the caches instead of invalidating
// (Workstream A4b) -- otherwise a posted URL would keep showing its domain
// fallback until the next reconciling refresh.
function fireLinkPreviewFetch(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
): void {
  void fetchLinkPreviews(memoryId)
    .then((result) => {
      if (result.data) {
        patchMemoryInCaches(queryClient, familyId, memoryId, {
          link_previews: result.data.linkPreviews as unknown as MemoryWithTags['link_previews'],
        });
      }
    })
    .catch(() => {});
}

function resolveMemoryTagPortraits(
  memories: readonly MemoryWithTags[],
  portraitVersions: readonly FamilyMemberPortraitVersion[],
): MemoryWithTags[] {
  const portraitMap = groupPortraitVersionsByMember(portraitVersions);
  return memories.map((memory) => ({
    ...memory,
    taggedMembers: memory.taggedMembers.map((member) => {
      const versions = portraitMap.get(member.id) ?? [];
      return versions.length === 0
        ? member
        : {
            ...member,
            ...resolveMemberPortraitFields(versions, memory.memory_date, member.updated_at),
          };
    }),
  }));
}

export interface CreateMemoryMutationInput {
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
  memoryType?: MemoryType;
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

// Memory mutations without the timeline list query. Screens that only mutate
// (detail, edit, new-memory) mount this instead of useMemories so opening
// them doesn't subscribe to -- and refetch -- the whole timeline.
export function useMemoryMutations() {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: async (input: CreateMemoryMutationInput) => {
      if (!user) {
        throw new Error('You must be signed in to save a memory');
      }
      if (!familyId) {
        throw new Error('You must have a family to save a memory');
      }

      const { data, error } = await createMemory({
        userId: user.id,
        familyId,
        content: input.content,
        memoryDate: input.memoryDate,
        taggedMemberIds: input.taggedMemberIds,
        memoryType: input.memoryType,
      });

      if (error) {
        throw toError(error, 'Could not save memory');
      }

      return data as MemoryWithTags;
    },
    onSuccess: (memory, variables) => {
      invalidateMemoryQueries(queryClient);
      invalidateFamilyMemberTagOrdering(queryClient);
      prependMemoryToListCaches(queryClient, familyId, memory);
      notifyFamilyActivityFireAndForget(memory.id);

      if (variables.content && extractUrls(variables.content).length > 0) {
        fireLinkPreviewFetch(queryClient, familyId, memory.id);
      }
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      memoryId: string;
      content?: string;
      memoryDate?: string;
      taggedMemberIds?: string[];
      mediaAssets?: MemoryMediaMutationAsset[];
      memoryType?: MemoryType;
    }) => {
      if (!user) {
        throw new Error('You must be signed in to update a memory');
      }
      if (!familyId) {
        throw new Error('You must have a family to update a memory');
      }

      const activeFamilyId = familyId;
      const uploadedKeys: string[] = [];

      let data: MemoryWithTags | null = null;
      try {
        const mediaAssets = input.mediaAssets
          ? await uploadMemoryMediaAssets({
              userId: user.id,
              familyId: activeFamilyId,
              memoryId: input.memoryId,
              assets: input.mediaAssets,
              uploadedKeys,
            })
          : undefined;

        const result = await updateMemory(input.memoryId, {
          content: input.content,
          memoryDate: input.memoryDate,
          taggedMemberIds: input.taggedMemberIds,
          mediaAssets,
          memoryType: input.memoryType,
        });

        if (result.error) {
          throw toError(result.error, 'Could not update memory');
        }

        data = result.data;
      } catch (error) {
        await Promise.all(uploadedKeys.map((key) => deleteStorageObject(key)));
        throw toError(error, 'Could not update memory');
      }

      const memory = data as MemoryWithTags;
      const captionChanged = input.content !== undefined;
      const mediaChanged = input.mediaAssets !== undefined;
      const isPhotoMedia = memory.memory_type === 'media' && hasImageMediaAsset(
        memory.mediaAssets.map((asset) => ({ contentType: asset.content_type })),
      );

      if ((captionChanged || mediaChanged) && isPhotoMedia) {
        void runMediaPhotoEmotionAnalysis(memory.id)
          .then((emotion) => {
            if (emotion) {
              setMemoryEmotionInCache(queryClient, familyId, memory.id, emotion);
            }
          })
          .catch(() => {});
      }

      return memory;
    },
    onSuccess: (memory, variables) => {
      invalidateMemoryQueries(queryClient);
      patchMemoryInCaches(queryClient, familyId, memory.id, memory);

      if (variables.taggedMemberIds !== undefined) {
        invalidateFamilyMemberTagOrdering(queryClient);
      }

      // Fire whenever content was part of the update -- not only when the
      // new content contains a URL. An edit that removes the last URL must
      // still invoke the function so its prune step clears stale
      // link_previews entries; the no-URL invocation is cheap (prunes to
      // {}, fetches nothing).
      if (variables.content !== undefined) {
        fireLinkPreviewFetch(queryClient, familyId, memory.id);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (memoryId: string) => {
      const { error } = await deleteMemory(memoryId);

      if (error) {
        throw toError(error, 'Could not delete memory');
      }
    },
    onSuccess: (_data, memoryId) => {
      invalidateMemoryQueries(queryClient);
      invalidateFamilyMemberTagOrdering(queryClient);
      removeMemoryFromListCaches(queryClient, familyId, memoryId);
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (memoryId: string) => {
      const { error } = await retryMemoryIllustration(memoryId);

      if (error) {
        throw toError(error, 'Could not retry illustration');
      }
    },
    onMutate: async (memoryId) => {
      await queryClient.cancelQueries({ queryKey: memoriesQueryKey(familyId) });
      setMemoryIllustrationPendingInCache(queryClient, familyId, memoryId);
    },
    onSettled: () => {
      invalidateMemoryQueries(queryClient);
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async (memoryId: string) => {
      const { error } = await regenerateMemoryIllustration(memoryId);

      if (error) {
        throw toError(error, 'Could not regenerate illustration');
      }
    },
    onMutate: async (memoryId) => {
      await queryClient.cancelQueries({ queryKey: memoriesQueryKey(familyId) });
      setMemoryIllustrationPendingInCache(queryClient, familyId, memoryId);
    },
    onSettled: () => {
      invalidateMemoryQueries(queryClient);
    },
  });

  return {
    createMemory: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    updateMemory: updateMutation.mutateAsync,
    isUpdating: updateMutation.isPending,
    deleteMemory: deleteMutation.mutateAsync,
    isDeleting: deleteMutation.isPending,
    retryIllustration: retryMutation.mutateAsync,
    isRetrying: retryMutation.isPending,
    regenerateIllustration: regenerateMutation.mutateAsync,
    isRegenerating: regenerateMutation.isPending,
  };
}

// Timeline feed (Workstream A1/A2). Keyset-paginated (40/page) instead of
// loading the full family history -- fetchNextPage/hasNextPage/
// isFetchingNextPage are exposed for the list to page in more as the user
// scrolls. `memories` is the flattened, id-deduplicated set of every page
// loaded so far (dedup guards against a row shifting pages between
// fetches), not the whole library.
export function useMemories(options?: { shouldReconcileOnForeground?: () => boolean }) {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const recoveringIllustrationsRef = useRef(new Set<string>());
  const recoveringEmotionsRef = useRef(new Set<string>());
  const canRecoverIllustrations = canEditFamilyContent(role);
  const portraitVersionsQuery = useFamilyPortraitVersions();

  // Shared status poll (A5) -- mounting it here means this hook's own
  // re-renders (e.g. a mutation patching a new pending memory into this
  // list) make react-query re-evaluate the poll's refetchInterval callback,
  // which is what wakes it from idle. See useGenerationStatusPolling.ts.
  useGenerationStatusPolling();

  const query = useInfiniteQuery({
    queryKey: memoriesQueryKey(familyId),
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchMemoriesPage({
        cursor: pageParam ?? undefined,
        limit: MEMORIES_PAGE_SIZE,
      });

      if (error) {
        throw toError(error, 'Could not load memories');
      }

      return data ?? { memories: [], nextCursor: null };
    },
    initialPageParam: null as MemoriesPageCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(user && familyId),
    // Every mutation already patches or invalidates this query
    // (invalidateMemoryQueries) and per-memory illustration/emotion updates
    // patch the cache directly, so a short default staleTime just causes
    // wasted page-1 refetches on ordinary remounts, e.g. switching tabs.
    staleTime: 5 * 60 * 1000,
    // v5 refetches every loaded page of a stale infinite query on window
    // focus. Tab screens never unmount, so that would reintroduce the
    // whole-timeline cost this workstream removes -- refreshFirstPage below
    // (pull-to-refresh + the AppState handler) is the intended
    // reconciliation path instead.
    refetchOnWindowFocus: false,
  });

  const isStaleRef = useRef(query.isStale);
  isStaleRef.current = query.isStale;
  // Ref (not a dep) so a caller passing a new function identity each render
  // -- as the timeline screen does -- doesn't resubscribe the AppState
  // effect below.
  const shouldReconcileOnForegroundRef = useRef(options?.shouldReconcileOnForeground);
  shouldReconcileOnForegroundRef.current = options?.shouldReconcileOnForeground;
  const refetchQuery = query.refetch;

  const refreshFirstPage = useCallback(async () => {
    // Do NOT use resetQueries (clears data and flips the query to
    // isLoading, swapping the pulled list for the full-screen spinner
    // branch mid-gesture) or react-query's maxPages (evicts from the FRONT
    // of `pages` on this forward-only infinite query, i.e. drops the NEWEST
    // page and permanently hides new memories once pageParams desync -- see
    // docs/plans/performance-optimizations.md §A4). Pull-to-refresh can only
    // fire while the user is at the top of the list, and the AppState
    // handler below only calls this when the caller reports the scroll
    // position is near the top too (see shouldReconcileOnForeground) -- so
    // trimming to page 1 before refetching stays correct UX and keeps the
    // refetch to a single page's enrichment cost.
    trimListCacheToFirstPage(queryClient, familyId);
    await refetchQuery();
  }, [queryClient, familyId, refetchQuery]);

  // A4a: refetchOnWindowFocus is off above, and tab screens never unmount
  // (so "next mount" never reconciles this query either) -- reconcile
  // explicitly on app foreground when the query has gone stale, using the
  // same trim-to-page-1 refresh as pull-to-refresh. Trimming to page 1 only
  // reads correctly when the user is actually near the top of the list, so
  // the optional shouldReconcileOnForeground getter gates it -- a caller
  // that's scrolled deep returns false and the reconcile is skipped rather
  // than collapsing the loaded pages out from under the visible scroll
  // position (which clamps the scroll to the bottom of the shortened list).
  // A skipped reconcile isn't lost, just deferred: it happens on the next
  // pull-to-refresh or the next foreground-while-near-top instead. Other
  // members' content edits/retags/engagement reconcile here or on
  // pull-to-refresh, not mid-session (documented in
  // docs/features/memories.md).
  useEffect(() => {
    if (!familyId) {
      return;
    }

    const subscription = AppState.addEventListener('change', (status) => {
      const shouldReconcile = shouldReconcileOnForegroundRef.current;
      if (
        status === 'active' &&
        isStaleRef.current &&
        (shouldReconcile === undefined || shouldReconcile())
      ) {
        void refreshFirstPage();
      }
    });

    return () => subscription.remove();
  }, [familyId, refreshFirstPage]);

  const rawMemories = useMemo(
    () => query.data?.pages.flatMap((page) => page.memories) ?? [],
    [query.data],
  );
  const memories = useMemo(() => dedupeMemoriesById(rawMemories), [rawMemories]);

  const resolvedMemories = useMemo(
    () =>
      portraitVersionsQuery.data === undefined
        ? memories
        : resolveMemoryTagPortraits(memories, portraitVersionsQuery.data),
    [memories, portraitVersionsQuery.data],
  );

  // Viewers' writes are RLS-rejected (memories: update requires manager+),
  // so a viewer running this would have its illustration_status UPDATE and
  // generate-illustration call rejected every time -- a permanent retry
  // loop (plan §7's analyze-emotion row explains the same failure shape).
  //
  // A7: this only walks memories the user has actually paged into this
  // session (bounded work), not the whole library -- a memory stuck
  // pending/generating deep in history now only self-heals when its page is
  // loaded or its detail screen is opened. A server-side periodic sweep
  // would be the durable fix; out of scope here (see docs/features/memories.md).
  useEffect(() => {
    if (!canRecoverIllustrations) {
      return;
    }

    for (const memory of memories) {
      if (!needsIllustrationRecovery(memory)) {
        continue;
      }

      if (recoveringIllustrationsRef.current.has(memory.id)) {
        continue;
      }

      recoveringIllustrationsRef.current.add(memory.id);

      // Patch just this memory to 'pending' instead of invalidating every
      // memory query -- the shared A5 poll picks up the real status from
      // there once it notices the pending row.
      void retryMemoryIllustration(memory.id)
        .then(({ error }) => {
          if (error) {
            console.warn('Failed to recover stale illustration', memory.id, error.message);
            return;
          }

          setMemoryIllustrationPendingInCache(queryClient, familyId, memory.id);
        })
        .catch((error) => {
          console.warn(
            'Failed to recover stale illustration',
            memory.id,
            error instanceof Error ? error.message : 'unknown',
          );
        })
        .finally(() => {
          recoveringIllustrationsRef.current.delete(memory.id);
        });
    }
  }, [memories, queryClient, familyId, canRecoverIllustrations]);

  // Backfill emotion tags for memories that were never analyzed or whose
  // analysis previously failed (e.g. older text_only entries). One attempt per
  // memory per session; the edge function's cooldown guards against races with
  // the create-time triggers. Same A7 loaded-pages-only bound as above.
  useEffect(() => {
    for (const memory of memories) {
      if (!isEmotionAnalyzable(memory)) {
        continue;
      }

      if (
        memory.memory_type === 'text_illustration' &&
        (memory.illustration_status === 'pending' || memory.illustration_status === 'generating')
      ) {
        continue;
      }

      if (recoveringEmotionsRef.current.has(memory.id)) {
        continue;
      }

      recoveringEmotionsRef.current.add(memory.id);

      const analyze =
        memory.memory_type === 'media'
          ? runMediaPhotoEmotionAnalysis
          : runTextOnlyEmotionAnalysis;

      // Patch the resolved emotion straight into the caches rather than
      // invalidating every memory query per analyzed memory.
      void analyze(memory.id)
        .then((emotion) => {
          if (emotion) {
            setMemoryEmotionInCache(queryClient, familyId, memory.id, emotion);
          }
        })
        .catch((error) => {
          console.warn(
            'Failed to backfill emotion',
            memory.id,
            error instanceof Error ? error.message : 'unknown',
          );
        });
    }
  }, [memories, queryClient, familyId]);

  const mutations = useMemoryMutations();

  return {
    memories: resolvedMemories,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    // Pull-to-refresh / manual retry: trims to page 1 then refetches (see
    // refreshFirstPage above), NOT a raw multi-page query.refetch().
    refetch: refreshFirstPage,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    ...mutations,
  };
}

// Search results (Workstream A2): a separate, non-infinite query so the
// InfiniteData shape the timeline/member lists rely on never has to share a
// cache-key prefix with a flat search-results array. Search currently has no
// reachable UI (no caller sets a non-empty query), so this is exercised by
// tests only until the search feature ships -- see E1b/E2/E3 for the rest of
// the search work.
export function useMemoriesSearch(searchQuery: string) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const trimmed = searchQuery.trim();

  const query = useQuery({
    queryKey: memoriesSearchQueryKey(familyId, trimmed),
    queryFn: async () => {
      const { data, error } = await searchMemories(trimmed);

      if (error) {
        throw toError(error, 'Could not search memories');
      }

      return data ?? [];
    },
    enabled: Boolean(user && familyId && trimmed),
  });

  return {
    memories: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}

export function useMemory(memoryId: string | undefined) {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const recoveringIllustrationRef = useRef(false);
  const previousIllustrationStatusRef = useRef<string | null>(null);
  const canRecoverIllustrations = canEditFamilyContent(role);
  const portraitVersionsQuery = useFamilyPortraitVersions();

  const query = useQuery({
    queryKey: memoryDetailQueryKey(familyId, memoryId),
    queryFn: async () => {
      if (!memoryId) {
        return null;
      }

      const { data, error } = await fetchMemoryById(memoryId);

      if (error) {
        throw toError(error, 'Could not load memory');
      }

      return data;
    },
    enabled: Boolean(user && memoryId),
    placeholderData: () => findMemoryInListCache(queryClient, familyId, memoryId),
    // Kept as its own single-row poll (unlike the list queries' A5 poll) --
    // it refetches one memory, which is cheap and self-contained.
    refetchInterval: (queryState) => {
      const memory = queryState.state.data;
      if (!memory) {
        return false;
      }

      if (
        memory.illustration_status === 'pending' ||
        memory.illustration_status === 'generating'
      ) {
        return 3000;
      }

      return shouldPollForEmotion(memory) ? 5000 : false;
    },
  });
  const refetchMemory = query.refetch;

  useEffect(() => {
    // Never act on the list-cache placeholder: its illustration_status can be
    // minutes stale (e.g. cache says 'generating' when the server already
    // marked it 'failed'), and firing recovery off it would relaunch the
    // OpenAI pipeline behind the manual retry gate. Recovery re-evaluates
    // once the real fetch resolves.
    if (query.isPlaceholderData) {
      return;
    }

    const memory = query.data;

    if (
      !canRecoverIllustrations ||
      !memory ||
      !needsIllustrationRecovery(memory) ||
      recoveringIllustrationRef.current
    ) {
      return;
    }

    recoveringIllustrationRef.current = true;

    // Patch just this memory to 'pending' (with a fresh updated_at) instead
    // of invalidating every memory query; the detail query's own 3s
    // illustration polling takes over from there.
    void retryMemoryIllustration(memory.id)
      .then(({ error }) => {
        if (error) {
          console.warn('Failed to recover stale illustration', memory.id, error.message);
          return;
        }

        setMemoryIllustrationPendingInCache(queryClient, familyId, memory.id);
      })
      .catch((error) => {
        console.warn(
          'Failed to recover stale illustration',
          memory.id,
          error instanceof Error ? error.message : 'unknown',
        );
      })
      .finally(() => {
        recoveringIllustrationRef.current = false;
      });
  }, [query.data, query.isPlaceholderData, queryClient, familyId, canRecoverIllustrations]);

  useEffect(() => {
    // Ignore the placeholder entirely: recording its (possibly stale)
    // 'pending'/'generating' status would make the fresh fetch's 'ready'
    // look like a live transition and trigger a redundant refetch plus
    // app-wide media-url and calendar invalidations on plain navigation.
    if (query.isPlaceholderData) {
      return;
    }

    const memory = query.data;
    const previousStatus = previousIllustrationStatusRef.current;
    previousIllustrationStatusRef.current = memory?.illustration_status ?? null;

    if (
      !memory ||
      memory.illustration_status !== 'ready' ||
      (previousStatus !== 'pending' && previousStatus !== 'generating')
    ) {
      return;
    }

    void refetchMemory();
    queryClient.invalidateQueries({ queryKey: ['media-urls'] });
    queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
  }, [query.data, query.isPlaceholderData, refetchMemory, queryClient]);

  const resolvedMemory = useMemo(() => {
    if (!query.data) return query.data;
    if (portraitVersionsQuery.data === undefined) return query.data;
    return resolveMemoryTagPortraits([query.data], portraitVersionsQuery.data ?? [])[0];
  }, [query.data, portraitVersionsQuery.data]);

  return { ...query, data: resolvedMemory };
}

// Member-profile timeline (Workstream A6): same infinite/keyset shape as
// useMemories, filtered server-side to memories tagging one family member
// instead of client-side filtering the whole (loaded) timeline. The query
// key is deliberately `[...memoriesQueryKey(familyId), 'member', memberId]`
// -- nested under the same memoriesQueryKeyBase/familyId prefix so
// isMemoriesListQueryKey keeps matching it, which is what lets A5's poll,
// D2's realtime patches, and the mutations above keep this screen's status
// live (it used to get that for free by sharing useMemories' unfiltered
// query). It intentionally does NOT run useMemories' recovery/backfill
// effects -- those stay owned by the timeline's loaded pages so opening a
// member profile can't trigger a sweep over that member's whole history.
export function useMemberMemories(memberId: string | undefined) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const portraitVersionsQuery = useFamilyPortraitVersions();

  const query = useInfiniteQuery({
    queryKey: [...memoriesQueryKey(familyId), 'member', memberId],
    queryFn: async ({ pageParam }) => {
      if (!memberId) {
        return { memories: [], nextCursor: null };
      }

      const { data, error } = await fetchMemoriesPageForMember(memberId, {
        cursor: pageParam ?? undefined,
        limit: MEMORIES_PAGE_SIZE,
      });

      if (error) {
        throw toError(error, 'Could not load memories');
      }

      return data ?? { memories: [], nextCursor: null };
    },
    initialPageParam: null as MemoriesPageCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: Boolean(user && familyId && memberId),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const rawMemories = useMemo(
    () => query.data?.pages.flatMap((page) => page.memories) ?? [],
    [query.data],
  );
  const memories = useMemo(() => dedupeMemoriesById(rawMemories), [rawMemories]);

  const resolvedMemories = useMemo(
    () =>
      portraitVersionsQuery.data === undefined
        ? memories
        : resolveMemoryTagPortraits(memories, portraitVersionsQuery.data),
    [memories, portraitVersionsQuery.data],
  );

  return {
    memories: resolvedMemories,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    fetchNextPage: query.fetchNextPage,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
  };
}
