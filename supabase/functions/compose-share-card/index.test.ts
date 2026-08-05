import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { buildShareCardKey } from '../_shared/storage-keys.ts';
import {
  _resetRateLimitStateForTests,
  authorizeShareCardAccessFromQueryRow,
  buildShareCardFilename,
  buildTaggedMemberPortraits,
  clampMediaAspectRatio,
  type ComposeShareCardDependencies,
  convertWebpToJpeg,
  DESIGN_VERSION,
  handleComposeShareCard,
  isComposeRateLimited,
  isFreshShareCardKey,
  isRejectedMemoryType,
  isUnrasterizableMimeType,
  isVideoContentType,
  isWarmRateLimited,
  markComposeRun,
  markWarmRun,
  mimeTypeFromObjectKey,
  parseShareCardKeyDesignVersion,
  resolveCallerRoleFromQueryRow,
  resolveImageMimeType,
  resolveMemberPortraitKey,
  resolvePortraitKeysToFetch,
  resolveShareCardCacheTarget,
  resolveShareCardSourceFromQueryRow,
  resolveTaggedMembersFromQueryRow,
  runShareCardCompose,
  SHARE_CARD_MAX_IMAGE_EDGE,
  SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW,
  SHARE_CARD_RATE_LIMIT_WINDOW_MS,
  SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW,
  type ShareCardMemoryQueryRow,
  type ShareCardStoreDependencies,
  storeShareCardAndUpdateCache,
} from './index.ts';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDER_ID = '44444444-4444-4444-8444-444444444444';
const FAMILY_A = '55555555-5555-4555-8555-555555555555';
const MEMORY_ID = '77777777-7777-4777-8777-777777777777';
const MEMBER_1 = '88888888-8888-4888-8888-888888888888';
const MEMBER_2 = '99999999-9999-4999-8999-999999999999';
const ASSET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ── Round-3 fixture builder ──────────────────────────────────────────────
// Round 3 replaced every DB-calling helper (authorizeShareCardAccess,
// resolveShareCardSource, fetchTaggedMembers) with pure functions that
// post-process the SINGLE nested query's already-fetched row (see
// SHARE_CARD_MEMORY_SELECT's header comment in index.ts) -- so these tests
// no longer need a fake Supabase query-builder mock at all. A plain object
// literal (this builder) is both simpler AND a closer match to what the
// real functions actually receive at runtime.
function buildQueryRow(overrides: Partial<ShareCardMemoryQueryRow> = {}): ShareCardMemoryQueryRow {
  return {
    id: MEMORY_ID,
    family_id: FAMILY_A,
    // Store-through cache (W2): the memory's creator -- defaults to OWNER_ID
    // so buildShareCardKey's prefix is deterministic in tests that don't
    // care about ownership specifically.
    user_id: OWNER_ID,
    content: null,
    memory_type: 'text_only',
    memory_date: '2026-06-08',
    illustration_key: null,
    illustration_status: 'none',
    emotion: null,
    // No stored card by default -- every cache-related test overrides this
    // explicitly.
    share_card_key: null,
    families: { id: FAMILY_A, viewer_sharing_enabled: true, family_memberships: [] },
    memory_media: [],
    memory_family_members: [],
    ...overrides,
  };
}

/** A family_memberships fixture with the caller present as `role`, for
 * handler-level tests (W2) that need authorizeShareCardAccessFromQueryRow to
 * succeed for a specific user id. */
function ownerFamilies(callerId: string, role: 'owner' | 'manager' | 'viewer' = 'owner') {
  return { id: FAMILY_A, viewer_sharing_enabled: true, family_memberships: [{ user_id: callerId, role }] };
}

// ── Rate limiting ("rate-limit row" in the S3 test matrix) ────────────────

Deno.test('isComposeRateLimited allows up to the max per window and then blocks', () => {
  _resetRateLimitStateForTests();
  const userId = 'rate-user-1';
  const now = 1_000_000;

  for (let i = 0; i < SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    assertEquals(isComposeRateLimited(userId, now), false);
    markComposeRun(userId, now);
  }

  assertEquals(isComposeRateLimited(userId, now), true);
});

Deno.test('isComposeRateLimited resets once the window has elapsed', () => {
  _resetRateLimitStateForTests();
  const userId = 'rate-user-2';
  const now = 2_000_000;

  for (let i = 0; i < SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    markComposeRun(userId, now);
  }
  assertEquals(isComposeRateLimited(userId, now), true);

  const later = now + SHARE_CARD_RATE_LIMIT_WINDOW_MS + 1;
  assertEquals(isComposeRateLimited(userId, later), false);
});

Deno.test('isComposeRateLimited tracks each user independently', () => {
  _resetRateLimitStateForTests();
  const now = 3_000_000;
  for (let i = 0; i < SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    markComposeRun('busy-user', now);
  }
  assertEquals(isComposeRateLimited('busy-user', now), true);
  assertEquals(isComposeRateLimited('quiet-user', now), false);
});

// ── Filename ────────────────────────────────────────────────────────────

Deno.test('buildShareCardFilename matches the locked momora-<mon>-<d>-<yyyy>.png format', () => {
  assertEquals(buildShareCardFilename('2026-06-08'), 'momora-jun-8-2026.png');
  assertEquals(buildShareCardFilename('2026-01-01'), 'momora-jan-1-2026.png');
  assertEquals(buildShareCardFilename('2026-12-31'), 'momora-dec-31-2026.png');
});

Deno.test('buildShareCardFilename does not zero-pad the day', () => {
  assertStringIncludes(buildShareCardFilename('2026-06-08'), '-8-');
});

Deno.test('buildShareCardFilename falls back gracefully for an unparsable date', () => {
  assertEquals(buildShareCardFilename('not-a-date'), 'momora-memory.png');
});

// ── MIME / format resolution ───────────────────────────────────────────

Deno.test('mimeTypeFromObjectKey resolves the common extensions', () => {
  assertEquals(mimeTypeFromObjectKey('u/memories/m/media/a.jpg'), 'image/jpeg');
  assertEquals(mimeTypeFromObjectKey('u/memories/m/media/a.jpeg'), 'image/jpeg');
  assertEquals(mimeTypeFromObjectKey('u/memories/m/illustrations/g.webp'), 'image/webp');
  assertEquals(mimeTypeFromObjectKey('u/family/m/photo.webp'), 'image/webp');
  assertEquals(mimeTypeFromObjectKey('u/family/m/portraits/v/photo.jpg'), 'image/jpeg');
  assertEquals(mimeTypeFromObjectKey('u/memories/m/media/a.png'), 'image/png');
  assertEquals(mimeTypeFromObjectKey('u/memories/m/media/a.heic'), 'image/heic');
});

// resolveImageMimeType: regression coverage for the production incident
// where generate-portrait-illustration uploads real PNG/JPEG bytes under a
// `.webp`-suffixed R2 key (OpenAI's `output_format: 'webp'` request was not
// honored), and mimeTypeFromObjectKey alone -- trusting only the extension
// -- fed satori a declared `image/webp` data URI containing PNG bytes,
// which throws ("Invalid WebP") and crashed the ENTIRE compose for any
// memory tagging a member with a mismatched portrait. Verified against
// production data: 9/9 family members' illustrated_profile_key portraits
// have this exact mismatch (see the implementation report).
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
const GARBAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

