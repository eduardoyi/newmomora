import {
  getMediaExtensionFromContentType,
  validateMediaFile,
} from '@/utils/media-validation';

describe('media validation utils', () => {
  it('accepts valid image files under the size limit', () => {
    expect(
      validateMediaFile({
        sizeBytes: 1024,
        contentType: 'image/jpeg',
      }),
    ).toBeNull();
  });

  it('rejects oversized images', () => {
    expect(
      validateMediaFile({
        sizeBytes: 21 * 1024 * 1024,
        contentType: 'image/jpeg',
      }),
    ).toMatch(/20 MB/i);
  });

  it('validates video duration in milliseconds', () => {
    expect(
      validateMediaFile({
        sizeBytes: 1024 * 1024,
        durationMs: 61_000,
        contentType: 'video/mp4',
      }),
    ).toMatch(/60 seconds/i);

    expect(
      validateMediaFile({
        sizeBytes: 1024 * 1024,
        durationMs: 30_000,
        contentType: 'video/mp4',
      }),
    ).toBeNull();
  });

  it('rejects oversized videos', () => {
    expect(
      validateMediaFile({
        sizeBytes: 101 * 1024 * 1024,
        durationMs: 30_000,
        contentType: 'video/mp4',
      }),
    ).toMatch(/100 MB/i);
  });

  it('rejects unknown mime types', () => {
    expect(
      validateMediaFile({
        sizeBytes: 1024,
        contentType: 'application/pdf',
      }),
    ).toMatch(/unsupported/i);
  });

  it('maps content types to extensions', () => {
    expect(getMediaExtensionFromContentType('video/quicktime')).toBe('mov');
    expect(getMediaExtensionFromContentType('image/heic')).toBe('heic');
  });
});
