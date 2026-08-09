import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { cancelAnimation, runOnJS, useSharedValue, withTiming } from 'react-native-reanimated';

import type { LookingBackCheckpoint, LookingBackPauseReason } from '@/hooks/useLookingBackSession';
import type { LookingBackFrame } from '@/utils/looking-back-frames';

export type LookingBackPlaybackPhase = 'intro' | 'playing' | 'complete' | 'closed';
export interface LookingBackPlaybackState { phase: LookingBackPlaybackPhase; frameIndex: number; frameFraction: number; pauseReasons: LookingBackPauseReason[]; isMuted: boolean; }
type PlaybackAction =
  | { type: 'ADVANCE'; frames: LookingBackFrame[] }
  | { type: 'SKIP'; direction: -1 | 1; frames: LookingBackFrame[] }
  | { type: 'PAUSE'; reason: LookingBackPauseReason }
  | { type: 'RESUME'; reason: LookingBackPauseReason }
  | { type: 'SYNC_FRACTION'; fraction: number }
  | { type: 'RECONCILE_FRAMES'; frames: LookingBackFrame[]; previousFrameId: string | null }
  | { type: 'INTRO_COMPLETE' } | { type: 'REPLAY' } | { type: 'RESTORE'; checkpoint: LookingBackCheckpoint; frames: LookingBackFrame[] }
  | { type: 'TOGGLE_MUTE' } | { type: 'CLOSE' };

/**
 * Callers commonly build frame arrays during render. Reconcile only when the
 * viewer-relevant frame content changed, rather than treating a fresh array
 * identity as a deletion/reorder event (which would dispatch forever).
 */
export function lookingBackFramesFingerprint(frames: LookingBackFrame[]): string {
  return frames.map((frame) => [
    frame.id,
    frame.kind,
    frame.durationMs,
    frame.memory?.id ?? '',
    frame.memory?.updated_at ?? '',
    frame.memory?.content ?? '',
    frame.memory?.illustration_key ?? '',
    frame.memory?.illustration_status ?? '',
    frame.asset?.id ?? '',
    frame.asset?.object_key ?? '',
    frame.asset?.preview_object_key ?? '',
    frame.asset?.duration_ms ?? '',
  ].join('\u001f')).join('\u001e');
}

export function lookingBackPlaybackReducer(state: LookingBackPlaybackState, action: PlaybackAction): LookingBackPlaybackState {
  switch (action.type) {
    case 'INTRO_COMPLETE': return state.phase === 'intro' ? {
      ...state,
      phase: 'playing',
      frameIndex: 0,
      frameFraction: 0,
      // Starting is explicit. A stale touch-owned pause from an older
      // checkpoint must not make the first memory appear frozen, while
      // accessibility/lifecycle pause owners remain authoritative.
      pauseReasons: state.pauseReasons.filter((reason) => reason !== 'manual'),
    } : state;
    case 'ADVANCE': {
      if (state.phase !== 'playing' || state.pauseReasons.length) return state;
      const next = state.frameIndex + 1;
      return next >= action.frames.length ? { ...state, phase: 'complete', frameFraction: 1 } : { ...state, frameIndex: next, frameFraction: 0 };
    }
    case 'SKIP': {
      if (state.phase === 'intro' && action.direction > 0) return { ...state, phase: 'playing', frameIndex: 0, frameFraction: 0 };
      if (state.phase !== 'playing') return state;
      if (action.direction > 0 && state.frameIndex >= action.frames.length - 1) {
        return { ...state, phase: 'complete', frameFraction: 1 };
      }
      return { ...state, frameIndex: Math.max(0, Math.min(action.frames.length - 1, state.frameIndex + action.direction)), frameFraction: 0 };
    }
    case 'PAUSE': return state.pauseReasons.includes(action.reason) ? state : { ...state, pauseReasons: [...state.pauseReasons, action.reason] };
    case 'RESUME': return { ...state, pauseReasons: state.pauseReasons.filter((reason) => reason !== action.reason) };
    case 'SYNC_FRACTION': return { ...state, frameFraction: Math.min(1, Math.max(0, action.fraction)) };
    case 'RECONCILE_FRAMES': {
      if (action.frames.length === 0) return { ...state, phase: 'complete', frameIndex: 0, frameFraction: 1 };
      const survivingIndex = action.previousFrameId
        ? action.frames.findIndex((frame) => frame.id === action.previousFrameId)
        : -1;
      if (survivingIndex >= 0) return { ...state, frameIndex: survivingIndex };
      // The current frame was removed. Index selects its deterministic next
      // replacement; when it was the last frame, fall back to the new last.
      return { ...state, frameIndex: Math.min(state.frameIndex, action.frames.length - 1), frameFraction: 0 };
    }
    case 'REPLAY': return { ...state, phase: 'playing', frameIndex: 0, frameFraction: 0, pauseReasons: [] };
    case 'RESTORE': {
      const frameIndex = action.frames.length ? Math.max(0, Math.min(action.frames.length - 1, action.checkpoint.frameIndex)) : 0;
      return { phase: action.checkpoint.phase, frameIndex, frameFraction: Math.min(1, Math.max(0, action.checkpoint.frameFraction)), pauseReasons: action.checkpoint.pauseReasons, isMuted: action.checkpoint.isMuted };
    }
    case 'TOGGLE_MUTE': return { ...state, isMuted: !state.isMuted };
    case 'CLOSE': return { ...state, phase: 'closed', pauseReasons: ['background'] };
    default: return state;
  }
}

