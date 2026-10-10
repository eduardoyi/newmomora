// Post-save trim for an audio memory on the edit screen (docs/plans/
// audio-trim-import.md "Addendum: post-save trim"). Owns the local-file side
// of the flow: download the saved clip, analyse it, run the trim sheet, render
// the cut, and hold it as a *pending* trim until the parent taps Save. The
// upload + memory write happen in the screen's Save (useMemoryMutations).
//
// Every async step re-checks a generation token (bumped by each new operation,
// by a superseding Done and by unmount), so a late download/render never
// applies, and never leaves a file behind, once the screen has moved on.
//
// Privacy: these are a family's voice recordings. Never log URIs, notes or
// transcripts.
import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useRef, useState } from 'react';

import { trackEvent, type AnalyticsEventMap } from '@/services/analytics';
import { discardAudioClip, newAudioRecordingUri } from '@/utils/audio-clip-custody';
import { sanitizeWaveform, suggestTrim, waveformFromEnergies } from '@/utils/audio-waveform';

import * as MomoraAudio from '../../modules/momora-audio';
import type { AudioEnergies } from '../../modules/momora-audio';

export const SAVED_TRIM_OFFLINE_COPY = 'Trimming needs a connection.';
export const SAVED_TRIM_LOAD_FAILED_COPY = "Couldn't load this sound. Try again.";
export const SAVED_TRIM_FAILED_COPY = "Couldn't trim that sound. Try again.";

const MAX_SELECTION_MS = 300_000;
const MIN_SELECTION_MS = 1000;
const TRIM_RENDER_BITRATE = 96_000;
const ANALYZE_OPTIONS = { maxBuckets: 4000, minBucketMs: 20 } as const;
// The sheet quantises its handles, so "the whole clip" is matched with slack.
const SAME_RANGE_TOLERANCE_MS = 50;

type TrimRange = { startMs: number; endMs: number };

export interface SavedAudioPendingTrim {
  /** The rendered, trimmed `.m4a` (96 kbps). Uploaded on Save. */
  localUri: string;
  durationMs: number;
  sizeBytes: number;
  waveform: number[] | null;
  /** The cut, relative to the downloaded original (reopens the sheet where it was left). */
  range: TrimRange;
  /** Total ms cut from the saved clip (for the analytics bucket). */
  removedMs: number;
}

interface SavedAudioOriginal {
  localUri: string;
  durationMs: number;
  energies: AudioEnergies;
}

export interface SavedTrimSheetConfig {
  sourceUri: string;
  durationMs: number;
  energies: number[];
  bucketMs: number;
  initialRange: TrimRange;
  suggested: boolean;
  maxSelectionMs: number;
  mustTrim: false;
  hasUserNote: boolean;
}

interface UseSavedAudioTrimOptions {
  /** Signed URL of the saved clip (null/undefined while it is unresolved). */
  audioClipUrl: string | null | undefined;
  isOnline: boolean;
  /** Whether the note field currently holds text (drives the sheet's one-line hint). */
  hasUserNote: () => boolean;
  setErrorMessage: (message: string) => void;
}

function isFullRange(range: TrimRange, durationMs: number): boolean {
  return (
    range.startMs <= SAME_RANGE_TOLERANCE_MS && range.endMs >= durationMs - SAME_RANGE_TOLERANCE_MS
  );
}

function isSameRange(a: TrimRange, b: TrimRange): boolean {
  return (
    Math.abs(a.startMs - b.startMs) <= SAME_RANGE_TOLERANCE_MS &&
    Math.abs(a.endMs - b.endMs) <= SAME_RANGE_TOLERANCE_MS
  );
}

/** Total seconds cut from the clip, bucketed (no exact durations in analytics). */
export function bucketSavedTrimRemovedMs(
  removedMs: number,
): AnalyticsEventMap['audio_trim_applied']['removed_bucket'] {
  const seconds = Math.max(0, removedMs) / 1000;
  if (seconds <= 5) return '0_5s';
  if (seconds <= 15) return '5_15s';
  if (seconds <= 60) return '15_60s';
  return '60s_plus';
}

