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

/**
 * Which asset universe a scan pass drew from. `'camera_album'`: Android,
 * scoped to the exact-title 'Camera' album (device captures only, per the
 * 2026-08-11 product decision -- WhatsApp/iMessage/downloads saves are
 * excluded). `'full_library_fallback'`: no camera album resolved (or
 * album-scoped querying isn't available), OR this is iOS, which has no
 * camera-source signal at all and always uses the broader library (a saved
 * WhatsApp photo only enters the iOS library if the user explicitly saved
 * it, which is an explicit action, not an automatic sync) -- both cases
 * share this one value because both mean "not camera-scoped this pass", and
 * gallery-import-frontier.ts resets rather than mixes coverage across a
 * corpus-mode change.
 */
export type GalleryCorpusMode = 'camera_album' | 'full_library_fallback';

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
  /**
   * True only when the platform positively reports a screenshot subtype
   * (iOS `PHAssetMediaSubtype.screenshot`). Leave `undefined` when the
   * platform has no reliable signal (Android) rather than guessing from a
   * filename or dimensions — an omitted field admits the asset.
   */
  isScreenshot?: boolean;
}

export interface GalleryMediaLibraryAdapter {
  getPermission: () => Promise<GalleryPhotoPermission>;
  requestPermission: () => Promise<GalleryPhotoPermission>;
  presentPermissionPicker?: () => Promise<void>;
  /**
   * Resolved ONCE, at scan start, before any `getPhotoPage` call -- see
   * `scanGallerySnapshot`. The real adapter resolves (and caches) the
   * Android exact-title 'Camera' album here and scopes every subsequent
   * `getPhotoPage` call to it; iOS omits this method entirely (it never
   * attempts camera-scoping, see `GalleryCorpusMode`). Optional so a
   * hand-built test adapter that never implements it defaults to
   * `'full_library_fallback'` inside `scanGallerySnapshot`.
   */
  resolveCorpus?: () => Promise<{ mode: GalleryCorpusMode }>;
  /**
   * `newerThanMs`/`olderThanMs` bound the query by `creationTime` (exclusive)
   * for progressive-deepening's two-phase windowed scan -- see
   * `scanGallerySnapshot`'s `frontier` option. Omit both for an unbounded
   * newest-first page, exactly as before deepening existed.
   */
  getPhotoPage: (input: { offset: number; limit: number; newerThanMs?: number; olderThanMs?: number }) => Promise<GalleryPhotoMetadata[]>;
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
  /** True when the bounded corpus may omit newer-since-last-run or deeper-
   * than-frontier photos this pass could not reach. */
  wasTruncated: boolean;
  /**
   * True when this pass's oldest-going enumeration -- the only direction on
   * a fresh (no-frontier) scan, or Phase B's deepening walk when a frontier
   * is supplied -- ran to natural completion (fewer results than requested,
   * i.e. no more remain) rather than being cut off by the enumeration
   * budget. False (conservatively) when that direction never got to run at
   * all, e.g. Phase A alone consumed the whole budget. Progressive
   * deepening (gallery-import-frontier.ts) uses this, independent of any
   * per-run cluster/asset admission cap, to know whether the device-level
   * photo library's true oldest end has been reached.
   */
  reachedLibraryEnd: boolean;
  /** Which asset universe this pass actually drew from -- see GalleryCorpusMode. */
  corpusMode: GalleryCorpusMode;
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
  /**
   * Progressive-deepening continuation point from a prior run (see
   * gallery-import-frontier.ts). Omitted/null means a fresh top-of-corpus
   * newest-first scan, exactly as before deepening existed. When supplied,
   * Phase A first catches up on anything newer than `coveredThroughNewestMs`,
   * then Phase B spends the rest of `maxEnumeratedAssets` deepening backward
   * from `oldestCoveredMs` -- the already-covered range between the two
   * bounds is never re-walked.
   *
   * `corpusMode` records which universe those bounds were built under. This
   * pass resolves its OWN corpus mode first (see `resolveCorpus`); if it
   * differs from `frontier.corpusMode` (e.g. the Android camera album
   * appeared/disappeared between runs), the bounds are ignored and this
   * pass scans fresh from the top under its own mode instead -- mixing
   * coverage across corpora would silently skip photos that were never
   * actually examined under the other mode.
   */
  frontier?: { coveredThroughNewestMs: number; oldestCoveredMs: number; corpusMode: GalleryCorpusMode } | null;
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

