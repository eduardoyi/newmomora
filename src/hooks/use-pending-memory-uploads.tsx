import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { calendarMemoriesQueryKeyBase, memoriesQueryKeyBase } from '@/hooks/queryKeys';
import {
  patchMemoryInCaches,
  prependMemoryToListCaches,
  setMemoryEmotionInCache,
} from '@/hooks/memory-cache';
import { fetchLinkPreviews } from '@/services/ai';
import { runMediaPhotoEmotionAnalysis, type MemoryWithTags } from '@/services/memories';
import {
  hasImageMediaAsset,
  notifyFamilyActivityFireAndForget,
  postMediaMemory,
  type PostMediaMemoryInput,
} from '@/services/memory-posting';
import { extractUrls } from '@/utils/links';

export type PendingMemoryUploadStatus = 'posting' | 'failed';

export interface PendingMemoryUpload {
  memoryId: string;
  familyId: string;
  status: PendingMemoryUploadStatus;
  totalAssets: number;
  uploadedAssets: number;
  errorMessage: string | null;
  previewUri: string | null;
  previewContentType: string | null;
}

interface PendingMemoryUploadsContextValue {
  uploads: PendingMemoryUpload[];
  enqueue: (input: PostMediaMemoryInput) => void;
  retry: (memoryId: string) => void;
  discard: (memoryId: string) => void;
}

const PendingMemoryUploadsContext = createContext<PendingMemoryUploadsContextValue | null>(null);

// Instagram-style deferred posting: the composer hands the memory to this
// queue and closes immediately; timeline/calendar render the queue as
// progress cards. Uploads live here (mounted for the whole app session in
// AppProviders) so they survive the composer unmounting. The queue is
// in-memory only -- a force-quit mid-upload loses the pending post (v1
// tradeoff; persistence is backlog).
export function PendingMemoryUploadsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { familyId } = useFamily();
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<PendingMemoryUpload[]>([]);
  // Original inputs (incl. local file URIs) plus the user/family captured at
  // enqueue time, kept out of render state so failed posts can be retried
  // without the composer -- and retried against the family they were composed
  // for even if the user has switched active family since.
  const inputsRef = useRef(
    new Map<string, { input: PostMediaMemoryInput; userId: string; familyId: string }>(),
  );

  const patchUpload = useCallback(
    (memoryId: string, patch: Partial<PendingMemoryUpload>) => {
      setUploads((current) =>
        current.map((upload) =>
          upload.memoryId === memoryId ? { ...upload, ...patch } : upload,
        ),
      );
    },
    [],
  );

  const removeUpload = useCallback((memoryId: string) => {
    inputsRef.current.delete(memoryId);
    setUploads((current) => current.filter((upload) => upload.memoryId !== memoryId));
  }, []);

  const runUpload = useCallback(
    async (input: PostMediaMemoryInput, userId: string, activeFamilyId: string) => {
      try {
        const memory = await postMediaMemory({
          userId,
          familyId: activeFamilyId,
          input,
          onAssetUploaded: () => {
            setUploads((current) =>
              current.map((upload) =>
                upload.memoryId === input.memoryId
                  ? { ...upload, uploadedAssets: upload.uploadedAssets + 1 }
                  : upload,
              ),
            );
          },
        });

        // postMediaMemory already returns the enriched row -- prepend it
        // (sorted by memory_date desc, created_at desc) into whichever list
        // caches it belongs to instead of relying on a refetch to surface
        // it. The memoriesQueryKeyBase invalidations below are now
        // refetchType: 'none' backstops (Workstream A4b): with list caches
        // as InfiniteData, a refetching invalidation would re-run every
        // loaded page's enrichment round-trips per media post -- the exact
        // regression this rework prevents. Calendar stays a normal
        // (refetching) invalidation -- it's array-shaped, windowed, cheap.
        prependMemoryToListCaches(queryClient, activeFamilyId, memory);
        // The card is already replaced by the prepended memory, so there's
        // no gap to bridge by waiting on a refetch before removing it.
        removeUpload(input.memoryId);

        if (hasImageMediaAsset(input.mediaAssets)) {
          void runMediaPhotoEmotionAnalysis(memory.id)
            .then((emotion) => {
              if (emotion) {
                setMemoryEmotionInCache(queryClient, activeFamilyId, memory.id, emotion);
              }
            })
            .finally(() => {
              queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase], refetchType: 'none' });
              queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
            });
        }
        notifyFamilyActivityFireAndForget(memory.id);

        // Inline links (docs/plans/inline-links.md §7): media memories are
        // created outside the useMemories mutations, so the caption's URL
        // trigger lives here instead. fetch-link-previews returns the
        // resolved map in its response -- patch it straight in rather than
        // invalidating, or a posted URL would show its domain fallback
        // until the next reconciling refresh (see fireLinkPreviewFetch in
        // useMemories.ts for the same fix on the non-media create/update path).
        if (input.content && extractUrls(input.content).length > 0) {
          void fetchLinkPreviews(memory.id)
            .then((result) => {
              if (result.data) {
                patchMemoryInCaches(queryClient, activeFamilyId, memory.id, {
                  link_previews: result.data.linkPreviews as unknown as MemoryWithTags['link_previews'],
                });
              }
            })
            .catch(() => {})
            .finally(() => {
              queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase], refetchType: 'none' });
              queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
            });
        }

        queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase], refetchType: 'none' });
        queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
      } catch (error) {
        patchUpload(input.memoryId, {
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : 'Could not save memory',
        });
      }
    },
    [patchUpload, queryClient, removeUpload],
  );

  const enqueue = useCallback(
    (input: PostMediaMemoryInput) => {
      if (!user) {
        throw new Error('You must be signed in to save a memory');
      }
      if (!familyId) {
        throw new Error('You must have a family to save a memory');
      }

      const previewAsset = input.mediaAssets[0];
      inputsRef.current.set(input.memoryId, { input, userId: user.id, familyId });
      setUploads((current) => [
        ...current,
        {
          memoryId: input.memoryId,
          familyId,
          status: 'posting',
          totalAssets: input.mediaAssets.length,
          uploadedAssets: 0,
          errorMessage: null,
          previewUri: previewAsset?.fileUri ?? null,
          previewContentType: previewAsset?.contentType ?? null,
        },
      ]);

      void runUpload(input, user.id, familyId);
    },
    [user, familyId, runUpload],
  );

  const retry = useCallback(
    (memoryId: string) => {
      const record = inputsRef.current.get(memoryId);
      if (!record) {
        return;
      }

      // Failed posts had their partial uploads rolled back, so retry restarts
      // from zero -- against the enqueue-time user/family, not the current one.
      patchUpload(memoryId, { status: 'posting', uploadedAssets: 0, errorMessage: null });
      void runUpload(record.input, record.userId, record.familyId);
    },
    [patchUpload, runUpload],
  );

  const value = useMemo(
    () => ({ uploads, enqueue, retry, discard: removeUpload }),
    [uploads, enqueue, retry, removeUpload],
  );

  return (
    <PendingMemoryUploadsContext.Provider value={value}>
      {children}
    </PendingMemoryUploadsContext.Provider>
  );
}

export function usePendingMemoryUploads(): PendingMemoryUploadsContextValue {
  const context = useContext(PendingMemoryUploadsContext);
  if (!context) {
    throw new Error(
      'usePendingMemoryUploads must be used within PendingMemoryUploadsProvider',
    );
  }
  return context;
}
