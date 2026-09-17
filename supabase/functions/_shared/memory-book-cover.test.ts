import { assertEquals } from 'jsr:@std/assert@1';
import { COVER_PHOTO_MIN_WIDTH_PX, pickCoverAssetKey } from './memory-book-cover.ts';

function bookDocument(outline: unknown, manifest: unknown) {
  return { outline, manifest };
}

function photoAsset(file: string, width: number, overrides: Record<string, unknown> = {}) {
  return { file, kind: 'photo', width, ...overrides };
}

Deno.test('pickCoverAssetKey: happy path resolves the first coverCandidates entry that clears the width gate', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1', 'memory-2'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [photoAsset('covers/memory-1.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
        'memory-2': { date: '2025-06-01', assets: [photoAsset('covers/memory-2.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'covers/memory-1.jpg');
});

Deno.test('pickCoverAssetKey: the width gate rejects an under-2000px candidate and falls through to the next one', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1', 'memory-2'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        // Below the 2000px gate -- must NOT win pass 1, even though it's
        // the first candidate and its only asset is otherwise a fine photo.
        'memory-1': { date: '2025-06-01', assets: [photoAsset('covers/too-small.jpg', COVER_PHOTO_MIN_WIDTH_PX - 1)] },
        'memory-2': { date: '2025-06-01', assets: [photoAsset('covers/memory-2.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'covers/memory-2.jpg');
});

Deno.test('pickCoverAssetKey: prefers originalWidth over width for the gate (preview-export width alone would reject it)', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        // width is the ~1280px preview-export size; originalWidth is the
        // real source resolution and is what must be gated on.
        'memory-1': {
          date: '2025-06-01',
          assets: [photoAsset('covers/memory-1.jpg', 1280, { originalWidth: 3000 })],
        },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'covers/memory-1.jpg');
});

Deno.test('pickCoverAssetKey: within a candidate memory, picks the first qualifying PHOTO asset in that memory\'s own asset order', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': {
          date: '2025-06-01',
          assets: [
            { file: 'video-poster.jpg', kind: 'video-poster', width: COVER_PHOTO_MIN_WIDTH_PX },
            photoAsset('too-small.jpg', COVER_PHOTO_MIN_WIDTH_PX - 1),
            photoAsset('the-real-cover.jpg', COVER_PHOTO_MIN_WIDTH_PX),
          ],
        },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'the-real-cover.jpg');
});

