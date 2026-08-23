// Pure math and data helpers behind the gallery-import review deck
// (design: gi-review.jsx useSwipeCard/SwipeIntent + gi-notes.jsx "The swipe").
// Everything here is a plain function so gesture thresholds, rest-point
// cadence, and day-pool reconstruction stay unit-testable without mounting
// the gesture handler or the animation runtime. The 'worklet' directives let
// the same functions run inside react-native-gesture-handler callbacks.
import { GALLERY_IMPORT_CLUSTER_GAP_MS } from '@/constants/gallery-import';
import type { GalleryImportCheckpoint, GalleryImportCheckpointAsset } from '@/utils/gallery-import-checkpoint';
import type { GalleryImportFrontier } from '@/utils/gallery-import-frontier';
import type { GalleryImportRun } from '@/services/gallery-import';

/**
 * Clusters sitting in LOCAL checkpoint chunks that have not been dispatched
 * yet -- a description of this device's own upload plan, not of what the
 * server has actually received or resolved. Kept for what it was always
 * good at (gallery-import-runner.ts's own resume bookkeeping and tests
 * verify a 'failed' chunk is treated the same as 'dispatched', never as
 * still-forthcoming), but round 4 moved every UI-facing "+N coming" surface
 * (the review deck, and the progress screen's ready-stage copy) off this
 * function entirely: a resume leaves this local plan stale in exactly the
 * way that produced a device-observed phantom "+51 coming" that persisted
 * all day. Those surfaces now read `deriveGalleryImportComingIndicator`
 * below, driven by the server's own pending-cluster count. Do not wire this
 * back into anything the user looks at.
 */
export function galleryImportStillComingCount(
  chunks: GalleryImportCheckpoint['chunks'] | undefined,
): number {
  return (chunks ?? []).reduce(
    // 'abandoned' (continuous model, 2026-08-23) is as terminal as
    // 'dispatched' for this legacy local-plan count -- it will never be
    // retried again, so it must never read as still forthcoming either.
    (count, chunk) => (chunk.status === 'dispatched' || chunk.status === 'failed' || chunk.status === 'abandoned' ? count : count + chunk.clusters.length),
    0,
  );
}

/** Run statuses nothing further will ever happen to. */
const GALLERY_IMPORT_TERMINAL_RUN_STATUSES: ReadonlySet<GalleryImportRun['status']> = new Set([
  'completed', 'cancelled', 'expired', 'failed',
]);

export function isGalleryImportRunTerminal(status: GalleryImportRun['status'] | null | undefined): boolean {
  return Boolean(status) && GALLERY_IMPORT_TERMINAL_RUN_STATUSES.has(status as GalleryImportRun['status']);
}

/**
 * "+N coming" / "more on the way", driven by SERVER truth (round 4) instead
 * of the client's own local upload plan -- a resume, a stall, or a flaky
 * connection all leave the local plan stale (device-observed: a real run
 * planned ~16 chunks/61 clusters locally while the server had only 4 chunks
 * completed and was slowly gaining more; the old local count showed a
 * phantom "+51 coming" that never moved).
 *
 * Continuous model (S9, 2026-08-23): "coming" is now server pending +
 * locally planned/failed (retryable, not yet abandoned) clusters +
 * `moreHistory` (the frontier has not proven the library is fully covered,
 * and `autoContinue` has not been turned off). A deck/progress screen is
 * never honestly "done" while any of these hold, even if the server's own
 * pendingClusters count happens to read zero right now.
 *
 * - `'none'`: nothing more is coming -- the run is genuinely terminal. This
 *   is the only state that makes "done"/completing the run honest.
 * - `'count'`: a real, addable number is known (server pending + local
 *   planned/failed clusters) -- show it. `moreHistory` may still be true
 *   alongside a `count` of 0 (nothing currently pending, but the sweep has
 *   more of the library left to look through).
 * - `'unknown'`: the run has not finished scanning/registering its first
 *   window yet ('scanning'/'processing', or `run` has not loaded), or the
 *   server could not compute its own pending count this time AND there is no
 *   local count to fall back on -- more is coming, but not a trustworthy
 *   number. Show qualitative copy ("more on the way"), never a guessed digit.
 *
 * `moreHistory` is required on the non-`'none'` variants (tightened
 * 2026-08-23 once every production caller -- the review deck, the progress
 * screen, and `useGalleryImportEntryStatus` -- passed `checkpoint`/`frontier`
 * through to this function, per docs/plans/gallery-import-continuous.md I4a):
 * every branch below always sets it explicitly, so there is no longer a
 * legitimate way to construct this type without deciding the value.
 */
