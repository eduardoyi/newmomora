import { describe, expect, it, vi } from 'vitest';
import { frontOptionsOf } from '../../../card/fromData';
import type { PickerPoolPage } from '../cardTypes';
import {
  buildAssetUrl,
  createPickerProvider,
  frontIdForPick,
  localFrontFromPick,
  LOCAL_FILE_PREFIX,
  mergeFrontOptions,
  PLACEHOLDER_LONG_EDGE_PX,
  pruneLocalFronts,
  removeLocalFront,
  sizeFromAspect,
} from '../pickerProvider';
import { fictionalCardData } from './helpers';

const page = (over: Partial<PickerPoolPage> = {}): PickerPoolPage => ({
  items: [
    { memoryId: 'mem-1', mediaId: 'media-10', previewKey: 'previews/a.jpg', date: '2026-09-02', aspectRatio: 1.5 },
    { memoryId: 'mem-2', mediaId: 'media-11', previewKey: 'previews/b.jpg', date: '2026-08-15', aspectRatio: 0.75 },
    { memoryId: 'mem-3', mediaId: 'media-12', previewKey: 'previews/c.jpg', date: '2026-07-01', aspectRatio: null },
  ],
  nextCursor: 'MzA=',
  ...over,
});

describe('sizeFromAspect', () => {
  it('derives width/height from the aspect ratio, 1:1 when unknown', () => {
    expect(sizeFromAspect(1.5)).toEqual({ width: PLACEHOLDER_LONG_EDGE_PX, height: Math.round(PLACEHOLDER_LONG_EDGE_PX / 1.5) });
    expect(sizeFromAspect(0.75)).toEqual({ width: Math.round(PLACEHOLDER_LONG_EDGE_PX * 0.75), height: PLACEHOLDER_LONG_EDGE_PX });
    expect(sizeFromAspect(1)).toEqual({ width: PLACEHOLDER_LONG_EDGE_PX, height: PLACEHOLDER_LONG_EDGE_PX });
    expect(sizeFromAspect(null)).toEqual({ width: PLACEHOLDER_LONG_EDGE_PX, height: PLACEHOLDER_LONG_EDGE_PX });
    expect(sizeFromAspect(0)).toEqual({ width: PLACEHOLDER_LONG_EDGE_PX, height: PLACEHOLDER_LONG_EDGE_PX });
  });
});

describe('createPickerProvider', () => {
  it('lists the pool with coalescer thumbnails, orientation from the aspect ratio, and the cursor', async () => {
    const fetchPool = vi.fn(async () => page());
    const getUrls = vi.fn(async (keys: string[]) => new Map(keys.filter((k) => k !== 'previews/c.jpg').map((k) => [k, `https://cdn.example.test/${k}`])));
    const provider = createPickerProvider({ fetchPool, getUrls });
    const result = await provider.list(null);
    expect(fetchPool).toHaveBeenCalledWith(null);
    expect(getUrls).toHaveBeenCalledWith(['previews/a.jpg', 'previews/b.jpg', 'previews/c.jpg']);
    expect(result.nextCursor).toBe('MzA=');
    expect(result.items.map((i) => i.id)).toEqual(['media-10', 'media-11', 'media-12']);
    expect(result.items[0]).toMatchObject({ kind: 'photo', thumbUrl: 'https://cdn.example.test/previews/a.jpg', date: '2026-09-02' });
    expect(result.items[0].width).toBeGreaterThan(result.items[0].height); // landscape
    expect(result.items[1].height).toBeGreaterThan(result.items[1].width); // portrait
    expect(result.items[2].width).toBe(result.items[2].height); // null → 1:1
    expect(result.items[2].thumbUrl).toBe(''); // unsigned key: blank, never a crash
  });

  it('passes the next cursor through and skips the URL call for an empty page', async () => {
    const fetchPool = vi.fn(async (cursor: string | null) => (cursor ? page({ items: [], nextCursor: null }) : page()));
    const getUrls = vi.fn(async () => new Map<string, string>());
    const provider = createPickerProvider({ fetchPool, getUrls });
    await provider.list('MzA=');
    expect(fetchPool).toHaveBeenLastCalledWith('MzA=');
    expect(getUrls).not.toHaveBeenCalled();
  });

  it('a failing pool rejects (the picker shows its error)', async () => {
    const provider = createPickerProvider({ fetchPool: async () => Promise.reject(new Error('boom')), getUrls: async () => new Map() });
    await expect(provider.list(null)).rejects.toThrow('boom');
  });
});

describe('local front picks (append, then revert)', () => {
  const item = { id: 'media-10', kind: 'photo' as const, thumbUrl: 'https://cdn.example.test/t.jpg', width: 4000, height: 2667, date: '2026-09-02' };

  it('appends a picked photo to the editor\'s frontOptions and draws it from the preview URL', () => {
    const data = fictionalCardData();
    const local = localFrontFromPick(item);
    expect(local.option).toMatchObject({ id: 'media-10', kind: 'photo', file: `${LOCAL_FILE_PREFIX}media-10`, width: 4000, height: 2667 });
    const merged = mergeFrontOptions(frontOptionsOf(data), [local]);
    expect(merged.map((o) => o.id)).toEqual(['media-1', 'media-2', 'media-10']);
    const assetUrl = buildAssetUrl({ 'front-1.jpg': 'https://cdn.example.test/front-1.jpg' }, [local], 'blank');
    expect(assetUrl(`${LOCAL_FILE_PREFIX}media-10`)).toBe('https://cdn.example.test/t.jpg');
    expect(assetUrl('front-1.jpg')).toBe('https://cdn.example.test/front-1.jpg');
    expect(assetUrl('missing.jpg')).toBe('blank');
  });

  it('reverts: removing the local pick removes it from the options', () => {
    const data = fictionalCardData();
    const locals = [localFrontFromPick(item)];
    expect(mergeFrontOptions(frontOptionsOf(data), removeLocalFront(locals, 'media-10')).map((o) => o.id)).toEqual(['media-1', 'media-2']);
  });

  it('the server\'s own entry wins once it lists the photo', () => {
    const data = fictionalCardData();
    const locals = [localFrontFromPick(item)];
    const serverNow = [...frontOptionsOf(data), { id: 'media-10', kind: 'photo' as const, file: 'front-10.jpg', width: 4032, height: 3024 }];
    expect(mergeFrontOptions(serverNow, locals).filter((o) => o.id === 'media-10')).toHaveLength(1);
    expect(mergeFrontOptions(serverNow, locals).find((o) => o.id === 'media-10')?.file).toBe('front-10.jpg');
    expect(pruneLocalFronts(locals, serverNow)).toEqual([]);
    expect(pruneLocalFronts(locals, frontOptionsOf(data))).toEqual(locals);
  });
});

describe('frontIdForPick', () => {
  it('picking the default photo clears the override, except when re-picking after the front vanished', () => {
    expect(frontIdForPick('media-1', 'media-1', false)).toBeNull();
    expect(frontIdForPick('media-1', 'media-1', true)).toBe('media-1');
    expect(frontIdForPick('media-2', 'media-1', false)).toBe('media-2');
    expect(frontIdForPick('media-2', 'media-1', true)).toBe('media-2');
  });
});
