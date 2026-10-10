// The new-memory composer's audio-clip state machine (docs/plans/
// audio-trim-import.md "Composer state & flows"). Owns everything about the
// single clip an `audio` memory carries: keeping a recording, trimming it,
// importing an outside voice note, the "user text beats the AI caption"
// ratchet, and which local files may be deleted when.
//
// Why this is a hook and not inline in the screen: in v1 the voice modal
// covered the composer while a clip was claimed, so every state change was a
// synchronous tap. In v2 the note field stays editable while a trim render or
// an import runs for seconds, so completions are async re-entry into live
// state. Everything below that touches state after an `await` therefore reads
// refs (never closure values) and carries a generation token.
//
// Privacy: this handles a family's voice recordings. Never log URIs,
// transcripts, notes or file names.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import type { VoiceKeptClip } from '@/components/voice-speak-it-modal';
import type { VoiceFamilyMemberPayload } from '@/services/ai';
import { trackEvent, type AnalyticsEventMap } from '@/services/analytics';
import { importAudioFile, type AudioImportEntry, type NeedsTrim } from '@/services/audio-import';
import { transcribeClip, type VoiceProcessingResult } from '@/services/voice-transcription';
import { discardAudioClip, newAudioRecordingUri } from '@/utils/audio-clip-custody';
import { sanitizeWaveform, suggestTrim, waveformFromEnergies } from '@/utils/audio-waveform';

import * as MomoraAudio from '../../modules/momora-audio';
import type { AudioEnergies } from '../../modules/momora-audio';

export type ComposerAudioSource = 'recorded' | 'imported';

export interface ComposerAudioOriginal {
  /** The pre-trim source the trim sheet always edits relative to. */
  localUri: string;
  durationMs: number;
  /** Null for a fresh recording (never measured; only imports need it). */
  sizeBytes: number | null;
  energies: AudioEnergies | null;
  /** This exact file may be uploaded as the memory's clip (recorded, or a passthrough import). */
  uploadable: boolean;
  /** Restored on a full-range Done so un-trimming costs no extra call. */
  transcription: VoiceProcessingResult | null;
}

export interface ComposerAudioClip {
  /** The clip that will be saved (claimed, inside audio-recordings/). */
  localUri: string;
  durationMs: number;
  sizeBytes: number | null;
  /** 64 buckets of THIS clip; null when analysis is unavailable/failed/late. */
  waveform: number[] | null;
  source: ComposerAudioSource;
  original: ComposerAudioOriginal;
  trimmed: boolean;
  /** The cut relative to `original` (only when `trimmed`); reopens the sheet where it was left. */
  trimRange: { startMs: number; endMs: number } | null;
}

export interface TrimSheetConfig {
  sourceUri: string;
  durationMs: number;
  energies: number[];
  bucketMs: number;
  initialRange: { startMs: number; endMs: number };
  suggested: boolean;
  maxSelectionMs: number;
  mustTrim: boolean;
  hasUserNote: boolean;
}

export const RECORDED_MAX_SELECTION_MS = 120_000;
export const IMPORTED_MAX_SELECTION_MS = 300_000;
/** `handleSaveAudio` waits this long for a still-running analysis, then saves with `waveform: null`. */
export const SAVE_ANALYSIS_WAIT_MS = 1500;
/** Upper bound on waiting for a closing Modal's `onDismissed` before opening the next one. */
const MODAL_SETTLE_TIMEOUT_MS = 1500;
const TRIM_RENDER_BITRATE = 96_000;
const ANALYZE_OPTIONS = { maxBuckets: 4000, minBucketMs: 20 } as const;
const MIN_SELECTION_MS = 1000;
// Handles are quantised by the sheet, so "the whole clip" is matched with a
// little slack rather than exactly.
const SAME_RANGE_TOLERANCE_MS = 50;

export const AUDIO_IMPORT_REFUSED_PHOTOS_COPY =
  'This memory already has photos. Save it first, then share the voice note.';
export const AUDIO_IMPORT_REFUSED_ARTWORK_COPY =
  'This memory is artwork. Save it first, then add a sound.';
export const SHARE_PHOTOS_REFUSED_SOUND_COPY =
  'This memory is a sound. Save it first, then share photos.';
export const AUDIO_IMPORT_UPDATE_COPY = 'Update Momora to bring in voice notes.';
export const AUDIO_TRIM_FAILED_COPY = "Couldn't trim that sound. Try again.";

