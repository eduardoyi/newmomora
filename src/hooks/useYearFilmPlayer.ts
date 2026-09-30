// Year Film playback controller (docs/plans/year-film-p2.md Step 6).
//
// SHARED-OBJECT RULE (commit 25ef6be; see memory-media-carousel.tsx /
// full-screen-media-viewer.tsx): the expo-video player is created ONCE per
// screen mount (`createVideoPlayer(null)` in a lazy `useState`), sources are
// only ever swapped through `replaceAsync`, and `release()` runs once, on
// unmount, a frame after the mounted `VideoView` has gone. Never
// `useVideoPlayer` with a changing source -- it releases the player under a
// mounted view.
import { useEventListener } from 'expo';
import { useFocusEffect } from 'expo-router';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { pauseAllAudioPlayback, prepareAudioPlaybackMode } from '@/hooks/audio-playback-coordinator';
import { getYearFilmPlayback } from '@/services/year-films';
import {
  nextSceneTarget,
  parseFilmScenes,
  previousSceneTarget,
  sceneIndexAt,
  singleFilmScene,
  type FilmScene,
} from '@/utils/year-film-scenes';

export type YearFilmPlayerPhase = 'loading' | 'ready' | 'unavailable' | 'error';

interface LoadOptions {
  resumeAtMs?: number;
  isRecovery?: boolean;
}

interface UseYearFilmPlayerOptions {
  filmId: string;
  /** Used when neither the playback response nor the player reports a duration. */
  fallbackDurationMs?: number | null;
  /** First time the film actually plays (record the view). */
  onFirstPlay?: () => void;
  /** The film reached its end (naturally or by tapping past the last scene). */
  onComplete?: (durationMs: number) => void;
  /** The server says the film is gone (404/409): refresh lists that show it. */
  onUnavailable?: () => void;
}

const TIME_UPDATE_INTERVAL_S = 0.1;
/** Playback must have got past this before any "ended" signal is believed. */
const MIN_PLAYED_S = 0.5;
/** `playToEnd` only counts within this distance of the known duration... */
const END_TOLERANCE_S = 1.5;
/** ...or once this fraction of it has been played. */
const END_PLAYED_FRACTION = 0.9;
/** `timeUpdate` at this distance from the end, while paused, also finishes the film. */
const END_TIME_UPDATE_TOLERANCE_S = 0.3;

// VideoPlayer is an imperative native shared object. Keep its mutation in
// these adapters (as memory-media-carousel.tsx does) rather than treating the
// player held in React state as ordinary immutable application data.
function configureNewPlayer(player: VideoPlayer) {
  player.loop = false;
  player.muted = false;
  player.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
}

function setPlayerMuted(player: VideoPlayer, muted: boolean) {
  player.muted = muted;
}

function seekPlayerToSeconds(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}

