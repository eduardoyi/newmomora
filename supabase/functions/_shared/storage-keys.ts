const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FAMILY_PHOTO_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const MEMORY_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
]);

const MEMORY_MEDIA_EXTENSION_PATTERN = /^([^/]+)\/media\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$/i;
const MEMORY_MEDIA_ASSET_EXTENSION_PATTERN =
  /^([^/]+)\/media\/([A-Za-z0-9_-]{1,128})\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$/i;

export function buildFamilyPhotoKey(userId: string, familyMemberId: string): string {
  return `${userId}/family/${familyMemberId}/photo.webp`;
}

export function buildFamilyPortraitKey(userId: string, familyMemberId: string): string {
  return `${userId}/family/${familyMemberId}/portrait.webp`;
}

export function buildMemoryIllustrationKey(userId: string, memoryId: string): string {
  return `${userId}/memories/${memoryId}/illustration.webp`;
}

export function buildMemoryMediaKey(userId: string, memoryId: string, ext: string): string {
  return `${userId}/memories/${memoryId}/media.${ext}`;
}

export function buildMemoryMediaAssetKey(
  userId: string,
  memoryId: string,
  mediaAssetId: string,
  ext: string,
): string {
  return `${userId}/memories/${memoryId}/media/${mediaAssetId}.${ext}`;
}

export function assertUserOwnedKey(objectKey: string, userId: string): void {
  if (!objectKey.startsWith(`${userId}/`)) {
    throw new Error('Object key must belong to the authenticated user');
  }
}

export function isFamilyPhotoKey(objectKey: string, userId: string): boolean {
  const prefix = `${userId}/family/`;
  const suffix = '/photo.webp';

  if (!objectKey.startsWith(prefix) || !objectKey.endsWith(suffix)) {
    return false;
  }

  const familyMemberId = objectKey.slice(prefix.length, objectKey.length - suffix.length);
  return UUID_PATTERN.test(familyMemberId);
}

export function isMemoryMediaKey(objectKey: string, userId: string): boolean {
  const prefix = `${userId}/memories/`;
  if (!objectKey.startsWith(prefix)) {
    return false;
  }

  const rest = objectKey.slice(prefix.length);
  const match = rest.match(MEMORY_MEDIA_EXTENSION_PATTERN);
  if (match) {
    return UUID_PATTERN.test(match[1]);
  }

  const assetMatch = rest.match(MEMORY_MEDIA_ASSET_EXTENSION_PATTERN);
  if (!assetMatch) {
    return false;
  }

  return UUID_PATTERN.test(assetMatch[1]);
}

export function isAllowedUploadKey(objectKey: string, userId: string): boolean {
  return isFamilyPhotoKey(objectKey, userId) || isMemoryMediaKey(objectKey, userId);
}

export function getAllowedContentTypes(objectKey: string, userId: string): Set<string> | null {
  if (isFamilyPhotoKey(objectKey, userId)) {
    return FAMILY_PHOTO_CONTENT_TYPES;
  }

  if (isMemoryMediaKey(objectKey, userId)) {
    return MEMORY_MEDIA_CONTENT_TYPES;
  }

  return null;
}

export function isMemoryIllustrationKey(objectKey: string, userId: string): boolean {
  const prefix = `${userId}/memories/`;
  const suffix = '/illustration.webp';

  if (!objectKey.startsWith(prefix) || !objectKey.endsWith(suffix)) {
    return false;
  }

  const memoryId = objectKey.slice(prefix.length, objectKey.length - suffix.length);
  return UUID_PATTERN.test(memoryId);
}

export function isFamilyPortraitKey(objectKey: string, userId: string): boolean {
  const prefix = `${userId}/family/`;
  const suffix = '/portrait.webp';

  if (!objectKey.startsWith(prefix) || !objectKey.endsWith(suffix)) {
    return false;
  }

  const familyMemberId = objectKey.slice(prefix.length, objectKey.length - suffix.length);
  return UUID_PATTERN.test(familyMemberId);
}

export function isDeletableUserObjectKey(objectKey: string, userId: string): boolean {
  return (
    isFamilyPhotoKey(objectKey, userId) ||
    isFamilyPortraitKey(objectKey, userId) ||
    isMemoryMediaKey(objectKey, userId) ||
    isMemoryIllustrationKey(objectKey, userId)
  );
}

// ---------------------------------------------------------------------------
// Family-sharing Phase 3: parse a key WITHOUT knowing the caller's uid up
// front, returning the entity id embedded in the key. Authorization then
// resolves the entity's *owning row* (memories.family_id or
// family_members.family_id) by this parsed entity id -- never by whether
// some memory_media row happens to reference the key, which is spoofable
// (direct memory_media inserts don't constrain object_key). The `{uid}`
// path segment (`ownerUserId`) is returned for completeness but must NOT be
// used as the authorization signal for read/delete -- it only matters for
// the caller-prefix rule on uploads.
// ---------------------------------------------------------------------------

export type StorageKeyKind =
  | 'family_photo'
  | 'family_portrait'
  | 'memory_media'
  | 'memory_illustration';

export interface ParsedStorageKey {
  kind: StorageKeyKind;
  /** The `{uid}` path segment the key was written under. Not an auth signal for reads/deletes. */
  ownerUserId: string;
  /** The id embedded in the key: a family_members.id for family_photo/family_portrait, a memories.id otherwise. */
  entityId: string;
}

const FAMILY_MEMBER_PATTERN = /^([^/]+)\/family\/([^/]+)\/(photo|portrait)\.webp$/;
const MEMORY_ILLUSTRATION_FULL_PATTERN =
  /^([^/]+)\/memories\/([^/]+)\/illustration\.webp$/;
const MEMORY_MEDIA_FULL_PATTERN =
  /^([^/]+)\/memories\/([^/]+)\/media\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$/i;
const MEMORY_MEDIA_ASSET_FULL_PATTERN =
  /^([^/]+)\/memories\/([^/]+)\/media\/[A-Za-z0-9_-]{1,128}\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$/i;

export function parseStorageKey(objectKey: string): ParsedStorageKey | null {
  const familyMemberMatch = objectKey.match(FAMILY_MEMBER_PATTERN);
  if (familyMemberMatch) {
    const [, ownerUserId, entityId, type] = familyMemberMatch;
    if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(entityId)) {
      return null;
    }
    return {
      kind: type === 'photo' ? 'family_photo' : 'family_portrait',
      ownerUserId,
      entityId,
    };
  }

  const illustrationMatch = objectKey.match(MEMORY_ILLUSTRATION_FULL_PATTERN);
  if (illustrationMatch) {
    const [, ownerUserId, entityId] = illustrationMatch;
    if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(entityId)) {
      return null;
    }
    return { kind: 'memory_illustration', ownerUserId, entityId };
  }

  const mediaMatch = objectKey.match(MEMORY_MEDIA_FULL_PATTERN);
  if (mediaMatch) {
    const [, ownerUserId, entityId] = mediaMatch;
    if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(entityId)) {
      return null;
    }
    return { kind: 'memory_media', ownerUserId, entityId };
  }

  const mediaAssetMatch = objectKey.match(MEMORY_MEDIA_ASSET_FULL_PATTERN);
  if (mediaAssetMatch) {
    const [, ownerUserId, entityId] = mediaAssetMatch;
    if (!UUID_PATTERN.test(ownerUserId) || !UUID_PATTERN.test(entityId)) {
      return null;
    }
    return { kind: 'memory_media', ownerUserId, entityId };
  }

  return null;
}
