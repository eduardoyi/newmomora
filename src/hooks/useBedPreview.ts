// Plays the ~5 s bundled preview of a Year Film music bed in the edit sheet
// (docs/plans/year-film-p2.md Step 11). One expo-audio player per mount,
// created once and re-pointed with `replace()` -- never released while the
// sheet's rows still use it (shared-object release rule, commit 25ef6be; same
// shape as useAudioClipPlayback). It claims the app-wide playback slot, so a
// preview pauses whatever else is playing (and is paused by it).
import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { beginAudioPlayback, endAudioPlayback, prepareAudioPlaybackMode } from '@/hooks/audio-playback-coordinator';
import type { YearFilmBed } from '@/utils/year-film-beds';

export interface UseBedPreviewResult {
  /** The bed whose preview is playing right now, if any. */
  playingBedId: string | null;
  /** Starts this bed's preview (stopping any other), or stops it when it is the one playing. */
  toggle: (bed: Pick<YearFilmBed, 'id' | 'preview'>) => Promise<void>;
  stop: () => void;
}

export function useBedPreview(): UseBedPreviewResult {
  const clipId = useId();
  const playerRef = useRef<AudioPlayer | null>(null);
  const loadedBedRef = useRef<string | null>(null);
  const playingBedRef = useRef<string | null>(null);
  const [playingBedId, setPlayingBedId] = useState<string | null>(null);

  const setPlaying = useCallback((bedId: string | null) => {
    playingBedRef.current = bedId;
    setPlayingBedId(bedId);
  }, []);

  useEffect(() => {
    const player = createAudioPlayer(null);
    playerRef.current = player;

    const subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (status.didJustFinish) {
        endAudioPlayback(clipId);
        setPlaying(null);
      }
    });

    return () => {
      subscription.remove();
      player.pause();
      endAudioPlayback(clipId);
      playerRef.current = null;
      // Release a frame late, like the other players: a native view may
      // still be detaching from the shared object this frame.
      requestAnimationFrame(() => {
        try {
          player.remove();
        } catch {
          // Already released -- nothing to clean up.
        }
      });
    };
    // Mount-only: the player is created once (see the header comment).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    playerRef.current?.pause();
    endAudioPlayback(clipId);
    setPlaying(null);
  }, [clipId, setPlaying]);

  const toggle = useCallback(
    async (bed: Pick<YearFilmBed, 'id' | 'preview'>) => {
      const player = playerRef.current;
      if (!player) return;

      if (playingBedRef.current === bed.id) {
        stop();
        return;
      }

      await prepareAudioPlaybackMode();
      // The sheet may have closed while the audio session was being set up.
      if (playerRef.current !== player) return;
      // Another preview or clip may be playing: the coordinator pauses it.
      beginAudioPlayback(clipId, () => {
        player.pause();
        setPlaying(null);
      });

      if (loadedBedRef.current !== bed.id) {
        loadedBedRef.current = bed.id;
        player.replace(bed.preview);
      } else {
        await player.seekTo(0);
      }
      setPlaying(bed.id);
      player.play();
    },
    [clipId, setPlaying, stop],
  );

  return { playingBedId, toggle, stop };
}