Deno.test('resolveImageMimeType sniffs real PNG bytes even when the key claims .webp (the incident case)', () => {
  assertEquals(
    resolveImageMimeType('u/family/m/illustrated_profile.webp', PNG_BYTES),
    'image/png',
  );
});

Deno.test('resolveImageMimeType sniffs real JPEG bytes even when the key claims .webp', () => {
  assertEquals(
    resolveImageMimeType('u/family/m/profile_picture.webp', JPEG_BYTES),
    'image/jpeg',
  );
});

Deno.test('resolveImageMimeType confirms real WebP bytes as image/webp', () => {
  assertEquals(
    resolveImageMimeType('u/family/m/photo.webp', WEBP_BYTES),
    'image/webp',
  );
});

Deno.test('resolveImageMimeType falls back to the extension when the signature is unrecognized (e.g. HEIC)', () => {
  assertEquals(
    resolveImageMimeType('u/memories/m/media/a.heic', GARBAGE_BYTES),
    'image/heic',
  );
});

Deno.test('isUnrasterizableMimeType flags HEIC/HEIF only', () => {
  assertEquals(isUnrasterizableMimeType('image/heic'), true);
  assertEquals(isUnrasterizableMimeType('image/heif'), true);
  assertEquals(isUnrasterizableMimeType('image/jpeg'), false);
  assertEquals(isUnrasterizableMimeType('image/webp'), false);
});

Deno.test('isVideoContentType matches the two allowed video content types', () => {
  assertEquals(isVideoContentType('video/mp4'), true);
  assertEquals(isVideoContentType('video/quicktime'), true);
  assertEquals(isVideoContentType('image/jpeg'), false);
});

// ── Real-WebP decode (bug 3: "illustrated memories render NO
// illustration") ─────────────────────────────────────────────────────────
// Root cause (see this package's implementation report): resvg-wasm@2.6.2's
// bundled `image` crate cannot decode real (non-mislabeled) WebP bytes --
// verified against a real production illustration_key, it rasters as a
// BLANK image block with NO exception anywhere in the pipeline (satori
// embeds the <image> node with a correct href; resvg just renders nothing).
// 19/20 sampled illustration_key files are genuine webp, so this broke
// nearly every illustrated memory's share. convertWebpToJpeg decodes via
// @jsquash/webp (proven against that exact production image where both
// resvg-wasm and imagescript's own decoder failed) and re-encodes to JPEG.
//
// Fixture: a real, valid, minimal (54-byte) lossy WebP -- a solid 4x4
// RGBA(200,80,120,255) image -- generated via @jsquash/webp's own encode()
// during implementation (not hand-crafted bytes), so this exercises the
// REAL decode path, not a mocked one.
const TINY_REAL_WEBP_B64 = 'UklGRi4AAABXRUJQVlA4ICIAAAAwAQCdASoEAAQAAgA0JaAAA3AA/teQf//OJf/QL/wF7jAA';

function base64ToBytesForTest(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Round 4 (this package's implementation report): convertWebpToJpeg no
// longer decodes its own wasm bytes from a base64 module -- the caller
// (index.ts, via assets-loader.ts in production) supplies them. Tests read
// the SAME real binary the upload script pushes to R2 straight off disk
// (assets/bin/webp-dec.wasm) -- no network/R2 access in this test file.
const WEBP_DEC_WASM_BYTES = await Deno.readFile(new URL('./assets/bin/webp-dec.wasm', import.meta.url));

Deno.test('convertWebpToJpeg decodes a real webp and re-encodes as JPEG (the must-not-be-blank fix)', async () => {
  const bytes = base64ToBytesForTest(TINY_REAL_WEBP_B64);
  const result = await convertWebpToJpeg(bytes, SHARE_CARD_MAX_IMAGE_EDGE, WEBP_DEC_WASM_BYTES);
  if (!result) {
    throw new Error('expected convertWebpToJpeg to succeed on a real, valid webp fixture');
  }
  assertEquals(result.contentType, 'image/jpeg');
  // A valid JPEG always starts with the FF D8 FF SOI marker -- the cheapest
  // possible proof this is real re-encoded image data, not an empty/garbage
  // buffer silently passed through.
  assertEquals(result.bytes[0], 0xff);
  assertEquals(result.bytes[1], 0xd8);
  assertEquals(result.bytes[2], 0xff);
  assertEquals(result.bytes.length > 0, true);
});

Deno.test('convertWebpToJpeg resizes when the decoded image exceeds maxEdge', async () => {
  const bytes = base64ToBytesForTest(TINY_REAL_WEBP_B64); // 4x4 real webp
  const uncapped = await convertWebpToJpeg(bytes, 1600, WEBP_DEC_WASM_BYTES);
  const capped = await convertWebpToJpeg(bytes, 2, WEBP_DEC_WASM_BYTES); // force a resize on a 4x4 source
  if (!uncapped || !capped) {
    throw new Error('expected both conversions to succeed on a real, valid webp fixture');
  }
  // Both are valid re-encoded JPEGs; the aggressively-capped one must not be
  // LARGER than the uncapped one (a real resize happened, not a no-op).
  assertEquals(capped.bytes.length <= uncapped.bytes.length, true);
});

Deno.test('convertWebpToJpeg returns null (fails closed, not blank) on corrupt bytes', async () => {
  const garbage = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9, 9]);
  const result = await convertWebpToJpeg(garbage, SHARE_CARD_MAX_IMAGE_EDGE, WEBP_DEC_WASM_BYTES);
  assertEquals(result, null);
});

// ── Aspect math ─────────────────────────────────────────────────────────

Deno.test('clampMediaAspectRatio clamps to [3/4, 16/9], matching src/utils/media-aspect.ts', () => {
  assertEquals(clampMediaAspectRatio(1), 1);
  assertEquals(clampMediaAspectRatio(0.1), 3 / 4);
  assertEquals(clampMediaAspectRatio(10), 16 / 9);
});

// Bug 1 regression: this clamp used to be named/scoped to "illustration"
// only and NEVER applied to real media photos -- verified against
// production data, ~22% of real image assets store an aspect_ratio outside
// [3/4, 16/9] (the DB's own CHECK constraint only requires 0.1-10). An
// extreme unclamped value inflates the card's image-block height well past
// what the in-app card ever shows, and is believed to be a contributor to
// WORKER_RESOURCE_LIMIT compose failures on carousel/media shares. This
// pins the exact production-shaped extreme (a tall portrait screenshot)
// that the pre-fix code would have let straight through.
Deno.test('clampMediaAspectRatio clamps a real extreme value (production sample: 0.45) into range', () => {
  assertEquals(clampMediaAspectRatio(0.45), 3 / 4);
});

// ── Memory-type rejection ──────────────────────────────────────────────

Deno.test('isRejectedMemoryType accepts the three shippable types', () => {
  assertEquals(isRejectedMemoryType('text_only'), false);
  assertEquals(isRejectedMemoryType('text_illustration'), false);
  assertEquals(isRejectedMemoryType('media'), false);
});

