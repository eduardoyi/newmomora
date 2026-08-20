import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildFamilyPhotoKey,
  buildMemoryIllustrationKey,
  buildPortraitVersionAttemptKey,
  buildPortraitVersionPhotoKey,
  buildMemoryMediaAssetKey,
  buildMemoryMediaKey,
  buildShareCardKey,
  getAllowedContentTypes,
  isAllowedUploadKey,
  isDeletableUserObjectKey,
  isMemoryIllustrationKey,
  parseStorageKey,
} from './storage-keys.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const GENERATION_ID = '55555555-5555-4555-8555-555555555555';

Deno.test('buildMemoryIllustrationKey includes the immutable generation id', () => {
  assertEquals(
    buildMemoryIllustrationKey(USER_ID, MEMORY_ID, GENERATION_ID),
    `${USER_ID}/memories/${MEMORY_ID}/illustrations/${GENERATION_ID}.webp`,
  );
});

Deno.test('buildFamilyPhotoKey uses user and member ids', () => {
  assertEquals(
    buildFamilyPhotoKey(USER_ID, MEMBER_ID),
    `${USER_ID}/family/${MEMBER_ID}/photo.webp`,
  );
});
Deno.test('isAllowedUploadKey accepts versioned family photos and rejects mutable legacy photo keys', () => {
  assertEquals(isAllowedUploadKey(buildFamilyPhotoKey(USER_ID, MEMBER_ID), USER_ID), false);
  assertEquals(
    isAllowedUploadKey(buildPortraitVersionPhotoKey(USER_ID, MEMBER_ID, VERSION_ID), USER_ID),
    true,
  );
  assertEquals(
    isAllowedUploadKey(buildMemoryMediaKey(USER_ID, MEMORY_ID, 'mp4'), USER_ID),
    true,
  );
  assertEquals(
    isAllowedUploadKey(
      buildMemoryMediaAssetKey(USER_ID, MEMORY_ID, '44444444-4444-4444-8444-444444444444', 'jpg'),
      USER_ID,
    ),
    true,
  );
  assertEquals(
    isAllowedUploadKey(`${USER_ID}/memories/${MEMORY_ID}/media/asset-photo-1.jpg`, USER_ID),
    true,
  );
});

// Workstream C4 (performance-optimizations plan): preview keys use a
// `-preview` suffix on the asset id rather than a `previews/` path prefix,
// because the asset-id char class (`[A-Za-z0-9_-]{1,128}`) forbids `/` --
// pinning that the same pattern already accepts the exact preview key shape
// `uploadMemoryMediaAssets` writes.
Deno.test('isAllowedUploadKey and isDeletableUserObjectKey accept the {assetId}-preview.jpg shape', () => {
  const previewKey = buildMemoryMediaAssetKey(
    USER_ID,
    MEMORY_ID,
    `${MEMBER_ID}-preview`,
    'jpg',
  );

  assertEquals(previewKey, `${USER_ID}/memories/${MEMORY_ID}/media/${MEMBER_ID}-preview.jpg`);
  assertEquals(isAllowedUploadKey(previewKey, USER_ID), true);
  assertEquals(isDeletableUserObjectKey(previewKey, USER_ID), true);
});

Deno.test('getAllowedContentTypes is pattern-specific', () => {
  const familyTypes = getAllowedContentTypes(
    buildPortraitVersionPhotoKey(USER_ID, MEMBER_ID, VERSION_ID),
    USER_ID,
  );
  const mediaTypes = getAllowedContentTypes(
    buildMemoryMediaAssetKey(USER_ID, MEMORY_ID, '44444444-4444-4444-8444-444444444444', 'mp4'),
    USER_ID,
  );

  assertEquals(familyTypes?.has('image/jpeg'), true);
  assertEquals(familyTypes?.has('video/mp4'), false);
  assertEquals(mediaTypes?.has('video/mp4'), true);
});