  // Resolved once per adapter instance (== once per scan pass, since a
  // fresh adapter is created per run/resume call) and reused by every
  // getPhotoPage call. `undefined` = not yet resolved; `null` = resolved to
  // "no camera album" (or resolution failed) -- both mean unscoped queries.
  let cameraAlbum: MediaLibrary.Album | null | undefined;

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
    // iOS omits this entirely -- see GalleryCorpusMode -- so the adapter
    // object itself never carries the key there, and scanGallerySnapshot's
    // `adapter.resolveCorpus?.() ?? full_library_fallback` applies.
    resolveCorpus: Platform.OS === 'android' ? async () => {
      if (cameraAlbum === undefined) {
        try {
          // Camera captures land in the DCIM "Camera" bucket as a de-facto
          // standard across OEMs; exact-title match only in v1 (rare OEM
          // variants that split capture buckets across multiple album
          // titles are not handled here). A title match is the SDK's only
          // lookup surface -- it cannot distinguish the true DCIM/Camera
          // bucket from an unrelated user-created album also titled
          // "Camera", a known limitation of this approach.
          cameraAlbum = await MediaLibrary.Album.get('Camera');
        } catch {
          // Missing/incompatible album API on this device/SDK build --
          // degrade to the full-library fallback rather than throwing.
          cameraAlbum = null;
        }
      }
      return { mode: cameraAlbum ? 'camera_album' as const : 'full_library_fallback' as const };
    } : undefined,
    getPhotoPage: async ({ offset, limit, newerThanMs, olderThanMs }) => {
      let query = new MediaLibrary.Query()
        .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.IMAGE);
      // Camera-captures-only corpus (2026-08-11 product decision): once
      // resolveCorpus has found the Camera album, every page is scoped to
      // it -- WhatsApp/iMessage/downloads saves elsewhere in the library
      // are excluded on Android. Unresolved/not-found degrades to an
      // unscoped (full-library) query, exactly like before this existed.
      if (cameraAlbum) query = query.album(cameraAlbum);
      // Progressive deepening's two disjoint windows: query the native store
      // directly by creationTime rather than paging through (and discarding)
      // the already-covered middle range client-side.
      if (typeof newerThanMs === 'number') query = query.gt(MediaLibrary.AssetField.CREATION_TIME, newerThanMs);
      if (typeof olderThanMs === 'number') query = query.lt(MediaLibrary.AssetField.CREATION_TIME, olderThanMs);
      const metadata = await query
        .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
        .offset(offset)
        .limit(limit)
        .exeForMetadata();

      // Do not add filename, URI, EXIF, or location here. The new SDK API lets
      // enumeration remain metadata-only and avoids decoding local image bytes.
      // mediaSubtypes is the one sanctioned exception: this SDK exposes it only
      // per asset (there is no batch metadata field for it), so it is read here
      // with one native call per asset and per-asset failure isolation. Android
      // has no subtype signal in this SDK; those assets admit conservatively
      // (isScreenshot left undefined, no filtering) rather than guessing.
      const isScreenshot = Platform.OS === 'ios'
        ? await Promise.all(metadata.map(async (asset) => {
          try {
            const subtypes = await new MediaLibrary.Asset(asset.id).getMediaSubtypes();
            return subtypes.includes(MediaLibrary.MediaSubtype.SCREENSHOT);
          } catch {
            return false;
          }
        }))
        : null;

