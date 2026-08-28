import { describe, expect, it } from 'vitest';

import { parseMemoryId, resolveViewerMedia, type MemoryHeaderRow, type MemoryMediaAssetRow } from '../src/resolve';

const VALID_ID = '0fbc1354-eaf7-552c-b659-78a0f751691e';

describe('parseMemoryId', () => {
  it('extracts a valid viewer-path memory id', () => {
    expect(parseMemoryId(`/m/${VALID_ID}`, '/m/')).toBe(VALID_ID);
  });

  it('extracts a valid media-path memory id', () => {
    expect(parseMemoryId(`/media/${VALID_ID}`, '/media/')).toBe(VALID_ID);
  });

  it('lowercases an uppercase UUID', () => {
    expect(parseMemoryId(`/m/${VALID_ID.toUpperCase()}`, '/m/')).toBe(VALID_ID);
  });

  it('rejects a path under the wrong prefix', () => {
    expect(parseMemoryId(`/media/${VALID_ID}`, '/m/')).toBeNull();
  });

  it('rejects a non-UUID segment', () => {
    expect(parseMemoryId('/m/not-a-uuid', '/m/')).toBeNull();
  });

  it('rejects trailing path segments', () => {
    expect(parseMemoryId(`/m/${VALID_ID}/extra`, '/m/')).toBeNull();
  });

  it('rejects an empty segment', () => {
    expect(parseMemoryId('/m/', '/m/')).toBeNull();
  });

  it('rejects the bare root path', () => {
    expect(parseMemoryId('/', '/m/')).toBeNull();
  });
});

const baseMemory: MemoryHeaderRow = {
  id: VALID_ID,
  memory_type: 'media',
  memory_date: '2026-06-01',
  content: 'First splash in the pool',
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
      durationMs: null,
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
      durationMs: 12_500,
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
