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
import { fetchLinkPreviews } from '@/services/ai';
import { runMediaPhotoEmotionAnalysis } from '@/services/memories';
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

        if (hasImageMediaAsset(input.mediaAssets)) {
          void runMediaPhotoEmotionAnalysis(memory.id).finally(() => {
            void queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
            void queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
          });
        }
        notifyFamilyActivityFireAndForget(memory.id);

        // Inline links (docs/plans/inline-links.md §7): media memories are
        // created outside the useMemories mutations, so the caption's URL
        // trigger lives here instead. Reuses this block's invalidation.
        if (input.content && extractUrls(input.content).length > 0) {
          void fetchLinkPreviews(memory.id)
            .catch(() => {})
            .finally(() => {
              void queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] });
              void queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] });
            });
        }

        // Refetch before removing the card so the posted memory replaces it
        // without a gap where neither is visible.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: [memoriesQueryKeyBase] }),
          queryClient.invalidateQueries({ queryKey: [calendarMemoriesQueryKeyBase] }),
        ]);
        removeUpload(input.memoryId);
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
