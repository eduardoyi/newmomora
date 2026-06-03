import {
  buildFamilyPhotoKey,
  buildMemoryMediaAssetKey,
  buildMemoryMediaKey,
} from '@/utils/storage-keys';

describe('storage key utils', () => {
  it('builds the single-bucket family photo key', () => {
    expect(
      buildFamilyPhotoKey(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).toBe('11111111-1111-4111-8111-111111111111/family/22222222-2222-4222-8222-222222222222/photo.webp');
  });

  it('builds memory media keys', () => {
    expect(
      buildMemoryMediaKey(
        '11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-333333333333',
        'mp4',
      ),
    ).toBe(
      '11111111-1111-4111-8111-111111111111/memories/33333333-3333-4333-8333-333333333333/media.mp4',
    );
    expect(
      buildMemoryMediaAssetKey(
        '11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
        'jpg',
      ),
    ).toBe(
      '11111111-1111-4111-8111-111111111111/memories/33333333-3333-4333-8333-333333333333/media/44444444-4444-4444-8444-444444444444.jpg',
    );
  });
});
