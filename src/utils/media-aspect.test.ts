import {
  DEFAULT_MEDIA_ASPECT_RATIO,
  MAX_MEDIA_ASPECT_RATIO,
  MIN_MEDIA_ASPECT_RATIO,
  aspectRatioFromDimensions,
  clampMediaAspectRatio,
} from './media-aspect';

describe('aspectRatioFromDimensions', () => {
  it('returns width / height for valid dimensions', () => {
    expect(aspectRatioFromDimensions(1600, 1200)).toBeCloseTo(4 / 3);
    expect(aspectRatioFromDimensions(1080, 1920)).toBeCloseTo(9 / 16);
  });

  it('returns null for missing or invalid dimensions', () => {
    expect(aspectRatioFromDimensions(null, 100)).toBeNull();
    expect(aspectRatioFromDimensions(100, undefined)).toBeNull();
    expect(aspectRatioFromDimensions(0, 100)).toBeNull();
    expect(aspectRatioFromDimensions(100, -5)).toBeNull();
  });
});

describe('clampMediaAspectRatio', () => {
  it('keeps ratios inside the bounds unchanged', () => {
    expect(clampMediaAspectRatio(1)).toBe(1);
    expect(clampMediaAspectRatio(DEFAULT_MEDIA_ASPECT_RATIO)).toBe(DEFAULT_MEDIA_ASPECT_RATIO);
  });

  it('clamps extreme portrait ratios to the minimum', () => {
    expect(clampMediaAspectRatio(9 / 16)).toBe(MIN_MEDIA_ASPECT_RATIO);
  });

  it('clamps extreme landscape ratios to the maximum', () => {
    expect(clampMediaAspectRatio(3)).toBe(MAX_MEDIA_ASPECT_RATIO);
  });
});