// Share card store-through cache (docs/plans/share-card-store-through.md,
// W1): buildShareCardKey's `{uuid}/memories/{uuid}/share-card/{name}.png`
// shape must be classified by parseStorageKey as its own `share_card` kind
// (not swallowed by the memory_media asset pattern, which lives under a
// different `media/` path segment), and malformed variants must be rejected
// outright rather than silently matching a looser pattern.
Deno.test('buildShareCardKey builds the {uuid}/memories/{uuid}/share-card/{name}.png shape', () => {
  const key = buildShareCardKey(USER_ID, MEMORY_ID, 'v1-55555555-5555-4555-8555-555555555555');
  assertEquals(key, `${USER_ID}/memories/${MEMORY_ID}/share-card/v1-55555555-5555-4555-8555-555555555555.png`);
});

Deno.test('parseStorageKey classifies a share card key as kind share_card', () => {
  const key = buildShareCardKey(USER_ID, MEMORY_ID, 'v1-55555555-5555-4555-8555-555555555555');
  assertEquals(parseStorageKey(key), {
    kind: 'share_card',
    ownerUserId: USER_ID,
    entityId: MEMORY_ID,
  });
});

Deno.test('parseStorageKey rejects malformed share card key variants', () => {
  // Wrong extension (only .png is a valid compose output).
  assertEquals(
    parseStorageKey(`${USER_ID}/memories/${MEMORY_ID}/share-card/v1-name.jpg`),
    null,
  );
  // Missing name segment entirely.
  assertEquals(parseStorageKey(`${USER_ID}/memories/${MEMORY_ID}/share-card/.png`), null);
  // Non-uuid owner prefix.
  assertEquals(parseStorageKey(`not-a-uuid/memories/${MEMORY_ID}/share-card/v1-name.png`), null);
  // Non-uuid memory id.
  assertEquals(parseStorageKey(`${USER_ID}/memories/not-a-uuid/share-card/v1-name.png`), null);
  // Wrong path segment ("media" instead of "share-card") must not be
  // reclassified as share_card.
  assertEquals(
    parseStorageKey(`${USER_ID}/memories/${MEMORY_ID}/media/v1-name.png`) === null,
    false,
  );
  assertEquals(
    parseStorageKey(`${USER_ID}/memories/${MEMORY_ID}/media/v1-name.png`)?.kind,
    'memory_media',
  );
  // Path traversal / nested segment inside the name must not match.
  assertEquals(
    parseStorageKey(`${USER_ID}/memories/${MEMORY_ID}/share-card/nested/name.png`),
    null,
  );
});

// Byte/extension mismatch fix (docs/features/memories.md changelog, git log
// around 6fc17d7/e4c9140): OpenAI's images/edits endpoint has been observed
// to ignore `output_format: 'webp'` and return PNG bytes anyway. Once the
// generators sniff the real bytes (`_shared/image-bytes.ts`) and re-encode a
// mismatch to JPEG, the resulting key must carry a `.jpg` extension that
// every downstream validator/authorizer still recognizes -- these tests pin
// that the key builders AND the regex-based validators both accept it.

Deno.test('buildMemoryIllustrationKey accepts an explicit jpg extension for re-encoded mismatches', () => {
  assertEquals(
    buildMemoryIllustrationKey(USER_ID, MEMORY_ID, GENERATION_ID, 'jpg'),
    `${USER_ID}/memories/${MEMORY_ID}/illustrations/${GENERATION_ID}.jpg`,
  );
});