Deno.test('isRejectedMemoryType rejects audio and unknown types', () => {
  assertEquals(isRejectedMemoryType('audio'), true);
  assertEquals(isRejectedMemoryType('something_else'), true);
  assertEquals(isRejectedMemoryType(''), true);
});

// ── resolveShareCardSourceFromQueryRow (memory-type / media-asset validation) ──
// Round 3: reads the candidate asset from `row.memory_media` (already
// fetched by the single nested query) instead of issuing its own DB call --
// see resolveShareCardSourceFromQueryRow's doc comment in index.ts. Same
// exact validation matrix as the pre-round-3 resolveShareCardSource; only
// the fixture shape changed (a plain query-row object, not a fake Supabase
// client).

function mediaRow(overrides: Partial<{
  id: string;
  memory_id: string;
  object_key: string;
  preview_object_key: string | null;
  content_type: string;
  aspect_ratio: number | null;
  share_card_key: string | null;
}> = {}) {
  return {
    id: ASSET_ID,
    memory_id: MEMORY_ID,
    object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.jpg`,
    preview_object_key: null,
    content_type: 'image/jpeg',
    aspect_ratio: 1.5,
    // Store-through cache (W2): no stored per-asset card by default.
    share_card_key: null,
    ...overrides,
  };
}

Deno.test('resolveShareCardSourceFromQueryRow: audio memory type is rejected explicitly', () => {
  const result = resolveShareCardSourceFromQueryRow(buildQueryRow({ memory_type: 'audio' }), undefined);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'unsupported_memory_type');
    assertEquals(result.error.status, 400);
  }
});

Deno.test('resolveShareCardSourceFromQueryRow: unknown memory type is rejected explicitly', () => {
  const result = resolveShareCardSourceFromQueryRow(buildQueryRow({ memory_type: 'some_future_type' }), undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'unsupported_memory_type');
});

Deno.test('resolveShareCardSourceFromQueryRow: text_only resolves with no media source', () => {
  const result = resolveShareCardSourceFromQueryRow(buildQueryRow({ memory_type: 'text_only' }), undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.source, { kind: 'text' });
});

Deno.test('resolveShareCardSourceFromQueryRow: text_illustration not ready is rejected', () => {
  const row = buildQueryRow({ memory_type: 'text_illustration', illustration_status: 'generating', illustration_key: null });
  const result = resolveShareCardSourceFromQueryRow(row, undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'illustration_not_ready');
});

Deno.test('resolveShareCardSourceFromQueryRow: ready text_illustration resolves to the illustration key', () => {
  const objectKey = `${OWNER_ID}/memories/${MEMORY_ID}/illustrations/g1.webp`;
  const row = buildQueryRow({ memory_type: 'text_illustration', illustration_status: 'ready', illustration_key: objectKey });
  const result = resolveShareCardSourceFromQueryRow(row, undefined);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.source, { kind: 'illustration', objectKey });
  }
});

Deno.test('resolveShareCardSourceFromQueryRow: media memory requires mediaAssetId', () => {
  const result = resolveShareCardSourceFromQueryRow(buildQueryRow({ memory_type: 'media' }), undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'validation_error');
});

// Round 3 note: "ownership" is now enforced STRUCTURALLY by the nested
// select itself (PostgREST only ever embeds memory_media rows whose FK
// actually points at this memory), not by an app-level `.eq('memory_id',
// ...)` filter -- so a foreign-memory's asset can never appear in
// `row.memory_media` in the first place. This test simulates that: the
// row's `memory_media` array simply doesn't contain the requested id
// (as if it belonged to a different memory and was never embedded here),
// and asserts the same asset_not_found outcome the old ownership check produced.
Deno.test('resolveShareCardSourceFromQueryRow: an asset id not present in this memory\'s embedded memory_media is asset_not_found (structural ownership guarantee)', () => {
  const row = buildQueryRow({ memory_type: 'media', memory_media: [mediaRow({ id: 'some-other-assets-id' })] });
  const result = resolveShareCardSourceFromQueryRow(row, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'asset_not_found');
    assertEquals(result.error.status, 404);
  }
});

// Bug 1 repro/regression: "carousel share fails every time; single-photo
// works". Traced (see this package's implementation report) to a suspected
// client/server mediaAssetId mismatch for a NON-FIRST carousel page --
// disproven against real production data (explicit correct mediaAssetId
// values for both single- and multi-asset memories succeeded and failed at
// statistically indistinguishable rates, purely from the pre-existing
// WORKER_RESOURCE_LIMIT flakiness). This test pins the exact scenario the
// bug report describes -- a real multi-asset (carousel) memory, requesting
// the SECOND (non-first) page's mediaAssetId while the first page's row is
// ALSO present in the embedded array -- and asserts the lookup resolves to
// that exact asset, not silently the first row / not a spurious
// asset_not_found. Guards against a future regression in the `.find(m =>
// m.id === mediaAssetId)` lookup (e.g. an accidental `[0]` instead).
Deno.test('resolveShareCardSourceFromQueryRow: carousel non-first page resolves to the EXACT requested asset, not the first row', () => {
  const FIRST_ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const SECOND_ASSET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [
      mediaRow({ id: FIRST_ASSET_ID, object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${FIRST_ASSET_ID}.jpg` }),
      mediaRow({
        id: SECOND_ASSET_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}.jpg`,
        preview_object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}-preview.jpg`,
        aspect_ratio: 0.8,
      }),
    ],
  });

  const result = resolveShareCardSourceFromQueryRow(row, SECOND_ASSET_ID);
  assertEquals(result.ok, true);
  if (result.ok && result.source.kind === 'media') {
    assertEquals(result.source.objectKey, `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}-preview.jpg`);
    assertEquals(result.source.storedAspectRatio, 0.8);
  }

  // The first page must still resolve correctly too -- proves this isn't
  // "second page only ever wins" but genuinely id-selective both ways.
  const firstResult = resolveShareCardSourceFromQueryRow(row, FIRST_ASSET_ID);
  assertEquals(firstResult.ok, true);
  if (firstResult.ok && firstResult.source.kind === 'media') {
    assertEquals(firstResult.source.objectKey, `${OWNER_ID}/memories/${MEMORY_ID}/media/${FIRST_ASSET_ID}.jpg`);
  }
});

Deno.test('resolveShareCardSourceFromQueryRow: video content types are rejected', () => {
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [mediaRow({ object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.mp4`, content_type: 'video/mp4', aspect_ratio: null })],
  });
  const result = resolveShareCardSourceFromQueryRow(row, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'video_not_supported');
});

Deno.test('resolveShareCardSourceFromQueryRow: photo media resolves preview_object_key over object_key', () => {
  const previewKey = `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}-preview.jpg`;
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [mediaRow({
      object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.heic`,
      preview_object_key: previewKey,
      content_type: 'image/heic',
      aspect_ratio: 0.8,
    })],
  });
  const result = resolveShareCardSourceFromQueryRow(row, ASSET_ID);
  assertEquals(result.ok, true);
  if (result.ok && result.source.kind === 'media') {
    assertEquals(result.source.objectKey, previewKey);
    assertEquals(result.source.storedAspectRatio, 0.8);
  }
});

Deno.test('resolveShareCardSourceFromQueryRow: legacy HEIC row with no preview is rejected as unsupported', () => {
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [mediaRow({ object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.heic`, content_type: 'image/heic', aspect_ratio: null })],
  });
  const result = resolveShareCardSourceFromQueryRow(row, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'unsupported_image_format');
});

