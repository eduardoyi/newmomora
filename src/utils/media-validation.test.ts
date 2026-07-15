import {
  getMediaExtensionFromContentType,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SOURCE_BYTES,
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
        durationMs: 180 * 1000 + 1,
        contentType: 'video/mp4',
      }),
    ).toMatch(/3 minutes/i);

    expect(
      validateMediaFile({
        sizeBytes: 1024 * 1024,
        durationMs: 30_000,
        contentType: 'video/mp4',
      }),
    ).toBeNull();
  });

  it('accepts a video source file well over the old 100MB pick-time cap, within the new source sanity cap', () => {
    // The regression this fix addresses: a raw 4K/60 clip can legitimately
    // exceed 100MB before compression. Pick-time validation must not block
    // it -- MAX_VIDEO_BYTES is now the post-compression/upload cap, checked
    // later in the pipeline, not here.
    expect(
      validateMediaFile({
        sizeBytes: MAX_VIDEO_BYTES * 5,
        durationMs: 150_000,
        contentType: 'video/mp4',
      }),
    ).toBeNull();
  });

  it('rejects a video source file over the sanity cap', () => {
    expect(
      validateMediaFile({
        sizeBytes: MAX_VIDEO_SOURCE_BYTES + 1,
        durationMs: 150_000,
        contentType: 'video/mp4',
      }),
    ).toMatch(/too large/i);
  });

  it('accepts a video source file exactly at the sanity cap', () => {
    expect(
      validateMediaFile({
        sizeBytes: MAX_VIDEO_SOURCE_BYTES,
        durationMs: 150_000,
        contentType: 'video/mp4',
      }),
    ).toBeNull();
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
