import type { Memory } from '@/services/memories';
import {
  MEDIA_EMOTION_POLL_WINDOW_MS,
  isEmotionAnalyzable,
  memoriesNeedEmotionPolling,
  memoriesNeedMediaEmotionPolling,
  shouldPollForEmotion,
  shouldPollForMediaEmotion,
} from '@/utils/media-emotion-polling';

type PollMemory = Pick<
  Memory,
  'memory_type' | 'media_content_type' | 'emotion' | 'created_at' | 'content' | 'illustration_status'
>;

function buildMemory(overrides: Partial<PollMemory>): PollMemory {
  return {
    memory_type: 'media',
    media_content_type: 'image/jpeg',
    emotion: null,
    created_at: new Date().toISOString(),
    content: null,
    illustration_status: 'none',
    ...overrides,
  };
}

describe('media-emotion-polling', () => {
  it('polls for recent photo media without emotion', () => {
    expect(shouldPollForMediaEmotion(buildMemory({}))).toBe(true);
    expect(memoriesNeedMediaEmotionPolling([buildMemory({})])).toBe(true);
    expect(memoriesNeedEmotionPolling([buildMemory({})])).toBe(true);
  });

  it('does not poll for video media', () => {
    expect(
      shouldPollForMediaEmotion(buildMemory({ media_content_type: 'video/mp4' })),
    ).toBe(false);
  });

  it('does not poll when emotion is already set', () => {
    expect(shouldPollForMediaEmotion(buildMemory({ emotion: 'joy' }))).toBe(false);
  });

  it('does not poll outside the analysis window', () => {
    const oldCreatedAt = new Date(Date.now() - MEDIA_EMOTION_POLL_WINDOW_MS - 1000).toISOString();
    expect(shouldPollForMediaEmotion(buildMemory({ created_at: oldCreatedAt }))).toBe(false);
  });

  it('polls for recent text_only memory without emotion', () => {
    const memory = buildMemory({
      memory_type: 'text_only',
      media_content_type: null,
      content: 'Lila asked if the moon gets tired.',
    });
    expect(shouldPollForEmotion(memory)).toBe(true);
    expect(memoriesNeedEmotionPolling([memory])).toBe(true);
    // Media-scoped helper ignores text memories.
    expect(shouldPollForMediaEmotion(memory)).toBe(false);
  });

  it('does not poll text_only memory without content', () => {
    expect(
      shouldPollForEmotion(
        buildMemory({ memory_type: 'text_only', media_content_type: null, content: '   ' }),
      ),
    ).toBe(false);
  });

  it('defers to the illustration pipeline while a text_illustration is generating', () => {
    const memory = buildMemory({
      memory_type: 'text_illustration',
      media_content_type: null,
      content: 'Noor peeled a banana.',
      illustration_status: 'generating',
    });
    expect(isEmotionAnalyzable(memory)).toBe(true);
    expect(shouldPollForEmotion(memory)).toBe(false);
  });

  it('polls a text_illustration awaiting emotion once illustration settled', () => {
    const memory = buildMemory({
      memory_type: 'text_illustration',
      media_content_type: null,
      content: 'Noor peeled a banana.',
      illustration_status: 'ready',
    });
    expect(shouldPollForEmotion(memory)).toBe(true);
  });
});
