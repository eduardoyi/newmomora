// Share a Year Film (docs/plans/year-film-p2.md Step 6.7). The MP4 (25-65 MB)
// is downloaded into cache/film-share/ with progress + Cancel, handed to the
// OS share sheet, and deleted on EVERY exit path (success, cancel, error,
// screen unmount). A kill mid-share is covered by `sweepFilmShareCache` at app
// start. Uses the legacy file-system API like the rest of the repo.
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import { trackEvent } from '@/services/analytics';
import { getYearFilmPlayback } from '@/services/year-films';
import { deleteFilmShareFile, prepareFilmShareFile } from '@/utils/film-share';

type DownloadResumable = ReturnType<typeof FileSystem.createDownloadResumable>;

export type YearFilmShareStatus = 'idle' | 'downloading' | 'sharing';

/** Where Share was tapped: the player's top bar mid-film, or the end-of-film overlay. */
export type YearFilmShareSource = 'player' | 'completion';

interface UseYearFilmShareOptions {
  filmId: string;
  /** Null until the film row is known: analytics then skip (kind is required). */
  kind: 'birthday' | 'family_month' | 'family_year' | null;
  /** The share sheet's title (Android `dialogTitle`); the film title. */
  title: string | null;
}

export function useYearFilmShare({ filmId, kind, title }: UseYearFilmShareOptions) {
  const [status, setStatus] = useState<YearFilmShareStatus>('idle');
  const [progress, setProgress] = useState(0);
  const isBusyRef = useRef(false);
  const cancelledRef = useRef(false);
  const isMountedRef = useRef(true);
  const resumableRef = useRef<DownloadResumable | null>(null);
  const fileUriRef = useRef<string | null>(null);

  const cleanup = useCallback(async () => {
    resumableRef.current = null;
    const uri = fileUriRef.current;
    fileUriRef.current = null;
    await deleteFilmShareFile(uri);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelledRef.current = true;
      // Leaving the screen mid-download (or mid-sheet): stop the transfer and
      // drop the file. `share()`'s finally block deletes again; both are idempotent.
      const resumable = resumableRef.current;
      if (resumable) void resumable.cancelAsync().catch(() => undefined);
      void deleteFilmShareFile(fileUriRef.current);
    };
  }, []);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    const resumable = resumableRef.current;
    if (resumable) void resumable.cancelAsync().catch(() => undefined);
  }, []);

  const share = useCallback(async (source: YearFilmShareSource) => {
    if (isBusyRef.current) return;
    isBusyRef.current = true;
    cancelledRef.current = false;
    if (kind) trackEvent('year_film_share_tapped', { kind, source });
    setProgress(0);
    setStatus('downloading');

    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'Sharing is not available on this device.');
        return;
      }

      // Always sign a fresh URL: the playback URL may be 15 minutes old.
      const playback = await getYearFilmPlayback(filmId);
      if (cancelledRef.current) return;
      if (!playback.data) {
        Alert.alert(
          playback.unavailable ? "This film isn't available right now." : "Couldn't prepare the video",
          playback.unavailable ? 'Please try again later.' : 'Check your connection and try again.',
        );
        return;
      }

      const destination = await prepareFilmShareFile(filmId);
      if (!destination) {
        Alert.alert("Couldn't prepare the video", 'Please try again.');
        return;
      }
      fileUriRef.current = destination;
      // A leftover from an earlier attempt would make the download resume/append oddly.
      await deleteFilmShareFile(destination);
      if (cancelledRef.current) return;

      const resumable = FileSystem.createDownloadResumable(
        playback.data.videoUrl,
        destination,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (!isMountedRef.current || cancelledRef.current || totalBytesExpectedToWrite <= 0) return;
          setProgress(Math.min(1, totalBytesWritten / totalBytesExpectedToWrite));
        },
      );
      resumableRef.current = resumable;

      const result = await resumable.downloadAsync();
      resumableRef.current = null;
      if (cancelledRef.current) return;
      if (!result || (typeof result.status === 'number' && result.status >= 400)) {
        Alert.alert("Couldn't prepare the video", 'Check your connection and try again.');
        return;
      }

      if (isMountedRef.current) setStatus('sharing');
      await Sharing.shareAsync(result.uri, {
        mimeType: 'video/mp4',
        UTI: 'public.mpeg-4',
        ...(title ? { dialogTitle: title } : {}),
      });
      // The sheet returned; this is not proof that a share completed.
      if (kind) trackEvent('year_film_shared', { kind, source });
    } catch {
      // A cancelled transfer surfaces as a rejection on some platforms; that is not an error.
      if (!cancelledRef.current) {
        Alert.alert("Couldn't prepare the video", 'Check your connection and try again.');
      }
    } finally {
      await cleanup();
      isBusyRef.current = false;
      if (isMountedRef.current) {
        setStatus('idle');
        setProgress(0);
      }
    }
  }, [cleanup, filmId, kind, title]);

  return { status, progress, share, cancel };
}
