/* eslint-disable import/first -- native module mock is deliberately declared before tested imports. */
jest.mock('expo-media-library', () => ({
  AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' },
  MediaType: { IMAGE: 'image' },
  MediaSubtype: { SCREENSHOT: 'screenshot' },
  Query: jest.fn(),
  Asset: jest.fn(),
  Album: { get: jest.fn() },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  presentPermissionsPicker: jest.fn(),
}));

const mockRandomUUID = jest.fn(() => '12345678-1234-4234-8234-123456789abc');
jest.mock('expo-crypto', () => ({
  randomUUID: () => mockRandomUUID(),
}));

import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

import {
  clusterGalleryAssets,
  createClusterSignature,
  createExpoGalleryMediaLibraryAdapter,
  getGalleryPhotoPermissionState,
  scanGallerySnapshot,
  type GalleryMediaLibraryAdapter,
  type LocalGalleryAsset,
} from '@/utils/gallery-import-scanner';

const NOW = Date.UTC(2026, 7, 9, 12);

function asset(id: string, captureAtMs: number): LocalGalleryAsset {
  return {
    assetToken: `token-${id}`,
    osAssetId: id,
    captureAtMs,
    width: 1200,
    height: 800,
    isFavorite: false,
  };
}

describe('gallery import scanner', () => {
  beforeEach(() => {
    mockRandomUUID.mockClear();
  });

  it('distinguishes full, limited, denied and non-repromptable permission states', () => {
    expect(getGalleryPhotoPermissionState({ granted: true, canAskAgain: true, accessPrivileges: 'all' })).toBe('full');
    expect(getGalleryPhotoPermissionState({ granted: true, canAskAgain: true, accessPrivileges: 'limited' })).toBe('limited');
    expect(getGalleryPhotoPermissionState({ granted: false, canAskAgain: true, accessPrivileges: 'none' })).toBe('denied');
    expect(getGalleryPhotoPermissionState({ granted: false, canAskAgain: false, accessPrivileges: 'none' })).toBe('blocked');
  });

  it('uses the iOS no-download cloud check and defaults to local availability elsewhere', async () => {
    const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
    const getIsInCloud = jest.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    (MediaLibrary.Asset as unknown as jest.Mock).mockImplementation(() => ({ getIsInCloud }));
    try {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
      const adapter = createExpoGalleryMediaLibraryAdapter();
      await expect(adapter.isAssetAvailableLocally!('cloud-photo')).resolves.toBe(false);
      await expect(adapter.isAssetAvailableLocally!('local-photo')).resolves.toBe(true);
      expect(getIsInCloud).toHaveBeenCalledTimes(2);

      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
      await expect(adapter.isAssetAvailableLocally!('android-photo')).resolves.toBe(true);
      expect(MediaLibrary.Asset).toHaveBeenCalledTimes(2);
    } finally {
      if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
    }
  });

  function mockQueryChain(metadata: { id: string; creationTime: number; width: number; height: number; isFavorite: boolean }[]) {
    const exeForMetadata = jest.fn().mockResolvedValue(metadata);
    const queryChain = {
      eq: jest.fn().mockReturnThis(),
      album: jest.fn().mockReturnThis(),
      gt: jest.fn().mockReturnThis(),
      lt: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exeForMetadata,
    };
    (MediaLibrary.Query as unknown as jest.Mock).mockImplementation(() => queryChain);
    return { exeForMetadata, queryChain };
  }

  it('reads mediaSubtypes per photo on iOS, flagging only a positive screenshot signal', async () => {
    const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
    mockQueryChain([
      { id: 'shot-1', creationTime: NOW, width: 100, height: 100, isFavorite: false },
      { id: 'photo-1', creationTime: NOW - 1, width: 100, height: 100, isFavorite: false },
      { id: 'error-1', creationTime: NOW - 2, width: 100, height: 100, isFavorite: false },
    ]);
    (MediaLibrary.Asset as unknown as jest.Mock).mockImplementation((id: string) => ({
      getMediaSubtypes: jest.fn(async () => {
        if (id === 'shot-1') return ['screenshot'];
        if (id === 'error-1') throw new Error('native subtype lookup failed');
        return [];
      }),
    }));
    try {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
      const page = await createExpoGalleryMediaLibraryAdapter().getPhotoPage({ offset: 0, limit: 3 });
      expect(page.find((item) => item.id === 'shot-1')?.isScreenshot).toBe(true);
      expect(page.find((item) => item.id === 'photo-1')?.isScreenshot).toBe(false);
      // A failed per-asset lookup degrades to "not a screenshot" rather than
      // crashing enumeration or excluding the photo outright.
      expect(page.find((item) => item.id === 'error-1')?.isScreenshot).toBe(false);
    } finally {
      if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
    }
  });

  it('does not attempt per-asset subtype lookups on Android and leaves isScreenshot unset', async () => {
    const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
    mockQueryChain([
      { id: 'android-1', creationTime: NOW, width: 100, height: 100, isFavorite: false },
    ]);
    const assetConstructor = MediaLibrary.Asset as unknown as jest.Mock;
    assetConstructor.mockClear();
    try {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
      const page = await createExpoGalleryMediaLibraryAdapter().getPhotoPage({ offset: 0, limit: 1 });
      expect(page[0].isScreenshot).toBeUndefined();
      expect(assetConstructor).not.toHaveBeenCalled();
    } finally {
      if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
    }
  });

  it('excludes a positively flagged screenshot while admitting an asset with no subtype signal', async () => {
    const getPhotoPage = jest.fn(async ({ offset }: { offset: number }) => {
      if (offset > 0) return [];
      return [
        { id: 'shot-1', creationTime: NOW - 1_000, width: 100, height: 100, isFavorite: false, isScreenshot: true },
        { id: 'no-signal-1', creationTime: NOW - 2_000, width: 100, height: 100, isFavorite: false },
      ];
    });
    const adapter: GalleryMediaLibraryAdapter = {
      getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      getPhotoPage,
      resolveAssetUri: jest.fn(),
    };

    const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10 });

    expect(result.scannedAssetCount).toBe(1);
    expect(result.rejectedAssetCount).toBe(1);
    // The asset with no subtype field at all (the Android path) is still admitted.
    expect(result.clusters.flatMap((cluster) => cluster.assets.map((item) => item.osAssetId))).toEqual(['no-signal-1']);
  });

  describe('Android camera-captures-only corpus (2026-08-11 product decision)', () => {
    const albumGet = MediaLibrary.Album.get as unknown as jest.Mock;

    beforeEach(() => {
      albumGet.mockReset();
    });

    it('resolves camera_album when the exact-title "Camera" album is found, then scopes getPhotoPage to it', async () => {
      const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
      const cameraAlbum = { id: 'album-camera' };
      albumGet.mockResolvedValue(cameraAlbum);
      const { exeForMetadata, queryChain } = mockQueryChain([
        { id: 'a', creationTime: NOW, width: 100, height: 100, isFavorite: false },
      ]);
      try {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const adapter = createExpoGalleryMediaLibraryAdapter();
        await expect(adapter.resolveCorpus!()).resolves.toEqual({ mode: 'camera_album' });
        expect(albumGet).toHaveBeenCalledWith('Camera');

        await adapter.getPhotoPage({ offset: 0, limit: 10 });
        expect(queryChain.album).toHaveBeenCalledWith(cameraAlbum);
        expect(exeForMetadata).toHaveBeenCalledTimes(1);

        // Resolved once, cached, and reused -- a second resolveCorpus call
        // does not re-query the native Album API.
        await adapter.resolveCorpus!();
        expect(albumGet).toHaveBeenCalledTimes(1);
      } finally {
        if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
      }
    });

    it('resolves full_library_fallback and never scopes the query when no "Camera" album is found', async () => {
      const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
      albumGet.mockResolvedValue(null);
      const { queryChain } = mockQueryChain([{ id: 'a', creationTime: NOW, width: 100, height: 100, isFavorite: false }]);
      try {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const adapter = createExpoGalleryMediaLibraryAdapter();
        await expect(adapter.resolveCorpus!()).resolves.toEqual({ mode: 'full_library_fallback' });

        await adapter.getPhotoPage({ offset: 0, limit: 10 });
        expect(queryChain.album).not.toHaveBeenCalled();
      } finally {
        if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
      }
    });

    it('degrades to full_library_fallback (never throws) when the native Album API itself fails', async () => {
      const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
      albumGet.mockRejectedValue(new Error('album API unavailable on this device/SDK build'));
      try {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const adapter = createExpoGalleryMediaLibraryAdapter();
        await expect(adapter.resolveCorpus!()).resolves.toEqual({ mode: 'full_library_fallback' });
      } finally {
        if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
      }
    });

    it('omits resolveCorpus entirely on iOS -- it never attempts camera-scoping', async () => {
      const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
      try {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const adapter = createExpoGalleryMediaLibraryAdapter();
        expect(adapter.resolveCorpus).toBeUndefined();
        expect(albumGet).not.toHaveBeenCalled();
      } finally {
        if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
      }
    });

    it('a full album-scoped two-phase scanGallerySnapshot pass reports corpusMode: camera_album', async () => {
      const originalOs = Object.getOwnPropertyDescriptor(Platform, 'OS');
      const cameraAlbum = { id: 'album-camera' };
      albumGet.mockResolvedValue(cameraAlbum);
      (MediaLibrary.getPermissionsAsync as unknown as jest.Mock).mockResolvedValue({ granted: true, canAskAgain: true, accessPrivileges: 'all' });
      const { queryChain } = mockQueryChain([
        { id: 'a', creationTime: NOW, width: 100, height: 100, isFavorite: false },
      ]);
      try {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        const result = await scanGallerySnapshot(createExpoGalleryMediaLibraryAdapter(), {
          nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10,
        });
        expect(result.corpusMode).toBe('camera_album');
        expect(result.scannedAssetCount).toBe(1);
        expect(queryChain.album).toHaveBeenCalledWith(cameraAlbum);
      } finally {
        if (originalOs) Object.defineProperty(Platform, 'OS', originalOs);
      }
    });
  });

  describe('scanGallerySnapshot corpus-mode resolution and frontier compatibility', () => {
    it('reports corpusMode from a hand-built adapter\'s resolveCorpus', async () => {
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        resolveCorpus: async () => ({ mode: 'camera_album' }),
        getPhotoPage: async ({ offset }) => (offset > 0 ? [] : [{ id: 'a', creationTime: NOW, width: 1, height: 1, isFavorite: false }]),
        resolveAssetUri: jest.fn(),
      };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10 });
      expect(result.corpusMode).toBe('camera_album');
    });

    it('defaults to full_library_fallback when the adapter has no resolveCorpus', async () => {
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage: async ({ offset }) => (offset > 0 ? [] : [{ id: 'a', creationTime: NOW, width: 1, height: 1, isFavorite: false }]),
        resolveAssetUri: jest.fn(),
      };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10 });
      expect(result.corpusMode).toBe('full_library_fallback');
    });

    it('ignores a frontier built under a different corpus mode and scans fresh instead of windowing by it', async () => {
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs }: { offset: number; newerThanMs?: number; olderThanMs?: number }) => {
        // A fresh (unbounded) scan must never pass either bound.
        if (newerThanMs !== undefined || olderThanMs !== undefined) {
          throw new Error('expected an unbounded query when the frontier is ignored for a corpus-mode mismatch');
        }
        return offset > 0 ? [] : [{ id: 'a', creationTime: NOW, width: 1, height: 1, isFavorite: false }];
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        resolveCorpus: async () => ({ mode: 'full_library_fallback' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      // This frontier was built under 'camera_album'; this adapter resolves
      // 'full_library_fallback' -- a mismatch.
      const mismatchedFrontier = { coveredThroughNewestMs: NOW - 10_000, oldestCoveredMs: NOW - 20_000, corpusMode: 'camera_album' as const };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier: mismatchedFrontier });
      expect(result.corpusMode).toBe('full_library_fallback');
      expect(result.scannedAssetCount).toBe(1);
    });

    it('uses a frontier whose corpus mode matches this pass, windowing normally', async () => {
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs }: { offset: number; newerThanMs?: number; olderThanMs?: number }) => {
        if (newerThanMs !== undefined) return [];
        if (olderThanMs !== undefined) return offset > 0 ? [] : [{ id: 'old-1', creationTime: olderThanMs - 1_000, width: 1, height: 1, isFavorite: false }];
        throw new Error('expected a bounded query when the frontier matches this pass\'s corpus mode');
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        resolveCorpus: async () => ({ mode: 'camera_album' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const matchingFrontier = { coveredThroughNewestMs: NOW - 10_000, oldestCoveredMs: NOW - 20_000, corpusMode: 'camera_album' as const };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier: matchingFrontier });
      expect(result.corpusMode).toBe('camera_album');
      expect(result.scannedAssetCount).toBe(1);
    });
  });

  it('clusters deterministic newest-first metadata without resolving local URIs', async () => {
    const getPhotoPage = jest.fn(async ({ offset }: { offset: number }) => {
      if (offset > 0) return [];
      return [
        { id: 'new-1', creationTime: NOW - 1_000, width: 100, height: 100, isFavorite: true },
        { id: 'new-2', creationTime: NOW - 2_000, width: 100, height: 100, isFavorite: false },
        { id: 'old-1', creationTime: NOW - 8 * 60 * 60 * 1000, width: 100, height: 100, isFavorite: false },
        { id: 'bad-date', creationTime: null, width: 100, height: 100, isFavorite: false },
      ];
    });
    const adapter: GalleryMediaLibraryAdapter = {
      getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      getPhotoPage,
      resolveAssetUri: jest.fn(),
    };

    const result = await scanGallerySnapshot(adapter, {
      nowMs: NOW,
      pageSize: 10,
      createToken: (() => {
        let index = 0;
        return () => `opaque-${++index}`;
      })(),
    });

    expect(result.permission).toBe('full');
    expect(result.scannedAssetCount).toBe(3);
    expect(result.rejectedAssetCount).toBe(1);
    expect(result.clusters.map((cluster) => cluster.assets.map((item) => item.assetToken))).toEqual([
      ['opaque-1', 'opaque-2'],
      ['opaque-3'],
    ]);
    expect(adapter.resolveAssetUri).not.toHaveBeenCalled();
    expect(getPhotoPage).toHaveBeenCalledWith({ offset: 0, limit: 10 });
  });

  it('uses Expo native cryptographic randomness when creating opaque asset tokens', async () => {
    const adapter: GalleryMediaLibraryAdapter = {
      getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      getPhotoPage: jest.fn()
        .mockResolvedValueOnce([
          { id: 'photo-1', creationTime: NOW, width: 100, height: 100, isFavorite: false },
        ])
        .mockResolvedValueOnce([]),
      resolveAssetUri: jest.fn(),
    };

    const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10 });

    expect(mockRandomUUID).toHaveBeenCalledTimes(1);
    expect(result.clusters[0].assets[0].assetToken).toBe('12345678-1234-4234-8234-123456789abc');
  });

  it('rejects scan attempts without a usable photo permission', async () => {
    const adapter: GalleryMediaLibraryAdapter = {
      getPermission: async () => ({ granted: false, canAskAgain: false, accessPrivileges: 'none' }),
      requestPermission: async () => ({ granted: false, canAskAgain: false, accessPrivileges: 'none' }),
      getPhotoPage: jest.fn(),
      resolveAssetUri: jest.fn(),
    };
    await expect(scanGallerySnapshot(adapter)).rejects.toThrow('blocked');
    expect(adapter.getPhotoPage).not.toHaveBeenCalled();
  });

  it('makes a stable signature from the local identifiers and capture times only', () => {
    const original = [asset('b', NOW), asset('a', NOW - 1)];
    const reordered = [asset('a', NOW - 1), asset('b', NOW)];
    expect(createClusterSignature(original)).toBe(createClusterSignature(reordered));
    expect(createClusterSignature(original)).not.toBe(createClusterSignature([asset('b', NOW)]));
    expect(createClusterSignature(reordered)).toBe('a9d0332fc779ad622179262e69803574ac2cdc3cf1d4b5d92458c5da3d9a55b1');
  });

  it('caps a large cluster by spreading selected assets across the event', () => {
    const assets = Array.from({ length: 21 }, (_, index) => asset(String(index), NOW - index));
    const [cluster] = clusterGalleryAssets(assets, { maxAssetsPerCluster: 3 });
    expect(cluster.assets.map((item) => item.osAssetId)).toEqual(['0', '10', '20']);
  });

  it('keeps a full-event receipt signature stable across representative caps and retains favorites', () => {
    const assets = Array.from({ length: 12 }, (_, index) => ({
      ...asset(String(index), NOW - index),
      isFavorite: index === 7,
    }));
    const [small] = clusterGalleryAssets(assets, { maxAssetsPerCluster: 3 });
    const [large] = clusterGalleryAssets(assets, { maxAssetsPerCluster: 8 });
    // A permanent skipped receipt must not be defeated by changing client cap
    // values: it identifies the full canonical event, not display samples.
    expect(small.signature).toBe(large.signature);
    expect(small.assets.map((item) => item.osAssetId)).toContain('7');
    expect(large.assets.map((item) => item.osAssetId)).toContain('7');
  });

  it('stops at the frozen enumeration ceiling and reports a potentially truncated corpus', async () => {
    const getPhotoPage = jest.fn(async ({ offset, limit }: { offset: number; limit: number }) => (
      Array.from({ length: limit }, (_, index) => ({
        id: String(offset + index), creationTime: NOW - offset - index, width: 1, height: 1, isFavorite: false,
      }))
    ));
    const adapter: GalleryMediaLibraryAdapter = {
      getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
      getPhotoPage,
      resolveAssetUri: jest.fn(),
    };
    const result = await scanGallerySnapshot(adapter, {
      nowMs: NOW,
      pageSize: 3,
      maxEnumeratedAssets: 5,
      createToken: (() => { let index = 0; return () => `token-${++index}`; })(),
    });
    expect(result.scannedAssetCount).toBe(5);
    expect(result.wasTruncated).toBe(true);
    expect(getPhotoPage).toHaveBeenNthCalledWith(1, { offset: 0, limit: 3 });
    expect(getPhotoPage).toHaveBeenNthCalledWith(2, { offset: 3, limit: 2 });
    expect(getPhotoPage).toHaveBeenCalledTimes(2);
  });

  describe('progressive-deepening two-phase windowed scan', () => {
    it('with no frontier, queries unbounded and reports reachedLibraryEnd true when the pass finishes without truncation', async () => {
      const getPhotoPage = jest.fn(async ({ offset }: { offset: number }) => (offset > 0 ? [] : [
        { id: 'a', creationTime: NOW, width: 1, height: 1, isFavorite: false },
      ]));
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10 });
      expect(result.wasTruncated).toBe(false);
      expect(result.reachedLibraryEnd).toBe(true);
      expect(getPhotoPage).toHaveBeenCalledWith(expect.objectContaining({ newerThanMs: undefined, olderThanMs: undefined }));
    });

    it('with no frontier, reports reachedLibraryEnd false when the enumeration budget cuts the pass off', async () => {
      const getPhotoPage = jest.fn(async ({ offset, limit }: { offset: number; limit: number }) => (
        Array.from({ length: limit }, (_, index) => ({ id: String(offset + index), creationTime: NOW - offset - index, width: 1, height: 1, isFavorite: false }))
      ));
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 3, maxEnumeratedAssets: 5 });
      expect(result.wasTruncated).toBe(true);
      expect(result.reachedLibraryEnd).toBe(false);
    });

    it('with a frontier, runs Phase A (newer than covered) then Phase B (older than covered), never re-walking the already-covered middle', async () => {
      const getPhotoPage = jest.fn(async ({ offset, limit, newerThanMs, olderThanMs }: { offset: number; limit: number; newerThanMs?: number; olderThanMs?: number }) => {
        if (newerThanMs !== undefined) {
          if (offset > 0) return [];
          return [
            { id: 'new-1', creationTime: NOW, width: 1, height: 1, isFavorite: false },
            { id: 'new-2', creationTime: NOW - 1_000, width: 1, height: 1, isFavorite: false },
          ].slice(0, limit);
        }
        if (olderThanMs !== undefined) {
          if (offset > 0) return [];
          return [{ id: 'old-1', creationTime: olderThanMs - 1_000, width: 1, height: 1, isFavorite: false }].slice(0, limit);
        }
        throw new Error('expected every query to be bounded once a frontier is supplied');
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW - 500_000, oldestCoveredMs: NOW - 1_000_000, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier,
        createToken: (() => { let index = 0; return () => `token-${++index}`; })(),
      });
      expect(result.scannedAssetCount).toBe(3);
      expect(result.clusters.flatMap((cluster) => cluster.assets.map((asset) => asset.osAssetId)).sort())
        .toEqual(['new-1', 'new-2', 'old-1']);
      expect(getPhotoPage).toHaveBeenCalledWith(expect.objectContaining({ newerThanMs: frontier.coveredThroughNewestMs }));
      expect(getPhotoPage).toHaveBeenCalledWith(expect.objectContaining({ olderThanMs: frontier.oldestCoveredMs }));
    });

    it('with a frontier, reports reachedLibraryEnd true only once Phase B (the deepening direction) completes naturally', async () => {
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs }: { offset: number; newerThanMs?: number; olderThanMs?: number }) => {
        if (newerThanMs !== undefined) return [];
        if (olderThanMs !== undefined) {
          return offset > 0 ? [] : [{ id: 'old-1', creationTime: olderThanMs - 1_000, width: 1, height: 1, isFavorite: false }];
        }
        throw new Error('expected every query to be bounded once a frontier is supplied');
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW - 10_000, oldestCoveredMs: NOW - 20_000, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier });
      expect(result.wasTruncated).toBe(false);
      expect(result.reachedLibraryEnd).toBe(true);
    });

    it('with a frontier, reports reachedLibraryEnd false when Phase A alone consumes the whole budget (Phase B never runs)', async () => {
      const getPhotoPage = jest.fn(async ({ offset, limit, newerThanMs }: { offset: number; limit: number; newerThanMs?: number }) => {
        if (newerThanMs === undefined) throw new Error('Phase B must not run once Phase A has used the entire budget');
        return Array.from({ length: limit }, (_, index) => ({ id: `new-${offset + index}`, creationTime: NOW - offset - index, width: 1, height: 1, isFavorite: false }));
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW - 10_000, oldestCoveredMs: NOW - 20_000, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, { nowMs: NOW, pageSize: 3, maxEnumeratedAssets: 3, frontier });
      expect(result.scannedAssetCount).toBe(3);
      expect(result.wasTruncated).toBe(true);
      expect(result.reachedLibraryEnd).toBe(false);
    });
  });
});
