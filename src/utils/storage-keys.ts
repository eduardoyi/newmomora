export function buildFamilyPhotoKey(userId: string, familyMemberId: string): string {
  return `${userId}/family/${familyMemberId}/photo.webp`;
}

export function buildFamilyPortraitKey(userId: string, familyMemberId: string): string {
  return `${userId}/family/${familyMemberId}/portrait.webp`;
}

export function buildFamilyPortraitVersionPhotoKey(
  userId: string,
  familyMemberId: string,
  portraitVersionId: string,
): string {
  return `${userId}/family/${familyMemberId}/portraits/${portraitVersionId}/photo.jpg`;
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
