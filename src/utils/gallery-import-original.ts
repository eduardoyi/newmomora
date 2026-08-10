import * as FileSystem from 'expo-file-system/legacy';

import type { GalleryOriginalContentType } from '@/services/gallery-import';

const MIME_BY_EXTENSION: Record<string, GalleryOriginalContentType> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp',
};

export function galleryOriginalContentTypeFromUri(uri: string, filename?: string | null): GalleryOriginalContentType | null {
  const match = /\.([a-zA-Z0-9]+)(?:$|[?#])/.exec(filename || uri);
  return match ? MIME_BY_EXTENSION[match[1].toLowerCase()] ?? null : null;
}

/** Resolve and verify at approval time only. Never read source metadata while scanning. */
export async function getGalleryImportOriginalUpload(input: { uri: string; filename?: string | null; width: number | null; height: number | null }) {
  const contentType = galleryOriginalContentTypeFromUri(input.uri, input.filename);
  if (!contentType) throw new Error('This photo format is not supported yet. Choose another photo from this suggestion.');
  const info = await FileSystem.getInfoAsync(input.uri);
  if (!info.exists || typeof info.size !== 'number' || info.size <= 0) {
    throw new Error('This photo is no longer available on this device.');
  }
  return {
    contentType,
    byteLength: info.size,
    aspectRatio: input.width && input.height ? input.width / input.height : undefined,
  };
}
