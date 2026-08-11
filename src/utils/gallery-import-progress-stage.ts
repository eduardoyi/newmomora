// Pure "what should the progress screen show right now" derivation --
// deliberately side-effect free (no network, no AsyncStorage, no React) so
// every branch is cheap to unit test in isolation. gallery-import-progress.tsx
// owns copy/rendering; this file only decides which of the design's eleven
// GI_STAGE stages (gi-progress.jsx), which exception screen (gi-states.jsx),
// or which empty outcome (gi-entry.jsx GIOutcomeEmpty) applies, using only
// data this app can actually observe -- see docs/design/gallery-import/README.md
// and the fix plan's "verified findings" for why some designed distinctions
// (e.g. lapsed vs capped vs an already-active run, all server code
// `not_available`) can't be told apart from an HTTP error code alone.
import type { GalleryImportRun } from '@/services/gallery-import';
import type { GalleryImportRunnerProgress } from '@/services/gallery-import-runner';

export type GalleryImportStageKey =
  | 'scanning'
  | 'preparing'
  | 'waitingWifi'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'paused'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** The subset of gi-states.jsx GI_STATES this screen can reach. `wrongDevice`
 * is handled before a checkpoint/run even exists (see DeviceBoundNotice in
 * gallery-import-shared.tsx) so it is intentionally not part of this union.
 * `removed` (full family-membership loss) is also excluded: a checkpoint only
 * loads here when its stored familyId matches the *active* family
 * (useRunCheckpoint looks it up by that key), and having a resolved active
 * familyId already guarantees membership -- so "removed from this run's
 * family" can never be distinguished from "wrong device" by the time this
 * function runs. That case renders the restyled DeviceBoundNotice instead. */
export type GalleryImportExceptionKind =
  | 'lapsed'
  | 'demoted'
  | 'offline'
  | 'errorRecoverable'
  | 'errorFinal';

export type GalleryImportEmptyKind = 'nothing' | 'limitedNothing';

export type GalleryImportProgressOutcome =
  | {
    kind: 'stage';
    stage: GalleryImportStageKey;
    /** Ready-to-review candidate count, when known (0 when not yet known). */
    ready: number;
    /** A real completed/total pair once one is known; both null while indeterminate. */
    value: number | null;
    total: number | null;
    scannedAssetCount: number | null;
  }
  | { kind: 'exception'; exception: GalleryImportExceptionKind }
  | { kind: 'empty'; empty: GalleryImportEmptyKind };

export interface GalleryImportProgressStageInput {
  /** Local checkpoint status. 'paused' means this screen previously recorded
   * a Wi-Fi wait (see the cellular-confirm sheet wiring in
   * gallery-import-progress.tsx) -- it is not set anywhere else. */
  checkpointStatus: 'scanning' | 'processing' | 'reviewing' | 'paused';
  deckCursor: number;
  serverStatus: GalleryImportRun['status'] | null;
  readyCount: number;
  /** Family billing status; null while not yet loaded (never treated as lapsed). */
  hasWriteAccess: boolean | null;
  /** True when the user still belongs to the family but can no longer edit it
   * (role dropped below manager after the run started). */
  isDemoted: boolean;
  isOffline: boolean;
  /** The runner's live in-session progress (see gallery-import-live-progress.ts),
   * when this device is the one actively running scan/prepare/upload/dispatch. */
  live: GalleryImportRunnerProgress | null;
  /** True while a resume attempt (after relaunch) is in flight. */
  isResuming: boolean;
  /** Captured at run creation (see toCheckpoint's permissionMode field);
   * absent for checkpoints saved before that field existed. */
  permissionMode: 'full' | 'limited' | null;
  /** A resume/refresh attempt failed with a transient (non-server-declared)
   * error, e.g. a network request threw. Distinct from the server explicitly
   * reporting the run status as 'failed'. */
  hasTransientError: boolean;
}

