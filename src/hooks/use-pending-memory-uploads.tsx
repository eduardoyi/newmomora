import { onlineManager, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/hooks/use-auth';
import { useFamily } from '@/hooks/use-family';
import { calendarMemoriesQueryKeyBase, memoriesQueryKeyBase } from '@/hooks/queryKeys';
import { trackEvent } from '@/services/analytics';
import {
  patchMemoryInCaches,
  prependMemoryToListCaches,
  setMemoryEmotionInCache,
} from '@/hooks/memory-cache';
import { fetchLinkPreviews } from '@/services/ai';
import {
  patchAudioDescriptionIfEmpty,
  runAudioEmotionAnalysis,
  runMediaPhotoEmotionAnalysis,
  type MemoryWithTags,
} from '@/services/memories';
import {
  hasImageMediaAsset,
  isAudioUploadInput,
  notifyFamilyActivityFireAndForget,
  postAudioMemory,
  postMediaMemory,
  type PendingMemoryUploadInput,
} from '@/services/memory-posting';
import { warmShareCardForMemoryFireAndForget } from '@/services/share-card';
import { extractUrls } from '@/utils/links';
import { isNetworkFailure } from '@/utils/network-errors';

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
  // O6 (docs/plans/offline-awareness-and-share-cards.md): only meaningful
  // when status is 'failed'. Distinguishes a failure worth auto-retrying on
  // reconnect (the device just couldn't reach the server) from a failure
  // that would fail identically again (content-safety rejection,
  // validation, usage-limit) -- blind auto-retry would re-fire doomed
  // posts and double-count `memory_save_failed` analytics.
  isNetworkFailure: boolean;
}

