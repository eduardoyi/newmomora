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
  const result = validateMediaPhotoMemoryRow({
    memory_type: 'media',
    media_key: 'user-1/memories/memory-1/media.mp4',
    media_content_type: 'video/mp4',
  });

  assertEquals(result?.code, 'video_not_supported');
});

// Family sharing: key ownership is no longer validated here -- membership in
// the memory's family (checked earlier in the handler) is the authorization
// signal, and keys are read from the DB row (trusted), not client input. A
// manager analyzing another member's memory must see a key under that
// member's uid prefix accepted, not rejected as "foreign".
Deno.test('validateMediaPhotoMemoryRow accepts a media key under a different member\'s uid prefix', () => {
  const result = validateMediaPhotoMemoryRow({
    memory_type: 'media',
    media_key: 'other-member/memories/memory-1/media.jpg',
    media_content_type: 'image/jpeg',
  });

  assertEquals(result, null);
});

Deno.test('updateEmotionIfSnapshotMatches returns false when no row matches', async () => {
  // .update({emotion}).eq('id', ...).eq('updated_at', ...).select('id').maybeSingle()
  // is exactly two .eq() calls before .select() -- the mock chain must match.
  const terminalQuery = {
    select: () => ({
      maybeSingle: async () => ({ data: null, error: null }),
    }),
  };

  const firstEq = {
    eq: () => terminalQuery,
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

// Family sharing: the handler now calls this with the SERVICE-ROLE client
// rather than the caller's user client, specifically so a viewer-triggered
// analysis still persists. A viewer's user-client UPDATE would match zero
// rows under the manager+ `memories` RLS policy (200 with a silent no-op);
// the service-role client bypasses that policy and the write succeeds
// regardless of the triggering caller's role. This test stands in for that
// client swap: it proves the function itself just needs *a* client whose
// UPDATE isn't blocked -- exactly what passing the service client achieves.
Deno.test('updateEmotionIfSnapshotMatches persists the write when the snapshot matches (viewer-triggered, service-role client)', async () => {
  const terminalQuery = {
    select: () => ({
      maybeSingle: async () => ({ data: { id: 'memory-1' }, error: null }),
    }),
  };

  const firstEq = {
    eq: () => terminalQuery,
  };

  const serviceRoleClient = {
    from: () => ({
      update: () => ({
        eq: () => firstEq,
      }),
    }),
  };

  const updated = await updateEmotionIfSnapshotMatches(
    serviceRoleClient as never,
    '22222222-2222-4222-8222-222222222222',
    'calm',
    {
      updated_at: '2026-05-26T00:00:00Z',
      content: 'caption',
    },
  );

  assertEquals(updated, true);
});