export function deriveGalleryImportProgressOutcome(input: GalleryImportProgressStageInput): GalleryImportProgressOutcome {
  // Distinguishable, high-confidence signals come first -- each is checked
  // directly against real client state, never guessed from an ambiguous
  // server error code.
  if (input.hasWriteAccess === false) return { kind: 'exception', exception: 'lapsed' };
  if (input.isDemoted) return { kind: 'exception', exception: 'demoted' };
  if (input.checkpointStatus === 'paused') {
    return { kind: 'stage', stage: 'waitingWifi', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }
  if (input.isOffline) return { kind: 'exception', exception: 'offline' };

  // A server-confirmed post-dispatch status is authoritative and must be
  // checked *before* `live` -- once the runner's last published event for
  // this run/session was 'dispatching' (the final chunk going out), `live`
  // never changes again (see gallery-import-live-progress.ts: it is a
  // retained last-value snapshot, not cleared on completion). Checking
  // `live?.stage === 'dispatching'` first, as an earlier version of this
  // function did, permanently pinned the screen on the 'processing' stage
  // even after the poll below (gallery-import-progress.tsx's refreshStatus)
  // correctly observed the server move to 'reviewing' -- confirmed on device
  // with a 306-photo run that reached 'reviewing' server-side (10/10 chunks,
  // 60 candidates staged) while the screen stayed on "Writing the drafts"
  // indefinitely. `live`'s scanning/preparing/uploading/dispatching detail is
  // only meaningful while the server hasn't yet confirmed what came after.
  if (input.serverStatus === 'expired') {
    return { kind: 'stage', stage: 'expired', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }
  if (input.serverStatus === 'cancelled') {
    return { kind: 'stage', stage: 'cancelled', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }
  if (input.serverStatus === 'failed') {
    if (input.readyCount > 0) {
      return { kind: 'stage', stage: 'failed', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
    }
    return { kind: 'exception', exception: 'errorFinal' };
  }
  if (input.serverStatus === 'reviewing') {
    if (input.readyCount === 0 && input.deckCursor === 0) {
      return { kind: 'empty', empty: input.permissionMode === 'limited' ? 'limitedNothing' : 'nothing' };
    }
    if (input.readyCount === 0) {
      // Everything staged so far has been reviewed while the run is still
      // non-terminal -- drafts are (or may be) still being written. Showing
      // the 'ready' stage here produced "FIRST MOMENTS ARE READY / 0
      // moments, ready for you." on device. 'processing' is the honest
      // stage; the poll flips it to 'ready' the moment a new candidate
      // lands, and the deck's own done state owns the true all-caught-up
      // ending once the run completes.
      return { kind: 'stage', stage: 'processing', ready: 0, value: null, total: null, scannedAssetCount: null };
    }
    return { kind: 'stage', stage: 'ready', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }
  if (input.serverStatus === 'completed') {
    return { kind: 'stage', stage: 'ready', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }

  // Below here the server has not yet confirmed a post-dispatch status
  // (still 'scanning'/'processing', or no poll result has landed yet) --
  // `live` gives finer-grained detail than the server's own coarse status
  // while that remains true.
  const live = input.live;
  if (live?.stage === 'scanning') {
    return { kind: 'stage', stage: 'scanning', ready: input.readyCount, value: null, total: null, scannedAssetCount: live.scannedAssetCount ?? live.completed };
  }
  if (live?.stage === 'preparing') {
    return { kind: 'stage', stage: 'preparing', ready: input.readyCount, value: live.completed, total: live.total, scannedAssetCount: null };
  }
  if (live?.stage === 'uploading') {
    return { kind: 'stage', stage: 'uploading', ready: input.readyCount, value: live.completed, total: live.total, scannedAssetCount: null };
  }
  if (live?.stage === 'dispatching') {
    return { kind: 'stage', stage: 'processing', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }

  if (input.hasTransientError) return { kind: 'exception', exception: 'errorRecoverable' };

  // 'scanning' | 'processing' server status, or no poll result yet: the
  // server-side chunk pipeline is running. A resume that already banked ready
  // candidates before this relaunch reads as "picked up again", not a plain
  // indeterminate wait.
  if (input.isResuming && input.readyCount > 0) {
    return { kind: 'stage', stage: 'interrupted', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
  }
  return { kind: 'stage', stage: 'processing', ready: input.readyCount, value: null, total: null, scannedAssetCount: null };
}