Deno.test('buildPortraitVersionAttemptKey defaults to webp and accepts an explicit jpg extension', () => {
  assertEquals(
    buildPortraitVersionAttemptKey(USER_ID, MEMBER_ID, VERSION_ID, GENERATION_ID),
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/${GENERATION_ID}.webp`,
  );
  assertEquals(
    buildPortraitVersionAttemptKey(USER_ID, MEMBER_ID, VERSION_ID, GENERATION_ID, 'jpg'),
    `${USER_ID}/family/${MEMBER_ID}/portraits/${VERSION_ID}/portrait/${GENERATION_ID}.jpg`,
  );
});

Deno.test('isMemoryIllustrationKey and parseStorageKey recognize a jpg-suffixed versioned illustration key', () => {
  const jpgKey = buildMemoryIllustrationKey(USER_ID, MEMORY_ID, GENERATION_ID, 'jpg');

  assertEquals(isMemoryIllustrationKey(jpgKey, USER_ID), true);
  assertEquals(parseStorageKey(jpgKey), {
    kind: 'memory_illustration',
    ownerUserId: USER_ID,
    entityId: MEMORY_ID,
  });
  assertEquals(isDeletableUserObjectKey(jpgKey, USER_ID), true);
});

Deno.test('parseStorageKey recognizes a jpg-suffixed portrait attempt key', () => {
  const jpgKey = buildPortraitVersionAttemptKey(USER_ID, MEMBER_ID, VERSION_ID, GENERATION_ID, 'jpg');

  assertEquals(parseStorageKey(jpgKey), {
    kind: 'portrait_version_portrait',
    ownerUserId: USER_ID,
    entityId: MEMBER_ID,
    portraitVersionId: VERSION_ID,
    attemptId: GENERATION_ID,
  });
});

// Audio memories "keep the sound" (docs/features/audio-memories.md, P1.3):
// expo-audio records .m4a on both native platforms. All four extension
// allow-lists (unqualified `media.{ext}`, asset `media/{id}.{ext}`, and their
// FULL/parseStorageKey counterparts) must accept it, or an uploaded clip is
// unplayable (get-media-url fails closed) even though the upload succeeded.
Deno.test('m4a is accepted by the upload allow-list, the deletable-key allow-list, and parseStorageKey', () => {
  const assetKey = buildMemoryMediaAssetKey(USER_ID, MEMORY_ID, GENERATION_ID, 'm4a');
  assertEquals(assetKey, `${USER_ID}/memories/${MEMORY_ID}/media/${GENERATION_ID}.m4a`);

  assertEquals(isAllowedUploadKey(assetKey, USER_ID), true);
  assertEquals(isDeletableUserObjectKey(assetKey, USER_ID), true);

  const contentTypes = getAllowedContentTypes(assetKey, USER_ID);
  assertEquals(contentTypes?.has('audio/mp4'), true);
  assertEquals(contentTypes?.has('audio/m4a'), true);
  assertEquals(contentTypes?.has('audio/x-m4a'), true);

  assertEquals(parseStorageKey(assetKey), {
    kind: 'memory_media',
    ownerUserId: USER_ID,
    entityId: MEMORY_ID,
  });

  // The unqualified `media.{ext}` shape (legacy single-asset key) also
  // accepts m4a.
  const legacyKey = buildMemoryMediaKey(USER_ID, MEMORY_ID, 'm4a');
  assertEquals(isAllowedUploadKey(legacyKey, USER_ID), true);
  assertEquals(parseStorageKey(legacyKey), {
    kind: 'memory_media',
    ownerUserId: USER_ID,
    entityId: MEMORY_ID,
  });
});

Deno.test('isDeletableUserObjectKey accepts known user object patterns', () => {
  assertEquals(isDeletableUserObjectKey(buildMemoryMediaKey(USER_ID, MEMORY_ID, 'jpg'), USER_ID), true);
  assertEquals(
    isDeletableUserObjectKey(
      buildMemoryMediaAssetKey(USER_ID, MEMORY_ID, '44444444-4444-4444-8444-444444444444', 'jpg'),
      USER_ID,
    ),
    true,
  );
  assertEquals(
    isDeletableUserObjectKey(`${USER_ID}/memories/${MEMORY_ID}/media/asset-photo-1.jpg`, USER_ID),
    true,
  );
  assertEquals(isDeletableUserObjectKey(`${USER_ID}/unknown/path.jpg`, USER_ID), false);
});
