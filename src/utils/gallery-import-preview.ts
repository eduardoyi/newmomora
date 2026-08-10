import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image } from 'react-native';

import { getGalleryImportPreviewCacheDirectory } from '@/utils/gallery-import-checkpoint';
import { galleryImportSha256HexFromBytes } from '@/utils/gallery-import-scanner';

export const GALLERY_IMPORT_PREVIEW_MAX_EDGE = 512;
export const GALLERY_IMPORT_PREVIEW_MAX_BYTES = 1_500_000;
export const GALLERY_IMPORT_PREVIEW_JPEG_QUALITY = 0.72;

export interface GalleryImportPreview {
  uri: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject));
}

function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index] ?? 'A');
    const b = alphabet.indexOf(clean[index + 1] ?? 'A');
    const c = clean[index + 2] === '=' ? 0 : alphabet.indexOf(clean[index + 2] ?? 'A');
    const d = clean[index + 3] === '=' ? 0 : alphabet.indexOf(clean[index + 3] ?? 'A');
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Could not hash the generated preview.');
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((triple >> 16) & 0xff);
    if (clean[index + 2] !== '=') bytes.push((triple >> 8) & 0xff);
    if (clean[index + 3] !== '=') bytes.push(triple & 0xff);
  }
  return new Uint8Array(bytes);
}

/**
 * Creates a small JPEG in a run-specific cache folder. This is intentionally
 * serial at its call site: manipulating multiple camera originals at once can
 * exceed mobile memory even though the output itself is tiny.
 */
export async function createGalleryImportPreview(input: {
  sourceUri: string;
  runId: string;
  assetToken: string;
  /** Attempt-scoped local filename; never leaves the device. */
  localCacheKey?: string;
}): Promise<GalleryImportPreview> {
  const directory = getGalleryImportPreviewCacheDirectory(input.runId);
  if (!directory) throw new Error('Could not prepare the private preview cache.');
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const sourceSize = await getImageSize(input.sourceUri);
  const shouldResize = Math.max(sourceSize.width, sourceSize.height) > GALLERY_IMPORT_PREVIEW_MAX_EDGE;
  const result = await ImageManipulator.manipulateAsync(
    input.sourceUri,
    shouldResize ? [{ resize: sourceSize.width >= sourceSize.height
      ? { width: GALLERY_IMPORT_PREVIEW_MAX_EDGE }
      : { height: GALLERY_IMPORT_PREVIEW_MAX_EDGE } }] : [],
    { compress: GALLERY_IMPORT_PREVIEW_JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );
  const uri = `${directory}${input.localCacheKey ?? input.assetToken}.jpg`;
  let didMoveResult = false;
  try {
    // Each runner attempt owns its exact local target. Move (not copy)
    // ImageManipulator's opaque result so run cleanup owns the sole byte copy.
    if (result.uri !== uri) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      await FileSystem.moveAsync({ from: result.uri, to: uri });
    }
    didMoveResult = true;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || typeof info.size !== 'number' || info.size <= 0) {
      throw new Error('The generated preview was empty.');
    }
    if (info.size > GALLERY_IMPORT_PREVIEW_MAX_BYTES) {
      throw new Error('The generated preview was larger than the upload byte limit.');
    }
    if (result.width > GALLERY_IMPORT_PREVIEW_MAX_EDGE || result.height > GALLERY_IMPORT_PREVIEW_MAX_EDGE) {
      throw new Error('The generated preview was larger than the upload dimension limit.');
    }
    const encoded = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return { uri, width: result.width, height: result.height, byteLength: info.size, sha256: galleryImportSha256HexFromBytes(decodeBase64(encoded)) };
  } catch (error) {
    await FileSystem.deleteAsync(didMoveResult ? uri : result.uri, { idempotent: true }).catch(() => undefined);
    throw error;
  }
}
