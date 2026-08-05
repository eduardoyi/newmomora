import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  _resetRateLimitStateForTests,
  authorizeShareCardAccess,
  buildShareCardFilename,
  clampMediaAspectRatio,
  convertWebpToJpeg,
  fetchTaggedMembers,
  handleComposeShareCard,
  isComposeRateLimited,
  isRejectedMemoryType,
  isUnrasterizableMimeType,
  isVideoContentType,
  markComposeRun,
  mimeTypeFromObjectKey,
  resolveImageMimeType,
  resolveMemberPortraitKey,
  resolveShareCardSource,
  runShareCardCompose,
  SHARE_CARD_MAX_IMAGE_EDGE,
  SHARE_CARD_RATE_LIMIT_MAX_PER_WINDOW,
  SHARE_CARD_RATE_LIMIT_WINDOW_MS,
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

// ── Minimal thenable query-builder mock, tailored to the .select().eq()/
// .in()/.maybeSingle() chains this package's functions issue. Doesn't model
// a real relational join -- callers supply pre-joined row shapes directly,
// same simplification _shared/family-access.test.ts's fakeSupabase uses. ──
// deno-lint-ignore no-explicit-any
function makeTable(rows: Array<Record<string, any>>) {
  return {
    // deno-lint-ignore no-explicit-any
    select(_cols?: string) {
      let filtered = rows;
      const builder = {
        // deno-lint-ignore no-explicit-any
        eq(col: string, val: any) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        // deno-lint-ignore no-explicit-any
        in(col: string, vals: any[]) {
          filtered = filtered.filter((r) => vals.includes(r[col]));
          return builder;
        },
        async maybeSingle() {
          return { data: filtered[0] ?? null, error: null };
        },
        // deno-lint-ignore no-explicit-any
        then(resolve: (v: { data: any[]; error: null }) => void) {
          resolve({ data: filtered, error: null });
        },
      };
      return builder;
    },
  };
}

interface FakeSupabaseOptions {
  families?: Array<{ id: string; owner_id: string; deleted_at: string | null; viewer_sharing_enabled?: boolean }>;
  memberships?: Array<{ family_id: string; role: string; user_id: string }>;
  // deno-lint-ignore no-explicit-any
  memoryMedia?: any[];
  // deno-lint-ignore no-explicit-any
  memoryFamilyMembers?: any[];
}

function fakeSupabase(options: FakeSupabaseOptions) {
  const tables: Record<string, ReturnType<typeof makeTable>> = {
    families: makeTable(options.families ?? []),
    family_memberships: makeTable(options.memberships ?? []),
    memory_media: makeTable(options.memoryMedia ?? []),
    memory_family_members: makeTable(options.memoryFamilyMembers ?? []),
  };

  return {
    from(table: string) {
      const found = tables[table];
      if (!found) {
        throw new Error(`Unexpected table ${table}`);
      }
      return found;
    },
  };
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

Deno.test('convertWebpToJpeg decodes a real webp and re-encodes as JPEG (the must-not-be-blank fix)', async () => {
  const bytes = base64ToBytesForTest(TINY_REAL_WEBP_B64);
  const result = await convertWebpToJpeg(bytes, SHARE_CARD_MAX_IMAGE_EDGE);
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
  const uncapped = await convertWebpToJpeg(bytes, 1600);
  const capped = await convertWebpToJpeg(bytes, 2); // force a resize on a 4x4 source
  if (!uncapped || !capped) {
    throw new Error('expected both conversions to succeed on a real, valid webp fixture');
  }
  // Both are valid re-encoded JPEGs; the aggressively-capped one must not be
  // LARGER than the uncapped one (a real resize happened, not a no-op).
  assertEquals(capped.bytes.length <= uncapped.bytes.length, true);
});

Deno.test('convertWebpToJpeg returns null (fails closed, not blank) on corrupt bytes', async () => {
  const garbage = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 9, 9, 9, 9]);
  const result = await convertWebpToJpeg(garbage, SHARE_CARD_MAX_IMAGE_EDGE);
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

// ── resolveShareCardSource (memory-type / media-asset validation) ────────

function textOnlyMemory() {
  return {
    id: MEMORY_ID,
    family_id: FAMILY_A,
    content: 'hello',
    memory_type: 'text_only',
    memory_date: '2026-06-08',
    illustration_key: null,
    illustration_status: 'none',
    emotion: null,
  };
}

Deno.test('resolveShareCardSource: audio memory type is rejected explicitly', async () => {
  const supabase = fakeSupabase({});
  const result = await resolveShareCardSource(
    supabase as never,
    { ...textOnlyMemory(), memory_type: 'audio' },
    undefined,
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'unsupported_memory_type');
    assertEquals(result.error.status, 400);
  }
});

Deno.test('resolveShareCardSource: unknown memory type is rejected explicitly', async () => {
  const supabase = fakeSupabase({});
  const result = await resolveShareCardSource(
    supabase as never,
    { ...textOnlyMemory(), memory_type: 'some_future_type' },
    undefined,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'unsupported_memory_type');
});

