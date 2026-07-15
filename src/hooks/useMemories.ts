import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { useFamilyPortraitVersions } from '@/hooks/usePortraitVersions';
import {
  calendarMemoriesQueryKeyBase,
  familyMembersQueryKeyBase,
  memoriesQueryKey,
  memoriesQueryKeyBase,
  memoryDetailQueryKey,
} from '@/hooks/queryKeys';
import { canEditFamilyContent } from '@/utils/roles';
import { fetchLinkPreviews } from '@/services/ai';
import {
  createMemory,
  deleteMemory,
  fetchMemories,
  fetchMemoryById,
  regenerateMemoryIllustration,
  retryMemoryIllustration,
  runMediaPhotoEmotionAnalysis,
  runTextOnlyEmotionAnalysis,
  searchMemories,
  updateMemory,
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
  memoriesNeedEmotionPolling,
  shouldPollForEmotion,
} from '@/utils/media-emotion-polling';
import {
  groupPortraitVersionsByMember,
  resolveMemberPortraitFields,
  type FamilyMemberPortraitVersion,
} from '@/utils/portrait-versions';

export type { MemoryMediaMutationAsset } from '@/services/memory-posting';

// Invalidates every family's cached list/detail data (React Query prefix-
// matches array keys, so passing just the base string covers every
// `[base, familyId, ...]` variant). Simpler and safer than tracking the
// current familyId here -- stale entries for other families just refetch
// lazily the next time they're viewed.
function invalidateMemoryQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
  queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
}

// Family members are ordered by how often they're tagged in memories, so any
// mutation that can change tags must refresh that ordering too.
function invalidateFamilyMemberTagOrdering(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.invalidateQueries({ queryKey: [familyMembersQueryKeyBase] });
}

function isMemoriesListQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === memoriesQueryKeyBase && queryKey[2] !== 'detail';
}

// The timeline list cache already holds the full MemoryWithTags (tags + media)
// for every memory it rendered, so the detail screen can paint from it
// immediately while the fresh fetch runs in the background. Scoped to the
// active family so another family's cache never leaks into the detail view.
function findMemoryInListCache(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string | undefined,
): MemoryWithTags | undefined {
  if (!memoryId) {
    return undefined;
  }

  const listEntries = queryClient.getQueriesData<MemoryWithTags[]>({
    predicate: (query) =>
      isMemoriesListQueryKey(query.queryKey) && query.queryKey[1] === familyId,
  });

  for (const [, memories] of listEntries) {
    const memory = Array.isArray(memories)
      ? memories.find((candidate) => candidate.id === memoryId)
      : undefined;

    if (memory) {
      return memory;
    }
  }

  return undefined;
}

// Inline links (docs/plans/inline-links.md §7): fire-and-forget, same slot
// as notifyFamilyActivityFireAndForget -- never awaited on the save path,
// and a failure just leaves links rendered with their domain fallback.
function fireLinkPreviewFetch(
  queryClient: ReturnType<typeof useQueryClient>,
  memoryId: string,
): void {
  void fetchLinkPreviews(memoryId)
    .then(() => invalidateMemoryQueries(queryClient))
    .catch(() => {});
}

function patchMemoryInCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
  patch: Partial<MemoryWithTags>,
): void {
  const patchMemory = (memory: MemoryWithTags): MemoryWithTags =>
    memory.id === memoryId ? { ...memory, ...patch } : memory;

  queryClient.setQueriesData<MemoryWithTags[]>({
    predicate: (query) => isMemoriesListQueryKey(query.queryKey),
  }, (current) => (Array.isArray(current) ? current.map(patchMemory) : current));

  // Calendar range caches hold the same memory rows; the base key also
  // matches the 'oldest-date' entry (a string), which the Array.isArray
  // guard leaves untouched.
  queryClient.setQueriesData<MemoryWithTags[]>({
    queryKey: [calendarMemoriesQueryKeyBase],
  }, (current) => (Array.isArray(current) ? current.map(patchMemory) : current));

  queryClient.setQueryData<MemoryWithTags | null>(
    memoryDetailQueryKey(familyId, memoryId),
    (current) => (current ? patchMemory(current) : current),
  );
}

function setMemoryIllustrationPendingInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
): void {
  // Bump updated_at alongside the status (mirroring the server-side trigger)
  // so needsIllustrationRecovery sees a fresh 'pending' -- without it the
  // recovery effect would treat the patched row as stale-pending and retry
  // in a loop.
  patchMemoryInCaches(queryClient, familyId, memoryId, {
    illustration_status: 'pending',
    updated_at: new Date().toISOString(),
  });
}

function setMemoryEmotionInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  familyId: string | null | undefined,
  memoryId: string,
  emotion: string,
): void {
  patchMemoryInCaches(queryClient, familyId, memoryId, { emotion });
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
      notifyFamilyActivityFireAndForget(memory.id);

      if (variables.content && extractUrls(variables.content).length > 0) {
        fireLinkPreviewFetch(queryClient, memory.id);
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

      if (variables.taggedMemberIds !== undefined) {
        invalidateFamilyMemberTagOrdering(queryClient);
      }

      // Fire whenever content was part of the update -- not only when the
      // new content contains a URL. An edit that removes the last URL must
      // still invoke the function so its prune step clears stale
      // link_previews entries; the no-URL invocation is cheap (prunes to
      // {}, fetches nothing).
      if (variables.content !== undefined) {
        fireLinkPreviewFetch(queryClient, memory.id);
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
    onSuccess: () => {
      invalidateMemoryQueries(queryClient);
      invalidateFamilyMemberTagOrdering(queryClient);
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

export function useMemories(searchQuery = '') {
  const { user } = useAuth();
  const { familyId, role } = useFamily();
  const queryClient = useQueryClient();
  const recoveringIllustrationsRef = useRef(new Set<string>());
  const recoveringEmotionsRef = useRef(new Set<string>());
  const canRecoverIllustrations = canEditFamilyContent(role);
  const portraitVersionsQuery = useFamilyPortraitVersions();

  const query = useQuery({
    queryKey: [...memoriesQueryKey(familyId), searchQuery],
    queryFn: async () => {
      const { data, error } = searchQuery.trim()
        ? await searchMemories(searchQuery)
        : await fetchMemories();

      if (error) {
        throw toError(error, 'Could not load memories');
      }

      return data ?? [];
    },
    enabled: Boolean(user),
    // Every mutation already invalidates this query (invalidateMemoryQueries)
    // and per-memory illustration/emotion updates patch the cache directly,
    // so a short default staleTime just causes wasted full-timeline refetches
    // (up to ~700 memories) on ordinary remounts, e.g. opening a member page.
    staleTime: 5 * 60 * 1000,
    refetchInterval: (queryState) => {
      const memories = queryState.state.data ?? [];
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
  const resolvedMemories = useMemo(
    () =>
      portraitVersionsQuery.data === undefined
        ? query.data ?? []
        : resolveMemoryTagPortraits(query.data ?? [], portraitVersionsQuery.data),
    [query.data, portraitVersionsQuery.data],
  );

  // Viewers' writes are RLS-rejected (memories: update requires manager+),
  // so a viewer running this would have its illustration_status UPDATE and
  // generate-illustration call rejected every time -- a permanent retry
  // loop (plan §7's analyze-emotion row explains the same failure shape).
  useEffect(() => {
    if (!canRecoverIllustrations) {
      return;
    }

    const memories = query.data ?? [];

    for (const memory of memories) {
      if (!needsIllustrationRecovery(memory)) {
        continue;
      }

      if (recoveringIllustrationsRef.current.has(memory.id)) {
        continue;
      }

      recoveringIllustrationsRef.current.add(memory.id);

      // Patch just this memory to 'pending' instead of invalidating every
      // memory query -- the list's 3s illustration polling picks up the real
      // status from there. With hundreds of memories, per-recovery full
      // invalidations used to trigger repeated whole-timeline refetches.
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
  }, [query.data, queryClient, familyId, canRecoverIllustrations]);

  // Backfill emotion tags for memories that were never analyzed or whose
  // analysis previously failed (e.g. older text_only entries). One attempt per
  // memory per session; the edge function's cooldown guards against races with
  // the create-time triggers.
  useEffect(() => {
    const memories = query.data ?? [];

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
      // invalidating every memory query per analyzed memory -- with a large
      // backfill (e.g. freshly migrated libraries) those invalidations
      // caused a full-timeline refetch per memory.
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
  }, [query.data, queryClient, familyId]);

  const mutations = useMemoryMutations();

  return {
    memories: resolvedMemories,
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    ...mutations,
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
