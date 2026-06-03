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
  /^([^/]+)\/media\/([^/]+)\.(jpg|jpeg|png|heic|heif|webp|mp4|mov)$/i;

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

  return UUID_PATTERN.test(assetMatch[1]) && UUID_PATTERN.test(assetMatch[2]);
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