export function useLookingBackPlayback({ frames, checkpoint, isScreenReaderEnabled = false }: { frames: LookingBackFrame[]; checkpoint?: LookingBackCheckpoint | null; isScreenReaderEnabled?: boolean }) {
  const initial = useMemo<LookingBackPlaybackState>(() => checkpoint ? { phase: checkpoint.phase, frameIndex: checkpoint.frameIndex, frameFraction: checkpoint.frameFraction, pauseReasons: checkpoint.pauseReasons, isMuted: checkpoint.isMuted } : { phase: 'intro', frameIndex: 0, frameFraction: 0, pauseReasons: [], isMuted: true }, [checkpoint]);
  const [state, dispatch] = useReducer(lookingBackPlaybackReducer, initial);
  const framesRef = useRef(frames);
  const previousFramesRef = useRef(frames);
  const framesFingerprint = lookingBackFramesFingerprint(frames);
  const previousFramesFingerprintRef = useRef(framesFingerprint);
  const restoredCheckpointKeyRef = useRef<string | null>(null);
  const stateRef = useRef(state);
  const clockRef = useRef({ durationMs: 0, fraction: state.frameFraction, frameIndex: state.frameIndex, startedAtMs: 0 });
  const progress = useSharedValue(state.frameFraction);
  useEffect(() => {
    if (framesFingerprint === previousFramesFingerprintRef.current) return;
    const previousFrameId = previousFramesRef.current[stateRef.current.frameIndex]?.id ?? null;
    framesRef.current = frames;
    previousFramesRef.current = frames;
    previousFramesFingerprintRef.current = framesFingerprint;
    dispatch({ type: 'RECONCILE_FRAMES', frames, previousFrameId });
  }, [frames, framesFingerprint]);
  useEffect(() => { stateRef.current = state; }, [state]);
  const checkpointKey = checkpoint
    ? `${checkpoint.familyId}:${checkpoint.dailySetId}:${checkpoint.packageId}:${checkpoint.frameIndex}:${checkpoint.frameFraction}:${checkpoint.phase}:${checkpoint.isMuted}:${checkpoint.pauseReasons.join(',')}`
    : null;
  useEffect(() => {
    if (!checkpoint || checkpointKey === restoredCheckpointKeyRef.current) return;
    restoredCheckpointKeyRef.current = checkpointKey;
    dispatch({ type: 'RESTORE', checkpoint, frames: framesRef.current });
  }, [checkpoint, checkpointKey]);
  useEffect(() => { dispatch(isScreenReaderEnabled ? { type: 'PAUSE', reason: 'screen-reader' } : { type: 'RESUME', reason: 'screen-reader' }); }, [isScreenReaderEnabled]);

  const finishFrame = useCallback(() => dispatch({ type: 'ADVANCE', frames: framesRef.current }), []);
  useEffect(() => {
    cancelAnimation(progress);
    const frame = frames[state.frameIndex];
    if (state.phase !== 'playing' || !frame || state.pauseReasons.length) return;
    clockRef.current = {
      durationMs: frame.durationMs,
      fraction: state.frameFraction,
      frameIndex: state.frameIndex,
      startedAtMs: Date.now(),
    };
    progress.value = state.frameFraction;
    progress.value = withTiming(1, { duration: Math.max(1, frame.durationMs * (1 - state.frameFraction)) }, (finished) => { if (finished) runOnJS(finishFrame)(); });
  }, [finishFrame, frames, progress, state.frameFraction, state.frameIndex, state.pauseReasons.length, state.phase]);

  const currentFraction = useCallback(() => {
    const current = stateRef.current;
    const clock = clockRef.current;
    if (
      current.phase !== 'playing' || current.pauseReasons.length > 0 ||
      clock.frameIndex !== current.frameIndex || clock.durationMs <= 0
    ) return current.frameFraction;
    return Math.min(1, Math.max(0, clock.fraction + ((Date.now() - clock.startedAtMs) / clock.durationMs)));
  }, []);
  const pause = useCallback((reason: LookingBackPauseReason) => {
    const current = stateRef.current;
    if (current.pauseReasons.includes(reason)) return;
    let frameFraction = current.frameFraction;
    // Only the first active pause captures elapsed time. A second source
    // (background while buffering, for example) must preserve that exact
    // frozen fraction rather than trying to resume it.
    if (current.phase === 'playing' && current.pauseReasons.length === 0) {
      frameFraction = currentFraction();
      clockRef.current = { ...clockRef.current, fraction: frameFraction, startedAtMs: 0 };
      cancelAnimation(progress);
      dispatch({ type: 'SYNC_FRACTION', fraction: frameFraction });
    }
    // A lifecycle handler can checkpoint immediately after pausing. Keep the
    // JS checkpoint authority coherent synchronously; React's reducer render
    // follows afterwards and remains the visual source of truth.
    stateRef.current = { ...current, frameFraction, pauseReasons: [...current.pauseReasons, reason] };
    dispatch({ type: 'PAUSE', reason });
  }, [currentFraction, progress]);
  const resume = useCallback((reason: LookingBackPauseReason) => {
    stateRef.current = { ...stateRef.current, pauseReasons: stateRef.current.pauseReasons.filter((activeReason) => activeReason !== reason) };
    dispatch({ type: 'RESUME', reason });
  }, []);
  const next = useCallback(() => { cancelAnimation(progress); dispatch({ type: 'SKIP', direction: 1, frames: framesRef.current }); }, [progress]);
  const previous = useCallback(() => { cancelAnimation(progress); dispatch({ type: 'SKIP', direction: -1, frames: framesRef.current }); }, [progress]);
  const checkpointFor = useCallback((identity: Pick<LookingBackCheckpoint, 'familyId' | 'dailySetId' | 'packageId'>): LookingBackCheckpoint => {
    const current = stateRef.current;
    return {
      ...identity,
      frameIndex: current.frameIndex,
      // The JS clock is checkpoint authority. Reanimated owns only visual
      // interpolation, so no UI shared value is synchronously read from a JS
      // event handler during pause/background/route cleanup.
      frameFraction: currentFraction(),
      phase: current.phase === 'closed' ? 'complete' : current.phase,
      isMuted: current.isMuted,
      pauseReasons: current.pauseReasons,
    };
  }, [currentFraction]);
  return { state, currentFrame: frames[state.frameIndex] ?? null, progress, dispatch, pause, resume, next, previous, replay: () => dispatch({ type: 'REPLAY' }), toggleMuted: () => dispatch({ type: 'TOGGLE_MUTE' }), checkpointFor };
}