export type GalleryImportComingIndicator =
  | { kind: 'none' }
  | { kind: 'count'; count: number; moreHistory: boolean }
  | { kind: 'unknown'; moreHistory: boolean };

/** Clusters in local chunks that will still be attempted -- planned, or
 * failed but not yet exhausted (abandoned chunks are terminal, like
 * dispatched ones, and contribute nothing here). Distinct from the legacy
 * `galleryImportStillComingCount` above only in name/intent: this is the
 * one S9 wires into user-facing "+N coming" surfaces. */
function localRetryableClusterCount(chunks: GalleryImportCheckpoint['chunks'] | undefined): number {
  return (chunks ?? []).reduce(
    (count, chunk) => (chunk.status === 'dispatched' || chunk.status === 'abandoned' ? count : count + chunk.clusters.length),
    0,
  );
}

export function deriveGalleryImportComingIndicator(
  run: Pick<GalleryImportRun, 'status' | 'pendingClusters'> | null | undefined,
  checkpoint?: Pick<GalleryImportCheckpoint, 'chunks'> | null,
  frontier?: Pick<GalleryImportFrontier, 'completedLibrary' | 'autoContinue'> | null,
): GalleryImportComingIndicator {
  const moreHistory = Boolean(frontier) && frontier!.completedLibrary !== true && frontier!.autoContinue !== false;
  if (!run) return { kind: 'unknown', moreHistory };
  if (isGalleryImportRunTerminal(run.status)) return { kind: 'none' };
  const localCount = localRetryableClusterCount(checkpoint?.chunks);
  // Still scanning/registering the run's very first window server-side: more
  // is coming by definition, and a pending-cluster count from before the
  // first chunk even landed would be misleadingly small.
  if (run.status !== 'reviewing') return { kind: 'unknown', moreHistory };
  const pending = run.pendingClusters;
  if (typeof pending === 'number' && Number.isFinite(pending)) {
    const total = pending + localCount;
    if (total > 0) return { kind: 'count', count: total, moreHistory };
    return moreHistory ? { kind: 'count', count: 0, moreHistory } : { kind: 'none' };
  }
  if (localCount > 0) return { kind: 'count', count: localCount, moreHistory };
  return { kind: 'unknown', moreHistory };
}

// gi-notes.jsx: "Commit threshold 92px or a fling over 0.6 px/ms."
export const GALLERY_DECK_COMMIT_THRESHOLD_PX = 92;
export const GALLERY_DECK_COMMIT_VELOCITY_PX_PER_MS = 0.6;
// gi-notes.jsx: "Intent stamps appear from 26px of travel, opacity tracking
// distance" -- gi-review.jsx ramps strength over 110px.
export const GALLERY_DECK_INTENT_THRESHOLD_PX = 26;
export const GALLERY_DECK_INTENT_FULL_PX = 110;
// gi-notes.jsx: "Rotation is dx ÷ 28, capped at 8°."
export const GALLERY_DECK_ROTATION_DIVISOR = 28;
export const GALLERY_DECK_MAX_ROTATION_DEG = 8;
// gi-notes.jsx: "Exit: 240ms translate to ±460px with an 8° rotation and no
// fade." Below-threshold return is 260ms. Reduced motion cross-fades ~120ms
// and the prototype fires the callback at 90ms.
export const GALLERY_DECK_EXIT_DISTANCE_PX = 460;
export const GALLERY_DECK_EXIT_DURATION_MS = 240;
export const GALLERY_DECK_RETURN_DURATION_MS = 260;
export const GALLERY_DECK_REDUCED_EXIT_DURATION_MS = 90;
// gi-review.jsx GIRestPoint: a rest point after every ~6 keeps.
export const GALLERY_DECK_REST_POINT_EVERY_KEEPS = 6;

export type GalleryDeckSwipeDirection = 'keep' | 'aside';

/** 1:1 follow with paper-like tilt: dx ÷ 28, capped at ±8°. */
export function galleryDeckRotationDeg(dx: number): number {
  'worklet';
  const raw = dx / GALLERY_DECK_ROTATION_DIVISOR;
  if (raw > GALLERY_DECK_MAX_ROTATION_DEG) return GALLERY_DECK_MAX_ROTATION_DEG;
  if (raw < -GALLERY_DECK_MAX_ROTATION_DEG) return -GALLERY_DECK_MAX_ROTATION_DEG;
  return raw;
}

