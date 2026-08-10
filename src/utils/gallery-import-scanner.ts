import * as Crypto from 'expo-crypto';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

import {
  GALLERY_IMPORT_ALGORITHM_VERSION,
  GALLERY_IMPORT_CLUSTER_GAP_MS,
  GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER,
  GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN,
  GALLERY_IMPORT_MAX_ENUMERATED_ASSETS,
  GALLERY_IMPORT_MIN_CAPTURE_TIME_MS,
  GALLERY_IMPORT_SCAN_PAGE_SIZE,
} from '@/constants/gallery-import';

export type GalleryPhotoPermissionState = 'full' | 'limited' | 'denied' | 'blocked';

export interface GalleryPhotoPermission {
  granted: boolean;
  canAskAgain: boolean;
  accessPrivileges?: 'all' | 'limited' | 'none';
}

/** Lightweight fields only. Filenames, URIs, EXIF, and locations are deliberately absent. */
export interface GalleryPhotoMetadata {
  id: string;
  creationTime: number | null;
  width: number | null;
  height: number | null;
  isFavorite: boolean;
}

export interface GalleryMediaLibraryAdapter {
  getPermission: () => Promise<GalleryPhotoPermission>;
  requestPermission: () => Promise<GalleryPhotoPermission>;
  presentPermissionPicker?: () => Promise<void>;
  getPhotoPage: (input: { offset: number; limit: number }) => Promise<GalleryPhotoMetadata[]>;
  /** True when URI resolution will not trigger a cloud-original download. */
  isAssetAvailableLocally?: (osAssetId: string) => Promise<boolean>;
  resolveAssetUri: (osAssetId: string) => Promise<string>;
  /** Approval-only: never call while scanning or send the filename off-device. */
  getAssetFilename?: (osAssetId: string) => Promise<string>;
}

export interface LocalGalleryAsset {
  /** A random per-run token. This is the only asset identifier that may leave the device. */
  assetToken: string;
  /** Local-only; never pass to services, logs, analytics, R2 keys, or prompts. */
  osAssetId: string;
  captureAtMs: number;
  width: number | null;
  height: number | null;
  isFavorite: boolean;
}

export interface GalleryCluster {
  algorithmVersion: typeof GALLERY_IMPORT_ALGORITHM_VERSION;
  signature: string;
  captureAtMs: number;
  assets: LocalGalleryAsset[];
}

export interface GalleryScanSnapshot {
  permission: Exclude<GalleryPhotoPermissionState, 'denied' | 'blocked'>;
  clusters: GalleryCluster[];
  scannedAssetCount: number;
  rejectedAssetCount: number;
  /** True when the bounded newest-first corpus may omit older photos. */
  wasTruncated: boolean;
}

export interface GalleryScanOptions {
  nowMs?: number;
  pageSize?: number;
  maxEnumeratedAssets?: number;
  maxClusters?: number;
  maxAssetsPerCluster?: number;
  clusterGapMs?: number;
  createToken?: () => string;
  onPage?: (progress: { scannedAssetCount: number; rejectedAssetCount: number }) => void;
  yieldToEventLoop?: () => Promise<void>;
}

function isPlausibleCaptureTime(captureAtMs: number | null, nowMs: number): captureAtMs is number {
  return typeof captureAtMs === 'number'
    && Number.isFinite(captureAtMs)
    && captureAtMs >= GALLERY_IMPORT_MIN_CAPTURE_TIME_MS
    && captureAtMs <= nowMs + 24 * 60 * 60 * 1000;
}

export function getGalleryPhotoPermissionState(
  permission: GalleryPhotoPermission,
): GalleryPhotoPermissionState {
  if (permission.granted) {
    return permission.accessPrivileges === 'limited' ? 'limited' : 'full';
  }
  return permission.canAskAgain ? 'denied' : 'blocked';
}