/** Refusal copy for an import blocked by attached media: scanned artwork gets its own wording. */
function importRefusedCopy(attached: readonly unknown[]): string {
  return attached.some((item) => (item as { source?: string } | null)?.source === 'scan')
    ? AUDIO_IMPORT_REFUSED_ARTWORK_COPY
    : AUDIO_IMPORT_REFUSED_PHOTOS_COPY;
}

type ComposerAudioRange = { startMs: number; endMs: number };

type TrimTarget =
  | { kind: 'edit'; original: ComposerAudioOriginal; source: ComposerAudioSource }
  | {
      kind: 'import';
      original: ComposerAudioOriginal;
      source: 'imported';
      suggestedDateIso: string | null;
    };

interface ApplyKeptClipInput {
  clip: ComposerAudioClip;
  /** Already resolved by keep time (the user sat at the fork long enough). */
  transcriptionResult: VoiceProcessingResult | null;
  /** Still in flight; applied late, guarded by identity. */
  pendingTranscription: Promise<VoiceProcessingResult | null> | null;
  /** Fresh recordings only: analysis still running; its result fills in waveform + energies. */
  analysis: Promise<AudioEnergies | null> | null;
}

export interface ImportAudioInput {
  uri: string;
  fileName: string;
  mimeType: string | null | undefined;
  sizeBytes?: number | null;
  entry: AudioImportEntry;
}

interface UseComposerAudioClipOptions {
  /** The note field's live text (the screen keeps it in sync on every change). */
  contentRef: MutableRefObject<string>;
  /** Only `.length` is read: photos and a sound are mutually exclusive. */
  attachedMediaRef: MutableRefObject<readonly unknown[]>;
  setContent: (text: string) => void;
  setErrorMessage: (message: string) => void;
  applyVoiceResult: (result: { cleanedText: string; mentionedMemberIds: string[] }) => void;
  members: readonly { id: string }[];
  voiceMembers: VoiceFamilyMemberPayload[];
  familyId: string | null;
  /** `memory_saved.used_voice` -- set for recordings, never for imports. */
  usedVoiceRef: MutableRefObject<boolean>;
  /**
   * Resolves once any Modal that is still closing (the bring-in sheet) has
   * dismissed. iOS will not present a Modal while another is dismissing, so
   * the must-trim sheet waits on this.
   */
  awaitModalsSettled?: () => Promise<void>;
}

function startAnalysis(uri: string): Promise<AudioEnergies | null> | null {
  if (!MomoraAudio.isAvailable()) {
    return null;
  }
  return MomoraAudio.analyze(uri, ANALYZE_OPTIONS).catch(() => null);
}

function waveformFor(energies: AudioEnergies | null): number[] | null {
  return energies ? sanitizeWaveform(waveformFromEnergies(energies.energies)) : null;
}

function isFullRange(range: ComposerAudioRange, durationMs: number): boolean {
  return (
    range.startMs <= SAME_RANGE_TOLERANCE_MS && range.endMs >= durationMs - SAME_RANGE_TOLERANCE_MS
  );
}

function isSameRange(a: ComposerAudioRange, b: ComposerAudioRange): boolean {
  return (
    Math.abs(a.startMs - b.startMs) <= SAME_RANGE_TOLERANCE_MS &&
    Math.abs(a.endMs - b.endMs) <= SAME_RANGE_TOLERANCE_MS
  );
}

/** Total seconds cut from the clip, bucketed (no exact durations in analytics). */
function bucketRemovedMs(
  removedMs: number,
): AnalyticsEventMap['audio_trim_applied']['removed_bucket'] {
  const seconds = Math.max(0, removedMs) / 1000;
  if (seconds <= 5) return '0_5s';
  if (seconds <= 15) return '5_15s';
  if (seconds <= 60) return '15_60s';
  return '60s_plus';
}

function initialMustTrimRange(
  durationMs: number,
  suggested: ComposerAudioRange | null,
): ComposerAudioRange {
  if (suggested) {
    const startMs = Math.max(0, suggested.startMs);
    const endMs = Math.min(suggested.endMs, durationMs, startMs + IMPORTED_MAX_SELECTION_MS);
    if (endMs - startMs >= MIN_SELECTION_MS) {
      return { startMs, endMs };
    }
  }
  return { startMs: 0, endMs: Math.min(durationMs, IMPORTED_MAX_SELECTION_MS) };
}

