import { useIncomingShare } from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';

import type { MediaAttachment } from '@/components/memory-media-picker';
import { extractImageCaptureDateIso } from '@/utils/image-exif-capture-date';
import { getLocalFileSizeBytes } from '@/utils/local-files';
import { prepareSharedMedia } from '@/utils/prepare-shared-media';
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

interface UseIncomingMemoryShareOptions {
  onPrepared: (attachments: MediaAttachment[], errorMessage: string | null) => void;
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
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current([], 'Could not open the shared photos or videos. Try sharing them again.');
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
    }).then(({ attachments, errorMessage }) => {
      if (preparationGeneration !== preparationGenerationRef.current) {
        return;
      }
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current(attachments, errorMessage);
    }).catch(() => {
      if (preparationGeneration !== preparationGenerationRef.current) {
        return;
      }
      clearAndRefreshSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current([], 'Could not open the shared photos or videos. Try sharing them again.');
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