/** Maps Expo's next MediaLibrary API to the intentionally narrow scanner adapter. */
export function createExpoGalleryMediaLibraryAdapter(): GalleryMediaLibraryAdapter {
  const toPermission = (permission: MediaLibrary.PermissionResponse): GalleryPhotoPermission => ({
    granted: permission.granted,
    canAskAgain: permission.canAskAgain,
    accessPrivileges: permission.accessPrivileges,
  });

  return {
    getPermission: async () => toPermission(
      await MediaLibrary.getPermissionsAsync(false, ['photo']),
    ),
    requestPermission: async () => toPermission(
      await MediaLibrary.requestPermissionsAsync(false, ['photo']),
    ),
    presentPermissionPicker: async () => {
      await MediaLibrary.presentPermissionsPicker(['photo']);
    },
    getPhotoPage: async ({ offset, limit }) => {
      const metadata = await new MediaLibrary.Query()
        .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE)
        .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
        .offset(offset)
        .limit(limit)
        .exeForMetadata();

      // Do not add filename, URI, EXIF, or location here. The new SDK API lets
      // enumeration remain metadata-only and avoids decoding local image bytes.
      return metadata.map((asset) => ({
        id: asset.id,
        creationTime: asset.creationTime,
        width: asset.width,
        height: asset.height,
        isFavorite: asset.isFavorite,
      }));
    },
    isAssetAvailableLocally: async (osAssetId) => Platform.OS !== 'ios'
      || !(await new MediaLibrary.Asset(osAssetId).getIsInCloud()),
    resolveAssetUri: (osAssetId) => new MediaLibrary.Asset(osAssetId).getUri(),
    getAssetFilename: (osAssetId) => new MediaLibrary.Asset(osAssetId).getFilename(),
  };
}

function defaultCreateToken(): string {
  return Crypto.randomUUID();
}

// Compact SHA-256 implementation avoids adding a second native dependency only
// for a local best-effort dedup digest. The raw canonical string never leaves
// this module; callers receive its hex digest only.
/** SHA-256 for bounded local inputs. It never transmits the source bytes. */
export function galleryImportSha256HexFromBytes(bytes: Uint8Array): string {
  const words: number[] = [];
  for (let index = 0; index < bytes.length; index++) {
    words[index >> 2] = (words[index >> 2] ?? 0) | (bytes[index] << (24 - (index % 4) * 8));
  }
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] = (words[bitLength >> 5] ?? 0) | (0x80 << (24 - (bitLength % 32)));
  const paddedLength = (((bitLength + 64) >> 9) << 4) + 15;
  words[paddedLength] = bitLength;

  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rightRotate = (number: number, amount: number) => (number >>> amount) | (number << (32 - amount));

  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = new Array<number>(64);
    for (let index = 0; index < 16; index++) schedule[index] = words[offset + index] ?? 0;
    for (let index = 16; index < 64; index++) {
      const a = schedule[index - 15];
      const b = schedule[index - 2];
      schedule[index] = (rightRotate(a, 7) ^ rightRotate(a, 18) ^ (a >>> 3))
        + schedule[index - 16]
        + (rightRotate(b, 17) ^ rightRotate(b, 19) ^ (b >>> 10))
        + schedule[index - 7];
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choice + constants[index] + schedule[index]) | 0;
      const sigma0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    hash = hash.map((part, index) => (part + [a, b, c, d, e, f, g, h][index]) | 0);
  }
  return hash.map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

export function galleryImportSha256Hex(value: string): string {
  return galleryImportSha256HexFromBytes(new TextEncoder().encode(value));
}

export function createClusterSignature(
  assets: Pick<LocalGalleryAsset, 'osAssetId' | 'captureAtMs'>[],
  algorithmVersion = GALLERY_IMPORT_ALGORITHM_VERSION,
): string {
  const canonical = assets
    .slice()
    .sort((left, right) => left.captureAtMs - right.captureAtMs || left.osAssetId.localeCompare(right.osAssetId))
    .map((asset) => `${asset.osAssetId}\u001f${asset.captureAtMs}`)
    .join('\u001e');
  return galleryImportSha256Hex(`${algorithmVersion}\u001d${canonical}`);
}

/** Per-asset opaque digest; raw library ids are never returned or transmitted. */
export function createGalleryAssetFingerprint(
  asset: Pick<LocalGalleryAsset, 'osAssetId' | 'captureAtMs'>,
  algorithmVersion = GALLERY_IMPORT_ALGORITHM_VERSION,
): string {
  return galleryImportSha256Hex(`${algorithmVersion}\u001casset\u001d${asset.osAssetId}\u001f${asset.captureAtMs}`);
}

function spreadAssets(assets: LocalGalleryAsset[], count: number): LocalGalleryAsset[] {
  if (count >= assets.length) return assets.slice();
  if (count <= 0) return [];
  if (count === 1) return [assets[0]];
  return Array.from({ length: count }, (_, index) => (
    assets[Math.floor((index * (assets.length - 1)) / (count - 1))]
  ));
}

