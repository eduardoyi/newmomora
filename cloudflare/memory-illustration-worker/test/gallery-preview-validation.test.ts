import { describe, expect, it } from 'vitest';

import { GalleryPreviewError, galleryPreviewDimensions, sniffGalleryPreviewContentType, validateGalleryPreview } from '../src/gallery-preview-validation';
import type { GalleryPreviewAsset } from '../src/types';

function jpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
}

async function sha(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

function body(bytes: Uint8Array, contentType = 'image/jpeg') {
  return {
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    httpMetadata: { contentType },
  } as unknown as R2ObjectBody;
}

describe('gallery preview validation', () => {
  it('validates real magic bytes, R2 type, hash, byte length, and dimensions together', async () => {
    const bytes = jpeg();
    const asset: GalleryPreviewAsset = {
      assetToken: '123e4567-e89b-42d3-a456-426614174000', previewKey: 'actor/imports/run/token.jpg',
      expectedByteLength: bytes.byteLength, expectedSha256: await sha(bytes), expectedContentType: 'image/jpeg',
      previewWidth: 1, previewHeight: 1, captureDate: '2026-08-01', width: 4_032, height: 3_024, isFavorite: false,
    };
    await expect(validateGalleryPreview(asset, body(bytes))).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });

  it('rejects an extension/metadata lie and a byte-hash mismatch before vision', async () => {
    const bytes = jpeg();
    const asset: GalleryPreviewAsset = {
      assetToken: '123e4567-e89b-42d3-a456-426614174000', previewKey: 'actor/imports/run/token.jpg',
      expectedByteLength: bytes.byteLength, expectedSha256: '0'.repeat(64), expectedContentType: 'image/jpeg',
      previewWidth: 1, previewHeight: 1, captureDate: '2026-08-01', width: 4_032, height: 3_024, isFavorite: false,
    };
    await expect(validateGalleryPreview(asset, body(bytes, 'image/png'))).rejects.toBeInstanceOf(GalleryPreviewError);
  });

  it('sniffs dimensions from real file bytes rather than accepting caller dimensions', () => {
    const bytes = jpeg();
    expect(sniffGalleryPreviewContentType(bytes)).toBe('image/jpeg');
    expect(galleryPreviewDimensions('image/jpeg', bytes)).toEqual({ width: 1, height: 1 });
  });

  it('accepts exactly 1,500,000 bytes and rejects the next byte', async () => {
    const base = jpeg();
    const atLimit = new Uint8Array(1_500_000);
    atLimit.set(base);
    const asset: GalleryPreviewAsset = {
      assetToken: '123e4567-e89b-42d3-a456-426614174000', previewKey: 'actor/imports/run/token.jpg',
      expectedByteLength: atLimit.byteLength, expectedSha256: await sha(atLimit), expectedContentType: 'image/jpeg',
      previewWidth: 1, previewHeight: 1, captureDate: '2026-08-01', width: null, height: null, isFavorite: false,
    };
    await expect(validateGalleryPreview(asset, body(atLimit))).resolves.toMatchObject({ contentType: 'image/jpeg' });

    const overLimit = new Uint8Array(1_500_001);
    overLimit.set(base);
    await expect(validateGalleryPreview({
      ...asset,
      expectedByteLength: overLimit.byteLength,
      expectedSha256: await sha(overLimit),
    }, body(overLimit))).rejects.toBeInstanceOf(GalleryPreviewError);
  });
});
