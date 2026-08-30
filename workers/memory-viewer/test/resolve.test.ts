import { describe, expect, it } from 'vitest';

import {
  classifyShareToken,
  parseShareToken,
  resolveOpenGraphPoster,
  resolveViewerMedia,
  type MemoryHeaderRow,
  type MemoryMediaAssetRow,
  type ShareTokenRow,
} from '../src/resolve';

const VALID_ID = '0fbc1354-eaf7-552c-b659-78a0f751691e';
const VALID_TOKEN = 'aB3xQ9zK1mN7pR5tW2yC4d'; // 22 base62 chars, matches generateShareToken's shape.

describe('parseShareToken', () => {
  it('extracts a valid viewer-path share token', () => {
    expect(parseShareToken(`/m/${VALID_TOKEN}`, '/m/')).toBe(VALID_TOKEN);
  });

  it('extracts a valid media-path share token', () => {
    expect(parseShareToken(`/media/${VALID_TOKEN}`, '/media/')).toBe(VALID_TOKEN);
  });

  it('extracts a valid poster-path share token', () => {
    expect(parseShareToken(`/poster/${VALID_TOKEN}`, '/poster/')).toBe(VALID_TOKEN);
  });

  it('preserves case -- unlike the retired UUID path, base62 tokens are case-sensitive', () => {
    const mixedCase = 'aB3xQ9zK1mN7pR5tW2yC4d';
    expect(parseShareToken(`/m/${mixedCase}`, '/m/')).toBe(mixedCase);
    expect(parseShareToken(`/m/${mixedCase}`, '/m/')).not.toBe(mixedCase.toLowerCase());
  });

  it('accepts a token containing - and _ (URL-safe extras beyond base62)', () => {
    const token = 'aB3-xQ9_zK1mN7pR5tW2y';
    expect(parseShareToken(`/m/${token}`, '/m/')).toBe(token);
  });

  it('rejects a path under the wrong prefix', () => {
    expect(parseShareToken(`/media/${VALID_TOKEN}`, '/m/')).toBeNull();
  });

  it('rejects a token shorter than the minimum length', () => {
    expect(parseShareToken('/m/short', '/m/')).toBeNull();
  });

  it('rejects a token with disallowed characters (e.g. a slash-adjacent or space)', () => {
    expect(parseShareToken('/m/has a space here', '/m/')).toBeNull();
  });

  it('rejects trailing path segments', () => {
    expect(parseShareToken(`/m/${VALID_TOKEN}/extra`, '/m/')).toBeNull();
  });

  it('rejects an empty segment', () => {
    expect(parseShareToken('/m/', '/m/')).toBeNull();
  });

  it('rejects the bare root path', () => {
    expect(parseShareToken('/', '/m/')).toBeNull();
  });

  it('still tolerates a legacy UUID-shaped path segment (it happens to match the token pattern too)', () => {
    // Not a meaningful behavior to preserve on purpose -- just documents
    // that the pattern widened rather than narrowed, so an old bookmarked
    // /m/<uuid> link 404s downstream (no matching media_share_tokens row)
    // rather than being rejected at the routing layer itself.
    expect(parseShareToken(`/m/${VALID_ID}`, '/m/')).toBe(VALID_ID);
  });
});

describe('classifyShareToken', () => {
  it('classifies a missing row as not_found', () => {
    expect(classifyShareToken(null)).toEqual({ status: 'not_found' });
  });

  it('classifies a row with revoked_at set as revoked', () => {
    const row: ShareTokenRow = { memory_id: VALID_ID, revoked_at: '2026-08-01T00:00:00.000Z' };
    expect(classifyShareToken(row)).toEqual({ status: 'revoked' });
  });

  it('classifies a row with revoked_at null as active, carrying the memory id', () => {
    const row: ShareTokenRow = { memory_id: VALID_ID, revoked_at: null };
    expect(classifyShareToken(row)).toEqual({ status: 'active', memoryId: VALID_ID });
  });
});

