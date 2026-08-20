// Playback state for a single audio-memory clip, via expo-audio -- NEVER
// expo-av (deprecated/removed from this codebase; see AGENTS.md). Source is
// always a signed URL string the caller already resolved (e.g. via
// get-media-url + useMediaUrls) -- this hook does no fetching of its own.
//
// HARD RULE (commit 25ef6be lesson, mirrored from
// memory-media-carousel.tsx's `useDeferredReleaseVideoPlayer` for
// `expo-video`): create the player ONCE per mounted component instance and
// swap sources with `player.replace()` -- never release a player a mounted
// view still holds. A caption/description edit or a refreshed signed URL
// for the same clip changes `source` without this hook's caller ever
// unmounting; recreating the player on every such change would race the
// swap against whatever the view is doing with the just-released old
// player. Release is deferred to unmount only, one frame late (via
// requestAnimationFrame) for the same list-recycling reason the video
// adapter defers its release.
import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { beginAudioPlayback, endAudioPlayback, prepareAudioPlaybackMode } from './audio-playback-coordinator';

export interface UseAudioClipPlaybackResult {
  /** Current playback position, in seconds. */
  position: number;
  /** Clip duration, in seconds (0 until the player has loaded metadata). */
  duration: number;
  /** 0-1 duration-normalized playback progress -- 0 when duration is unknown. */
  progress: number;
  playing: boolean;
  /** True until the player has finished loading the current source. */
  loading: boolean;
  error: string | null;
  /**
   * Play/pause. Starting playback claims the app-wide single-active-clip
   * slot via the coordinator (pausing whatever was playing before) and
   * configures the audio session for playback first.
   */
  toggle: () => Promise<void>;
  /** Seeks to a 0-1 fraction of the clip's duration. No-op while duration is unknown. */
  seekTo: (fraction: number) => Promise<void>;
}

const FINISHED_EPSILON_SECONDS = 0.05;

export function useAudioClipPlayback(source: string | null | undefined): UseAudioClipPlaybackResult {
  const clipId = useId();
  const playerRef = useRef<AudioPlayer | null>(null);
  const loadedSourceRef = useRef<string | null>(null);
  const [player, setPlayer] = useState<AudioPlayer | null>(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Created once per mount, released only on unmount below -- see the
  // module-level comment. The initial source (if already known at mount)
  // is passed straight in, and `loadedSourceRef` is primed to match, so the
  // swap effect below doesn't immediately re-issue a redundant replace()
  // for the source the player was just created with.
  useEffect(() => {
    const initialSource = source ?? null;
    const nextPlayer = createAudioPlayer(initialSource ? { uri: initialSource } : null);
    loadedSourceRef.current = initialSource;
    playerRef.current = nextPlayer;
    setPlayer(nextPlayer);

    return () => {
      nextPlayer.pause();
      endAudioPlayback(clipId);
      playerRef.current = null;
      // Defer release a frame -- mirrors useDeferredReleaseVideoPlayer's
      // rationale: a recycled list row can reattach a native surface a
      // frame after React unmounts it, and releasing synchronously here
      // can hand that surface a dead shared object.
      requestAnimationFrame(() => {
        try {
          nextPlayer.remove();
        } catch {
          // Already released (e.g. a fast remount) -- nothing to clean up.
        }
      });
    };
    // Intentionally mount-only -- source changes are handled by the swap
    // effect below via player.replace(), not by recreating the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the source on the existing player instead of recreating it.
  useEffect(() => {
    if (!player) {
      return;
    }
    const nextSource = source ?? null;
    if (loadedSourceRef.current === nextSource) {
      return;
    }
    loadedSourceRef.current = nextSource;
    setLoading(true);
    setError(null);
    setPosition(0);
    player.replace(nextSource ? { uri: nextSource } : null);
  }, [player, source]);

  useEffect(() => {
    if (!player) {
      return undefined;
    }
    const subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      setPosition(status.currentTime ?? 0);
      setDuration(status.duration ?? 0);
      setPlaying(status.playing ?? false);
      setLoading(!status.isLoaded);
      setError(status.error ?? null);
      if (!status.playing) {
        endAudioPlayback(clipId);
      }
    });
    return () => subscription.remove();
  }, [clipId, player]);

  const toggle = useCallback(async () => {
    const current = playerRef.current;
    if (!current) {
      return;
    }

    if (current.playing) {
      current.pause();
      endAudioPlayback(clipId);
      return;
    }

    await prepareAudioPlaybackMode();
    beginAudioPlayback(clipId, () => current.pause());

    if (current.duration > 0 && current.currentTime >= current.duration - FINISHED_EPSILON_SECONDS) {
      await current.seekTo(0);
    }

    current.play();
  }, [clipId]);

  const seekTo = useCallback(async (fraction: number) => {
    const current = playerRef.current;
    if (!current || !current.duration) {
      return;
    }
    const clamped = Math.max(0, Math.min(1, fraction));
    await current.seekTo(clamped * current.duration);
  }, []);

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  return { position, duration, progress, playing, loading, error, toggle, seekTo };
}