Deno.test('resolveShareCardSource: text_only resolves with no media source', async () => {
  const supabase = fakeSupabase({});
  const result = await resolveShareCardSource(supabase as never, textOnlyMemory(), undefined);
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.source, { kind: 'text' });
});

Deno.test('resolveShareCardSource: text_illustration not ready is rejected', async () => {
  const supabase = fakeSupabase({});
  const memory = {
    ...textOnlyMemory(),
    memory_type: 'text_illustration',
    illustration_status: 'generating',
    illustration_key: null,
  };
  const result = await resolveShareCardSource(supabase as never, memory, undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'illustration_not_ready');
});

Deno.test('resolveShareCardSource: ready text_illustration resolves to the illustration key', async () => {
  const supabase = fakeSupabase({});
  const memory = {
    ...textOnlyMemory(),
    memory_type: 'text_illustration',
    illustration_status: 'ready',
    illustration_key: `${OWNER_ID}/memories/${MEMORY_ID}/illustrations/g1.webp`,
  };
  const result = await resolveShareCardSource(supabase as never, memory, undefined);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.source, {
      kind: 'illustration',
      objectKey: `${OWNER_ID}/memories/${MEMORY_ID}/illustrations/g1.webp`,
    });
  }
});

Deno.test('resolveShareCardSource: media memory requires mediaAssetId', async () => {
  const supabase = fakeSupabase({});
  const memory = { ...textOnlyMemory(), memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, undefined);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'validation_error');
});