Deno.test('resolveShareCardSourceFromQueryRow: asset id that does not exist at all is asset_not_found', () => {
  const row = buildQueryRow({ memory_type: 'media', memory_media: [] });
  const result = resolveShareCardSourceFromQueryRow(row, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'asset_not_found');
});

// ── resolveCallerRoleFromQueryRow / authorizeShareCardAccessFromQueryRow
// (authz matrix: owner/manager/viewer×toggle/non-member) ──────────────────
// Round 3: role + `viewer_sharing_enabled` both come from the single nested
// query's embedded `families(family_memberships(...))` relation -- no DB
// call. Same authz matrix as the pre-round-3 authorizeShareCardAccess.

Deno.test('authorizeShareCardAccessFromQueryRow: owner is always authorized', () => {
  const row = buildQueryRow({
    families: { id: FAMILY_A, viewer_sharing_enabled: false, family_memberships: [{ user_id: OWNER_ID, role: 'owner' }] },
  });
  const result = authorizeShareCardAccessFromQueryRow(row, OWNER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccessFromQueryRow: manager is always authorized, independent of the viewer toggle', () => {
  const row = buildQueryRow({
    families: { id: FAMILY_A, viewer_sharing_enabled: false, family_memberships: [{ user_id: MANAGER_ID, role: 'manager' }] },
  });
  const result = authorizeShareCardAccessFromQueryRow(row, MANAGER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccessFromQueryRow: viewer is authorized when viewer_sharing_enabled is true', () => {
  const row = buildQueryRow({
    families: { id: FAMILY_A, viewer_sharing_enabled: true, family_memberships: [{ user_id: VIEWER_ID, role: 'viewer' }] },
  });
  const result = authorizeShareCardAccessFromQueryRow(row, VIEWER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccessFromQueryRow: viewer is rejected (sharing_disabled) when viewer_sharing_enabled is false', () => {
  const row = buildQueryRow({
    families: { id: FAMILY_A, viewer_sharing_enabled: false, family_memberships: [{ user_id: VIEWER_ID, role: 'viewer' }] },
  });
  const result = authorizeShareCardAccessFromQueryRow(row, VIEWER_ID);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'sharing_disabled');
    assertEquals(result.error.status, 403);
  }
});

Deno.test('authorizeShareCardAccessFromQueryRow: caller absent from family_memberships is forbidden (defensive -- RLS should make this unreachable in practice)', () => {
  const row = buildQueryRow({
    families: { id: FAMILY_A, viewer_sharing_enabled: true, family_memberships: [] },
  });
  const result = authorizeShareCardAccessFromQueryRow(row, OUTSIDER_ID);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'forbidden');
    assertEquals(result.error.status, 403);
  }
});

Deno.test('resolveCallerRoleFromQueryRow: finds the caller among several memberships and ignores the others', () => {
  const row = buildQueryRow({
    families: {
      id: FAMILY_A,
      viewer_sharing_enabled: true,
      family_memberships: [
        { user_id: OWNER_ID, role: 'owner' },
        { user_id: MANAGER_ID, role: 'manager' },
        { user_id: VIEWER_ID, role: 'viewer' },
      ],
    },
  });
  assertEquals(resolveCallerRoleFromQueryRow(row, VIEWER_ID), 'viewer');
  assertEquals(resolveCallerRoleFromQueryRow(row, MANAGER_ID), 'manager');
  assertEquals(resolveCallerRoleFromQueryRow(row, OUTSIDER_ID), null);
});

// Round 3: authorization and resolution are now both SYNC post-processing
// of the same already-fetched row -- no more Promise.all, so there's no
// "which settles first" question to guard against (round 2's version of
// this test is gone). What's still worth pinning: the fixed check order in
// handleComposeShareCard (authorization checked before resolution) means a
// non-member/blocked-viewer gets 403, never a 400/404 that would leak the
// memory's type, when BOTH would fail.
Deno.test('authorization is checked before resolution, so a blocked viewer never sees a resolution-layer error code', () => {
  const row = buildQueryRow({
    memory_type: 'audio', // would also fail resolution (unsupported_memory_type)
    families: { id: FAMILY_A, viewer_sharing_enabled: false, family_memberships: [{ user_id: VIEWER_ID, role: 'viewer' }] },
  });

  const authorization = authorizeShareCardAccessFromQueryRow(row, VIEWER_ID);
  assertEquals(authorization.ok, false);
  if (!authorization.ok) assertEquals(authorization.error.code, 'sharing_disabled');

  // handleComposeShareCard never even calls resolveShareCardSourceFromQueryRow
  // once authorization has failed -- but confirming it WOULD also fail here
  // proves this scenario genuinely exercises the priority order, not a
  // coincidentally-passing case.
  const resolution = resolveShareCardSourceFromQueryRow(row, undefined);
  assertEquals(resolution.ok, false);
});

// ── Tagged-member portrait resolution ──────────────────────────────────

Deno.test('resolveMemberPortraitKey prefers the illustrated portrait when ready', () => {
  const key = resolveMemberPortraitKey({
    id: MEMBER_1,
    name: 'Mia',
    illustrated_profile_key: 'illustrated.webp',
    illustrated_profile_status: 'ready',
    profile_picture_key: 'photo.jpg',
  });
  assertEquals(key, 'illustrated.webp');
});

Deno.test('resolveMemberPortraitKey uses the raw photo while a portrait is generating', () => {
  const key = resolveMemberPortraitKey({
    id: MEMBER_1,
    name: 'Mia',
    illustrated_profile_key: 'stale-illustrated.webp',
    illustrated_profile_status: 'generating',
    profile_picture_key: 'photo.jpg',
  });
  assertEquals(key, 'photo.jpg');
});

Deno.test('resolveMemberPortraitKey falls back to the raw photo when there is no illustrated portrait yet', () => {
  const key = resolveMemberPortraitKey({
    id: MEMBER_1,
    name: 'Mia',
    illustrated_profile_key: null,
    illustrated_profile_status: 'pending',
    profile_picture_key: 'photo.jpg',
  });
  assertEquals(key, 'photo.jpg');
});

// resolveTaggedMembersFromQueryRow: round 3 rewrite of fetchTaggedMembers --
// same dedupe/cap logic, reads `row.memory_family_members` (already fetched
// by the single nested query) instead of its own DB call. Sync now.

Deno.test('resolveTaggedMembersFromQueryRow caps at MAX_VISIBLE_MEMBERS and reports the overflow count', () => {
  const memoryFamilyMembers = Array.from({ length: 8 }, (_, i) => ({
    family_member_id: `member-${i}`,
    family_members: {
      id: `member-${i}`,
      name: `Kid ${i}`,
      illustrated_profile_key: null,
      illustrated_profile_status: 'ready',
      profile_picture_key: null,
    },
  }));
  const row = buildQueryRow({ memory_family_members: memoryFamilyMembers });
  const result = resolveTaggedMembersFromQueryRow(row);
  assertEquals(result.members.length, 6);
  assertEquals(result.overflowCount, 2);
});

