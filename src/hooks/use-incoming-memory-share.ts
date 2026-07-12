import { useIncomingShare } from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';

import type { MediaAttachment } from '@/components/memory-media-picker';
import { prepareSharedMedia } from '@/utils/prepare-shared-media';
import { getSharedVideoDurationMs } from '@/utils/shared-video-duration';

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
    resolvedSharedPayloads,
    sharedPayloads,
  } = useIncomingShare();
  const hasPreparedRef = useRef(false);
  const onPreparedRef = useRef(onPrepared);
  const [isPreparing, setIsPreparing] = useState(sharedPayloads.length > 0);

  useEffect(() => {
    onPreparedRef.current = onPrepared;
  }, [onPrepared]);

  useEffect(() => {
    if (error && !hasPreparedRef.current) {
      hasPreparedRef.current = true;
      clearSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current([], 'Could not open the shared photos or videos. Try sharing them again.');
      return;
    }

    if (isResolving || resolvedSharedPayloads.length === 0 || hasPreparedRef.current) {
      return;
    }

    hasPreparedRef.current = true;
    setIsPreparing(true);
    void prepareSharedMedia(resolvedSharedPayloads, {
      createId: createAttachmentId,
      getVideoDurationMs: getSharedVideoDurationMs,
    }).then(({ attachments, errorMessage }) => {
      clearSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current(attachments, errorMessage);
    }).catch(() => {
      clearSharedPayloads();
      setIsPreparing(false);
      onPreparedRef.current([], 'Could not open the shared photos or videos. Try sharing them again.');
    });
  }, [clearSharedPayloads, error, isResolving, resolvedSharedPayloads]);

  return isPreparing || isResolving;
}