      return metadata.map((asset, index) => ({
        id: asset.id,
        creationTime: asset.creationTime,
        width: asset.width,
        height: asset.height,
        isFavorite: asset.isFavorite,
        isScreenshot: isScreenshot?.[index],
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

interface ScanWindowResult {
  assets: LocalGalleryAsset[];
  rejectedCount: number;
  enumeratedCount: number;
  /** True iff this window was cut off by its budget (more may remain). */
  wasTruncated: boolean;
}

async function scanWindow(
  adapter: GalleryMediaLibraryAdapter,
  input: {
    pageSize: number;
    budget: number;
    nowMs: number;
    createToken: () => string;
    newerThanMs?: number;
    olderThanMs?: number;
    onPage?: GalleryScanOptions['onPage'];
    yieldToEventLoop?: GalleryScanOptions['yieldToEventLoop'];
    /** For onPage's running totals across a prior window in the same pass. */
    scannedSoFar: number;
    rejectedSoFar: number;
  },
): Promise<ScanWindowResult> {
  let offset = 0;
  let enumeratedCount = 0;
  let rejectedCount = 0;
  let wasTruncated = false;
  const assets: LocalGalleryAsset[] = [];

  while (true) {
    const remaining = input.budget - enumeratedCount;
    if (remaining <= 0) {
      wasTruncated = true;
      break;
    }
    const page = await adapter.getPhotoPage({
      offset, limit: Math.min(input.pageSize, remaining),
      newerThanMs: input.newerThanMs, olderThanMs: input.olderThanMs,
    });
    if (page.length === 0) break;
    offset += page.length;
    enumeratedCount += page.length;
    for (const asset of page) {
      if (!isPlausibleCaptureTime(asset.creationTime, input.nowMs)) {
        rejectedCount += 1;
        continue;
      }
      if (asset.isScreenshot) {
        rejectedCount += 1;
        continue;
      }
      assets.push({
        assetToken: input.createToken(),
        osAssetId: asset.id,
        captureAtMs: asset.creationTime,
        width: asset.width,
        height: asset.height,
        isFavorite: asset.isFavorite,
      });
    }
    input.onPage?.({ scannedAssetCount: input.scannedSoFar + assets.length, rejectedAssetCount: input.rejectedSoFar + rejectedCount });
    await input.yieldToEventLoop?.();
    if (page.length < Math.min(input.pageSize, remaining)) break;
  }

  return { assets, rejectedCount, enumeratedCount, wasTruncated };
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

  // Resolve which corpus this pass draws from BEFORE deciding whether the
  // supplied frontier's bounds are usable -- they were built under whatever
  // mode a PRIOR run resolved, which may not match this one (the Android
  // camera album can appear/disappear between runs). A mismatch means the
  // already-covered range those bounds describe was never actually walked
  // under this pass's mode, so treat it exactly like no frontier: a fresh
  // top-of-corpus scan. gallery-import-frontier.ts is what actually resets
  // the persisted record once it sees this pass's corpusMode differ.
  const corpusMode = (await adapter.resolveCorpus?.())?.mode ?? 'full_library_fallback';
  const suppliedFrontier = options.frontier ?? null;
  const frontier = suppliedFrontier && suppliedFrontier.corpusMode === corpusMode ? suppliedFrontier : null;

  const scannedAssets: LocalGalleryAsset[] = [];
  let rejectedAssetCount = 0;
  let wasTruncated = false;
  // Whether the oldest-going direction (Phase B, or the single fresh-scan
  // pass) ran to completion this call -- see GalleryScanSnapshot.reachedLibraryEnd.
  let reachedLibraryEnd = false;

  if (frontier) {
    // Phase A: catch up on anything newer than what a prior run already
    // covered. This never re-walks the already-covered middle range.
    const phaseA = await scanWindow(adapter, {
      pageSize, budget: maxEnumeratedAssets, nowMs, createToken,
      newerThanMs: frontier.coveredThroughNewestMs,
      onPage: options.onPage, yieldToEventLoop: options.yieldToEventLoop,
      scannedSoFar: 0, rejectedSoFar: 0,
    });
    scannedAssets.push(...phaseA.assets);
    rejectedAssetCount += phaseA.rejectedCount;
    const remainingBudget = maxEnumeratedAssets - phaseA.enumeratedCount;
    if (remainingBudget > 0) {
      // Phase B: deepen backward from the stored frontier with whatever
      // budget Phase A left.
      const phaseB = await scanWindow(adapter, {
        pageSize, budget: remainingBudget, nowMs, createToken,
        olderThanMs: frontier.oldestCoveredMs,
        onPage: options.onPage, yieldToEventLoop: options.yieldToEventLoop,
        scannedSoFar: scannedAssets.length, rejectedSoFar: rejectedAssetCount,
      });
      scannedAssets.push(...phaseB.assets);
      rejectedAssetCount += phaseB.rejectedCount;
      if (phaseA.wasTruncated || phaseB.wasTruncated) wasTruncated = true;
      reachedLibraryEnd = !phaseB.wasTruncated;
    } else {
      // Phase A alone consumed this run's whole budget; Phase B never ran,
      // so this pass proves nothing about whether the library's oldest end
      // has been reached.
      wasTruncated = true;
      reachedLibraryEnd = false;
    }
  } else {
    const single = await scanWindow(adapter, {
      pageSize, budget: maxEnumeratedAssets, nowMs, createToken,
      onPage: options.onPage, yieldToEventLoop: options.yieldToEventLoop,
      scannedSoFar: 0, rejectedSoFar: 0,
    });
    scannedAssets.push(...single.assets);
    rejectedAssetCount += single.rejectedCount;
    wasTruncated = single.wasTruncated;
    reachedLibraryEnd = !single.wasTruncated;
  }

  return {
    permission,
    clusters: clusterGalleryAssets(scannedAssets, options),
    scannedAssetCount: scannedAssets.length,
    rejectedAssetCount,
    wasTruncated,
    reachedLibraryEnd,
    corpusMode,
  };
}
