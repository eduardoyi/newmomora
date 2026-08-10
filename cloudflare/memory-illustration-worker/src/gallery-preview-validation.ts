import type { GalleryPreviewAsset, GalleryPreviewContentType } from './types';

const MAX_PREVIEW_BYTES = 1_500_000;
const MAX_PREVIEW_DIMENSION = 512;

export class GalleryPreviewError extends Error {
  constructor(public readonly code: 'INVALID_PREVIEW' | 'PREVIEW_UNAVAILABLE') {
    super(code);
  }
}

export interface ValidatedGalleryPreview {
  asset: GalleryPreviewAsset;
  bytes: ArrayBuffer;
  contentType: GalleryPreviewContentType;
}

function equalsBytes(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

export function sniffGalleryPreviewContentType(bytes: Uint8Array): GalleryPreviewContentType | null {
  if (bytes.length >= 3 && equalsBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return null;
}

function readUint16(bytes: Uint8Array, offset: number, littleEndian: boolean): number {
  return littleEndian ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = readUint16(bytes, offset, false);
    if (length < 2 || offset + length > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (length < 7) return null;
      return { height: readUint16(bytes, offset + 3, false), width: readUint16(bytes, offset + 5, false) };
    }
    offset += length;
  }
  return null;
}

export function galleryPreviewDimensions(
  _contentType: GalleryPreviewContentType,
  bytes: Uint8Array,
): { width: number; height: number } | null {
  return jpegDimensions(bytes);
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function validateGalleryPreview(
  asset: GalleryPreviewAsset,
  object: R2ObjectBody | null,
): Promise<ValidatedGalleryPreview> {
  if (!object || !object.body || !Number.isSafeInteger(asset.expectedByteLength) ||
    asset.expectedByteLength <= 0 || asset.expectedByteLength > MAX_PREVIEW_BYTES) {
    throw new GalleryPreviewError(object ? 'INVALID_PREVIEW' : 'PREVIEW_UNAVAILABLE');
  }

  const bytes = await new Response(object.body).arrayBuffer();
  if (bytes.byteLength !== asset.expectedByteLength || bytes.byteLength > MAX_PREVIEW_BYTES) {
    throw new GalleryPreviewError('INVALID_PREVIEW');
  }
  const contentType = sniffGalleryPreviewContentType(new Uint8Array(bytes));
  if (!contentType || contentType !== asset.expectedContentType ||
    object.httpMetadata?.contentType?.split(';')[0].toLowerCase() !== contentType ||
    !/^[a-f0-9]{64}$/i.test(asset.expectedSha256) ||
    (await sha256Hex(bytes)) !== asset.expectedSha256.toLowerCase()) {
    throw new GalleryPreviewError('INVALID_PREVIEW');
  }
  const dimensions = galleryPreviewDimensions(contentType, new Uint8Array(bytes));
  if (!dimensions || dimensions.width !== asset.previewWidth || dimensions.height !== asset.previewHeight ||
    dimensions.width < 1 || dimensions.height < 1 ||
    dimensions.width > MAX_PREVIEW_DIMENSION || dimensions.height > MAX_PREVIEW_DIMENSION) {
    throw new GalleryPreviewError('INVALID_PREVIEW');
  }
  return { asset, bytes, contentType };
}
