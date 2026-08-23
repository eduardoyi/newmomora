// Derives the Timeline entry point's glyph/drawer state from local checkpoint
// + server run status. Pure and side-effect free so it's cheap to unit test
// independently of the network/AsyncStorage plumbing in useGalleryImport.ts.
//
// design source: gi-entry.jsx GIImportButton/GIImportDrawer (state: none |
// processing | ready | resume | attention | expiring).
import type { GalleryImportRun } from '@/services/gallery-import';
import type { GalleryImportCheckpoint } from '@/utils/gallery-import-checkpoint';

export type GalleryImportEntryState = 'none' | 'processing' | 'ready' | 'resume' | 'attention' | 'expiring';

/** Which real condition produced `attention` -- the design has one visual
 * state for both, but the drawer's copy needs to tell a user "get on Wi-Fi"
 * apart from "something went wrong, see options". */
export type GalleryImportAttentionReason = 'waiting_for_wifi' | 'run_failed' | null;

// The design's own numbers (an "18" candidate ceiling, "4 days left") are
// fixture data, not production constants (docs/design/gallery-import/README.md
// "Run ceilings are server-provided"). This threshold is the one number that
// IS a local UI decision: how close to the server-provided `reviewExpiresAt`
// counts as "ending soon" for the purposes of which icon/dot to show. It does
// not change when suggestions actually clear.
export const GALLERY_IMPORT_EXPIRING_SOON_DAYS = 4;

export interface GalleryImportEntryStatus {
  state: GalleryImportEntryState;
  attentionReason: GalleryImportAttentionReason;
  /** Whole days until `run.reviewExpiresAt`, rounded up. Null when unknown/not reviewing. */
  reviewDaysLeft: number | null;
  /** Continuous model (S9, 2026-08-23): the server's own `readyCandidates`
   * count, always exposed (0 when unknown/not reviewing/no run) so the
   * activity bell and Settings status row (I4a) can show a real number
   * without re-deriving it from `run` themselves. Distinct from `state`,
   * which folds this into a coarser 'ready'/'resume'/'processing' bucket. */
  readyCount: number;
}

function daysUntil(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - now.getTime()) / (24 * 60 * 60 * 1000));
}

export function deriveGalleryImportEntryStatus(
  checkpoint: GalleryImportCheckpoint | null,
  run: GalleryImportRun | null,
  now: Date = new Date(),
): GalleryImportEntryStatus {
  if (!checkpoint) {
    return { state: 'none', attentionReason: null, reviewDaysLeft: null, readyCount: 0 };
  }

  // Local-only condition: the runner paused itself waiting for Wi-Fi (see
  // GalleryImportWaitingForWifiError in gallery-import-runner.ts). The server
  // has no idea this happened, so this check must come before consulting
  // `run` at all.
  if (checkpoint.status === 'paused') {
    return { state: 'attention', attentionReason: 'waiting_for_wifi', reviewDaysLeft: null, readyCount: 0 };
  }

  // No server run reachable for this checkpoint (never started, or the
  // server has already forgotten it) -- normal state, not an error
  // (getGalleryImportRun's allowEmptyData contract).
  if (!run) {
    return { state: 'none', attentionReason: null, reviewDaysLeft: null, readyCount: 0 };
  }

  if (run.status === 'failed') {
    return { state: 'attention', attentionReason: 'run_failed', reviewDaysLeft: null, readyCount: run.readyCandidates ?? 0 };
  }

  if (run.status === 'scanning' || run.status === 'processing') {
    return { state: 'processing', attentionReason: null, reviewDaysLeft: null, readyCount: run.readyCandidates ?? 0 };
  }

  if (run.status === 'reviewing') {
    const reviewDaysLeft = daysUntil(run.reviewExpiresAt, now);
    if (reviewDaysLeft !== null && reviewDaysLeft <= GALLERY_IMPORT_EXPIRING_SOON_DAYS) {
      return { state: 'expiring', attentionReason: null, reviewDaysLeft, readyCount: run.readyCandidates ?? 0 };
    }
    // Round 4, device-tested finding: 'reviewing' does not mean "there is
    // something ready to look at" -- candidates stream in progressively, so
    // a device can be caught up (0 ready) while the run is still active.
    // `resume`/`ready` promise a card at the other end of the tap ("N left
    // to look at", "Pick up where you left off"); showing them with
    // readyCandidates 0 produced a nonsense "0 suggestions left" card. Both
    // require a real ready count -- otherwise this reads exactly like
    // scanning/processing (more may still be coming).
    if ((run.readyCandidates ?? 0) > 0) {
      // deckCursor advances only once the reviewer has moved past the first
      // card (see the checkpoint's own doc comment) -- a reliable "has this
      // device already started reviewing" signal without a second network call.
      if (checkpoint.deckCursor > 0) {
        return { state: 'resume', attentionReason: null, reviewDaysLeft, readyCount: run.readyCandidates ?? 0 };
      }
      return { state: 'ready', attentionReason: null, reviewDaysLeft, readyCount: run.readyCandidates ?? 0 };
    }
    return { state: 'processing', attentionReason: null, reviewDaysLeft: null, readyCount: 0 };
  }

  // completed | cancelled | expired -- nothing left behind the glyph.
  return { state: 'none', attentionReason: null, reviewDaysLeft: null, readyCount: 0 };
}
