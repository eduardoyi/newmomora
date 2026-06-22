import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { useAuth } from '@/hooks/use-auth';
import { calendarMemoriesQueryKey, memoriesQueryKey } from '@/hooks/queryKeys';
import {
  createMediaMemory,
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
import { deleteStorageObject, uploadMediaObject } from '@/services/media';
import {
  needsIllustrationRecovery,
  type MemoryType,
} from '@/utils/memories';
import {
  isEmotionAnalyzable,
  memoriesNeedEmotionPolling,
  shouldPollForEmotion,
} from '@/utils/media-emotion-polling';
import { buildMemoryMediaAssetKey } from '@/utils/storage-keys';
import { getMediaExtensionFromContentType, isVideoContentType } from '@/utils/media-validation';

const MEDIA_UPLOAD_CONCURRENCY = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidateMemoryQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.invalidateQueries({ queryKey: memoriesQueryKey });
  queryClient.invalidateQueries({ queryKey: calendarMemoriesQueryKey });
}

function isMemoriesListQueryKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === memoriesQueryKey[0] && queryKey[1] !== 'detail';
}

function setMemoryIllustrationPendingInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  memoryId: string,
): void {
  const patchMemory = (memory: MemoryWithTags): MemoryWithTags =>
    memory.id === memoryId ? { ...memory, illustration_status: 'pending' } : memory;

  queryClient.setQueriesData<MemoryWithTags[]>({
    predicate: (query) => isMemoriesListQueryKey(query.queryKey),
  }, (current) => (Array.isArray(current) ? current.map(patchMemory) : current));

  queryClient.setQueryData<MemoryWithTags | null>(
    [...memoriesQueryKey, 'detail', memoryId],
    (current) => (current ? patchMemory(current) : current),
  );
}

export interface CreateMemoryMutationInput {
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
  memoryType?: MemoryType;
}

export interface CreateMediaMemoryMutationInput {
  memoryId: string;
  mediaAssets: MemoryMediaMutationAsset[];
  content?: string;
  memoryDate: string;
  taggedMemberIds: string[];
}

export interface MemoryMediaMutationAsset {
  objectKey?: string;
  fileUri?: string;
  mediaAssetId?: string;
  contentType: string;
  durationMs?: number | null;
}

function createUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function hasImageMediaAsset(assets: Array<{ contentType: string }>): boolean {
  return assets.some((asset) => !isVideoContentType(asset.contentType));
}

function getStorageMediaAssetId(mediaAssetId?: string): string {
  return mediaAssetId && UUID_PATTERN.test(mediaAssetId) ? mediaAssetId : createUuid();
}