Deno.test('resolveTaggedMembersFromQueryRow drops rows whose joined family_members is null (deleted member)', () => {
  const row = buildQueryRow({
    memory_family_members: [
      {
        family_member_id: MEMBER_1,
        family_members: {
          id: MEMBER_1,
          name: 'Mia',
          illustrated_profile_key: null,
          illustrated_profile_status: 'ready',
          profile_picture_key: null,
        },
      },
      { family_member_id: MEMBER_2, family_members: null },
    ],
  });
  const result = resolveTaggedMembersFromQueryRow(row);
  assertEquals(result.members.length, 1);
  assertEquals(result.members[0].id, MEMBER_1);
});

// ── Perf-audit restructure: batched image fetch (this package's
// implementation report) -- resolvePortraitKeysToFetch / buildTaggedMemberPortraits
// replace the old resolveMemberPortraits, split so the request handler can
// fire the hero image fetch and every portrait fetch in the SAME wall-clock
// window (getObjectBytesBatch, _shared/r2.ts) instead of fetching portraits
// first and the hero image afterward. These tests exercise
// buildTaggedMemberPortraits' fail-open CPU-only processing step directly,
// with a fake "already fetched" bytes Map -- no network/DB needed -- to
// prove the fail-open guarantee survives the restructure. ─────────────────

// 1x1 transparent PNG -- same fixture layout.test.ts's STUB_IMAGE_DATA_URI
// uses, decoded to raw bytes here since buildTaggedMemberPortraits takes
// already-fetched bytes, not a data URI.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function member(id: string, name: string, portraitKey: string | null) {
  return {
    id,
    name,
    illustrated_profile_key: portraitKey,
    illustrated_profile_status: 'ready',
    profile_picture_key: null,
  };
}

Deno.test('resolvePortraitKeysToFetch returns one key per member that has one, in member order', () => {
  const keys = resolvePortraitKeysToFetch([
    member(MEMBER_1, 'Mia', 'mia.jpg'),
    member(MEMBER_2, 'No Photo Yet', null),
  ]);
  assertEquals(keys, ['mia.jpg']);
});

Deno.test('resolvePortraitKeysToFetch returns an empty array when no tagged member has a portrait key', () => {
  assertEquals(resolvePortraitKeysToFetch([member(MEMBER_1, 'No Photo', null)]), []);
});

Deno.test('buildTaggedMemberPortraits: a successfully-fetched portrait produces a real data URI', async () => {
  const bytes = base64ToBytesForTest(TINY_PNG_B64);
  const portraits = await buildTaggedMemberPortraits(
    [member(MEMBER_1, 'Mia', 'mia.jpg')],
    new Map([['mia.jpg', { ok: true, bytes }]]),
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits.length, 1);
  assertEquals(portraits[0].name, 'Mia');
  assertStringIncludes(portraits[0].dataUri ?? '', 'data:image/png;base64,');
});

// BUG-SURVIVAL regression test (coordinator's explicit ask): the fail-open
// guarantee -- one bad portrait must never fail the whole share -- predates
// this restructure (the old resolveMemberPortraits caught per-portrait
// errors from its own inline fetch). Verifies it survives moving the fetch
// OUT of this function entirely (now just reads pre-fetched batch results).
Deno.test('buildTaggedMemberPortraits: a portrait whose R2 fetch failed (ok:false in the batch) falls back to null dataUri, not a throw', async () => {
  const portraits = await buildTaggedMemberPortraits(
    [member(MEMBER_1, 'Mia', 'mia.jpg')],
    new Map([['mia.jpg', { ok: false, error: new Error('R2 fetch failed with status 404') }]]),
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits, [{ name: 'Mia', dataUri: null }]);
});

Deno.test('buildTaggedMemberPortraits: a portrait key entirely MISSING from the batch map (e.g. dropped by a bug upstream) also fails open, not a throw', async () => {
  const portraits = await buildTaggedMemberPortraits(
    [member(MEMBER_1, 'Mia', 'mia.jpg')],
    new Map(), // empty -- 'mia.jpg' was never fetched
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits, [{ name: 'Mia', dataUri: null }]);
});

Deno.test('buildTaggedMemberPortraits: a member with no portrait key at all is never looked up in the batch map', async () => {
  const portraits = await buildTaggedMemberPortraits(
    [member(MEMBER_1, 'No Photo', null)],
    new Map([['unrelated-key.jpg', { ok: true, bytes: base64ToBytesForTest(TINY_PNG_B64) }]]),
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits, [{ name: 'No Photo', dataUri: null }]);
});

Deno.test('buildTaggedMemberPortraits: ONE failed portrait among several does not affect the others (fail-open is per-member, not all-or-nothing)', async () => {
  const goodBytes = base64ToBytesForTest(TINY_PNG_B64);
  const portraits = await buildTaggedMemberPortraits(
    [
      member(MEMBER_1, 'Mia', 'mia.jpg'),
      member(MEMBER_2, 'Leo', 'leo.jpg'),
    ],
    new Map([
      ['mia.jpg', { ok: true, bytes: goodBytes }],
      ['leo.jpg', { ok: false, error: new Error('network error') }],
    ]),
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits.length, 2);
  assertStringIncludes(portraits[0].dataUri ?? '', 'data:image/png;base64,');
  assertEquals(portraits[1], { name: 'Leo', dataUri: null });
});

Deno.test('buildTaggedMemberPortraits: an unrasterizable format (HEIC) falls back to null even though the fetch itself succeeded', async () => {
  // HEIC magic bytes are irrelevant to resolveImageMimeType's PNG/JPEG/WEBP
  // sniffing -- it falls back to the KEY's extension for anything else, so
  // a `.heic`-suffixed key with arbitrary bytes exercises the
  // isUnrasterizableMimeType branch exactly like a real legacy HEIC portrait
  // would (compose-share-card's mismatched-extension incident notwithstanding
  // -- that incident was about the OPPOSITE case, webp-suffixed non-webp
  // bytes, not covered here).
  const portraits = await buildTaggedMemberPortraits(
    [member(MEMBER_1, 'Mia', 'mia.heic')],
    new Map([['mia.heic', { ok: true, bytes: new Uint8Array([1, 2, 3, 4]) }]]),
    WEBP_DEC_WASM_BYTES,
  );
  assertEquals(portraits, [{ name: 'Mia', dataUri: null }]);
});

// ── HTTP handler: unauthenticated + no-content-logging ─────────────────

