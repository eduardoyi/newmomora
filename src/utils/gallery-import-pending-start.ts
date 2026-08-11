// Tracks a gallery-import run that has been asked to start but does not have
// a run id yet (the scan + Wi-Fi check + createGalleryImportRun round-trip
// all happen before a run id exists). The entry screen navigates to the
// progress screen the instant permission is granted -- before any of that
// finishes -- so the progress screen needs a way to render *something* for a
// run it cannot look up by id yet, and to pick up the real id the moment one
// exists. See gallery-import-pipeline.ts, the only writer of this state.
//
// Deliberately a single slot, not runId-keyed like gallery-import-live-progress.ts:
// only one fresh (never-had-a-runId) start can be in flight for this device
// at a time (the entry screen's own gates -- permission/lapsed checks --
// already prevent starting a second one before the first resolves).
import type { GalleryImportRunnerProgress } from '@/services/gallery-import-runner';

export type GalleryImportPendingStartStatus = 'starting' | 'waitingWifi' | 'started' | 'failed';

export interface GalleryImportPendingStartState {
  status: GalleryImportPendingStartStatus;
  runId?: string;
  /** Live count while status is 'starting' and no run id exists yet (the
   * scanning stage's "N photos so far"). */
  scannedAssetCount?: number;
  error?: unknown;
  /** Carried across a 'waitingWifi'/'failed' retry (see gallery-import-pipeline.ts
   * and gallery-import-progress.tsx's cellular-confirm/retry handling) so a
   * retry started from the progress screen reports the same permission mode
   * the original attempt on the entry screen resolved. */
  permissionMode?: 'full' | 'limited';
}

type Listener = (state: GalleryImportPendingStartState | null) => void;

let state: GalleryImportPendingStartState | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener(state);
}

export function getGalleryImportPendingStart(): GalleryImportPendingStartState | null {
  return state;
}

export function setGalleryImportPendingStart(next: GalleryImportPendingStartState | null): void {
  state = next;
  notify();
}

/** Merges into the current pending-start state (e.g. a fresh scanning count)
 * without clobbering fields a different update set. No-ops once the state
 * has moved on (cleared, or replaced by a later start) so a stale in-flight
 * scan's progress callback can never resurrect a state a newer call replaced. */
export function updateGalleryImportPendingStart(patch: Partial<GalleryImportPendingStartState>): void {
  if (!state) return;
  state = { ...state, ...patch };
  notify();
}

export function subscribeGalleryImportPendingStart(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearGalleryImportPendingStart(): void {
  state = null;
  notify();
}

export function applyGalleryImportPendingScanProgress(progress: GalleryImportRunnerProgress): void {
  if (progress.stage !== 'scanning') return;
  updateGalleryImportPendingStart({ scannedAssetCount: progress.scannedAssetCount ?? progress.completed });
}
