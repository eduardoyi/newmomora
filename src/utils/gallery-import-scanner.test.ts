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
import { mergeGalleryImportFrontierCoverage } from '@/utils/gallery-import-frontier';

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

  describe('continuous model: windowed, contiguous-ordering scan (docs/plans/gallery-import-continuous.md)', () => {
    const hour = 60 * 60 * 1000;

    it('keeps a group\'s signature identical regardless of admission order (oldest_first vs newest_first)', () => {
      const group = [asset('a', NOW), asset('b', NOW - 1_000), asset('c', NOW - 2_000)];
      const newestFirst = clusterGalleryAssets(group, { order: 'newest_first' });
      const oldestFirst = clusterGalleryAssets(group, { order: 'oldest_first' });
      expect(newestFirst).toHaveLength(1);
      expect(oldestFirst).toHaveLength(1);
      expect(newestFirst[0].signature).toBe(oldestFirst[0].signature);
      // Within-group asset order is normalized back to newest-first either way.
      expect(newestFirst[0].assets.map((item) => item.osAssetId)).toEqual(['a', 'b', 'c']);
      expect(oldestFirst[0].assets.map((item) => item.osAssetId)).toEqual(['a', 'b', 'c']);
    });

    it('admits Phase A groups oldest-first (nearest the previously-covered boundary) up to the window', async () => {
      // Three well-separated Phase A groups, newest last: group "far" is
      // closest to "now", group "near" sits right above the frontier
      // boundary. A window of 1 must keep "near" (contiguous extension),
      // not "far" (which a naive newest-first slice would keep).
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs, limit }: { offset: number; newerThanMs?: number; olderThanMs?: number; limit: number }) => {
        if (olderThanMs !== undefined) return []; // Phase B: nothing further to deepen in this test.
        if (newerThanMs === undefined) throw new Error('expected a bounded Phase A query');
        if (offset > 0) return [];
        return [
          { id: 'far-1', creationTime: NOW, width: 1, height: 1, isFavorite: false },
          { id: 'near-1', creationTime: NOW - 10 * hour, width: 1, height: 1, isFavorite: false },
        ].slice(0, limit);
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW - 11 * hour, oldestCoveredMs: NOW - 20 * hour, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier, targetClusterCount: 1,
      });
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].assets.map((item) => item.osAssetId)).toEqual(['near-1']);
    });

    it('Phase A with more groups than the window, early-stopped, admits the groups adjacent to the old frontier with no gap in the merged frontier', async () => {
      const hour = 60 * 60 * 1000;
      const groupGap = 4 * hour; // > GALLERY_IMPORT_CLUSTER_GAP_MS (3h) so each asset is its own group.
      const boundary = NOW - 50 * hour; // frontier.coveredThroughNewestMs
      const groupCount = 10;
      // group[i] is the (i+1)-th oldest asset newer than `boundary` -- index 0
      // is adjacent to the old frontier, index 9 is closest to "now".
      const groupTimestamps = Array.from({ length: groupCount }, (_, index) => boundary + (index + 1) * groupGap);

      const getPhotoPage = jest.fn(async ({ offset, limit, newerThanMs, olderThanMs, ascending }: { offset: number; limit: number; newerThanMs?: number; olderThanMs?: number; ascending?: boolean }) => {
        if (olderThanMs !== undefined) return []; // Phase B: nothing to deepen in this test.
        if (newerThanMs === undefined) throw new Error('expected a bounded Phase A query');
        if (!ascending) throw new Error('expected Phase A to enumerate ascending, oldest-of-the-range first');
        return groupTimestamps
          .slice(offset, offset + limit)
          .map((creationTime, index) => ({ id: `group-${offset + index}`, creationTime, width: 1, height: 1, isFavorite: false }));
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: boundary, oldestCoveredMs: boundary - 1_000_000, corpusMode: 'full_library_fallback' as const };

      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 1, maxEnumeratedAssets: 100, frontier, targetClusterCount: 3,
      });

      // (1) The admitted clusters are the 3 OLDEST Phase-A groups -- adjacent
      // to coveredThroughNewestMs -- not an arbitrary or newest-first slice.
      expect(result.clusters).toHaveLength(3);
      const admittedTimestamps = result.clusters.map((cluster) => cluster.assets[0].captureAtMs).sort((left, right) => left - right);
      expect(admittedTimestamps).toEqual(groupTimestamps.slice(0, 3));

      // (2) No admitted asset is newer than the un-enumerated band's oldest
      // asset -- the early stop must never skip ahead over un-scanned history.
      const enumeratedCount = getPhotoPage.mock.calls.length;
      expect(enumeratedCount).toBeLessThan(groupCount);
      const unenumeratedBandOldest = groupTimestamps[enumeratedCount];
      expect(Math.max(...admittedTimestamps)).toBeLessThan(unenumeratedBandOldest);

      // (3) Merging this pass's registered coverage into the prior frontier
      // yields coveredThroughNewestMs equal to the newest ADMITTED asset --
      // no gap: the next Phase A resumes exactly where admission stopped.
      const merged = mergeGalleryImportFrontierCoverage(
        { ...frontier, completedLibrary: false, autoContinue: true },
        { oldestCoveredMs: Math.min(...admittedTimestamps), newestCoveredMs: Math.max(...admittedTimestamps) },
        false,
        'full_library_fallback',
      );
      expect(merged?.coveredThroughNewestMs).toBe(Math.max(...admittedTimestamps));
    });

    it('admits Phase B groups newest-first (nearest the previously-covered boundary) for the remaining window', async () => {
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs, limit }: { offset: number; newerThanMs?: number; olderThanMs?: number; limit: number }) => {
        if (newerThanMs !== undefined) return [];
        if (olderThanMs === undefined) throw new Error('expected a bounded Phase B query');
        if (offset > 0) return [];
        return [
          { id: 'near-1', creationTime: olderThanMs - hour, width: 1, height: 1, isFavorite: false },
          { id: 'far-1', creationTime: olderThanMs - 20 * hour, width: 1, height: 1, isFavorite: false },
        ].slice(0, limit);
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW, oldestCoveredMs: NOW - 10 * hour, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier, targetClusterCount: 1,
      });
      expect(result.clusters).toHaveLength(1);
      expect(result.clusters[0].assets.map((item) => item.osAssetId)).toEqual(['near-1']);
    });

    it('stops enumerating a phase early once target+1 complete groups exist, before the byte budget is exhausted', async () => {
      // 5 groups, each 1 asset, spaced far enough apart (>3h) to never merge.
      // targetClusterCount 2 -> early stop should fire once 3 complete groups
      // exist (index 3, i.e. 4 assets seen), well before maxEnumeratedAssets.
      const allAssets = Array.from({ length: 5 }, (_, index) => ({
        id: `g${index}`, creationTime: NOW - index * 4 * hour, width: 1, height: 1, isFavorite: false,
      }));
      const getPhotoPage = jest.fn(async ({ offset, limit }: { offset: number; limit: number }) => allAssets.slice(offset, offset + limit));
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 1, maxEnumeratedAssets: 100, targetClusterCount: 2,
      });
      // 3 complete groups (g0, g1, g2) confirmed by seeing g3's gap -> 4 pages.
      expect(getPhotoPage).toHaveBeenCalledTimes(4);
      expect(result.scannedAssetCount).toBe(4);
      expect(result.wasTruncated).toBe(true);
      expect(result.clusters).toHaveLength(2);
      expect(result.clusters.map((cluster) => cluster.assets[0].osAssetId)).toEqual(['g0', 'g1']);
    });

    it('fixes completedLibrary: stays false when Phase B finished naturally but produced more groups than fit the window', async () => {
      // Phase B enumerates its whole (small) range naturally (no truncation),
      // but produces 2 groups while only 1 window slot remains -- the true
      // oldest edge exists but was not admitted/registered this pass.
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs, limit }: { offset: number; newerThanMs?: number; olderThanMs?: number; limit: number }) => {
        if (newerThanMs !== undefined) return [];
        if (olderThanMs === undefined) throw new Error('expected a bounded Phase B query');
        if (offset > 0) return [];
        return [
          { id: 'near-1', creationTime: olderThanMs - hour, width: 1, height: 1, isFavorite: false },
          { id: 'far-1', creationTime: olderThanMs - 20 * hour, width: 1, height: 1, isFavorite: false },
        ].slice(0, limit);
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW, oldestCoveredMs: NOW - 10 * hour, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier, targetClusterCount: 1,
      });
      expect(result.wasTruncated).toBe(false);
      expect(result.clusters).toHaveLength(1);
      // Both groups exist and enumeration was not cut off, but only 1 of the
      // 2 groups Phase B found actually fit -- completedLibrary must not lie.
      expect(result.reachedLibraryEnd).toBe(false);
    });

    it('sets completedLibrary true when Phase B finishes naturally AND every group it found is admitted', async () => {
      const getPhotoPage = jest.fn(async ({ offset, newerThanMs, olderThanMs, limit }: { offset: number; newerThanMs?: number; olderThanMs?: number; limit: number }) => {
        if (newerThanMs !== undefined) return [];
        if (olderThanMs === undefined) throw new Error('expected a bounded Phase B query');
        if (offset > 0) return [];
        return [{ id: 'only-1', creationTime: olderThanMs - hour, width: 1, height: 1, isFavorite: false }].slice(0, limit);
      });
      const adapter: GalleryMediaLibraryAdapter = {
        getPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        requestPermission: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
        getPhotoPage,
        resolveAssetUri: jest.fn(),
      };
      const frontier = { coveredThroughNewestMs: NOW, oldestCoveredMs: NOW - 10 * hour, corpusMode: 'full_library_fallback' as const };
      const result = await scanGallerySnapshot(adapter, {
        nowMs: NOW, pageSize: 10, maxEnumeratedAssets: 10, frontier, targetClusterCount: 5,
      });
      expect(result.wasTruncated).toBe(false);
      expect(result.clusters).toHaveLength(1);
      expect(result.reachedLibraryEnd).toBe(true);
    });
  });
});
