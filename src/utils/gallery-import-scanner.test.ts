/* eslint-disable import/first -- native module mock is deliberately declared before tested imports. */
jest.mock('expo-media-library', () => ({
  AssetField: { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' },
  MediaType: { IMAGE: 'image' },
  Query: jest.fn(),
  Asset: jest.fn(),
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
});