/** Intent-stamp opacity: 0 until 26px of travel, then ramps to 1 by 110px. */
export function galleryDeckIntentOpacity(dx: number, side: GalleryDeckSwipeDirection): number {
  'worklet';
  const travel = side === 'keep' ? dx : -dx;
  if (travel <= GALLERY_DECK_INTENT_THRESHOLD_PX) return 0;
  const strength = travel / GALLERY_DECK_INTENT_FULL_PX;
  return strength > 1 ? 1 : strength;
}

/** Release decision: 92px of travel or a 0.6 px/ms fling in one direction. */
export function galleryDeckSwipeCommit(dx: number, velocityPxPerMs = 0): GalleryDeckSwipeDirection | null {
  'worklet';
  const overDistance = Math.abs(dx) > GALLERY_DECK_COMMIT_THRESHOLD_PX;
  const overVelocity = Math.abs(velocityPxPerMs) > GALLERY_DECK_COMMIT_VELOCITY_PX_PER_MS
    // A fling must agree with the drag direction; a flick back cancels.
    && Math.sign(velocityPxPerMs) === Math.sign(dx) && dx !== 0;
  if (!overDistance && !overVelocity) return null;
  return dx > 0 ? 'keep' : 'aside';
}

/**
 * The rest point appears after every ~6 keeps, once per milestone. The
 * acknowledgement is session-local: the deck resumes silently after a
 * relaunch because the cursor already persists.
 */
export function isGalleryDeckRestPointDue(keptCount: number, acknowledgedAtKept: number | null): boolean {
  return keptCount > 0
    && keptCount % GALLERY_DECK_REST_POINT_EVERY_KEEPS === 0
    && acknowledgedAtKept !== keptCount;
}

export interface GalleryImportDayPoolAsset {
  assetToken: string;
  /** Local-only; never pass to services, logs, or analytics. */
  osAssetId: string;
  captureAtMs: number;
  width: number | null;
  height: number | null;
}

/**
 * Reconstructs the candidate's day pool ("N photos chosen · from M photos
 * that day") from the local checkpoint. Grouping mirrors the scanner's
 * clustering rule (same gap constant, same deterministic ordering) over
 * `assetByToken`, which outlives dispatch; the per-chunk cluster manifests do
 * not. Membership is intentionally conservative:
 *
 * - Only groups containing one of the candidate's selected tokens join the
 *   pool, so an offered photo is always inside the candidate's server-side
 *   cluster (update-gallery-import-candidate re-validates it there).
 * - Only server-admitted assets are offered: preview-uploaded tokens
 *   (`uploadedAssetTokens`) plus the candidate's own selection. Assets the
 *   server rejected at registration would fail the candidate update.
 */
export function buildGalleryImportDayPool(
  checkpoint: Pick<GalleryImportCheckpoint, 'assetByToken' | 'uploadedAssetTokens'>,
  selectedAssetTokens: string[],
): GalleryImportDayPoolAsset[] {
  const selected = new Set(selectedAssetTokens);
  if (selected.size === 0) return [];
  const assets = Object.values(checkpoint.assetByToken)
    .slice()
    .sort((left, right) => right.captureAtMs - left.captureAtMs || left.osAssetId.localeCompare(right.osAssetId));
  const groups: GalleryImportCheckpointAsset[][] = [];
  for (const asset of assets) {
    const current = groups[groups.length - 1];
    if (!current || current[current.length - 1].captureAtMs - asset.captureAtMs > GALLERY_IMPORT_CLUSTER_GAP_MS) {
      groups.push([asset]);
    } else {
      current.push(asset);
    }
  }
  const admitted = new Set([...checkpoint.uploadedAssetTokens, ...selectedAssetTokens]);
  const pool = groups
    .filter((group) => group.some((asset) => selected.has(asset.assetToken)))
    .flat()
    .filter((asset) => admitted.has(asset.assetToken));
  return pool
    .sort((left, right) => left.captureAtMs - right.captureAtMs || left.osAssetId.localeCompare(right.osAssetId))
    .map(({ assetToken, osAssetId, captureAtMs, width, height }) => ({ assetToken, osAssetId, captureAtMs, width, height }));
}