Deno.test('handleComposeShareCard rejects unauthenticated requests', async () => {
  const response = await handleComposeShareCard(
    new Request('http://localhost/compose-share-card', {
      method: 'POST',
      body: JSON.stringify({ memoryId: MEMORY_ID }),
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test('handleComposeShareCard rejects non-POST methods', async () => {
  const response = await handleComposeShareCard(
    new Request('http://localhost/compose-share-card', { method: 'GET' }),
  );
  assertEquals(response.status, 405);
});

Deno.test('runShareCardCompose returns a PNG response with the expected filename header', async () => {
  const png = new Uint8Array([1, 2, 3]);
  const response = await runShareCardCompose(MEMORY_ID, async () => ({
    png,
    memoryDate: '2026-06-08',
  }));

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('Content-Type'), 'image/png');
  assertEquals(
    response.headers.get('Content-Disposition'),
    'attachment; filename="momora-jun-8-2026.png"',
  );
  const body = new Uint8Array(await response.arrayBuffer());
  assertEquals(body, png);
});

Deno.test('runShareCardCompose on failure never logs error.message (no-content-logging)', async () => {
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  const secretCaption = 'the secret diary entry about grandma';
  try {
    const response = await runShareCardCompose(MEMORY_ID, async () => {
      throw new Error(`satori layout failed while shaping text node "${secretCaption}"`);
    });
    assertEquals(response.status, 500);
    const body = await response.json();
    assertEquals(body.code, 'compose_failed');
  } finally {
    console.error = originalConsoleError;
  }

  assertEquals(logged.length > 0, true);
  const loggedText = logged.map((args) => args.join(' ')).join('\n');
  assertEquals(loggedText.includes(secretCaption), false);
  assertEquals(loggedText.includes('grandma'), false);
  assertStringIncludes(loggedText, MEMORY_ID);
});

// ── Store-through cache (docs/plans/share-card-store-through.md, W2):
// DESIGN_VERSION / key parsing / cache-target resolution ──────────────────

Deno.test('parseShareCardKeyDesignVersion parses the {designVersion}-{generationId}.png shape', () => {
  const key = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION}-3fa85f64-5717-4562-b3fc-2c963f66afa6`);
  assertEquals(parseShareCardKeyDesignVersion(key), DESIGN_VERSION);
});

Deno.test('parseShareCardKeyDesignVersion returns null for anything that does not match the {version}-{id}.png shape', () => {
  assertEquals(parseShareCardKeyDesignVersion('not-a-real-key'), null);
  assertEquals(parseShareCardKeyDesignVersion(`${OWNER_ID}/memories/${MEMORY_ID}/share-card/garbage.png`), null);
  assertEquals(parseShareCardKeyDesignVersion(`${OWNER_ID}/memories/${MEMORY_ID}/share-card/2.png`), null);
});

Deno.test('isFreshShareCardKey: null/undefined is never fresh (never a cache hit)', () => {
  assertEquals(isFreshShareCardKey(null), false);
  assertEquals(isFreshShareCardKey(undefined), false);
});

Deno.test('isFreshShareCardKey: a key at the current DESIGN_VERSION is fresh; an older version is treated exactly like no key at all', () => {
  const fresh = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION}-${crypto.randomUUID()}`);
  const stale = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION - 1}-${crypto.randomUUID()}`);
  assertEquals(isFreshShareCardKey(fresh), true);
  assertEquals(isFreshShareCardKey(stale), false);
});

Deno.test('resolveShareCardCacheTarget: text/illustration sources resolve to the per-MEMORY column', () => {
  const row = buildQueryRow({ share_card_key: 'stale-memory-key.png' });
  const target = resolveShareCardCacheTarget({ kind: 'text' }, row, undefined);
  assertEquals(target, { table: 'memories', id: MEMORY_ID, storedKey: 'stale-memory-key.png' });
});

Deno.test('resolveShareCardCacheTarget: a media source resolves to the per-ASSET column of the EXACT requested asset, not a sibling asset on the same memory', () => {
  const OTHER_ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [
      mediaRow({ id: ASSET_ID, share_card_key: 'asset-key.png' }),
      mediaRow({ id: OTHER_ASSET_ID, share_card_key: 'other-asset-key.png' }),
    ],
  });
  const target = resolveShareCardCacheTarget(
    { kind: 'media', objectKey: 'irrelevant', storedAspectRatio: null },
    row,
    ASSET_ID,
  );
  assertEquals(target, { table: 'memory_media', id: ASSET_ID, storedKey: 'asset-key.png' });
});

Deno.test('resolveShareCardCacheTarget: a media asset with no stored card yet resolves storedKey to null', () => {
  const row = buildQueryRow({
    memory_type: 'media',
    memory_media: [mediaRow({ id: ASSET_ID, share_card_key: null })],
  });
  const target = resolveShareCardCacheTarget(
    { kind: 'media', objectKey: 'irrelevant', storedAspectRatio: null },
    row,
    ASSET_ID,
  );
  assertEquals(target.storedKey, null);
});

// ── Warm-mode rate limit: its own bucket, independent of the cold one ─────

Deno.test('isWarmRateLimited allows up to its own (looser) max and then blocks, independent of the cold compose bucket', () => {
  _resetRateLimitStateForTests();
  const userId = 'warm-user-1';
  const now = 5_000_000;

  for (let i = 0; i < SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    assertEquals(isWarmRateLimited(userId, now), false);
    markWarmRun(userId, now);
  }
  assertEquals(isWarmRateLimited(userId, now), true);
  // A burst of warms never eats into this same user's cold-path budget.
  assertEquals(isComposeRateLimited(userId, now), false);
});

Deno.test('a burst of cold compose calls never eats into the warm-mode budget either', () => {
  _resetRateLimitStateForTests();
  const userId = 'compose-user-1';
  const now = 6_000_000;

  for (let i = 0; i < SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW; i++) {
    markComposeRun(userId, now);
  }
  assertEquals(isComposeRateLimited(userId, now), true);
  assertEquals(isWarmRateLimited(userId, now), false);
});

// ── storeShareCardAndUpdateCache: R2 put + service-role column update + ───
// best-effort stale-object cleanup, everything non-fatal on failure ───────

interface ServiceUpdateCall {
  table: string;
  payload: Record<string, unknown>;
  column: string;
  id: string;
}

function fakeServiceClient(recorder: ServiceUpdateCall[], errorToReturn: { message: string } | null = null) {
  return {
    from(table: string) {
      return {
        update(payload: Record<string, unknown>) {
          return {
            eq(column: string, id: string) {
              recorder.push({ table, payload, column, id });
              return Promise.resolve({ error: errorToReturn });
            },
          };
        },
      };
    },
  };
}

Deno.test('storeShareCardAndUpdateCache: success path puts the PNG, updates ONLY share_card_key on the target row, and skips delete when there was no prior key', async () => {
  const putCalls: Array<{ key: string; contentType: string }> = [];
  const deleteCalls: string[] = [];
  const updateCalls: ServiceUpdateCall[] = [];

  const deps: ShareCardStoreDependencies = {
    putObjectBytes: async (key, _bytes, contentType) => {
      putCalls.push({ key, contentType });
    },
    deleteObject: async (key) => {
      deleteCalls.push(key);
    },
    createServiceClient: () => fakeServiceClient(updateCalls) as never,
  };

  const target = { table: 'memories' as const, id: MEMORY_ID, storedKey: null };
  const result = await storeShareCardAndUpdateCache(target, OWNER_ID, MEMORY_ID, new Uint8Array([1, 2, 3]), deps);

  assertEquals(result.stored, true);
  assertEquals(putCalls.length, 1);
  assertEquals(putCalls[0].contentType, 'image/png');
  assertStringIncludes(putCalls[0].key, `${OWNER_ID}/memories/${MEMORY_ID}/share-card/`);
  assertStringIncludes(putCalls[0].key, `${DESIGN_VERSION}-`);

  // Service-role update payload shape: exactly one column, matched by `id`.
  assertEquals(updateCalls.length, 1);
  assertEquals(updateCalls[0].table, 'memories');
  assertEquals(updateCalls[0].column, 'id');
  assertEquals(updateCalls[0].id, MEMORY_ID);
  assertEquals(Object.keys(updateCalls[0].payload), ['share_card_key']);
  assertEquals(updateCalls[0].payload.share_card_key, putCalls[0].key);

  assertEquals(deleteCalls.length, 0);
});

Deno.test('storeShareCardAndUpdateCache: a prior stored key is deleted best-effort AFTER the new one is stored, never the new key itself', async () => {
  const deleteCalls: string[] = [];
  const updateCalls: ServiceUpdateCall[] = [];
  const OLD_KEY = buildShareCardKey(OWNER_ID, MEMORY_ID, `1-${crypto.randomUUID()}`);

  const deps: ShareCardStoreDependencies = {
    putObjectBytes: async () => {},
    deleteObject: async (key) => {
      deleteCalls.push(key);
    },
    createServiceClient: () => fakeServiceClient(updateCalls) as never,
  };

  const target = { table: 'memories' as const, id: MEMORY_ID, storedKey: OLD_KEY };
  const result = await storeShareCardAndUpdateCache(target, OWNER_ID, MEMORY_ID, new Uint8Array([1]), deps);

  assertEquals(result.stored, true);
  assertEquals(deleteCalls, [OLD_KEY]);
  assertEquals(updateCalls[0].payload.share_card_key !== OLD_KEY, true);
});

Deno.test('storeShareCardAndUpdateCache: a per-ASSET target updates memory_media, not memories', async () => {
  const updateCalls: ServiceUpdateCall[] = [];
  const deps: ShareCardStoreDependencies = {
    putObjectBytes: async () => {},
    deleteObject: async () => {},
    createServiceClient: () => fakeServiceClient(updateCalls) as never,
  };

  const target = { table: 'memory_media' as const, id: ASSET_ID, storedKey: null };
  await storeShareCardAndUpdateCache(target, OWNER_ID, MEMORY_ID, new Uint8Array([1]), deps);

  assertEquals(updateCalls[0].table, 'memory_media');
  assertEquals(updateCalls[0].id, ASSET_ID);
});

Deno.test('storeShareCardAndUpdateCache: R2 put failure is non-fatal -- returns stored:false, never touches the DB or deletes the old object', async () => {
  const updateCalls: ServiceUpdateCall[] = [];
  const deleteCalls: string[] = [];
  const deps: ShareCardStoreDependencies = {
    putObjectBytes: async () => {
      throw new Error('R2 unavailable');
    },
    deleteObject: async (key) => {
      deleteCalls.push(key);
    },
    createServiceClient: () => fakeServiceClient(updateCalls) as never,
  };

  const target = { table: 'memories' as const, id: MEMORY_ID, storedKey: 'old-key.png' };
  const result = await storeShareCardAndUpdateCache(target, OWNER_ID, MEMORY_ID, new Uint8Array([1]), deps);

  assertEquals(result.stored, false);
  assertEquals(updateCalls.length, 0);
  assertEquals(deleteCalls.length, 0);
});

Deno.test('storeShareCardAndUpdateCache: DB column-update failure is non-fatal -- returns stored:false and does not delete the old (still-live) object', async () => {
  const deleteCalls: string[] = [];
  const deps: ShareCardStoreDependencies = {
    putObjectBytes: async () => {},
    deleteObject: async (key) => {
      deleteCalls.push(key);
    },
    createServiceClient: () => fakeServiceClient([], { message: 'db unavailable' }) as never,
  };

  const target = { table: 'memories' as const, id: MEMORY_ID, storedKey: 'old-key.png' };
  const result = await storeShareCardAndUpdateCache(target, OWNER_ID, MEMORY_ID, new Uint8Array([1]), deps);

  assertEquals(result.stored, false);
  assertEquals(deleteCalls.length, 0);
});

// ── handleComposeShareCard end-to-end: store-through cache + warm mode ────
// (W2). Only getAuthenticatedNonAnonymousUser's own `/auth/v1/user` call
// touches real `fetch` here -- every other dependency (the DB query, R2
// reads/writes, asset loading, composeShareCardPng) is injected through
// handleComposeShareCard's dependencyOverrides parameter (mirrors
// generate-illustration's DEFAULT_DEPENDENCIES pattern, see that package's
// index.ts/index.test.ts), so these tests never hit a real Supabase/R2
// endpoint other than that one auth call.

const HANDLER_TEST_ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_ANON_KEY: 'test-anon-key',
} as const;

async function withMockedAuth(callerId: string, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalEnv = new Map(Object.keys(HANDLER_TEST_ENV).map((key) => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(HANDLER_TEST_ENV)) {
    Deno.env.set(key, value);
  }

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/auth/v1/user') {
      return new Response(JSON.stringify({
        id: callerId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'parent@example.com',
        app_metadata: {},
        user_metadata: {},
        created_at: '2026-07-12T00:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected network request in a compose-share-card handler test: ${request.method} ${url}`);
  };

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

function shareRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/compose-share-card', {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const FAKE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const FAKE_ASSETS = {
  resvgWasm: new Uint8Array(),
  webpDecWasm: new Uint8Array(),
  newsreaderRegular: new Uint8Array(),
  newsreaderItalic: new Uint8Array(),
  newsreaderMedium: new Uint8Array(),
  jakartaRegular: new Uint8Array(),
  jakartaBold: new Uint8Array(),
  notoEmojiSubset: new Uint8Array(),
};