const baseMemory: MemoryHeaderRow = {
  id: VALID_ID,
  memory_type: 'media',
  memory_date: '2026-06-01',
  content: 'First splash in the pool',
  emotion: 'joy',
};

const baseAsset: MemoryMediaAssetRow = {
  object_key: 'user-1/memories/mem-1/media/asset-1.jpg',
  content_type: 'image/jpeg',
  duration_ms: null,
  preview_object_key: null,
};

describe('resolveViewerMedia', () => {
  it('returns null when the memory row is missing', () => {
    expect(resolveViewerMedia(null, baseAsset)).toBeNull();
  });

  it('returns null when the media asset row is missing', () => {
    expect(resolveViewerMedia(baseMemory, null)).toBeNull();
  });

  it('returns null for text_illustration memories (no QR page for those)', () => {
    expect(resolveViewerMedia({ ...baseMemory, memory_type: 'text_illustration' }, baseAsset)).toBeNull();
  });

  it('returns null for text_only memories', () => {
    expect(resolveViewerMedia({ ...baseMemory, memory_type: 'text_only' }, baseAsset)).toBeNull();
  });

  it('returns null for an unrecognized content type', () => {
    expect(
      resolveViewerMedia(baseMemory, { ...baseAsset, content_type: 'application/octet-stream' }),
    ).toBeNull();
  });

  it('resolves a plain image to kind image using the original key', () => {
    const resolved = resolveViewerMedia(baseMemory, baseAsset);
    expect(resolved).toEqual({
      kind: 'image',
      objectKey: baseAsset.object_key,
      contentType: 'image/jpeg',
      memoryDate: '2026-06-01',
      caption: 'First splash in the pool',
      emotion: 'joy',
      durationMs: null,
      previewObjectKey: null,
    });
  });

  it('prefers the JPEG preview over a HEIC original when present', () => {
    const heicAsset: MemoryMediaAssetRow = {
      ...baseAsset,
      content_type: 'image/heic',
      preview_object_key: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
    };
    const resolved = resolveViewerMedia(baseMemory, heicAsset);
    expect(resolved?.objectKey).toBe(heicAsset.preview_object_key);
    expect(resolved?.contentType).toBe('image/jpeg');
    expect(resolved?.kind).toBe('image');
  });

  it('falls back to the HEIC original when no preview exists', () => {
    const heicAsset: MemoryMediaAssetRow = { ...baseAsset, content_type: 'image/heic', preview_object_key: null };
    const resolved = resolveViewerMedia(baseMemory, heicAsset);
    expect(resolved?.objectKey).toBe(heicAsset.object_key);
    expect(resolved?.contentType).toBe('image/heic');
  });

  it('resolves a video asset and carries duration through', () => {
    const videoAsset: MemoryMediaAssetRow = {
      object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
      content_type: 'video/mp4',
      duration_ms: 12_500,
      preview_object_key: null,
    };
    const resolved = resolveViewerMedia(baseMemory, videoAsset);
    expect(resolved).toEqual({
      kind: 'video',
      objectKey: videoAsset.object_key,
      contentType: 'video/mp4',
      memoryDate: baseMemory.memory_date,
      caption: baseMemory.content,
      emotion: baseMemory.emotion,
      durationMs: 12_500,
      previewObjectKey: null,
    });
  });

  it('resolves an audio memory (memory_type audio) to kind audio', () => {
    const audioMemory: MemoryHeaderRow = { ...baseMemory, memory_type: 'audio', content: null };
    const audioAsset: MemoryMediaAssetRow = {
      object_key: 'user-1/memories/mem-2/media/asset-1.m4a',
      content_type: 'audio/mp4',
      duration_ms: 4_200,
      preview_object_key: null,
    };
    const resolved = resolveViewerMedia(audioMemory, audioAsset);
    expect(resolved?.kind).toBe('audio');
    expect(resolved?.durationMs).toBe(4_200);
    expect(resolved?.caption).toBeNull();
  });
});

