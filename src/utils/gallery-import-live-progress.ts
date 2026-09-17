// A tiny in-memory pub/sub bus that lets the progress screen render the
// runner's live scanning/sending/dispatching counts even though
// the runner is kicked off from the entry screen and keeps running after
// entry navigates away (see gallery-import-entry.tsx's requestPermissionThenStart
// and docs/plans/gallery-import.md's progress redesign notes).
//
// The runner itself is an already-detached async function -- React Native
// does not cancel an in-flight promise just because the component that
// started it unmounted. This module is the seam that lets a *different*
// mounted component (the progress screen) observe that promise's ongoing
// `onProgress` callbacks. It is pure bookkeeping: no timers, no network, no
// React. `startGalleryImportRunner`/`resumeGalleryImportRunner` are
// unmodified by this file -- callers pass an `onProgress` that publishes here.
import type { GalleryImportRunnerProgress } from '@/services/gallery-import-runner';

type Listener = (progress: GalleryImportRunnerProgress) => void;

const latestByRunId = new Map<string, GalleryImportRunnerProgress>();
const listenersByRunId = new Map<string, Set<Listener>>();
const activeRunIds = new Set<string>();

/** Marks a run as having an in-flight startGalleryImportRunner/resumeGalleryImportRunner
 * call somewhere in this process. The progress screen's own auto-resume effect
 * checks this before calling resumeGalleryImportRunner itself -- without it, a
 * screen that mounts right after entry's onRunStarted fires (before the
 * runner has published its first progress event) could start a *second*,
 * concurrent resume against the same checkpoint. Callers must pair this with
 * `markGalleryImportRunnerInactive` in a `finally`. */
export function markGalleryImportRunnerActive(runId: string): void {
  activeRunIds.add(runId);
}

export function markGalleryImportRunnerInactive(runId: string): void {
  activeRunIds.delete(runId);
}

export function isGalleryImportRunnerActive(runId: string): boolean {
  return activeRunIds.has(runId);
}

/** Records the latest progress for a run and notifies any live subscribers. */
export function publishGalleryImportLiveProgress(runId: string, progress: GalleryImportRunnerProgress): void {
  latestByRunId.set(runId, progress);
  for (const listener of listenersByRunId.get(runId) ?? []) listener(progress);
}

/** The most recent progress published for a run, if any -- lets a screen that
 * mounts *after* some progress already happened (e.g. the progress screen
 * mounting a tick after entry's onRunStarted fires) render the current state
 * immediately instead of waiting for the next callback. */
export function getLatestGalleryImportLiveProgress(runId: string): GalleryImportRunnerProgress | null {
  return latestByRunId.get(runId) ?? null;
}

/** Subscribes to live progress for a run. Returns an unsubscribe function. */
export function subscribeGalleryImportLiveProgress(runId: string, listener: Listener): () => void {
  let set = listenersByRunId.get(runId);
  if (!set) {
    set = new Set();
    listenersByRunId.set(runId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listenersByRunId.delete(runId);
  };
}

/** Clears retained state for a run once it is no longer useful (dispatched,
 * cancelled, or the checkpoint itself was cleared). Never required for
 * correctness -- only bounds the memory this module retains across runs. */
export function clearGalleryImportLiveProgress(runId: string): void {
  latestByRunId.delete(runId);
  listenersByRunId.delete(runId);
}
