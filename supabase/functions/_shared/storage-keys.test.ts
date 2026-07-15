import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildFamilyPhotoKey,
  buildPortraitVersionPhotoKey,
  buildMemoryMediaAssetKey,
  buildMemoryMediaKey,
  getAllowedContentTypes,
  isAllowedUploadKey,
  isDeletableUserObjectKey,
} from './storage-keys.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const MEMORY_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';

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
