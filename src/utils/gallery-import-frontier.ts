/**
 * Persistent per-user+family progressive-deepening frontier for gallery
 * import scanning. Successive runs walk backward through the whole photo
 * library in bounded GALLERY_IMPORT_MAX_ENUMERATED_ASSETS-sized bites
 * (gallery-import-scanner.ts's scanGallerySnapshot `frontier` option)
 * instead of re-covering the same newest window forever. Mirrors
 * gallery-import-invite-dismissal.ts's per-user+family AsyncStorage scoping
 * and defensive try/catch-to-safe-default style: a storage hiccup must
 * degrade to "no frontier" (a fresh top-of-library scan next time), never
 * crash or silently corrupt state.
 *
 * Ordering key: the scanner's Query orders by AssetField.CREATION_TIME
 * descending (see createExpoGalleryMediaLibraryAdapter's getPhotoPage), and
 * every downstream consumer -- clusterGalleryAssets's gap rule,
 * createClusterSignature's hash, LocalGalleryAsset.captureAtMs -- keys off
 * that same field. This frontier is defined on captureAtMs (milliseconds,
 * i.e. expo-media-library's AssetMetadata.creationTime) for exactly that
 * reason: any other key (modificationTime, or an insertion/"date added"
 * order -- which this SDK's AssetMetadata does not even expose) would
 * silently desynchronize from what the scanner actually walks by and break
 * deepening (either re-covering the same range forever, or skipping past
 * unregistered photos).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { GalleryCorpusMode } from '@/utils/gallery-import-scanner';

const STORAGE_PREFIX = 'gallery-import-frontier';

export interface GalleryImportFrontier {
  /** The oldest captureAtMs value fully covered so far -- the boundary a
   * later run's Phase B deepens backward from. */
  oldestCoveredMs: number;
  /** The newest captureAtMs value fully covered so far -- the boundary a
   * later run's Phase A catches up forward from. */
  coveredThroughNewestMs: number;
  /** True once a scan has reached the true bottom of the photo library (its
   * oldest-going enumeration completed without being cut off by the
   * per-scan budget -- see GalleryScanSnapshot.reachedLibraryEnd). Sticky:
   * once true, a later run never clears it back to false. */
  completedLibrary: boolean;
  /**
   * The asset universe (GalleryCorpusMode) these bounds were built under --
   * Android's exact-title 'Camera' album vs. the full library. A frontier's
   * bounds are only meaningful within one corpus: "everything newer than
   * coveredThroughNewestMs has been examined" is true only for the mode
   * that examined it. If a later run resolves a DIFFERENT mode (the camera
   * album appeared/disappeared, or iOS vs. Android -- though a frontier is
   * already user+family+device-local, not cross-platform), mixing bounds
   * across modes would silently skip photos the other mode never looked at.
   * mergeGalleryImportFrontierCoverage resets (discards oldestCoveredMs/
   * coveredThroughNewestMs/completedLibrary) rather than merging across a
   * corpus-mode change; gallery-import-scanner.ts's scanGallerySnapshot
   * independently guards the same mismatch by ignoring incompatible bounds
   * before windowing a scan.
   */
  corpusMode: GalleryCorpusMode;
}

function storageKey(userId: string, familyId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${familyId}`;
}

function isFrontier(value: unknown): value is GalleryImportFrontier {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GalleryImportFrontier>;
  return typeof candidate.oldestCoveredMs === 'number' && Number.isFinite(candidate.oldestCoveredMs)
    && typeof candidate.coveredThroughNewestMs === 'number' && Number.isFinite(candidate.coveredThroughNewestMs)
    && candidate.oldestCoveredMs <= candidate.coveredThroughNewestMs
    && typeof candidate.completedLibrary === 'boolean'
    && (candidate.corpusMode === 'camera_album' || candidate.corpusMode === 'full_library_fallback');
}

export async function loadGalleryImportFrontier(userId: string, familyId: string): Promise<GalleryImportFrontier | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(userId, familyId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isFrontier(parsed) ? parsed : null;
  } catch {
    // Unreadable/corrupt storage degrades to "no frontier" -- the next scan
    // simply restarts from the newest photo. That is a resource/UX
    // regression (re-covering ground already covered), never a correctness
    // one, and never a crash.
    return null;
  }
}

export async function saveGalleryImportFrontier(userId: string, familyId: string, frontier: GalleryImportFrontier): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(userId, familyId), JSON.stringify(frontier));
  } catch {
    // Best effort -- losing this just means the next run rescans from the
    // top instead of continuing to deepen.
  }
}

export async function clearGalleryImportFrontier(userId: string, familyId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(storageKey(userId, familyId));
  } catch {
    // Best effort.
  }
}

/**
 * Pure merge: folds one run's actually-registered coverage into the
 * persisted frontier. `registeredCoverage` MUST reflect only assets that
 * made it into that run's chunked/registered manifest (i.e. after both the
 * local per-run cluster-count cap and the server's admission cap) -- never
 * raw scan bounds, which can be wider than what truly got registered and
 * would let the frontier skip past never-processed photos.
 *
 * Monotonic by construction (Math.max/Math.min against the existing
 * frontier): passing overlapping or already-covered bounds -- e.g. a
 * resumed/duplicated pass that re-registers part of an already-covered
 * range -- can only hold the frontier steady or extend it, never shrink it.
 * That is this module's contribution to "deepening tolerates overlap
 * gracefully"; true duplicate-cluster suppression is a server-side receipts
 * concern (gallery_import_cluster_receipts), out of scope here.
 *
 * `corpusMode` is THIS run's resolved mode (GalleryScanSnapshot.corpusMode).
 * When it differs from `existing.corpusMode`, `existing` is discarded
 * entirely before merging -- see GalleryImportFrontier.corpusMode for why
 * bounds from one corpus are meaningless (and unsafe to extend) under a
 * different one. The returned frontier always carries the CURRENT mode.
 */
export function mergeGalleryImportFrontierCoverage(
  existing: GalleryImportFrontier | null,
  registeredCoverage: { oldestCoveredMs: number; newestCoveredMs: number } | null,
  reachedLibraryEnd: boolean,
  corpusMode: GalleryCorpusMode,
): GalleryImportFrontier | null {
  const priorFrontier = existing && existing.corpusMode === corpusMode ? existing : null;
  if (!registeredCoverage) {
    // Nothing was registered this run (e.g. every chunk ended up empty
    // after local preview preparation failed for every asset). Only
    // completedLibrary can still legitimately move, and only onto an
    // already-existing SAME-MODE frontier -- there is nothing to anchor a
    // brand new frontier's bounds on, and a mode change with nothing
    // registered simply leaves no frontier rather than reviving a stale one.
    if (!priorFrontier) return null;
    return reachedLibraryEnd && !priorFrontier.completedLibrary ? { ...priorFrontier, completedLibrary: true } : priorFrontier;
  }
  const coveredThroughNewestMs = priorFrontier
    ? Math.max(priorFrontier.coveredThroughNewestMs, registeredCoverage.newestCoveredMs)
    : registeredCoverage.newestCoveredMs;
  const oldestCoveredMs = priorFrontier
    ? Math.min(priorFrontier.oldestCoveredMs, registeredCoverage.oldestCoveredMs)
    : registeredCoverage.oldestCoveredMs;
  const completedLibrary = Boolean(priorFrontier?.completedLibrary) || reachedLibraryEnd;
  return { coveredThroughNewestMs, oldestCoveredMs, completedLibrary, corpusMode };
}