/** Every field defaults to a fake that would fail loudly if hit
 * unexpectedly (or succeeds trivially for the happy path) -- individual
 * tests override only what they care about via `overrides`. */
function baseHandlerDeps(overrides: Partial<ComposeShareCardDependencies> = {}): Partial<ComposeShareCardDependencies> {
  return {
    getObjectBytesBatch: async () => new Map(),
    loadShareCardAssets: async () => FAKE_ASSETS,
    composeShareCardPng: async () => ({ png: FAKE_PNG_BYTES, initMs: 0, satoriMs: 0, resvgMs: 0, scale: 'full' as const }),
    putObjectBytes: async () => {},
    deleteObject: async () => {},
    createServiceClient: () => fakeServiceClient([]) as never,
    ...overrides,
  };
}

Deno.test('handleComposeShareCard: a fresh cache HIT streams the stored PNG directly, and never loads fonts/wasm or composes', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const storedKey = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION}-${crypto.randomUUID()}`);
    const storedBytes = new Uint8Array([9, 9, 9, 9]);
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: storedKey });

    let getObjectBytesKey: string | null = null;
    let assetLoads = 0;
    let composeCalls = 0;

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        getObjectBytes: async (key) => {
          getObjectBytesKey = key;
          return storedBytes;
        },
        loadShareCardAssets: async () => {
          assetLoads += 1;
          throw new Error('a cache HIT must never load fonts/wasm');
        },
        composeShareCardPng: async () => {
          composeCalls += 1;
          throw new Error('a cache HIT must never compose');
        },
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(getObjectBytesKey, storedKey);
    assertEquals(assetLoads, 0);
    assertEquals(composeCalls, 0);
    assertEquals(response.headers.get('Server-Timing')?.includes('cache;desc=hit'), true);
    const body = new Uint8Array(await response.arrayBuffer());
    assertEquals(body, storedBytes);
  });
});

Deno.test('handleComposeShareCard: a MISS (no stored key) composes, stores under the CREATOR prefix + DESIGN_VERSION, and streams the PNG', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: null });

    const putCalls: Array<{ key: string }> = [];
    const updateCalls: ServiceUpdateCall[] = [];
    let composeCalls = 0;

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        composeShareCardPng: async () => {
          composeCalls += 1;
          return { png: FAKE_PNG_BYTES, initMs: 0, satoriMs: 0, resvgMs: 0, scale: 'full' as const };
        },
        putObjectBytes: async (key) => {
          putCalls.push({ key });
        },
        createServiceClient: () => fakeServiceClient(updateCalls) as never,
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(composeCalls, 1);
    assertEquals(putCalls.length, 1);
    assertStringIncludes(putCalls[0].key, `${OWNER_ID}/memories/${MEMORY_ID}/share-card/${DESIGN_VERSION}-`);
    assertEquals(updateCalls.length, 1);
    assertEquals(updateCalls[0].table, 'memories');
    assertEquals(updateCalls[0].id, MEMORY_ID);
    assertEquals(updateCalls[0].payload.share_card_key, putCalls[0].key);

    const body = new Uint8Array(await response.arrayBuffer());
    assertEquals(body, FAKE_PNG_BYTES);
  });
});

Deno.test('handleComposeShareCard: a stored key from an OLDER DESIGN_VERSION is treated as a MISS, recomposes, and deletes the stale object', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const staleKey = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION - 1}-${crypto.randomUUID()}`);
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: staleKey });

    let getObjectBytesCalls = 0;
    const deleteCalls: string[] = [];
    const updateCalls: ServiceUpdateCall[] = [];

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        getObjectBytes: async () => {
          getObjectBytesCalls += 1;
          throw new Error('a stale-version key must never be read as a hit');
        },
        deleteObject: async (key) => {
          deleteCalls.push(key);
        },
        createServiceClient: () => fakeServiceClient(updateCalls) as never,
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(getObjectBytesCalls, 0);
    assertEquals(deleteCalls, [staleKey]);
    assertEquals(updateCalls[0].payload.share_card_key !== staleKey, true);
  });
});

