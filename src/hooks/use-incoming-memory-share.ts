import { useIncomingShare } from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';

import { extractImageCaptureDateIso } from '@/utils/image-exif-capture-date';
import { getLocalFileSizeBytes } from '@/utils/local-files';
import {
  prepareSharedMedia,
  unattachedSharedPayloadUris,
  type PrepareSharedMediaResult,
} from '@/utils/prepare-shared-media';
import { deleteShareCopies } from '@/utils/shared-file-cleanup';
import { getSharedVideoDurationMs } from '@/utils/shared-video-duration';
import { extractVideoCaptureDateIso } from '@/utils/video-capture-date';

function createAttachmentId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export const INCOMING_SHARE_OPEN_ERROR =
  'Could not open the shared photos or videos. Try sharing them again.';

interface UseIncomingMemoryShareOptions {
  /**
   * Called once per share with the discriminated result: `media` (photos and
   * videos, possibly with a notice), `audio` (exactly one voice note, not yet
   * imported -- the caller runs `importAudioFile`) or `error` (nothing to
   * apply, just show the message). The hook reports `isPreparing` until this
   * callback has been invoked; an audio share's import is the caller's work.
   */
  onPrepared: (result: PrepareSharedMediaResult) => void;
}

export function useIncomingMemoryShare({ onPrepared }: UseIncomingMemoryShareOptions): boolean {
  const {
    clearSharedPayloads,
    error,
    isResolving,
    refreshSharePayloads,
    resolvedSharedPayloads,
    sharedPayloads,
  } = useIncomingShare();
  const hasPreparedRef = useRef(false);
  const latestSharedPayloadsRef = useRef(sharedPayloads);
  const preparationGenerationRef = useRef(0);
  const onPreparedRef = useRef(onPrepared);
  const [isPreparing, setIsPreparing] = useState(sharedPayloads.length > 0);

  useEffect(() => {
    onPreparedRef.current = onPrepared;
  }, [onPrepared]);

  useEffect(() => {
    if (latestSharedPayloadsRef.current !== sharedPayloads) {
      latestSharedPayloadsRef.current = sharedPayloads;
      preparationGenerationRef.current += 1;
      hasPreparedRef.current = false;
    }

    if (sharedPayloads.length === 0 && !isResolving) {
      hasPreparedRef.current = false;
      return;
    }

    const clearAndRefreshSharedPayloads = () => {
      clearSharedPayloads();
      // Expo's clear function only clears its native singleton. Refresh the
      // hook too so a later share of the same URI is not mistaken for the
      // payload that was already consumed.
      refreshSharePayloads();
    };

    if (error && !hasPreparedRef.current) {
      hasPreparedRef.current = true;
      // Resolution failed, so nothing will ever read these copies. The raw
      // payload `value` is the copy's file URL for file-backed shares; the
      // helper ignores text / links and anything outside the share root.
      void deleteShareCopies(sharedPayloads.map((payload) => payload.value));
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current({ kind: 'error', errorMessage: INCOMING_SHARE_OPEN_ERROR });
      return;
    }

    if (isResolving || resolvedSharedPayloads.length === 0 || hasPreparedRef.current) {
      return;
    }

    hasPreparedRef.current = true;
    const preparationGeneration = preparationGenerationRef.current;
    setIsPreparing(true);
    void prepareSharedMedia(resolvedSharedPayloads, {
      createId: createAttachmentId,
      getLocalFileSizeBytes,
      getImageCaptureDateIso: extractImageCaptureDateIso,
      getVideoDurationMs: getSharedVideoDurationMs,
      getVideoCaptureDateIso: extractVideoCaptureDateIso,
    }).then((result) => {
      if (preparationGeneration !== preparationGenerationRef.current) {
        return;
      }
      // Copies that did not become attachments (errors, the 10-item cap,
      // unsupported types) are ours to delete now; attached ones are cleaned
      // up by the composer / upload queue.
      void deleteShareCopies(unattachedSharedPayloadUris(resolvedSharedPayloads, result));
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current(result);
    }).catch(() => {
      if (preparationGeneration !== preparationGenerationRef.current) {
        return;
      }
      void deleteShareCopies(resolvedSharedPayloads.map((payload) => payload.contentUri));
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current({ kind: 'error', errorMessage: INCOMING_SHARE_OPEN_ERROR });
    });
  }, [
    clearSharedPayloads,
    error,
    isResolving,
    refreshSharePayloads,
    resolvedSharedPayloads,
    sharedPayloads,
  ]);

  return isPreparing || isResolving;
}
