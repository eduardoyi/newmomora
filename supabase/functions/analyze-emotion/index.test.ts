import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildAnalyzeMemoryResponse,
  handleAnalyzeEmotion,
  updateMemoryAnalysisIfSnapshotMatches,
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

// Text/URL-stripping coverage moved with the logic itself: analyze-emotion
// no longer builds the classifier input directly (that's now
// `buildAnalysisInput` in `_shared/analyze-memory-core.ts`, extended to
// every memory type) -- see analyze-memory-core.test.ts's
// "buildAnalysisInput: text_only strips URLs and sends no images" and the
// audio join/skip cases for the equivalent, now-shared coverage (including
// the inline-links §8 "URLs must never reach the prompt" rule).

Deno.test('validateMediaPhotoMemoryRow rejects video media with no poster (no media rows loaded)', () => {
  const result = validateMediaPhotoMemoryRow({
    memory_type: 'media',
    media_key: 'user-1/memories/memory-1/media.mp4',
    media_content_type: 'video/mp4',
  });

  assertEquals(result?.code, 'video_not_supported');
});

// Closes the "video has no emotion in MVP" gap (docs/plans/memory-book.md
// §5 Stage A): a video WITH a backfilled poster frame is now a usable
// candidate, same as a photo.
Deno.test('validateMediaPhotoMemoryRow accepts a video WITH a poster (preview_object_key present)', () => {
  const result = validateMediaPhotoMemoryRow(
    {
      memory_type: 'media',
      media_key: 'user-1/memories/memory-1/media.mp4',
      media_content_type: 'video/mp4',
    },
    [
      {
        object_key: 'user-1/memories/memory-1/media.mp4',
        content_type: 'video/mp4',
        position: 0,
        preview_object_key: 'user-1/memories/memory-1/media-poster.jpg',
      },
    ],
  );

  assertEquals(result, null);
});

Deno.test('validateMediaPhotoMemoryRow still rejects an all-video media list with no poster on any asset', () => {
  const result = validateMediaPhotoMemoryRow(
    {
      memory_type: 'media',
      media_key: 'user-1/memories/memory-1/media.mp4',
      media_content_type: 'video/mp4',
    },
    [
      { object_key: 'clip-1.mp4', content_type: 'video/mp4', position: 0, preview_object_key: null },
      { object_key: 'clip-2.mp4', content_type: 'video/mp4', position: 1, preview_object_key: null },
    ],
  );

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

// Audio memories (docs/features/audio-memories.md, P1.4): the vision path's
// media-only guard must keep rejecting `audio` even though it now has its
// own text-input branch in analyze-memory-core.ts -- this pins the guard as
// defense-in-depth against a misrouted call.
Deno.test('validateMediaPhotoMemoryRow rejects audio on the vision (media) path', () => {
  const result = validateMediaPhotoMemoryRow({
    memory_type: 'audio',
    media_key: 'user-1/memories/memory-1/media/asset-1.m4a',
    media_content_type: 'audio/mp4',
  });

  assertEquals(result?.code, 'invalid_memory_type');
});

Deno.test('updateMemoryAnalysisIfSnapshotMatches returns false when no row matches', async () => {
  // .update({...}).eq('id', ...).eq('updated_at', ...).select('id').maybeSingle()
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

  const updated = await updateMemoryAnalysisIfSnapshotMatches(
    supabase as never,
    '22222222-2222-4222-8222-222222222222',
    { emotion: 'joy', topics: [], topicDetails: {}, labels: [], description: '', artworkMedium: null },
    {
      updated_at: '2026-05-26T00:00:00Z',
      content: 'caption',
    },
  );

  assertEquals(updated, false);
});

// Family sharing: the handler calls this with the SERVICE-ROLE client rather
// than the caller's user client, specifically so a viewer-triggered analysis
// still persists. A viewer's user-client UPDATE would match zero rows under
// the manager+ `memories` RLS policy (200 with a silent no-op); the
// service-role client bypasses that policy and the write succeeds
// regardless of the triggering caller's role. This test stands in for that
// client swap: it proves the function itself just needs *a* client whose
// UPDATE isn't blocked -- exactly what passing the service client achieves.
Deno.test('updateMemoryAnalysisIfSnapshotMatches persists the write when the snapshot matches (viewer-triggered, service-role client)', async () => {
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

  const updated = await updateMemoryAnalysisIfSnapshotMatches(
    serviceRoleClient as never,
    '22222222-2222-4222-8222-222222222222',
    {
      emotion: 'calm',
      topics: [{ id: 'beach', detail: null }],
      topicDetails: {},
      labels: ['sand'],
      description: 'A beach day.',
      artworkMedium: null,
    },
    {
      updated_at: '2026-05-26T00:00:00Z',
      content: 'caption',
    },
  );

  assertEquals(updated, true);
});

// --- artwork_medium on the CAS write (docs/plans/artwork-scanning.md 1.5) -------------

/** Captures the object passed to `.update()` and reports a landed write. */
function captureUpdatePayload() {
  const captured: { payload: Record<string, unknown> | null } = { payload: null };
  const client = {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        captured.payload = payload;
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({ maybeSingle: async () => ({ data: { id: 'memory-1' }, error: null }) }),
            }),
          }),
        };
      },
    }),
  };
  return { captured, client };
}

