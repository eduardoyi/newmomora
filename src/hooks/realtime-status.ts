import { useSyncExternalStore } from 'react';

// D3 (docs/plans/performance-optimizations.md Workstream D): reactive
// suppression flag for useGenerationStatusPolling. A plain ref cannot work
// here -- react-query only re-evaluates a `refetchInterval` callback on the
// poll query's own update or on an observer re-render (see the comment in
// useGenerationStatusPolling.ts), so flipping a non-reactive ref on
// CHANNEL_ERROR would leave the poll idle exactly when realtime goes down.
// useSyncExternalStore forces every subscribed hook instance to re-render
// when the status changes, which is what wakes react-query back up.
//
// A single module-level store (not per-familyId) is enough: useMemoriesRealtime
// mounts exactly once (app layout / family-provider level) and resubscribes
// its own channel on familyId change, so there is only ever one "current"
// channel at a time. `familyId` is still tracked alongside `isLive` so a
// stale status from a channel that's mid-teardown (e.g. the old channel's
// CLOSED event arriving after a family switch already started a new one)
// can't be mistaken for the new channel's status.

interface RealtimeStatusState {
  familyId: string | null;
  isLive: boolean;
}

let state: RealtimeStatusState = { familyId: null, isLive: false };
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

function getSnapshot(): RealtimeStatusState {
  return state;
}

/** Called by useMemoriesRealtime on every channel status transition. */
export function setRealtimeLive(familyId: string, isLive: boolean): void {
  if (state.familyId === familyId && state.isLive === isLive) {
    return;
  }
  state = { familyId, isLive };
  notify();
}

/** Called on unmount / resubscribe so a torn-down channel never leaves a stale "live" flag behind. */
export function clearRealtimeStatus(familyId: string): void {
  if (state.familyId !== familyId || !state.isLive) {
    return;
  }
  state = { familyId, isLive: false };
  notify();
}

// Only for tests -- production code has no reason to reset the module-level
// singleton mid-session.
export function resetRealtimeStatusForTests(): void {
  state = { familyId: null, isLive: false };
}

/**
 * True only when the realtime channel for THIS familyId is currently
 * SUBSCRIBED. A mismatched familyId (e.g. mid-resubscribe after a family
 * switch) is treated as "not live" so the poll stays on the safe default
 * rather than assuming coverage from a channel scoped to a different family.
 */
export function useIsRealtimeLive(familyId: string | null | undefined): boolean {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return Boolean(familyId) && snapshot.familyId === familyId && snapshot.isLive;
}