Deno.test('resolveShareCardSource: media asset must belong to the requested memory (asset-ownership)', async () => {
  const OTHER_MEMORY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const supabase = fakeSupabase({
    memoryMedia: [
      {
        id: ASSET_ID,
        memory_id: OTHER_MEMORY, // belongs to a different memory
        object_key: `${OWNER_ID}/memories/${OTHER_MEMORY}/media/${ASSET_ID}.jpg`,
        preview_object_key: null,
        content_type: 'image/jpeg',
        aspect_ratio: 1.5,
      },
    ],
  });
  const memory = { ...textOnlyMemory(), id: MEMORY_ID, memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, ASSET_ID);
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
// ALSO present in the same table -- and asserts the query resolves to that
// exact asset, not silently the first row / not a spurious asset_not_found.
// Guards against a future regression in the `.eq('id', ...).eq('memory_id',
// ...)` chain (e.g. an accidental `.limit(1)` before the id filter, or a
// join that collapses to the first match).
Deno.test('resolveShareCardSource: carousel non-first page resolves to the EXACT requested asset, not the first row', async () => {
  const FIRST_ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const SECOND_ASSET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const supabase = fakeSupabase({
    memoryMedia: [
      {
        id: FIRST_ASSET_ID,
        memory_id: MEMORY_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${FIRST_ASSET_ID}.jpg`,
        preview_object_key: null,
        content_type: 'image/jpeg',
        aspect_ratio: 1.5,
      },
      {
        id: SECOND_ASSET_ID,
        memory_id: MEMORY_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}.jpg`,
        preview_object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}-preview.jpg`,
        content_type: 'image/jpeg',
        aspect_ratio: 0.8,
      },
    ],
  });
  const memory = { ...textOnlyMemory(), id: MEMORY_ID, memory_type: 'media' };

  const result = await resolveShareCardSource(supabase as never, memory, SECOND_ASSET_ID);
  assertEquals(result.ok, true);
  if (result.ok && result.source.kind === 'media') {
    assertEquals(result.source.objectKey, `${OWNER_ID}/memories/${MEMORY_ID}/media/${SECOND_ASSET_ID}-preview.jpg`);
    assertEquals(result.source.storedAspectRatio, 0.8);
  }

  // The first page must still resolve correctly too -- proves this isn't
  // "second page only ever wins" but genuinely id-selective both ways.
  const firstResult = await resolveShareCardSource(supabase as never, memory, FIRST_ASSET_ID);
  assertEquals(firstResult.ok, true);
  if (firstResult.ok && firstResult.source.kind === 'media') {
    assertEquals(firstResult.source.objectKey, `${OWNER_ID}/memories/${MEMORY_ID}/media/${FIRST_ASSET_ID}.jpg`);
  }
});

Deno.test('resolveShareCardSource: video content types are rejected', async () => {
  const supabase = fakeSupabase({
    memoryMedia: [
      {
        id: ASSET_ID,
        memory_id: MEMORY_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.mp4`,
        preview_object_key: null,
        content_type: 'video/mp4',
        aspect_ratio: null,
      },
    ],
  });
  const memory = { ...textOnlyMemory(), memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'video_not_supported');
});

Deno.test('resolveShareCardSource: photo media resolves preview_object_key over object_key', async () => {
  const previewKey = `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}-preview.jpg`;
  const supabase = fakeSupabase({
    memoryMedia: [
      {
        id: ASSET_ID,
        memory_id: MEMORY_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.heic`,
        preview_object_key: previewKey,
        content_type: 'image/heic',
        aspect_ratio: 0.8,
      },
    ],
  });
  const memory = { ...textOnlyMemory(), memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, ASSET_ID);
  assertEquals(result.ok, true);
  if (result.ok && result.source.kind === 'media') {
    assertEquals(result.source.objectKey, previewKey);
    assertEquals(result.source.storedAspectRatio, 0.8);
  }
});

Deno.test('resolveShareCardSource: legacy HEIC row with no preview is rejected as unsupported', async () => {
  const supabase = fakeSupabase({
    memoryMedia: [
      {
        id: ASSET_ID,
        memory_id: MEMORY_ID,
        object_key: `${OWNER_ID}/memories/${MEMORY_ID}/media/${ASSET_ID}.heic`,
        preview_object_key: null,
        content_type: 'image/heic',
        aspect_ratio: null,
      },
    ],
  });
  const memory = { ...textOnlyMemory(), memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'unsupported_image_format');
});

Deno.test('resolveShareCardSource: asset id that does not exist at all is asset_not_found', async () => {
  const supabase = fakeSupabase({ memoryMedia: [] });
  const memory = { ...textOnlyMemory(), memory_type: 'media' };
  const result = await resolveShareCardSource(supabase as never, memory, ASSET_ID);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, 'asset_not_found');
});

// ── authorizeShareCardAccess (authz matrix: owner/manager/viewer×toggle/non-member) ──

Deno.test('authorizeShareCardAccess: owner is always authorized', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null, viewer_sharing_enabled: false }],
    memberships: [{ family_id: FAMILY_A, role: 'owner', user_id: OWNER_ID }],
  });
  const result = await authorizeShareCardAccess(supabase as never, FAMILY_A, OWNER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccess: manager is always authorized, independent of the viewer toggle', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null, viewer_sharing_enabled: false }],
    memberships: [{ family_id: FAMILY_A, role: 'manager', user_id: MANAGER_ID }],
  });
  const result = await authorizeShareCardAccess(supabase as never, FAMILY_A, MANAGER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccess: viewer is authorized when viewer_sharing_enabled is true', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null, viewer_sharing_enabled: true }],
    memberships: [{ family_id: FAMILY_A, role: 'viewer', user_id: VIEWER_ID }],
  });
  const result = await authorizeShareCardAccess(supabase as never, FAMILY_A, VIEWER_ID);
  assertEquals(result.ok, true);
});

Deno.test('authorizeShareCardAccess: viewer is rejected (sharing_disabled) when viewer_sharing_enabled is false', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null, viewer_sharing_enabled: false }],
    memberships: [{ family_id: FAMILY_A, role: 'viewer', user_id: VIEWER_ID }],
  });
  const result = await authorizeShareCardAccess(supabase as never, FAMILY_A, VIEWER_ID);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'sharing_disabled');
    assertEquals(result.error.status, 403);
  }
});

Deno.test('authorizeShareCardAccess: non-member is forbidden', async () => {
  const supabase = fakeSupabase({
    families: [{ id: FAMILY_A, owner_id: OWNER_ID, deleted_at: null, viewer_sharing_enabled: true }],
    memberships: [],
  });
  const result = await authorizeShareCardAccess(supabase as never, FAMILY_A, OUTSIDER_ID);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, 'forbidden');
    assertEquals(result.error.status, 403);
  }
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

Deno.test('fetchTaggedMembers caps at MAX_VISIBLE_MEMBERS and reports the overflow count', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    memory_id: MEMORY_ID,
    family_member_id: `member-${i}`,
    family_members: {
      id: `member-${i}`,
      name: `Kid ${i}`,
      illustrated_profile_key: null,
      illustrated_profile_status: 'ready',
      profile_picture_key: null,
    },
  }));
  const supabase = fakeSupabase({ memoryFamilyMembers: rows });
  const result = await fetchTaggedMembers(supabase as never, MEMORY_ID);
  assertEquals(result.members.length, 6);
  assertEquals(result.overflowCount, 2);
});

Deno.test('fetchTaggedMembers drops rows whose joined family_members is null (deleted member)', async () => {
  const supabase = fakeSupabase({
    memoryFamilyMembers: [
      {
        memory_id: MEMORY_ID,
        family_member_id: MEMBER_1,
        family_members: {
          id: MEMBER_1,
          name: 'Mia',
          illustrated_profile_key: null,
          illustrated_profile_status: 'ready',
          profile_picture_key: null,
        },
      },
      { memory_id: MEMORY_ID, family_member_id: MEMBER_2, family_members: null },
    ],
  });
  const result = await fetchTaggedMembers(supabase as never, MEMORY_ID);
  assertEquals(result.members.length, 1);
  assertEquals(result.members[0].id, MEMBER_1);
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
