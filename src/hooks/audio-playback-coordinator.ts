// Module-level "only one sound plays at a time, app-wide" coordinator for
// audio memories. Follows the same useSyncExternalStore singleton-store
// pattern as realtime-status.ts: a single module-level store is enough
// because there is only ever one app at a time, and every subscribed hook
// instance needs to re-render together when the active clip changes (e.g.
// a card that's playing must know to stop showing itself as active the
// instant a different card starts).
//
// docs/plans/audio-memories-v1.md P3.1 scopes v1 to wiring the coordinator
// itself plus `pauseAllAudioPlayback()`/`prepareAudioPlaybackMode()` for
// future callers -- the recorder (useVoiceInput) and video autoplay
// (timeline.tsx's `activeVideoId`) are NOT wired to this module yet; that
// integration is explicitly a later wave (see the plan's "Player
// coordination is new design work" note). Do not modify useVoiceInput.ts or
// timeline.tsx to call in from here as part of this change.
import { setAudioModeAsync } from 'expo-audio';
import { useSyncExternalStore } from 'react';

type PauseFn = () => void;

interface CoordinatorState {
  activeId: string | null;
}

let state: CoordinatorState = { activeId: null };
// Not part of the reactive `state` snapshot -- it's an imperative escape
// hatch (a closure back to the currently-playing clip's own pause()), not
// data any subscriber needs to re-render on.
let activePause: PauseFn | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CoordinatorState {
  return state;
}

/**
 * Claims the single app-wide "active" playback slot for `id`, pausing
 * whatever clip (or, in a later wave, autoplaying video) was previously
 * playing. Call this right before actually starting playback -- the
 * coordinator does not start `id`'s playback itself, it only stops
 * whatever came before.
 */
export function beginAudioPlayback(id: string, onPause: PauseFn): void {
  if (activePause && state.activeId !== id) {
    const previousPause = activePause;
    previousPause();
  }
  activePause = onPause;
  if (state.activeId !== id) {
    state = { activeId: id };
    notify();
  }
}

/**
 * Releases `id`'s claim on the active slot without pausing it again --
 * call this when a clip stops on its own (finished, or paused by its own
 * toggle) so the coordinator doesn't keep holding a pause callback for a
 * clip that already stopped.
 */
export function endAudioPlayback(id: string): void {
  if (state.activeId !== id) {
    return;
  }
  activePause = null;
  state = { activeId: null };
  notify();
}

/**
 * Pauses whatever is currently playing app-wide, if anything. This is the
 * function future callers (recorder start, video autoplay) reach for --
 * exported now per the plan even though nothing calls it yet in this wave.
 */
export function pauseAllAudioPlayback(): void {
  const pause = activePause;
  activePause = null;
  if (pause) {
    pause();
  }
  if (state.activeId !== null) {
    state = { activeId: null };
    notify();
  }
}

/**
 * Configures the audio session for playback (recording disabled) before a
 * clip starts. Mirrors useVoiceInput.ts's `setAudioModeAsync({
 * allowsRecording: true, playsInSilentMode: true })` call for recording --
 * this is the playback-side counterpart, not a modification of that hook.
 */
export async function prepareAudioPlaybackMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
  });
}

/** True when `id` currently holds the single app-wide active playback slot. */
export function useIsActiveAudioClip(id: string): boolean {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return snapshot.activeId === id;
}

// Only for tests -- production code has no reason to reset the module-level
// singleton mid-session.
export function resetAudioPlaybackCoordinatorForTests(): void {
  state = { activeId: null };
  activePause = null;
}