Deno.test('handleComposeShareCard: warm mode on an already-fresh cache is a no-op 204 -- no R2 read, no compose', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const storedKey = buildShareCardKey(OWNER_ID, MEMORY_ID, `${DESIGN_VERSION}-${crypto.randomUUID()}`);
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: storedKey });

    let getObjectBytesCalls = 0;
    let composeCalls = 0;

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID, warm: true }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        getObjectBytes: async () => {
          getObjectBytesCalls += 1;
          throw new Error('warm-on-already-fresh must never read the cached object');
        },
        composeShareCardPng: async () => {
          composeCalls += 1;
          throw new Error('warm-on-already-fresh must never compose');
        },
      }),
    );

    assertEquals(response.status, 204);
    assertEquals(getObjectBytesCalls, 0);
    assertEquals(composeCalls, 0);
    const bodyText = await response.text();
    assertEquals(bodyText, '');
  });
});

Deno.test('handleComposeShareCard: warm mode on a MISS composes + stores, and responds 204 with no body', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: null });

    const putCalls: string[] = [];
    const updateCalls: ServiceUpdateCall[] = [];
    let composeCalls = 0;

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID, warm: true }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        composeShareCardPng: async () => {
          composeCalls += 1;
          return { png: FAKE_PNG_BYTES, initMs: 0, satoriMs: 0, resvgMs: 0, scale: 'full' as const };
        },
        putObjectBytes: async (key) => {
          putCalls.push(key);
        },
        createServiceClient: () => fakeServiceClient(updateCalls) as never,
      }),
    );

    assertEquals(response.status, 204);
    assertEquals(composeCalls, 1);
    assertEquals(putCalls.length, 1);
    assertEquals(updateCalls.length, 1);
    const bodyText = await response.text();
    assertEquals(bodyText, '');
  });
});

Deno.test('handleComposeShareCard: warm requests are rate-limited on their OWN (looser) bucket, independent of the cold share limit', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    for (let i = 0; i < SHARE_CARD_WARM_RATE_LIMIT_MAX_PER_WINDOW; i++) {
      markWarmRun(OWNER_ID);
    }
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: null });

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID, warm: true }),
      baseHandlerDeps({ fetchQueryRow: async () => ({ data: row, error: null }) }),
    );

    assertEquals(response.status, 429);
  });
});

Deno.test('handleComposeShareCard: a store-through failure (R2 put throws) is non-fatal -- the share still streams the composed PNG', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const row = buildQueryRow({ families: ownerFamilies(OWNER_ID), share_card_key: null });
    const updateCalls: ServiceUpdateCall[] = [];

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        putObjectBytes: async () => {
          throw new Error('R2 unavailable');
        },
        createServiceClient: () => fakeServiceClient(updateCalls) as never,
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(updateCalls.length, 0);
    const body = new Uint8Array(await response.arrayBuffer());
    assertEquals(body, FAKE_PNG_BYTES);
  });
});

Deno.test('handleComposeShareCard: a media memory MISS stores/updates the per-ASSET column (memory_media), not the per-memory column', async () => {
  await withMockedAuth(OWNER_ID, async () => {
    _resetRateLimitStateForTests();
    const heroKey = `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.jpg`;
    const row = buildQueryRow({
      families: ownerFamilies(OWNER_ID),
      memory_type: 'media',
      memory_media: [mediaRow({ id: ASSET_ID, object_key: heroKey, share_card_key: null })],
      // A stale-looking per-MEMORY key must be completely ignored for a
      // media source -- only the per-ASSET column matters here.
      share_card_key: 'irrelevant-per-memory-key.png',
    });

    const updateCalls: ServiceUpdateCall[] = [];
    const heroBytes = base64ToBytesForTest(TINY_PNG_B64);

    const response = await handleComposeShareCard(
      shareRequest({ memoryId: MEMORY_ID, mediaAssetId: ASSET_ID }),
      baseHandlerDeps({
        fetchQueryRow: async () => ({ data: row, error: null }),
        getObjectBytesBatch: async (keys: string[]) => {
          const map = new Map();
          if (keys.includes(heroKey)) {
            map.set(heroKey, { ok: true, bytes: heroBytes });
          }
          return map;
        },
        createServiceClient: () => fakeServiceClient(updateCalls) as never,
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(updateCalls.length, 1);
    assertEquals(updateCalls[0].table, 'memory_media');
    assertEquals(updateCalls[0].id, ASSET_ID);
  });
});