function capClusterAssets(assets: LocalGalleryAsset[], maximum: number): LocalGalleryAsset[] {
  if (assets.length <= maximum) return assets;
  const favorites = assets.filter((asset) => asset.isFavorite);
  const nonFavorites = assets.filter((asset) => !asset.isFavorite);
  const favoriteSlots = Math.min(favorites.length, maximum);
  const selected = new Set([
    ...spreadAssets(favorites, favoriteSlots),
    ...spreadAssets(nonFavorites, maximum - favoriteSlots),
  ]);
  // Preserve the original deterministic newest-first order after representative
  // selection. Favorites are retained whenever the cap leaves a slot for them.
  return assets.filter((asset) => selected.has(asset));
}

export function clusterGalleryAssets(
  assets: LocalGalleryAsset[],
  options: Pick<GalleryScanOptions, 'clusterGapMs' | 'maxAssetsPerCluster' | 'maxClusters'> = {},
): GalleryCluster[] {
  const clusterGapMs = options.clusterGapMs ?? GALLERY_IMPORT_CLUSTER_GAP_MS;
  const maxAssets = options.maxAssetsPerCluster ?? GALLERY_IMPORT_MAX_ASSETS_PER_CLUSTER;
  const maxClusters = options.maxClusters ?? GALLERY_IMPORT_MAX_CLUSTERS_PER_RUN;
  const sorted = assets.slice().sort((left, right) => right.captureAtMs - left.captureAtMs || left.osAssetId.localeCompare(right.osAssetId));
  const groups: LocalGalleryAsset[][] = [];
  for (const asset of sorted) {
    const current = groups[groups.length - 1];
    if (!current || current[current.length - 1].captureAtMs - asset.captureAtMs > clusterGapMs) {
      groups.push([asset]);
    } else {
      current.push(asset);
    }
  }
  return groups.slice(0, maxClusters).map((group) => {
    const cappedAssets = capClusterAssets(group, maxAssets);
    return {
      algorithmVersion: GALLERY_IMPORT_ALGORITHM_VERSION,
      // Receipts key off the full event. Changing representative-cap values or
      // client presentation must not make a prior skip look like a new event.
      signature: createClusterSignature(group),
      captureAtMs: cappedAssets[0].captureAtMs,
      assets: cappedAssets,
    };
  });
}

export async function scanGallerySnapshot(
  adapter: GalleryMediaLibraryAdapter,
  options: GalleryScanOptions = {},
): Promise<GalleryScanSnapshot> {
  const permission = getGalleryPhotoPermissionState(await adapter.getPermission());
  if (permission === 'denied' || permission === 'blocked') {
    throw new Error(`Photo permission is ${permission}.`);
  }

  const nowMs = options.nowMs ?? Date.now();
  const pageSize = options.pageSize ?? GALLERY_IMPORT_SCAN_PAGE_SIZE;
  const maxEnumeratedAssets = options.maxEnumeratedAssets ?? GALLERY_IMPORT_MAX_ENUMERATED_ASSETS;
  const createToken = options.createToken ?? defaultCreateToken;
  let offset = 0;
  let enumeratedAssetCount = 0;
  let rejectedAssetCount = 0;
  let wasTruncated = false;
  const scannedAssets: LocalGalleryAsset[] = [];

  while (true) {
    const remaining = maxEnumeratedAssets - enumeratedAssetCount;
    if (remaining <= 0) {
      wasTruncated = true;
      break;
    }
    const page = await adapter.getPhotoPage({ offset, limit: Math.min(pageSize, remaining) });
    if (page.length === 0) break;
    offset += page.length;
    enumeratedAssetCount += page.length;
    for (const asset of page) {
      if (!isPlausibleCaptureTime(asset.creationTime, nowMs)) {
        rejectedAssetCount += 1;
        continue;
      }
      scannedAssets.push({
        assetToken: createToken(),
        osAssetId: asset.id,
        captureAtMs: asset.creationTime,
        width: asset.width,
        height: asset.height,
        isFavorite: asset.isFavorite,
      });
    }
    options.onPage?.({ scannedAssetCount: scannedAssets.length, rejectedAssetCount });
    await options.yieldToEventLoop?.();
    if (page.length < Math.min(pageSize, remaining)) break;
  }

  return {
    permission,
    clusters: clusterGalleryAssets(scannedAssets, options),
    scannedAssetCount: scannedAssets.length,
    rejectedAssetCount,
    wasTruncated,
  };
}