const baseWrite = {
  emotion: 'joy',
  topics: [{ id: 'arts-crafts', detail: null }],
  topicDetails: {},
  labels: ['artwork', 'crayon'],
  description: "a child's crayon drawing",
};

Deno.test('updateMemoryAnalysisIfSnapshotMatches writes artwork_medium for an artwork memory with a parsed medium', async () => {
  const { captured, client } = captureUpdatePayload();
  const updated = await updateMemoryAnalysisIfSnapshotMatches(
    client as never,
    'memory-1',
    { ...baseWrite, artworkMedium: 'crayon' },
    { updated_at: '2026-05-26T00:00:00Z', content: null, media_variant: 'artwork' },
  );
  assertEquals(updated, true);
  assertEquals(captured.payload?.artwork_medium, 'crayon');
});

Deno.test('updateMemoryAnalysisIfSnapshotMatches omits artwork_medium for an artwork memory whose medium parsed to null (never erases a good medium)', async () => {
  const { captured, client } = captureUpdatePayload();
  await updateMemoryAnalysisIfSnapshotMatches(
    client as never,
    'memory-1',
    { ...baseWrite, artworkMedium: null },
    { updated_at: '2026-05-26T00:00:00Z', content: null, media_variant: 'artwork' },
  );
  assertEquals('artwork_medium' in (captured.payload ?? {}), false);
});

Deno.test('updateMemoryAnalysisIfSnapshotMatches omits artwork_medium for non-artwork memories even if a medium is passed (check constraint safety)', async () => {
  for (const mediaVariant of [null, undefined]) {
    const { captured, client } = captureUpdatePayload();
    await updateMemoryAnalysisIfSnapshotMatches(
      client as never,
      'memory-1',
      { ...baseWrite, artworkMedium: 'crayon' },
      { updated_at: '2026-05-26T00:00:00Z', content: null, media_variant: mediaVariant },
    );
    assertEquals('artwork_medium' in (captured.payload ?? {}), false);
    assertEquals(captured.payload?.emotion, 'joy');
  }
});

// --- response contract (1.7): additive `artworkMedium` ----------------------------------

const completedResult = {
  skipped: false as const,
  emotion: 'joy',
  colorPalette: 'warm',
  topics: [{ id: 'arts-crafts', detail: null }],
  topicDetails: {},
  labels: ['artwork'],
  description: "a child's artwork drawing",
  milestones: [],
  artworkMedium: 'watercolor' as string | null,
  usage: null,
};

Deno.test('buildAnalyzeMemoryResponse includes artworkMedium for artwork memories (string or null)', () => {
  assertEquals(buildAnalyzeMemoryResponse(completedResult, 'artwork', true).artworkMedium, 'watercolor');
  const unparsed = buildAnalyzeMemoryResponse({ ...completedResult, artworkMedium: null }, 'artwork', true);
  assertEquals('artworkMedium' in unparsed, true);
  assertEquals(unparsed.artworkMedium, null);
});

Deno.test('buildAnalyzeMemoryResponse omits artworkMedium for non-artwork memories and keeps the existing fields', () => {
  const response = buildAnalyzeMemoryResponse({ ...completedResult, artworkMedium: null }, null, true);
  assertEquals('artworkMedium' in response, false);
  assertEquals(response, {
    emotion: 'joy',
    colorPalette: 'warm',
    topics: ['arts-crafts'],
    labels: ['artwork'],
    description: "a child's artwork drawing",
    skipped: undefined,
  });
  assertEquals(buildAnalyzeMemoryResponse(completedResult, null, false).skipped, true);
});