export function useYearFilmPlayer({
  filmId,
  fallbackDurationMs,
  onFirstPlay,
  onComplete,
  onUnavailable,
}: UseYearFilmPlayerOptions) {
  const [player] = useState<VideoPlayer>(() => {
    const created = createVideoPlayer(null);
    configureNewPlayer(created);
    return created;
  });

  const [phase, setPhaseState] = useState<YearFilmPlayerPhase>('loading');
  const [posterUrl, setPosterUrl] = useState<string | null>(null);
  const [scenes, setScenes] = useState<FilmScene[] | null>(null);
  const [playbackDurationMs, setPlaybackDurationMs] = useState<number | null>(null);
  const [playerDurationMs, setPlayerDurationMs] = useState<number | null>(null);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasFirstFrame, setHasFirstFrame] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [isHeld, setIsHeld] = useState(false);
  const [needsMotionConfirm, setNeedsMotionConfirm] = useState(false);

  /** Position in ms; drives the progress fills without re-rendering. */
  const positionMs: SharedValue<number> = useSharedValue(0);

  const phaseRef = useRef<YearFilmPlayerPhase>('loading');
  const positionRef = useRef(0);
  const scenesRef = useRef<FilmScene[]>(singleFilmScene(fallbackDurationMs));
  const sceneIndexRef = useRef(0);
  const wantsPlayRef = useRef(false);
  const heldRef = useRef(false);
  const completeRef = useRef(false);
  const startedRef = useRef(false);
  const suspendRef = useRef(new Set<'background' | 'blur'>());
  const loadGenerationRef = useRef(0);
  const retriedRef = useRef(false);
  const recoveringRef = useRef(false);
  const unmountedRef = useRef(false);
  const audioReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const durationRef = useRef<number | null>(null);
  // Real playback of the CURRENT source: expo-video (Android) emits `playToEnd`
  // for the empty playlist of `createVideoPlayer(null)` / during source
  // replacement, so "ended" is only believed after time genuinely progressed.
  const hasPlayedRef = useRef(false);
  const lastTimeRef = useRef(0);

  const callbacksRef = useRef({ onFirstPlay, onComplete, onUnavailable });
  useEffect(() => {
    callbacksRef.current = { onFirstPlay, onComplete, onUnavailable };
  });

  const durationMs = playbackDurationMs ?? playerDurationMs ?? fallbackDurationMs ?? null;
  useEffect(() => {
    durationRef.current = durationMs;
  }, [durationMs]);

  const effectiveScenes = useMemo(() => scenes ?? singleFilmScene(durationMs), [scenes, durationMs]);
  useEffect(() => {
    scenesRef.current = effectiveScenes;
  }, [effectiveScenes]);

  const setPhase = useCallback((next: YearFilmPlayerPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const resetPlayedState = useCallback(() => {
    hasPlayedRef.current = false;
    lastTimeRef.current = 0;
  }, []);

  const applyPlayState = useCallback(() => {
    if (phaseRef.current !== 'ready' || unmountedRef.current) return;
    const shouldPlay =
      wantsPlayRef.current && !completeRef.current && !heldRef.current && suspendRef.current.size === 0;
    try {
      if (shouldPlay) player.play();
      else player.pause();
    } catch {
      // Lost the race with release; nothing left to control.
    }
  }, [player]);

  const setPosition = useCallback(
    (ms: number) => {
      positionRef.current = ms;
      positionMs.set(ms);
      const index = sceneIndexAt(scenesRef.current, ms);
      if (index !== sceneIndexRef.current) {
        sceneIndexRef.current = index;
        setSceneIndex(index);
      }
    },
    [positionMs],
  );

  // --- loading + recovery -------------------------------------------------

  const loadFilm = useCallback(
    async ({ resumeAtMs, isRecovery = false }: LoadOptions = {}) => {
      loadGenerationRef.current += 1;
      const generation = loadGenerationRef.current;
      const isStale = () => unmountedRef.current || generation !== loadGenerationRef.current;
      if (!isRecovery) setPhase('loading');

      const result = await getYearFilmPlayback(filmId);
      if (isStale()) return;
      if (!result.data) {
        if (result.unavailable) {
          setPhase('unavailable');
          callbacksRef.current.onUnavailable?.();
        } else {
          setPhase('error');
        }
        return;
      }

      const playback = result.data;
      setPosterUrl(playback.posterUrl);
      setPlaybackDurationMs(playback.durationMs ?? null);
      if (!isRecovery && playback.scenesUrl) {
        void fetchScenes(playback.scenesUrl).then((parsed) => {
          if (!unmountedRef.current && parsed) setScenes(parsed);
        });
      }

      await audioReadyRef.current;
      if (isStale()) return;
      resetPlayedState();
      try {
        await player.replaceAsync({ uri: playback.videoUrl });
      } catch {
        if (!isStale()) setPhase('error');
        return;
      }
      if (isStale()) return;
      // Drop anything the previous/empty item reported while it was swapped out.
      resetPlayedState();

      if (resumeAtMs && resumeAtMs > 0) {
        try {
          seekPlayerToSeconds(player, resumeAtMs / 1000);
        } catch {
          // Seek is best-effort; playback restarts from wherever the player is.
        }
      }
      setPhase('ready');
      applyPlayState();
    },
    [applyPlayState, filmId, player, resetPlayedState, setPhase],
  );

  const handlePlayerError = useCallback(() => {
    if (recoveringRef.current || unmountedRef.current) return;
    if (phaseRef.current === 'unavailable') return;
    if (retriedRef.current) {
      setPhase('error');
      return;
    }
    // One automatic retry: the presigned URL (15 min) most likely expired
    // during a long pause. Refetch, swap the source in place, seek back.
    retriedRef.current = true;
    recoveringRef.current = true;
    void loadFilm({ resumeAtMs: positionRef.current, isRecovery: true }).finally(() => {
      recoveringRef.current = false;
    });
  }, [loadFilm, setPhase]);

  /** "Try again" after an error: a fresh retry budget, resuming where it stopped. */
  const retry = useCallback(() => {
    retriedRef.current = false;
    wantsPlayRef.current = true;
    setPhase('loading');
    void loadFilm({ resumeAtMs: positionRef.current, isRecovery: startedRef.current });
  }, [loadFilm, setPhase]);

  useEffect(() => {
    unmountedRef.current = false;
    let cancelled = false;
    // Other audio (audio memories) stops, and the session plays even with the
    // iOS silent switch on -- a dictation/audio-memory session may have left
    // a recording category behind. Not restored on close: every recorder
    // sets its own mode before recording (useVoiceInput).
    pauseAllAudioPlayback();
    audioReadyRef.current = prepareAudioPlaybackMode().catch(() => undefined);

    void (async () => {
      let reduceMotion = false;
      try {
        reduceMotion = await AccessibilityInfo.isReduceMotionEnabled();
      } catch {
        reduceMotion = false;
      }
      if (cancelled) return;
      if (reduceMotion) setNeedsMotionConfirm(true);
      else wantsPlayRef.current = true;
      await loadFilm();
    })();

    return () => {
      cancelled = true;
      unmountedRef.current = true;
      loadGenerationRef.current += 1;
    };
  }, [loadFilm]);

  // Released once, on unmount, after the VideoView (a child of the same
  // screen) has been detached -- see the header comment.
  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {
        // Already released.
      }
      requestAnimationFrame(() => {
        try {
          player.release();
        } catch {
          // Already released.
        }
      });
    };
  }, [player]);

  // --- player events ------------------------------------------------------

  useEventListener(player, 'playingChange', ({ isPlaying: nextIsPlaying }) => {
    setIsPlaying(nextIsPlaying);
    if (nextIsPlaying && !startedRef.current) {
      startedRef.current = true;
      callbacksRef.current.onFirstPlay?.();
    }
  });

  useEventListener(player, 'statusChange', ({ status }) => {
    setIsBuffering(status === 'loading');
    if (status === 'readyToPlay') {
      retriedRef.current = false;
      // Autoplay must not hinge on the one call made when the load promise
      // resolved: re-assert the desired play state once the item is ready.
      applyPlayState();
    }
    if (status === 'error') handlePlayerError();
  });

  useEventListener(player, 'sourceLoad', ({ duration }) => {
    if (Number.isFinite(duration) && duration > 0) setPlayerDurationMs(Math.round(duration * 1000));
  });

  const isPlayerPlaying = useCallback(() => {
    try {
      return Boolean(player.playing);
    } catch {
      return false;
    }
  }, [player]);

  const finish = useCallback(() => {
    if (completeRef.current) return;
    completeRef.current = true;
    setIsComplete(true);
    const total = durationRef.current ?? 0;
    setPosition(total);
    try {
      player.pause();
    } catch {
      // Already released.
    }
    callbacksRef.current.onComplete?.(total);
  }, [player, setPosition]);

  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (completeRef.current) return;
    lastTimeRef.current = currentTime;
    if (currentTime > MIN_PLAYED_S) hasPlayedRef.current = true;
    setPosition(Math.max(0, currentTime * 1000));
    if (currentTime > 0.05) setHasFirstFrame(true);
    // Belt and braces for platforms where `playToEnd` is late or missing: the
    // clock reached the end and the player stopped by itself.
    const totalMs = durationRef.current;
    if (
      hasPlayedRef.current &&
      phaseRef.current === 'ready' &&
      totalMs &&
      totalMs > 0 &&
      currentTime >= totalMs / 1000 - END_TIME_UPDATE_TOLERANCE_S &&
      !heldRef.current &&
      suspendRef.current.size === 0 &&
      !isPlayerPlaying()
    ) {
      finish();
    }
  });

  useEventListener(player, 'playToEnd', () => {
    if (completeRef.current || phaseRef.current !== 'ready' || !hasPlayedRef.current) return;
    let position = lastTimeRef.current;
    try {
      position = Math.max(position, player.currentTime);
    } catch {
      // Already released; fall back to the last reported time.
    }
    const totalS = durationRef.current ? durationRef.current / 1000 : 0;
    if (totalS > 0 && position < totalS - END_TOLERANCE_S && position < totalS * END_PLAYED_FRACTION) return;
    finish();
  });

  // --- interruptions (app background, another screen on top) ---------------

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') suspendRef.current.delete('background');
      else suspendRef.current.add('background');
      applyPlayState();
    });
    return () => subscription.remove();
  }, [applyPlayState]);

  useFocusEffect(
    useCallback(() => {
      suspendRef.current.delete('blur');
      if (startedRef.current) applyPlayState();
      return () => {
        // A second film pushed on top (push tap while watching), or memory
        // detail: never leave audio playing under another screen.
        suspendRef.current.add('blur');
        applyPlayState();
      };
    }, [applyPlayState]),
  );

  // --- controls -------------------------------------------------------------

  const seekToMs = useCallback(
    (ms: number) => {
      try {
        seekPlayerToSeconds(player, ms / 1000);
      } catch {
        return;
      }
      setPosition(ms);
    },
    [player, setPosition],
  );

  const next = useCallback(() => {
    if (phaseRef.current !== 'ready' || completeRef.current) return;
    const target = nextSceneTarget(scenesRef.current, positionRef.current);
    if (target.kind === 'end') finish();
    else seekToMs(target.ms);
  }, [finish, seekToMs]);

  const previous = useCallback(() => {
    if (phaseRef.current !== 'ready' || completeRef.current) return;
    const target = previousSceneTarget(scenesRef.current, positionRef.current);
    if (target.kind === 'seek') seekToMs(target.ms);
  }, [seekToMs]);

  const hold = useCallback(() => {
    heldRef.current = true;
    setIsHeld(true);
    applyPlayState();
  }, [applyPlayState]);

  const release = useCallback(() => {
    heldRef.current = false;
    setIsHeld(false);
    applyPlayState();
  }, [applyPlayState]);

  /** Play/pause toggle for the screen-reader controls (a hold is not discoverable). */
  const togglePaused = useCallback(() => {
    if (heldRef.current) release();
    else hold();
  }, [hold, release]);

  const replay = useCallback(() => {
    completeRef.current = false;
    resetPlayedState();
    setIsComplete(false);
    sceneIndexRef.current = 0;
    setSceneIndex(0);
    setPosition(0);
    try {
      seekPlayerToSeconds(player, 0);
    } catch {
      // Best-effort; play() below restarts from the paused end otherwise.
    }
    wantsPlayRef.current = true;
    applyPlayState();
  }, [applyPlayState, player, resetPlayedState, setPosition]);

  /** The Reduce Motion "Play" button. */
  const confirmPlay = useCallback(() => {
    setNeedsMotionConfirm(false);
    wantsPlayRef.current = true;
    applyPlayState();
  }, [applyPlayState]);

  const toggleMute = useCallback(() => {
    setIsMuted((current) => {
      const nextMuted = !current;
      try {
        setPlayerMuted(player, nextMuted);
      } catch {
        // Already released.
      }
      return nextMuted;
    });
  }, [player]);

  const markFirstFrame = useCallback(() => setHasFirstFrame(true), []);

  return {
    player,
    phase,
    posterUrl,
    scenes: effectiveScenes,
    sceneIndex,
    positionMs,
    durationMs,
    isPlaying,
    isBuffering,
    hasFirstFrame,
    isMuted,
    isComplete,
    isHeld,
    needsMotionConfirm,
    next,
    previous,
    hold,
    release,
    togglePaused,
    replay,
    retry,
    confirmPlay,
    toggleMute,
    markFirstFrame,
  };
}

async function fetchScenes(url: string): Promise<FilmScene[] | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return parseFilmScenes(await response.json());
  } catch {
    return null;
  }
}