export function useComposerAudioClip(options: UseComposerAudioClipOptions) {
  const [audioClip, setAudioClip] = useState<ComposerAudioClip | null>(null);
  const [audioClipRemoved, setAudioClipRemoved] = useState(false);
  const [audioTranscript, setAudioTranscript] = useState<string | null>(null);
  const [audioNoteGenerating, setAudioNoteGenerating] = useState(false);
  const [audioCapturedAtIso, setAudioCapturedAtIso] = useState<string | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const [importCount, setImportCount] = useState(0);
  const [isImportTrimPending, setIsImportTrimPending] = useState(false);
  const [trimSheet, setTrimSheet] = useState<{ visible: boolean; config: TrimSheetConfig | null }>({
    visible: false,
    config: null,
  });

  // Refs mirror state that async completions read. `audioClipRef` and
  // `audioTranscriptRef` are written synchronously with the state (commit*),
  // not in an effect, because a completion can run between a state write and
  // the next render.
  const audioClipRef = useRef<ComposerAudioClip | null>(null);
  const audioClipRemovedRef = useRef(false);
  const audioTranscriptRef = useRef<string | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Ratchets true the instant the user types anything (or already had text
  // before a clip was kept) and NEVER goes back to false: once the user has
  // authored the note, no later AI description (re-record, trim,
  // import) may overwrite it. Keep-time ORs in the live text (see
  // applyKeptClip), so an async completion that lands after the user edited
  // the note mid-render can't flip it back.
  const hasTypedNoteRef = useRef(false);
  // The exact description `applyAudioTranscriptionResult` last wrote into the
  // note. Lets keep-time tell "the AI's own words, untouched" (replaceable,
  // it describes a sound that is being replaced) from text the user typed.
  const lastAppliedAiCaptionRef = useRef<string | null>(null);
  // The kept clip's transcription while still in flight; awaited at save time
  // by the pending-uploads queue to backfill the description post-save. Also
  // the identity guard: a late result applies only if it is still this one.
  const pendingTranscriptionRef = useRef<Promise<VoiceProcessingResult | null> | null>(null);
  // Same idea for the waveform analysis of a fresh recording.
  const pendingAnalysisRef = useRef<{ uri: string; promise: Promise<AudioEnergies | null> } | null>(null);

  // Generation token: every trim / import / re-record bumps it. A completion
  // whose token is no longer current is stale -- it discards its own output
  // files and does nothing else (never touches state, never starts a
  // transcription).
  const audioOpGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const abandonedRef = useRef(false);
  const savedRef = useRef(false);
  // In-flight counters in refs too: openTrim / import need a synchronous answer.
  const renderCountRef = useRef(0);
  // The file an in-flight render is READING (the original). Never delete a
  // file a render may still be using; its completion discards it instead.
  const renderSourceUriRef = useRef<string | null>(null);
  const trimTargetRef = useRef<TrimTarget | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const commitClip = useCallback((next: ComposerAudioClip | null) => {
    audioClipRef.current = next;
    setAudioClip(next);
  }, []);

  const commitRemoved = useCallback((removed: boolean) => {
    audioClipRemovedRef.current = removed;
    setAudioClipRemoved(removed);
  }, []);

  const commitTranscript = useCallback((transcript: string | null) => {
    audioTranscriptRef.current = transcript;
    setAudioTranscript(transcript);
  }, []);

  const writeContent = useCallback((text: string) => {
    optionsRef.current.contentRef.current = text;
    optionsRef.current.setContent(text);
  }, []);

  const bumpGeneration = useCallback(() => {
    audioOpGenerationRef.current += 1;
    return audioOpGenerationRef.current;
  }, []);

  const isStale = useCallback(
    (generation: number) => generation !== audioOpGenerationRef.current || !mountedRef.current,
    [],
  );

  // The composer was cancelled (or left without saving): nothing a late
  // completion produces will ever be used, including the source it read.
  const isAbandoned = useCallback(
    () => abandonedRef.current || (!mountedRef.current && !savedRef.current),
    [],
  );

  const discardStale = useCallback(
    (outputs: readonly (string | null | undefined)[], sourceUri?: string | null) => {
      for (const uri of new Set(outputs)) {
        void discardAudioClip(uri);
      }
      if (sourceUri && isAbandoned()) {
        void discardAudioClip(sourceUri);
      }
    },
    [isAbandoned],
  );

  // ── Note / caption handling ───────────────────────────────────────────

  const markNoteTyped = useCallback(() => {
    hasTypedNoteRef.current = true;
  }, []);

  const isUntouchedAiCaption = useCallback((content: string) => {
    const trimmed = content.trim();
    return trimmed.length > 0 && trimmed === (lastAppliedAiCaptionRef.current ?? '').trim();
  }, []);

  // Applies a transcription result (already resolved, or arriving late) to
  // the composer: the description fills the note only while the user hasn't
  // authored one, and mentioned members are auto-tagged the way dictation does.
  const applyAudioTranscriptionResult = useCallback((result: VoiceProcessingResult) => {
    const { members, applyVoiceResult } = optionsRef.current;
    commitTranscript(result.cleanedText.trim() || null);
    if (!hasTypedNoteRef.current) {
      writeContent(result.description);
      lastAppliedAiCaptionRef.current = result.description;
    }
    const mentionedMemberIds =
      result.mentionedMemberIds.length === 0 && members.length === 1
        ? [members[0].id]
        : result.mentionedMemberIds;
    applyVoiceResult({ cleanedText: result.cleanedText, mentionedMemberIds });
  }, [commitTranscript, writeContent]);

  // ── The shared keep logic ─────────────────────────────────────────────
  // Every way a clip enters the composer (fork keep, re-record, trim result,
  // full-range restore, import) lands here. Reads live state only.
  const applyKeptClip = useCallback((input: ApplyKeptClipInput) => {
    let next = input.clip;
    const previous = audioClipRef.current;

    // File ownership: delete only what the new clip does not use. Dedupes
    // against BOTH of the new clip's files, so a trim (same `original`) keeps
    // the original, a restore keeps the original as the clip, and a re-record
    // or second import (new original) discards the old original too. The
    // saved/queued file is never in `previous` at this point (save is final).
    if (previous) {
      const keep = new Set([next.localUri, next.original.localUri]);
      for (const uri of new Set([previous.localUri, previous.original.localUri])) {
        if (!keep.has(uri)) {
          void discardAudioClip(uri);
        }
      }
    }

    // An untrimmed clip IS its original, so its transcription is the
    // original's transcription (restored on a later full-range Done).
    if (next.localUri === next.original.localUri && input.transcriptionResult) {
      next = { ...next, original: { ...next.original, transcription: input.transcriptionResult } };
    }

    commitClip(next);
    commitRemoved(false);

    // "User owns the note" = there's text AND it isn't just the previous
    // clip's untouched AI caption (which describes a sound being replaced).
    // OR-ed into the ratchet and read from the live note, never a closure.
    const liveContent = optionsRef.current.contentRef.current;
    const untouchedAiCaption = isUntouchedAiCaption(liveContent);
    const hasTypedNow = liveContent.trim().length > 0 && !untouchedAiCaption;
    hasTypedNoteRef.current = hasTypedNoteRef.current || hasTypedNow;

    // The previous clip's transcript describes a different sound: a failed or
    // late re-transcription must save null, never the old clip's words.
    commitTranscript(null);
    pendingTranscriptionRef.current = null;

    if (input.transcriptionResult) {
      setAudioNoteGenerating(false);
      applyAudioTranscriptionResult(input.transcriptionResult);
    } else if (input.pendingTranscription) {
      if (untouchedAiCaption) {
        // The old caption is about to be superseded by one for the new clip:
        // clear it now so the generating treatment shows instead of a stale
        // caption with no hint that it's about to change.
        writeContent('');
      }
      setAudioNoteGenerating(true);
      const awaited = input.pendingTranscription;
      pendingTranscriptionRef.current = awaited;
      void awaited.then((result) => {
        // The original's transcription is kept even if this clip has since
        // been trimmed away, so a later full-range Done can restore it.
        if (result && next.localUri === next.original.localUri) {
          const current = audioClipRef.current;
          if (current && current.original.localUri === next.original.localUri) {
            commitClip({
              ...current,
              original: { ...current.original, transcription: result },
            });
          }
        }
        // A re-record / trim replace, or a stale response from a previous
        // clip, must not resurrect the generating UI or apply a result that
        // no longer belongs to the clip currently in the composer.
        if (pendingTranscriptionRef.current !== awaited) {
          return;
        }
        pendingTranscriptionRef.current = null;
        setAudioNoteGenerating(false);
        if (result) {
          applyAudioTranscriptionResult(result);
        }
      });
    } else {
      setAudioNoteGenerating(false);
    }

    if (input.analysis) {
      const entry = { uri: next.localUri, promise: input.analysis };
      pendingAnalysisRef.current = entry;
      void Promise.resolve(input.analysis)
        .catch(() => null)
        .then((energies) => {
          if (pendingAnalysisRef.current !== entry) {
            return;
          }
          pendingAnalysisRef.current = null;
          const current = audioClipRef.current;
          // Failure leaves waveform null (seeded trace) and no trim button.
          if (!energies || !current || current.localUri !== entry.uri) {
            return;
          }
          // The decoded length is the duration the app trusts; the
          // recorder's can be ~0.5 s short.
          const isOriginal = current.original.localUri === entry.uri;
          commitClip({
            ...current,
            durationMs: energies.durationMs,
            waveform: waveformFor(energies),
            original: isOriginal
              ? { ...current.original, durationMs: energies.durationMs, energies }
              : current.original,
          });
        });
    } else {
      pendingAnalysisRef.current = null;
    }
  }, [
    applyAudioTranscriptionResult,
    commitClip,
    commitRemoved,
    commitTranscript,
    isUntouchedAiCaption,
    writeContent,
  ]);

  // ── Recording (fork / re-record keep) ─────────────────────────────────

  const closeTrimSheet = useCallback(() => {
    setTrimSheet((current) => (current.visible ? { ...current, visible: false } : current));
  }, []);

  // The sheet owns an expo-audio player for as long as it is mounted, so the
  // screen mounts it only while `trimSheet.config` exists and unmounts it
  // here, once the Modal has fully dismissed (never while it is animating
  // out, and never if a newer session already re-opened it).
  const handleTrimSheetDismissed = useCallback(() => {
    setTrimSheet((current) => (current.visible ? current : { visible: false, config: null }));
  }, []);

  // A must-trim import still waiting on its sheet is superseded (a new import
  // or a recording took over): its claimed source has nowhere else to go.
  const dropPendingImportTrim = useCallback(() => {
    const target = trimTargetRef.current;
    if (target?.kind === 'import') {
      trimTargetRef.current = null;
      setIsImportTrimPending(false);
      closeTrimSheet();
      void discardAudioClip(target.original.localUri);
    }
  }, [closeTrimSheet]);


  const keepRecordedSound = useCallback((kept: VoiceKeptClip) => {
    optionsRef.current.usedVoiceRef.current = true;
    bumpGeneration();
    dropPendingImportTrim();
    setAudioCapturedAtIso(null);
    // The fork modal already analysed the stopped clip (and drew it); reuse
    // that promise so the file isn't decoded twice.
    const analysis = kept.pendingAnalysis ?? startAnalysis(kept.localUri);
    applyKeptClip({
      clip: {
        localUri: kept.localUri,
        durationMs: kept.durationMs,
        sizeBytes: null,
        waveform: null,
        source: 'recorded',
        original: {
          localUri: kept.localUri,
          durationMs: kept.durationMs,
          sizeBytes: null,
          energies: null,
          uploadable: true,
          transcription: null,
        },
        trimmed: false,
        trimRange: null,
      },
      transcriptionResult: kept.transcriptionResult,
      pendingTranscription: kept.pendingTranscription,
      analysis,
    });
  }, [applyKeptClip, bumpGeneration, dropPendingImportTrim]);

  const removeClip = useCallback(() => {
    commitRemoved(true);
  }, [commitRemoved]);

  const undoRemoveClip = useCallback(() => {
    commitRemoved(false);
  }, [commitRemoved]);

  const skipNoteGeneration = useCallback(() => {
    setAudioNoteGenerating(false);
    hasTypedNoteRef.current = true;
    pendingTranscriptionRef.current = null;
  }, []);

  // ── Trim ──────────────────────────────────────────────────────────────

  const hasUserNote = useCallback(() => {
    const live = optionsRef.current.contentRef.current;
    return hasTypedNoteRef.current || (live.trim().length > 0 && !isUntouchedAiCaption(live));
  }, [isUntouchedAiCaption]);

  const openTrim = useCallback(() => {
    const clip = audioClipRef.current;
    const energies = clip?.original.energies;
    if (
      !clip ||
      !energies ||
      audioClipRemovedRef.current ||
      renderCountRef.current > 0 ||
      !MomoraAudio.isAvailable()
    ) {
      return;
    }
    const { original } = clip;

    let initialRange: ComposerAudioRange | null =
      clip.trimmed && clip.trimRange ? clip.trimRange : null;
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

    trimTargetRef.current = { kind: 'edit', original, source: clip.source };
    trackEvent('audio_trim_opened', { source: clip.source, suggested });
    setTrimSheet({
      visible: true,
      config: {
        sourceUri: original.localUri,
        durationMs: original.durationMs,
        energies: energies.energies,
        bucketMs: energies.bucketMs,
        initialRange,
        suggested,
        maxSelectionMs:
          clip.source === 'imported' ? IMPORTED_MAX_SELECTION_MS : RECORDED_MAX_SELECTION_MS,
        mustTrim: false,
        hasUserNote: hasUserNote(),
      },
    });
  }, [hasUserNote]);

  const beginRender = useCallback(() => {
    renderCountRef.current += 1;
    setRenderCount(renderCountRef.current);
  }, []);

  const endRender = useCallback(() => {
    renderCountRef.current = Math.max(0, renderCountRef.current - 1);
    setRenderCount(renderCountRef.current);
  }, []);

  // Cuts `original` to `range`, analyses the result, then enters it through
  // the shared keep logic with a FRESH transcription (the cut changes what
  // was said). Used by the trim sheet's Done and by must-trim imports.
  const renderAndApply = useCallback(
    async (target: TrimTarget, range: ComposerAudioRange) => {
      const { original, source } = target;
      const generation = bumpGeneration();
      beginRender();
      renderSourceUriRef.current = original.localUri;
      let outputUri: string | null = null;
      try {
        outputUri = await newAudioRecordingUri('m4a');
        const rendered = await MomoraAudio.render(original.localUri, {
          startMs: range.startMs,
          endMs: range.endMs,
          outputUri,
          bitrate: TRIM_RENDER_BITRATE,
        });
        if (isStale(generation)) {
          discardStale([outputUri, rendered.uri], original.localUri);
          return;
        }

        let energies: AudioEnergies | null = null;
        try {
          energies = await MomoraAudio.analyze(rendered.uri, ANALYZE_OPTIONS);
        } catch {
          // Waveform stays null (seeded trace); the trim itself succeeded.
        }
        if (isStale(generation)) {
          discardStale([outputUri, rendered.uri], original.localUri);
          return;
        }

        const durationMs = energies?.durationMs ?? rendered.durationMs;
        const { voiceMembers, familyId } = optionsRef.current;
        const transcription = transcribeClip(rendered.uri, voiceMembers, familyId, {
          ...(source === 'imported' ? { speaker: 'unknown' as const } : {}),
          durationMs,
          sizeBytes: rendered.sizeBytes,
        });

        if (target.kind === 'import') {
          setAudioCapturedAtIso(target.suggestedDateIso);
        }
        applyKeptClip({
          clip: {
            localUri: rendered.uri,
            durationMs,
            sizeBytes: rendered.sizeBytes,
            waveform: waveformFor(energies),
            source,
            original,
            trimmed: true,
            trimRange: range,
          },
          transcriptionResult: null,
          pendingTranscription: transcription,
          analysis: null,
        });
        trackEvent('audio_trim_applied', {
          source,
          removed_bucket: bucketRemovedMs(original.durationMs - (range.endMs - range.startMs)),
        });
      } catch {
        // render failed (partial output is deleted natively; this covers a
        // URI we minted but never wrote to).
        discardStale([outputUri], original.localUri);
        if (!isStale(generation)) {
          optionsRef.current.setErrorMessage(AUDIO_TRIM_FAILED_COPY);
        }
      } finally {
        if (renderSourceUriRef.current === original.localUri) {
          renderSourceUriRef.current = null;
        }
        endRender();
      }
    },
    [applyKeptClip, beginRender, bumpGeneration, discardStale, endRender, isStale],
  );

  const restoreOriginal = useCallback(
    (original: ComposerAudioOriginal, source: ComposerAudioSource) => {
      bumpGeneration();
      applyKeptClip({
        clip: {
          localUri: original.localUri,
          durationMs: original.durationMs,
          sizeBytes: original.sizeBytes,
          waveform: waveformFor(original.energies),
          source,
          original,
          trimmed: false,
          trimRange: null,
        },
        // Restored, not re-requested: un-trimming costs no transcription.
        transcriptionResult: original.transcription,
        pendingTranscription: null,
        analysis: null,
      });
    },
    [applyKeptClip, bumpGeneration],
  );

  const handleTrimCancel = useCallback(() => {
    closeTrimSheet();
    const target = trimTargetRef.current;
    trimTargetRef.current = null;
    if (target?.kind === 'import') {
      // Must-trim import abandoned: nothing of it may linger on disk.
      setIsImportTrimPending(false);
      void discardAudioClip(target.original.localUri);
    }
  }, [closeTrimSheet]);

  const handleTrimDone = useCallback(
    (range: ComposerAudioRange) => {
      closeTrimSheet();
      const target = trimTargetRef.current;
      trimTargetRef.current = null;
      if (!target) {
        return;
      }
      if (target.kind === 'import') {
        setIsImportTrimPending(false);
        void renderAndApply(target, range);
        return;
      }

      const clip = audioClipRef.current;
      if (!clip) {
        return;
      }
      const { original } = target;
      const full = isFullRange(range, original.durationMs);
      // Nothing changed: don't re-render or re-transcribe.
      if (full && !clip.trimmed) {
        return;
      }
      if (!full && clip.trimmed && clip.trimRange && isSameRange(range, clip.trimRange)) {
        return;
      }
      if (full && original.uploadable) {
        restoreOriginal(original, target.source);
        return;
      }
      void renderAndApply(target, range);
    },
    [closeTrimSheet, renderAndApply, restoreOriginal],
  );

  // ── Import ────────────────────────────────────────────────────────────

  const openMustTrim = useCallback(
    async (result: NeedsTrim, generation: number) => {
      const original: ComposerAudioOriginal = { ...result.original, transcription: null };
      const initialRange = initialMustTrimRange(original.durationMs, result.suggested);
      trimTargetRef.current = {
        kind: 'import',
        original,
        source: 'imported',
        suggestedDateIso: result.suggestedDateIso,
      };
      // Counts as "still bringing in" (draft restore stays deferred) until
      // the clip is in the composer or the sheet is cancelled.
      setIsImportTrimPending(true);

      // iOS won't present a Modal while another is dismissing.
      const settled = optionsRef.current.awaitModalsSettled;
      if (settled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          settled().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, MODAL_SETTLE_TIMEOUT_MS);
          }),
        ]);
        if (timer) {
          clearTimeout(timer);
        }
      }
      // A newer import / cancel may have taken over while we waited; the
      // owner of the target is whoever holds trimTargetRef now.
      if (isStale(generation) || trimTargetRef.current?.original !== original) {
        return;
      }

      trackEvent('audio_trim_opened', { source: 'imported', suggested: result.suggested !== null });
      setTrimSheet({
        visible: true,
        config: {
          sourceUri: original.localUri,
          durationMs: original.durationMs,
          energies: result.original.energies.energies,
          bucketMs: result.original.energies.bucketMs,
          initialRange,
          suggested: result.suggested !== null,
          maxSelectionMs: IMPORTED_MAX_SELECTION_MS,
          mustTrim: true,
          hasUserNote: hasUserNote(),
        },
      });
    },
    [hasUserNote, isStale],
  );

  const importAudio = useCallback(
    async (input: ImportAudioInput) => {
      const { entry } = input;
      const { attachedMediaRef, setErrorMessage, voiceMembers, familyId } = optionsRef.current;
      // The payload (share) / cache copy (picker) is ours to remove when we
      // refuse before importAudioFile gets to own it.
      if (attachedMediaRef.current.length > 0) {
        setErrorMessage(importRefusedCopy(attachedMediaRef.current));
        void discardAudioClip(input.uri);
        return;
      }
      if (!MomoraAudio.isAvailable()) {
        setErrorMessage(AUDIO_IMPORT_UPDATE_COPY);
        trackEvent('audio_import_failed', { entry, code: 'unavailable' });
        void discardAudioClip(input.uri);
        return;
      }

      dropPendingImportTrim();
      setErrorMessage('');
      const generation = bumpGeneration();
      setImportCount((count) => count + 1);
      trackEvent('audio_import_started', { entry });
      try {
        const result = await importAudioFile({
          uri: input.uri,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          entry,
        });

        if (result.kind === 'error') {
          // importAudioFile already removed everything it created.
          trackEvent('audio_import_failed', { entry, code: result.code });
          if (!isStale(generation)) {
            optionsRef.current.setErrorMessage(result.message);
          }
          return;
        }

        const resultUris =
          result.kind === 'clip'
            ? [result.clip.localUri, result.original.localUri]
            : [result.original.localUri];
        if (isStale(generation)) {
          // Superseded (another import / the composer left): drop the output.
          discardStale(resultUris);
          return;
        }
        // Mutual exclusion is re-checked at completion: photos may have been
        // attached while the file was being read.
        if (optionsRef.current.attachedMediaRef.current.length > 0) {
          optionsRef.current.setErrorMessage(
            importRefusedCopy(optionsRef.current.attachedMediaRef.current),
          );
          discardStale(resultUris);
          return;
        }

        if (result.kind === 'needsTrim') {
          await openMustTrim(result, generation);
          return;
        }

        const { clip, original } = result;
        setAudioCapturedAtIso(result.suggestedDateIso);
        applyKeptClip({
          clip: {
            localUri: clip.localUri,
            durationMs: clip.durationMs,
            sizeBytes: clip.sizeBytes,
            waveform: clip.waveform,
            source: 'imported',
            original,
            trimmed: false,
            trimRange: null,
          },
          transcriptionResult: null,
          // Imports are usually someone else speaking: don't map "I/me" to
          // the parent's own member (`speaker: 'unknown'`).
          pendingTranscription: transcribeClip(clip.localUri, voiceMembers, familyId, {
            speaker: 'unknown',
            durationMs: clip.durationMs,
            sizeBytes: clip.sizeBytes,
          }),
          analysis: null,
        });
      } finally {
        setImportCount((count) => Math.max(0, count - 1));
      }
    },
    [applyKeptClip, bumpGeneration, discardStale, dropPendingImportTrim, isStale, openMustTrim],
  );

  // ── Save / cancel ─────────────────────────────────────────────────────

  /**
   * Waits (<= 1.5 s) for a still-running waveform analysis, then returns the
   * clip as it stands. On timeout the clip saves with `waveform: null` (stays
   * seeded until a backfill re-run; there is no post-save patching).
   * Null when there is nothing to save any more.
   */
  const settleForSave = useCallback(async (): Promise<ComposerAudioClip | null> => {
    const pending = pendingAnalysisRef.current;
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        // Registered after keep-time's own handler, so by the time this
        // resolves the clip already carries the waveform.
        Promise.resolve(pending.promise).catch(() => null),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SAVE_ANALYSIS_WAIT_MS);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
    if (audioClipRemovedRef.current || abandonedRef.current) {
      return null;
    }
    return audioClipRef.current;
  }, []);

  /**
   * Call right after the clip was handed to the queue. The queue owns
   * `saved.localUri` (retries re-read it): only the other files go, and only
   * when they differ from it. Late completions are made stale.
   */
  const markSaved = useCallback((savedLocalUri: string) => {
    savedRef.current = true;
    bumpGeneration();
    const clip = audioClipRef.current;
    if (clip && clip.original.localUri !== savedLocalUri) {
      void discardAudioClip(clip.original.localUri);
    }
  }, [bumpGeneration]);

  /**
   * Cancel / back: discard the current clip + its original (deduped). A
   * render in flight is still reading the original, so that one file is
   * discarded by the render's own completion instead (see discardStale).
   */
  const abandon = useCallback(() => {
    abandonedRef.current = true;
    bumpGeneration();
    const uris = new Set<string>();
    const held = audioClipRef.current;
    if (held) {
      uris.add(held.localUri);
      uris.add(held.original.localUri);
    }
    const target = trimTargetRef.current;
    if (target?.kind === 'import') {
      uris.add(target.original.localUri);
    }
    trimTargetRef.current = null;
    if (renderSourceUriRef.current) {
      uris.delete(renderSourceUriRef.current);
    }
    for (const uri of uris) {
      void discardAudioClip(uri);
    }
    closeTrimSheet();
  }, [bumpGeneration, closeTrimSheet]);

  const isAudio = audioClip !== null;
  const isRendering = renderCount > 0;
  const isImporting = importCount > 0 || isImportTrimPending;

  return {
    audioClip,
    audioClipRef,
    isAudio,
    audioClipRemoved,
    audioTranscript,
    audioTranscriptRef,
    audioNoteGenerating,
    pendingTranscriptionRef,
    /** `YYYY-MM-DD` suggested by an imported voice note; null once the clip is removed or replaced by a recording. */
    suggestedDateIso: audioClipRemoved ? null : audioCapturedAtIso,
    /** A trim render is running: the chip shows a spinner and Save / mic are disabled. */
    isRendering,
    /** An import is running (or waiting on its must-trim sheet). */
    isImporting,
    /** Save, the toolbar mic and the attach button wait on this. */
    isProcessing: isRendering || isImporting,
    /** Native module present + energies loaded: the chip may offer the scissors. */
    canTrim:
      isAudio && !audioClipRemoved && MomoraAudio.isAvailable() && Boolean(audioClip?.original.energies),
    keepRecordedSound,
    removeClip,
    undoRemoveClip,
    skipNoteGeneration,
    markNoteTyped,
    openTrim,
    trimSheet,
    handleTrimCancel,
    handleTrimDone,
    handleTrimSheetDismissed,
    importAudio,
    settleForSave,
    markSaved,
    abandon,
  };
}
