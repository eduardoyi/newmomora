import { resolveMediaDisplayKey, resolvePreferredCoverKey } from '@/utils/media-preview';

describe('resolveMediaDisplayKey', () => {
  it('prefers the preview key when preferPreview is true and a preview exists', () => {
    expect(
      resolveMediaDisplayKey(
        { object_key: 'a/original.jpg', preview_object_key: 'a/original-preview.jpg' },
        true,
      ),
    ).toBe('a/original-preview.jpg');
  });

  it('falls back to the original when preferPreview is true but no preview exists', () => {
    expect(
      resolveMediaDisplayKey({ object_key: 'a/original.jpg', preview_object_key: null }, true),
    ).toBe('a/original.jpg');
  });

  it('falls back to the original when preview_object_key is undefined (legacy row shape)', () => {
    expect(resolveMediaDisplayKey({ object_key: 'a/original.jpg' }, true)).toBe('a/original.jpg');
  });

  it('always returns the original when preferPreview is false, even if a preview exists', () => {
    expect(
      resolveMediaDisplayKey(
        { object_key: 'a/original.jpg', preview_object_key: 'a/original-preview.jpg' },
        false,
      ),
    ).toBe('a/original.jpg');
  });
});

describe('resolvePreferredCoverKey', () => {
  it('prefers the cover asset preview key when present', () => {
    expect(
      resolvePreferredCoverKey(
        { object_key: 'a/original.jpg', preview_object_key: 'a/original-preview.jpg' },
        'a/legacy.jpg',
      ),
    ).toBe('a/original-preview.jpg');
  });

  it('falls back to the cover asset original when it has no preview', () => {
    expect(
      resolvePreferredCoverKey({ object_key: 'a/original.jpg', preview_object_key: null }, 'a/legacy.jpg'),
    ).toBe('a/original.jpg');
  });

  it('falls back to the legacy memory media key when there is no cover asset', () => {
    expect(resolvePreferredCoverKey(undefined, 'a/legacy.jpg')).toBe('a/legacy.jpg');
  });

  it('returns null when neither a cover asset nor a legacy key exists', () => {
    expect(resolvePreferredCoverKey(undefined, null)).toBeNull();
  });
});