export function useSavedAudioTrim(options: UseSavedAudioTrimOptions) {
  const [pending, setPending] = useState<SavedAudioPendingTrim | null>(null);
  const [busy, setBusy] = useState<'download' | 'render' | null>(null);
  const [trimSheet, setTrimSheet] = useState<{
    visible: boolean;
    config: SavedTrimSheetConfig | null;
  }>({ visible: false, config: null });

  const optionsRef = useRef(options);
  const pendingRef = useRef<SavedAudioPendingTrim | null>(null);
  const originalRef = useRef<SavedAudioOriginal | null>(null);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    optionsRef.current = options;
  });

  const isStale = useCallback(
    (generation: number) => generation !== generationRef.current || !mountedRef.current,
    [],
  );

  const setPendingTrim = useCallback((next: SavedAudioPendingTrim | null) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const closeTrimSheet = useCallback(() => {
    setTrimSheet((current) => (current.visible ? { ...current, visible: false } : current));
  }, []);

  // The sheet owns an expo-audio player while mounted: the screen mounts it
  // only while `config` exists and unmounts it here, once the Modal has fully
  // dismissed (never mid-animation, never if a newer session re-opened it).
  const handleTrimSheetDismissed = useCallback(() => {
    setTrimSheet((current) => (current.visible ? current : { visible: false, config: null }));
  }, []);

  /** Deletes every local file this session created, and supersedes anything in flight. */
  const discardAll = useCallback(() => {
    generationRef.current += 1;
    const files = [pendingRef.current?.localUri, originalRef.current?.localUri];
    pendingRef.current = null;
    originalRef.current = null;
    for (const uri of files) {
      void discardAudioClip(uri);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      discardAll();
    };
  }, [discardAll]);

  const openTrim = useCallback(async () => {
    const { audioClipUrl, isOnline, hasUserNote, setErrorMessage } = optionsRef.current;
    if (busyRef.current || !MomoraAudio.isAvailable()) {
      return;
    }
    if (!isOnline) {
      setErrorMessage(SAVED_TRIM_OFFLINE_COPY);
      return;
    }
    setErrorMessage('');

    let original = originalRef.current;
    if (!original) {
      if (!audioClipUrl) {
        setErrorMessage(SAVED_TRIM_LOAD_FAILED_COPY);
        return;
      }
      const generation = ++generationRef.current;
      busyRef.current = true;
      setBusy('download');
      let destination: string | null = null;
      try {
        destination = await newAudioRecordingUri('m4a');
        const download = await FileSystem.downloadAsync(audioClipUrl, destination);
        if (isStale(generation)) {
          void discardAudioClip(destination);
          return;
        }
        // downloadAsync resolves (and writes the error body) on a non-2xx,
        // e.g. an expired signed URL.
        if (download.status < 200 || download.status >= 300) {
          throw new Error('download_failed');
        }
        const energies = await MomoraAudio.analyze(destination, ANALYZE_OPTIONS);
        if (isStale(generation)) {
          void discardAudioClip(destination);
          return;
        }
        original = { localUri: destination, durationMs: energies.durationMs, energies };
        originalRef.current = original;
      } catch {
        void discardAudioClip(destination);
        if (!isStale(generation)) {
          setErrorMessage(
            optionsRef.current.isOnline ? SAVED_TRIM_LOAD_FAILED_COPY : SAVED_TRIM_OFFLINE_COPY,
          );
        }
        return;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(null);
        }
      }
    }

    const { energies } = original;
    let initialRange: TrimRange | null = pendingRef.current?.range ?? null;
    let suggested = false;
    if (!initialRange) {
      const suggestion = suggestTrim(energies.energies, energies.bucketMs);
      // The last energy bucket can overshoot the real length: clamp to it.
      const clamped = suggestion
        ? { startMs: suggestion.startMs, endMs: Math.min(suggestion.endMs, original.durationMs) }
        : null;
      if (clamped && clamped.endMs - clamped.startMs >= MIN_SELECTION_MS) {
        initialRange = clamped;
        suggested = true;
      }
    }
    initialRange ??= { startMs: 0, endMs: original.durationMs };

    trackEvent('audio_trim_opened', { source: 'saved', suggested });
    setTrimSheet({
      visible: true,
      config: {
        sourceUri: original.localUri,
        durationMs: original.durationMs,
        energies: energies.energies,
        bucketMs: energies.bucketMs,
        initialRange,
        suggested,
        maxSelectionMs: MAX_SELECTION_MS,
        mustTrim: false,
        hasUserNote: hasUserNote(),
      },
    });
  }, [isStale]);

  const renderAndApply = useCallback(
    async (original: SavedAudioOriginal, range: TrimRange) => {
      const generation = ++generationRef.current;
      busyRef.current = true;
      setBusy('render');
      let outputUri: string | null = null;
      const discardStale = (uris: (string | null)[]) => {
        for (const uri of new Set(uris)) {
          void discardAudioClip(uri);
        }
      };
      try {
        outputUri = await newAudioRecordingUri('m4a');
        const rendered = await MomoraAudio.render(original.localUri, {
          startMs: range.startMs,
          endMs: range.endMs,
          outputUri,
          bitrate: TRIM_RENDER_BITRATE,
        });
        if (isStale(generation)) {
          discardStale([outputUri, rendered.uri]);
          return;
        }

        let energies: AudioEnergies | null = null;
        try {
          energies = await MomoraAudio.analyze(rendered.uri, ANALYZE_OPTIONS);
        } catch {
          // Waveform stays null (seeded trace); the trim itself succeeded.
        }
        if (isStale(generation)) {
          discardStale([outputUri, rendered.uri]);
          return;
        }

        const previous = pendingRef.current;
        setPendingTrim({
          localUri: rendered.uri,
          durationMs: energies?.durationMs ?? rendered.durationMs,
          sizeBytes: rendered.sizeBytes,
          waveform: energies ? sanitizeWaveform(waveformFromEnergies(energies.energies)) : null,
          range,
          removedMs: Math.max(0, original.durationMs - (range.endMs - range.startMs)),
        });
        if (previous && previous.localUri !== rendered.uri) {
          void discardAudioClip(previous.localUri);
        }
      } catch {
        // render failed (partial output is deleted natively; this covers a
        // URI we minted but never wrote to).
        discardStale([outputUri]);
        if (!isStale(generation)) {
          optionsRef.current.setErrorMessage(SAVED_TRIM_FAILED_COPY);
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(null);
        }
      }
    },
    [isStale, setPendingTrim],
  );

  const handleTrimCancel = useCallback(() => {
    closeTrimSheet();
  }, [closeTrimSheet]);

  const handleTrimDone = useCallback(
    (range: TrimRange) => {
      closeTrimSheet();
      const original = originalRef.current;
      if (!original) {
        return;
      }
      const current = pendingRef.current;
      if (isFullRange(range, original.durationMs)) {
        // The whole clip: nothing to cut, so drop any pending trim.
        if (current) {
          generationRef.current += 1;
          setPendingTrim(null);
          void discardAudioClip(current.localUri);
        }
        return;
      }
      if (current && isSameRange(range, current.range)) {
        return;
      }
      void renderAndApply(original, range);
    },
    [closeTrimSheet, renderAndApply, setPendingTrim],
  );

  /**
   * Call once the trimmed clip has been saved. Returns the pending trim and
   * every local file of the session, and stops this hook from deleting them on
   * unmount: the caller still needs the render for transcription and deletes
   * the files itself once that settles.
   */
  const handOffFiles = useCallback(() => {
    const trim = pendingRef.current;
    if (!trim) {
      return null;
    }
    const uris = [trim.localUri, originalRef.current?.localUri].filter(
      (uri): uri is string => Boolean(uri),
    );
    pendingRef.current = null;
    originalRef.current = null;
    return { trim, uris };
  }, []);

  return {
    pending,
    isBusy: busy !== null,
    isDownloading: busy === 'download',
    trimSheet,
    openTrim,
    handleTrimCancel,
    handleTrimDone,
    handleTrimSheetDismissed,
    handOffFiles,
  };
}
