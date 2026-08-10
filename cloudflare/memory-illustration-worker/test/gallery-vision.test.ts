import { describe, expect, it } from 'vitest';

import { GalleryVisionError, validateGalleryVisionOutput } from '../src/gallery-vision';
import type { GalleryClusterInput } from '../src/types';

const cluster: GalleryClusterInput = {
  clusterSignature: 'a'.repeat(64), clusterStartDate: '2026-07-01', clusterEndDate: '2026-07-03',
  assets: [
    { assetToken: '123e4567-e89b-42d3-a456-426614174001', previewKey: 'one', expectedByteLength: 1, expectedSha256: 'a'.repeat(64), expectedContentType: 'image/jpeg', previewWidth: 1, previewHeight: 1, captureDate: '2026-07-01', width: 4_032, height: 3_024, isFavorite: false },
    { assetToken: '123e4567-e89b-42d3-a456-426614174002', previewKey: 'two', expectedByteLength: 1, expectedSha256: 'b'.repeat(64), expectedContentType: 'image/jpeg', previewWidth: 1, previewHeight: 1, captureDate: '2026-07-02', width: 4_032, height: 3_024, isFavorite: false },
  ],
};

describe('gallery vision schema validation', () => {
  it('allows only complete, bounded groups based on supplied opaque tokens', () => {
    expect(validateGalleryVisionOutput({
      groups: [{ caption: 'A quiet afternoon together.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: 'joy', confidence: 0.82 }],
      skip_reason: null,
    }, cluster)).toEqual(expect.objectContaining({ groups: [expect.objectContaining({ emotion: 'joy' })] }));
  });

  it('rejects groups that reuse a token, invent an asset, or date outside the event', () => {
    const invalid = {
      groups: [
        { caption: 'One.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: null, confidence: 0.5 },
        { caption: 'Two.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: null, confidence: 0.5 },
      ], skip_reason: null,
    };
    expect(() => validateGalleryVisionOutput(invalid, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({
      groups: [{ caption: 'No.', selected_asset_tokens: ['invented'], memory_date: '2026-08-01', emotion: null, confidence: 0.5 }], skip_reason: null,
    }, cluster)).toThrow(GalleryVisionError);
  });

  it('rejects calendar-impossible dates even when their text falls inside the cluster range', () => {
    const broadCluster = { ...cluster, clusterStartDate: '2026-02-01', clusterEndDate: '2026-03-03' };
    expect(() => validateGalleryVisionOutput({
      groups: [{ caption: 'No.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-02-31', emotion: null, confidence: 0.5 }],
      skip_reason: null,
    }, broadCluster)).toThrow(GalleryVisionError);
  });

  it('rejects unknown schema fields and non-taxonomy emotions', () => {
    const candidate = {
      caption: 'No.', selected_asset_tokens: [cluster.assets[0].assetToken], memory_date: '2026-07-02', emotion: 'excited', confidence: 0.5,
    };
    expect(() => validateGalleryVisionOutput({ groups: [candidate], skip_reason: null }, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({ groups: [{ ...candidate, emotion: null, invented: true }], skip_reason: null }, cluster)).toThrow(GalleryVisionError);
    expect(() => validateGalleryVisionOutput({ groups: [{ ...candidate, emotion: null }], skip_reason: null, commentary: 'extra' }, cluster)).toThrow(GalleryVisionError);
  });

  it('turns an empty valid response into a closed no-candidate outcome', () => {
    expect(validateGalleryVisionOutput({ groups: [], skip_reason: null }, cluster)).toEqual({ groups: [], skipReason: 'no_candidate' });
  });
});
