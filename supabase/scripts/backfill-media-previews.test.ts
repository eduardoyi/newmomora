import { assertEquals, assertThrows } from 'jsr:@std/assert@1';

import {
  decidePreviewResize,
  deriveMediaPreviewKey,
  PREVIEW_MAX_DIMENSION,
} from './backfill-media-previews.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';

function assetKey(ext: string, assetId = ASSET_ID): string {
  return `${USER_ID}/memories/${MEMORY_ID}/media/${assetId}.${ext}`;
}

// --- decidePreviewResize -----------------------------------------------
// Mirrors the no-upscale guard in src/utils/create-image-preview.ts exactly.

Deno.test('decidePreviewResize skips when the longest edge is under the cap', () => {
  assertEquals(decidePreviewResize(800, 600), { action: 'skip' });
});

Deno.test('decidePreviewResize skips exactly at the cap (no-upscale boundary)', () => {
  assertEquals(decidePreviewResize(PREVIEW_MAX_DIMENSION, 900), { action: 'skip' });
  assertEquals(decidePreviewResize(900, PREVIEW_MAX_DIMENSION), { action: 'skip' });
});

Deno.test('decidePreviewResize resizes by width for landscape/square images over the cap', () => {
  assertEquals(decidePreviewResize(PREVIEW_MAX_DIMENSION + 1, 900), {
    action: 'resize',
    targetWidth: PREVIEW_MAX_DIMENSION,
  });
  assertEquals(decidePreviewResize(2000, 2000), {
    action: 'resize',
    targetWidth: PREVIEW_MAX_DIMENSION,
  });
});

Deno.test('decidePreviewResize resizes by height for portrait images over the cap', () => {
  assertEquals(decidePreviewResize(900, PREVIEW_MAX_DIMENSION + 1), {
    action: 'resize',
    targetHeight: PREVIEW_MAX_DIMENSION,
  });
});

Deno.test('decidePreviewResize skips when dimensions are missing or invalid', () => {
  assertEquals(decidePreviewResize(null, 2000), { action: 'skip' });
  assertEquals(decidePreviewResize(2000, undefined), { action: 'skip' });
  assertEquals(decidePreviewResize(0, 2000), { action: 'skip' });
  assertEquals(decidePreviewResize(2000, -1), { action: 'skip' });
});

// --- deriveMediaPreviewKey ------------------------------------------------
// MUST produce byte-identical keys to src/services/memory-posting.ts's
// `buildMemoryMediaAssetKey(userId, memoryId, \`${mediaAssetId}-preview\`,
// 'jpg')` derivation -- these expected strings are written out by hand to
// pin that shape independent of the implementation under test.

for (const ext of ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp']) {
  Deno.test(`deriveMediaPreviewKey derives the -preview.jpg key for .${ext} originals`, () => {
    const objectKey = assetKey(ext);
    const previewKey = deriveMediaPreviewKey(objectKey);

    assertEquals(
      previewKey,
      `${USER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}-preview.jpg`,
    );
  });
}

Deno.test('deriveMediaPreviewKey never derives from a key already ending in -preview', () => {
  const alreadyPreviewKey = assetKey('jpg', `${ASSET_ID}-preview`);
  assertThrows(() => deriveMediaPreviewKey(alreadyPreviewKey));
});

Deno.test('deriveMediaPreviewKey asserts previewKey !== objectKey', () => {
  // Sanity check on the general property: for every valid input the
  // derived key must differ from the source key.
  const objectKey = assetKey('png');
  const previewKey = deriveMediaPreviewKey(objectKey);
  assertEquals(previewKey === objectKey, false);
});

Deno.test('deriveMediaPreviewKey rejects keys that fail MEMORY_MEDIA_ASSET_EXTENSION_PATTERN', () => {
  // Wrong path shape (missing /media/ segment).
  assertThrows(() => deriveMediaPreviewKey(`${USER_ID}/memories/${MEMORY_ID}/media.jpg`));
  // Unsupported extension.
  assertThrows(() => deriveMediaPreviewKey(assetKey('gif')));
  // Not a memory-media key at all.
  assertThrows(() => deriveMediaPreviewKey(`${USER_ID}/family/${ASSET_ID}/photo.webp`));
  // No leading user id segment.
  assertThrows(() => deriveMediaPreviewKey('not-a-valid-key'));
});
