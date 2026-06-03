import type { Memory } from '@/services/memories';
import { isVideoContentType } from '@/utils/media-validation';
import { isIllustrationInProgress } from '@/utils/memories';

export const MEDIA_EMOTION_POLL_WINDOW_MS = 3 * 60 * 1000;

type EmotionPollMemory = Pick<
  Memory,
  | 'memory_type'
  | 'media_content_type'
  | 'emotion'
  | 'created_at'
  | 'content'
  | 'illustration_status'
> & {
  mediaAssets?: Array<{ content_type: string }>;
};

// A memory is analyzable for emotion when it carries usable source material:
// a non-video photo, or text content for text-based memories.
export function isEmotionAnalyzable(memory: EmotionPollMemory): boolean {
  if (memory.emotion) {
    return false;
  }

  if (memory.memory_type === 'media') {
    if (memory.mediaAssets && memory.mediaAssets.length > 0) {
      return memory.mediaAssets.some((asset) => !isVideoContentType(asset.content_type));
    }

    return !isVideoContentType(memory.media_content_type ?? '');
  }

  if (memory.memory_type === 'text_only' || memory.memory_type === 'text_illustration') {
    return Boolean(memory.content?.trim());
  }

  return false;
}

function isWithinPollWindow(createdAt: string): boolean {
  const createdAtMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdAtMs)) {
    return false;
  }

  return Date.now() - createdAtMs < MEDIA_EMOTION_POLL_WINDOW_MS;
}

// True while we expect a freshly created memory's emotion to arrive shortly, so
// the list/detail queries should keep polling. Bounded to a short window so we
// don't poll forever for memories whose analysis permanently failed.
export function shouldPollForEmotion(memory: EmotionPollMemory): boolean {
  if (!isEmotionAnalyzable(memory)) {
    return false;
  }

  // text_illustration emotion is written by the illustration pipeline; let the
  // illustration polling drive refetches while that is in progress.
  if (
    memory.memory_type === 'text_illustration' &&
    isIllustrationInProgress(memory.illustration_status)
  ) {
    return false;
  }

  return isWithinPollWindow(memory.created_at);
}

export function memoriesNeedEmotionPolling(memories: EmotionPollMemory[]): boolean {
  return memories.some(shouldPollForEmotion);
}

// Backward-compatible aliases scoped to media photos.
export function shouldPollForMediaEmotion(memory: EmotionPollMemory): boolean {
  return memory.memory_type === 'media' && shouldPollForEmotion(memory);
}

export function memoriesNeedMediaEmotionPolling(memories: EmotionPollMemory[]): boolean {
  return memories.some(shouldPollForMediaEmotion);
}