Deno.test('pickCoverAssetKey: legacy heroCandidates fallback is NOT width-gated', () => {
  const doc = bookDocument(
    { heroCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [photoAsset('tiny-hero.jpg', 50)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'tiny-hero.jpg');
});

Deno.test('pickCoverAssetKey: heroCandidates fallback only triggers once coverCandidates is exhausted with no qualifying hit', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'], heroCandidates: ['memory-2'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        // coverCandidates points at memory-1, but it has no photo asset at all.
        'memory-1': { date: '2025-06-01', assets: [{ file: 'poster.jpg', kind: 'video-poster', width: 50 }] },
        'memory-2': { date: '2025-06-01', assets: [photoAsset('hero.jpg', 50)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'hero.jpg');
});

Deno.test('pickCoverAssetKey: middle-of-range fallback picks the photo whose memory date is closest to the scope midpoint', () => {
  const doc = bookDocument(
    {},
    {
      scope: { start: '2025-01-01', end: '2025-12-31' }, // midpoint ~ 2025-07-02
      memories: {
        'memory-early': { date: '2025-01-05', assets: [photoAsset('early.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
        'memory-middle': { date: '2025-07-01', assets: [photoAsset('middle.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
        'memory-late': { date: '2025-12-25', assets: [photoAsset('late.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'middle.jpg');
});

Deno.test('pickCoverAssetKey: middle-of-range tie-break 1 -- equal distance from midpoint, widest effectiveWidth wins', () => {
  const doc = bookDocument(
    {},
    {
      scope: { start: '2025-01-01', end: '2025-01-11' }, // midpoint = 2025-01-06
      memories: {
        // Both memories are exactly 1 day from the midpoint.
        'memory-a': { date: '2025-01-05', assets: [photoAsset('narrower.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
        'memory-b': { date: '2025-01-07', assets: [photoAsset('wider.jpg', COVER_PHOTO_MIN_WIDTH_PX + 500)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'wider.jpg');
});

Deno.test('pickCoverAssetKey: middle-of-range tie-break 2 -- equal distance AND equal width, lowest memory id wins', () => {
  const doc = bookDocument(
    {},
    {
      scope: { start: '2025-01-01', end: '2025-01-11' }, // midpoint = 2025-01-06
      memories: {
        'memory-z': { date: '2025-01-05', assets: [photoAsset('from-z.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
        'memory-a': { date: '2025-01-07', assets: [photoAsset('from-a.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'from-a.jpg');
});

Deno.test('pickCoverAssetKey: an unparseable scope/date is NaN-safe (infinite distance), never throws', () => {
  const doc = bookDocument(
    {},
    {
      scope: { start: 'not-a-date', end: 'also-not-a-date' },
      memories: {
        'memory-1': { date: 'still-not-a-date', assets: [photoAsset('only-option.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), 'only-option.jpg');
});

Deno.test('pickCoverAssetKey: video-poster-only manifest with no qualifying photo resolves to null', () => {
  const doc = bookDocument(
    { coverCandidates: [] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [{ file: 'poster-1.jpg', kind: 'video-poster', width: 3000 }] },
        'memory-2': { date: '2025-06-01', assets: [{ file: 'poster-2.jpg', kind: 'video-poster', width: 3000 }] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc), null);
});

Deno.test('pickCoverAssetKey: garbage input resolves to null rather than throwing', () => {
  assertEquals(pickCoverAssetKey(null), null);
  assertEquals(pickCoverAssetKey(undefined), null);
  assertEquals(pickCoverAssetKey('not an object'), null);
  assertEquals(pickCoverAssetKey(42), null);
  assertEquals(pickCoverAssetKey([]), null);
  assertEquals(pickCoverAssetKey({}), null);
  assertEquals(pickCoverAssetKey({ manifest: null }), null);
  assertEquals(pickCoverAssetKey({ manifest: {} }), null);
  assertEquals(pickCoverAssetKey({ manifest: { memories: 'not an object' } }), null);
  assertEquals(
    pickCoverAssetKey({ outline: { coverCandidates: 'not-an-array' }, manifest: { memories: {} } }),
    null,
  );
  assertEquals(
    pickCoverAssetKey({
      outline: { coverCandidates: [123, null, 'memory-1'] },
      manifest: { memories: { 'memory-1': { assets: 'not-an-array' } } },
    }),
    null,
  );
  assertEquals(
    pickCoverAssetKey({
      manifest: { memories: { 'memory-1': { assets: [{ file: 'no-kind.jpg', width: 'not-a-number' }] } } },
    }),
    null,
  );
});

// ── coverEdit awareness (mirrors applyCoverImageEdit + applyWidthHeight) ──

function coverEditRecord(file: string, overrides: Record<string, unknown> = {}) {
  return { slot: 'cover', mediaId: 'media-1', file, originalFile: 'original.jpg', aspectRatio: 1.5, ...overrides };
}

Deno.test('pickCoverAssetKey: a qualifying cover edit wins over the AI coverCandidates precedence', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [photoAsset('ai-pick.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  const coverEdit = coverEditRecord('edited-cover.jpg', { originalWidth: 3000, originalHeight: 2000 });
  assertEquals(pickCoverAssetKey(doc, coverEdit), 'edited-cover.jpg');
});

Deno.test('pickCoverAssetKey: an under-2000px cover edit loses and falls through to the unmodified precedence', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [photoAsset('ai-pick.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  const coverEdit = coverEditRecord('edited-cover.jpg', { originalWidth: 500, originalHeight: 400 });
  assertEquals(pickCoverAssetKey(doc, coverEdit), 'ai-pick.jpg');
});

Deno.test('pickCoverAssetKey: a garbage/malformed cover edit is ignored, same result as no coverEdit at all', () => {
  const doc = bookDocument(
    { coverCandidates: ['memory-1'] },
    {
      scope: { start: '2025-01-01', end: '2025-12-31' },
      memories: {
        'memory-1': { date: '2025-06-01', assets: [photoAsset('ai-pick.jpg', COVER_PHOTO_MIN_WIDTH_PX)] },
      },
    },
  );
  assertEquals(pickCoverAssetKey(doc, null), 'ai-pick.jpg');
  assertEquals(pickCoverAssetKey(doc, 'not-an-object'), 'ai-pick.jpg');
  assertEquals(pickCoverAssetKey(doc, {}), 'ai-pick.jpg'); // no file
  assertEquals(pickCoverAssetKey(doc, { file: '' }), 'ai-pick.jpg'); // empty file
  assertEquals(pickCoverAssetKey(doc, { file: 'x.jpg' }), 'ai-pick.jpg'); // missing required aspectRatio
  assertEquals(pickCoverAssetKey(doc, { file: 'x.jpg', aspectRatio: 'nope' }), 'ai-pick.jpg'); // malformed aspectRatio
  assertEquals(pickCoverAssetKey(doc), 'ai-pick.jpg'); // omitted entirely -- unchanged call site behavior
});

Deno.test('pickCoverAssetKey: a cover edit with no measured original dimensions gates on the aspectRatio sentinel width (round(100*aspectRatio))', () => {
  const doc = bookDocument({}, { scope: { start: '2025-01-01', end: '2025-12-31' }, memories: {} });

  // aspectRatio 25 -> sentinel width round(100*25) = 2500, clears the gate.
  assertEquals(pickCoverAssetKey(doc, coverEditRecord('wide-sentinel.jpg', { aspectRatio: 25 })), 'wide-sentinel.jpg');

  // aspectRatio 1.5 (a normal photo) -> sentinel width 150, well under the
  // gate -- and with no other candidate anywhere in this bare manifest, the
  // whole precedence resolves to null (the edit is NOT an unconditional
  // override).
  assertEquals(pickCoverAssetKey(doc, coverEditRecord('too-small-sentinel.jpg', { aspectRatio: 1.5 })), null);
});

Deno.test('pickCoverAssetKey: originalWidth without originalHeight still gates on originalWidth alone (mirrors the real independent-field quirk)', () => {
  const doc = bookDocument({}, { scope: { start: '2025-01-01', end: '2025-12-31' }, memories: {} });
  const coverEdit = coverEditRecord('edited-cover.jpg', { originalWidth: 3000, originalHeight: undefined, aspectRatio: 1.5 });
  assertEquals(pickCoverAssetKey(doc, coverEdit), 'edited-cover.jpg');
});