interface PendingMemoryUploadsContextValue {
  uploads: PendingMemoryUpload[];
  enqueue: (input: PendingMemoryUploadInput) => boolean;
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
    new Map<string, { input: PendingMemoryUploadInput; userId: string; familyId: string }>(),
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
    async (input: PendingMemoryUploadInput, userId: string, activeFamilyId: string) => {
      try {
        const onAssetUploaded = () => {
          setUploads((current) =>
            current.map((upload) =>
              upload.memoryId === input.memoryId
                ? { ...upload, uploadedAssets: upload.uploadedAssets + 1 }
                : upload,
            ),
          );
        };

        const isAudio = isAudioUploadInput(input);
        // Audio memories never flow through the image/video upload branch
        // (docs/plans/audio-memories-v1.md P2.4) -- postAudioMemory is a
        // minimal, dedicated pipeline (no compression/strip/preview).
        const memory = isAudio
          ? await postAudioMemory({ userId, familyId: activeFamilyId, input, onAssetUploaded })
          : await postMediaMemory({ userId, familyId: activeFamilyId, input, onAssetUploaded });

        // postMediaMemory/postAudioMemory already return the enriched row --
        // prepend it (sorted by memory_date desc, created_at desc) into
        // whichever list caches it belongs to instead of relying on a
        // refetch to surface it. The memoriesQueryKeyBase invalidations
        // below are now refetchType: 'none' backstops (Workstream A4b): with
        // list caches as InfiniteData, a refetching invalidation would
        // re-run every loaded page's enrichment round-trips per post -- the
        // exact regression this rework prevents. Calendar stays a normal
        // (refetching) invalidation -- it's array-shaped, windowed, cheap.
        prependMemoryToListCaches(queryClient, activeFamilyId, memory);
        // The card is already replaced by the prepended memory, so there's
        // no gap to bridge by waiting on a refetch before removing it.
        removeUpload(input.memoryId);

        if (isAudio && input.pendingTranscription) {
          // Ordering fix (cross-seam bug): the memories row is created by
          // THIS deferred post's insert, which typically finishes AFTER the
          // composer's in-flight transcription resolves. A caller firing
          // patchAudioDescriptionIfEmpty directly off the transcription
          // promise would race that insert -- a Supabase UPDATE matching
          // zero rows succeeds silently, permanently losing the
          // description/transcript in the common fast-save case. Chaining
          // off the promise HERE, after postAudioMemory has already
          // resolved (the row now exists), guarantees the patch always
          // lands after the insert. On a failed post this branch is never
          // reached (retry re-runs runUpload, re-chaining onto the same
          // already-resolved promise then fires immediately -- correct); on
          // discard it's never reached at all.
          input.pendingTranscription
            .then((result) => {
              if (!result) {
                return;
              }
              void patchAudioDescriptionIfEmpty(memory.id, {
                description: result.description.trim() || null,
                transcript: result.cleanedText.trim() || null,
              });
            })
            .catch((error) => {
              console.warn(
                'pendingTranscription failed; audio memory keeps its save-time description/transcript',
                memory.id,
                error instanceof Error ? error.message : 'unknown',
              );
            });
        }

        if (isAudio) {
          // Text-classifier emotion path, not the photo/vision path
          // hasImageMediaAsset would otherwise route audio into (the server
          // rejects vision analysis for a non-media type). Only kick when
          // there's actually something to analyze -- a both-null kick is a
          // wasted call, though the server no-ops it safely.
          const hasAnalyzableContent =
            Boolean(memory.content?.trim()) || Boolean(memory.audio_transcript?.trim());

          if (hasAnalyzableContent) {
            void runAudioEmotionAnalysis(memory.id)
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
        } else if (hasImageMediaAsset(input.mediaAssets)) {
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

        if (!isAudio) {
          // Store-through cache warm (docs/plans/share-card-store-through.md,
          // W3): same fire-and-forget slot as
          // notifyFamilyActivityFireAndForget above. Media memories always
          // warm the COVER asset (position 0) only --
          // warmShareCardForMemoryFireAndForget branches on
          // memory.memory_type, which is always 'media' for a post that
          // reaches this branch. Audio stays unwarmed here --
          // compose-share-card rejects `audio` in v1 (see
          // docs/features/audio-memories.md), so warming it would only ever
          // fail; teaching warmShareCardForMemoryFireAndForget itself to
          // skip `audio` is P3.3, out of this wave's scope.
          warmShareCardForMemoryFireAndForget(memory);
        }

        // Inline links (docs/plans/inline-links.md §7): media/audio memories
        // are created outside the useMemories mutations, so the caption's
        // URL trigger lives here instead. fetch-link-previews returns the
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
          isNetworkFailure: isNetworkFailure(error),
        });
        // Terminal-failure transition (docs/plans/analytics-tracking.md Tier
        // 2) -- the composer's own `memory_saved` already fired when the
        // media/audio path was enqueued, so this is the only place a post's
        // eventual failure gets reported. Fires again on a user-initiated
        // retry() that also fails -- that's a new terminal failure, not a
        // duplicate of this one. Audio failures use 'other' rather than a
        // new analytics literal (analytics.ts events are out of this wave's
        // scope).
        trackEvent('memory_save_failed', {
          code: isAudioUploadInput(input) ? 'other' : 'media_upload_failed',
        });
      }
    },
    [patchUpload, queryClient, removeUpload],
  );

  const enqueue = useCallback(
    (input: PendingMemoryUploadInput) => {
      if (!user) {
        throw new Error('You must be signed in to save a memory');
      }
      if (!familyId) {
        throw new Error('You must have a family to save a memory');
      }

      inputsRef.current.set(input.memoryId, { input, userId: user.id, familyId });

      const isAudio = isAudioUploadInput(input);
      const previewAsset = isAudio ? undefined : input.mediaAssets[0];
      setUploads((current) => [
        ...current,
        {
          memoryId: input.memoryId,
          familyId,
          status: 'posting',
          totalAssets: isAudio ? 1 : input.mediaAssets.length,
          uploadedAssets: 0,
          errorMessage: null,
          previewUri: isAudio ? input.clip.fileUri : (previewAsset?.fileUri ?? null),
          previewContentType: isAudio ? input.clip.contentType : (previewAsset?.contentType ?? null),
          isNetworkFailure: false,
        },
      ]);

      void runUpload(input, user.id, familyId);
      return true;
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
      patchUpload(memoryId, {
        status: 'posting',
        uploadedAssets: 0,
        errorMessage: null,
        isNetworkFailure: false,
      });
      void runUpload(record.input, record.userId, record.familyId);
    },
    [patchUpload, runUpload],
  );

  // O6: auto-retry network-caused failures once per reconnect edge (not on
  // every render/notification -- the wasOnline ref below tracks the actual
  // offline->online transition, same pattern as useMemories.ts' reconnect
  // effect). A ref (not `uploads` as a dependency) keeps this subscribing
  // once for the provider's lifetime while still reading the CURRENT queue
  // at the moment of reconnect. Content-safety/validation/usage-limit
  // failures (isNetworkFailure: false) are left for the user's manual
  // Retry/Discard -- auto-retrying those would re-fire a doomed post and
  // double-count `memory_save_failed`.
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  useEffect(() => {
    let wasOnline = onlineManager.isOnline();

    const unsubscribe = onlineManager.subscribe(() => {
      const isOnline = onlineManager.isOnline();
      if (isOnline && !wasOnline) {
        for (const upload of uploadsRef.current) {
          if (upload.status === 'failed' && upload.isNetworkFailure) {
            retry(upload.memoryId);
          }
        }
      }
      wasOnline = isOnline;
    });

    return () => unsubscribe();
  }, [retry]);

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
