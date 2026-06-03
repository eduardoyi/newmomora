import { assertEquals } from 'jsr:@std/assert@1';
import {
  analyzeTextIllustrationEmotion,
  handleAnalyzeEmotion,
  updateEmotionIfSnapshotMatches,
  validateMediaPhotoMemoryRow,
} from './index.ts';
import { normalizeEmotionLabel } from '../_shared/media-emotion.ts';
import { EMOTION_PALETTES } from '../_shared/prompts.ts';

Deno.test('analyze-emotion rejects unauthenticated requests', async () => {
  const response = await handleAnalyzeEmotion(
    new Request('http://localhost/analyze-emotion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: '22222222-2222-4222-8222-222222222222' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('normalizeEmotionLabel via shared helper resolves known emotions', () => {
  const result = normalizeEmotionLabel('joy', EMOTION_PALETTES);
  assertEquals(result.emotion, 'joy');
  assertEquals(typeof result.colorPalette, 'string');
});

Deno.test('analyzeTextIllustrationEmotion uses mocked OpenAI when OPENAI_API_KEY is test', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');

  Deno.env.set('OPENAI_API_KEY', 'test-key');

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                emotion: 'calm',
                colorPalette: 'sage green, pale blue',
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const result = await analyzeTextIllustrationEmotion('Quiet afternoon at the park.');
    assertEquals(result.emotion, 'calm');
    assertEquals(result.colorPalette, 'sage green, pale blue');
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey) {
      Deno.env.set('OPENAI_API_KEY', originalKey);
    } else {
      Deno.env.delete('OPENAI_API_KEY');
    }
  }
});

Deno.test('validateMediaPhotoMemoryRow rejects video media', () => {
  const result = validateMediaPhotoMemoryRow(
    {
      memory_type: 'media',
      media_key: 'user-1/memories/memory-1/media.mp4',
      media_content_type: 'video/mp4',
    },
    'user-1',
  );

  assertEquals(result?.code, 'video_not_supported');
});

Deno.test('validateMediaPhotoMemoryRow rejects foreign media keys', () => {
  const result = validateMediaPhotoMemoryRow(
    {
      memory_type: 'media',
      media_key: 'other-user/memories/memory-1/media.jpg',
      media_content_type: 'image/jpeg',
    },
    'user-1',
  );

  assertEquals(result?.code, 'forbidden');
});

Deno.test('updateEmotionIfSnapshotMatches returns false when no row matches', async () => {
  const terminalQuery = {
    select: () => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }),
  };

  const secondEq = {
    eq: () => terminalQuery,
  };

  const firstEq = {
    eq: () => secondEq,
  };

  const supabase = {
    from: () => ({
      update: () => ({
        eq: () => firstEq,
      }),
    }),
  };

  const updated = await updateEmotionIfSnapshotMatches(
    supabase as never,
    '22222222-2222-4222-8222-222222222222',
    'joy',
    {
      updated_at: '2026-05-26T00:00:00Z',
      content: 'caption',
    },
  );

  assertEquals(updated, false);
});