describe('resolveOpenGraphPoster', () => {
  it('uses a video asset’s generated JPEG preview rather than the video original', () => {
    const video = resolveViewerMedia(baseMemory, {
      object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
      content_type: 'video/mp4',
      duration_ms: 12_500,
      preview_object_key: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
    });

    expect(video).not.toBeNull();
    expect(resolveOpenGraphPoster(video!)).toEqual({
      kind: 'media',
      objectKey: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
      contentType: 'image/jpeg',
    });
  });

  it('uses an image preview when the viewer already substituted one', () => {
    const image = resolveViewerMedia(baseMemory, {
      ...baseAsset,
      content_type: 'image/heic',
      preview_object_key: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
    });

    expect(image).not.toBeNull();
    expect(resolveOpenGraphPoster(image!)).toEqual({
      kind: 'media',
      objectKey: 'user-1/memories/mem-1/media/asset-1-preview.jpg',
      contentType: 'image/jpeg',
    });
  });

  it('uses a browser-compatible image original when no preview exists', () => {
    const image = resolveViewerMedia(baseMemory, {
      ...baseAsset,
      content_type: 'image/png',
      preview_object_key: null,
    });

    expect(image).not.toBeNull();
    expect(resolveOpenGraphPoster(image!)).toEqual({
      kind: 'media',
      objectKey: baseAsset.object_key,
      contentType: 'image/png',
    });
  });

  it('uses the neutral JPEG brand card for audio and images social crawlers cannot decode', () => {
    const audio = resolveViewerMedia(
      { ...baseMemory, memory_type: 'audio' },
      {
        object_key: 'user-1/memories/mem-1/media/asset-1.m4a',
        content_type: 'audio/mp4',
        duration_ms: 4_200,
        preview_object_key: null,
      },
    );
    const heic = resolveViewerMedia(baseMemory, {
      ...baseAsset,
      content_type: 'image/heic',
      preview_object_key: null,
    });

    expect(audio).not.toBeNull();
    expect(heic).not.toBeNull();
    expect(resolveOpenGraphPoster(audio!)).toEqual({ kind: 'brand', contentType: 'image/jpeg' });
    expect(resolveOpenGraphPoster(heic!)).toEqual({ kind: 'brand', contentType: 'image/jpeg' });
  });

  it('uses the neutral JPEG brand card for a video without a generated poster', () => {
    const video = resolveViewerMedia(baseMemory, {
      object_key: 'user-1/memories/mem-1/media/asset-1.mp4',
      content_type: 'video/mp4',
      duration_ms: 12_500,
      preview_object_key: null,
    });

    expect(video).not.toBeNull();
    expect(resolveOpenGraphPoster(video!)).toEqual({ kind: 'brand', contentType: 'image/jpeg' });
  });
});

import { pickViewerAsset } from '../src/supabase';

describe('pickViewerAsset (owner bug 2026-08-29: a carousel QR must play the VIDEO, not position 0)', () => {
  const row = (content_type: string, key: string): MemoryMediaAssetRow =>
    ({ object_key: key, content_type, duration_ms: null, preview_object_key: null }) as MemoryMediaAssetRow;

  it('prefers the first video over an earlier photo in a carousel', () => {
    expect(pickViewerAsset([row('image/jpeg', 'p0'), row('video/mp4', 'v1'), row('image/jpeg', 'p2')])?.object_key).toBe('v1');
  });

  it('falls back to audio when no video exists', () => {
    expect(pickViewerAsset([row('image/jpeg', 'p0'), row('audio/m4a', 'a1')])?.object_key).toBe('a1');
  });

  it('keeps position-0 behavior for photo-only memories', () => {
    expect(pickViewerAsset([row('image/jpeg', 'p0'), row('image/jpeg', 'p1')])?.object_key).toBe('p0');
  });

  it('returns null for an assetless memory', () => {
    expect(pickViewerAsset([])).toBeNull();
  });
});