async function mapMediaUploads<T>(
  assets: MemoryMediaMutationAsset[],
  uploadAsset: (asset: MemoryMediaMutationAsset) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(assets.length);
  let nextIndex = 0;
  let firstError: unknown = null;

  async function worker() {
    while (nextIndex < assets.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      try {
        results[currentIndex] = await uploadAsset(assets[currentIndex]);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(MEDIA_UPLOAD_CONCURRENCY, assets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (firstError) {
    throw firstError;
  }

  return results;
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

export function useMemories(searchQuery = '') {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const recoveringIllustrationsRef = useRef(new Set<string>());
  const recoveringEmotionsRef = useRef(new Set<string>());

  const query = useQuery({
    queryKey: [...memoriesQueryKey, searchQuery],
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

  useEffect(() => {
    const memories = query.data ?? [];

    for (const memory of memories) {
      if (!needsIllustrationRecovery(memory)) {
        continue;
      }

      if (recoveringIllustrationsRef.current.has(memory.id)) {
        continue;
      }

      recoveringIllustrationsRef.current.add(memory.id);

      void retryMemoryIllustration(memory.id)
        .catch((error) => {
          console.warn(
            'Failed to recover stale illustration',
            memory.id,
            error instanceof Error ? error.message : 'unknown',
          );
        })
        .finally(() => {
          recoveringIllustrationsRef.current.delete(memory.id);
          invalidateMemoryQueries(queryClient);
        });
    }
  }, [query.data, queryClient]);

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

      void analyze(memory.id)
        .catch((error) => {
          console.warn(
            'Failed to backfill emotion',
            memory.id,
            error instanceof Error ? error.message : 'unknown',
          );
        })
        .finally(() => {
          invalidateMemoryQueries(queryClient);
        });
    }
  }, [query.data, queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateMemoryMutationInput) => {
      if (!user) {
        throw new Error('You must be signed in to save a memory');
      }

      const { data, error } = await createMemory({
        userId: user.id,
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
    onSuccess: () => {
      invalidateMemoryQueries(queryClient);
    },
  });

  const createMediaMutation = useMutation({
    mutationFn: async (input: CreateMediaMemoryMutationInput) => {
      if (!user) {
        throw new Error('You must be signed in to save a memory');
      }

      const uploadedKeys: string[] = [];

      const uploadAsset = async (asset: MemoryMediaMutationAsset) => {
        if (asset.objectKey) {
          return {
            objectKey: asset.objectKey,
            contentType: asset.contentType,
            durationMs: asset.durationMs ?? null,
          };
        }

        if (!asset.fileUri) {
          throw new Error('Media file is missing');
        }

        const extension = getMediaExtensionFromContentType(asset.contentType);
        if (!extension) {
          throw new Error('Unsupported file type');
        }

        const mediaAssetId = getStorageMediaAssetId(asset.mediaAssetId);
        const mediaKey = buildMemoryMediaAssetKey(
          user.id,
          input.memoryId,
          mediaAssetId,
          extension,
        );
        const { error: uploadError } = await uploadMediaObject(
          mediaKey,
          asset.fileUri,
          asset.contentType,
        );

        if (uploadError) {
          throw toError(uploadError, 'Media upload failed');
        }

        uploadedKeys.push(mediaKey);

        return {
          objectKey: mediaKey,
          contentType: asset.contentType,
          durationMs: asset.durationMs ?? null,
        };
      };

      try {
        const mediaAssets = await mapMediaUploads(input.mediaAssets, uploadAsset);

        const { data, error } = await createMediaMemory({
          userId: user.id,
          memoryId: input.memoryId,
          mediaAssets,
          content: input.content,
          memoryDate: input.memoryDate,
          taggedMemberIds: input.taggedMemberIds,
        });

        if (error) {
          throw toError(error, 'Could not save memory');
        }

        const memory = data as MemoryWithTags;

        if (hasImageMediaAsset(mediaAssets)) {
          void runMediaPhotoEmotionAnalysis(memory.id).finally(() => {
            invalidateMemoryQueries(queryClient);
          });
        }

        return memory;
      } catch (error) {
        await Promise.all(uploadedKeys.map((key) => deleteStorageObject(key)));
        throw toError(error, 'Could not save memory');
      }
    },
    onSuccess: () => {
      invalidateMemoryQueries(queryClient);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: {
      memoryId: string;
      content?: string;
      memoryDate?: string;
      taggedMemberIds?: string[];
      mediaAssets?: MemoryMediaMutationAsset[];
    }) => {
      if (!user) {
        throw new Error('You must be signed in to update a memory');
      }

      const uploadedKeys: string[] = [];

      const uploadAsset = async (asset: MemoryMediaMutationAsset) => {
        if (asset.objectKey) {
          return {
            objectKey: asset.objectKey,
            contentType: asset.contentType,
            durationMs: asset.durationMs ?? null,
          };
        }

        if (!asset.fileUri) {
          throw new Error('Media file is missing');
        }

        const extension = getMediaExtensionFromContentType(asset.contentType);
        if (!extension) {
          throw new Error('Unsupported file type');
        }

        const mediaAssetId = getStorageMediaAssetId(asset.mediaAssetId);
        const mediaKey = buildMemoryMediaAssetKey(
          user.id,
          input.memoryId,
          mediaAssetId,
          extension,
        );
        const { error: uploadError } = await uploadMediaObject(
          mediaKey,
          asset.fileUri,
          asset.contentType,
        );

        if (uploadError) {
          throw toError(uploadError, 'Media upload failed');
        }

        uploadedKeys.push(mediaKey);

        return {
          objectKey: mediaKey,
          contentType: asset.contentType,
          durationMs: asset.durationMs ?? null,
        };
      };

      let data: MemoryWithTags | null = null;
      try {
        const mediaAssets = input.mediaAssets
          ? await mapMediaUploads(input.mediaAssets, uploadAsset)
          : undefined;

        const result = await updateMemory(input.memoryId, {
          content: input.content,
          memoryDate: input.memoryDate,
          taggedMemberIds: input.taggedMemberIds,
          mediaAssets,
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
        void runMediaPhotoEmotionAnalysis(memory.id).finally(() => {
          invalidateMemoryQueries(queryClient);
        });
      }

      return memory;
    },
    onSuccess: () => {
      invalidateMemoryQueries(queryClient);
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
      await queryClient.cancelQueries({ queryKey: memoriesQueryKey });
      setMemoryIllustrationPendingInCache(queryClient, memoryId);
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
      await queryClient.cancelQueries({ queryKey: memoriesQueryKey });
      setMemoryIllustrationPendingInCache(queryClient, memoryId);
    },
    onSettled: () => {
      invalidateMemoryQueries(queryClient);
    },
  });

  return {
    memories: query.data ?? [],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    createMemory: createMutation.mutateAsync,
    isCreating: createMutation.isPending,
    createMediaMemory: createMediaMutation.mutateAsync,
    isCreatingMedia: createMediaMutation.isPending,
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

export function useMemory(memoryId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const recoveringIllustrationRef = useRef(false);
  const previousIllustrationStatusRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: [...memoriesQueryKey, 'detail', memoryId],
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

  useEffect(() => {
    const memory = query.data;

    if (!memory || !needsIllustrationRecovery(memory) || recoveringIllustrationRef.current) {
      return;
    }

    recoveringIllustrationRef.current = true;

    void retryMemoryIllustration(memory.id)
      .catch((error) => {
        console.warn(
          'Failed to recover stale illustration',
          memory.id,
          error instanceof Error ? error.message : 'unknown',
        );
      })
      .finally(() => {
        recoveringIllustrationRef.current = false;
        invalidateMemoryQueries(queryClient);
      });
  }, [query.data, queryClient]);

  useEffect(() => {
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

    void query.refetch();
    queryClient.invalidateQueries({ queryKey: ['media-urls'] });
    queryClient.invalidateQueries({ queryKey: calendarMemoriesQueryKey });
  }, [query.data, query.refetch, queryClient]);

  return query;
}
