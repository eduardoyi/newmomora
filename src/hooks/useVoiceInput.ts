import * as FileSystem from 'expo-file-system/legacy';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { pauseAllAudioPlayback } from '@/hooks/audio-playback-coordinator';
import { processVoiceMemory, type VoiceFamilyMemberPayload } from '@/services/ai';
import { readLocalFileAsBase64 } from '@/utils/local-files';
import {
  getOrRequestNativePermission,
  waitForNativePresentationToSettle,
} from '@/utils/native-permissions';

export const MAX_RECORDING_MS = 2 * 60 * 1000;

/**
 * `idle` -- nothing recorded yet, or a fresh recording just started.
 * `transcribing` -- kicked off the moment recording stops (docs/plans/
 * audio-memories-v1.md P2.1: "the fork must never wait"); both fork
 * branches share this one in-flight call.
 * `done` / `failed` -- terminal. `failed` never blocks "Keep the sound" --
 * only "Turn into text" depends on it.
 */
export type VoiceTranscriptionStatus = 'idle' | 'transcribing' | 'done' | 'failed';

export interface VoiceProcessingResult {
  cleanedText: string;
  /** Short AI-generated caption for a kept clip. Empty string when speech was unusable -- never an error. */
  description: string;
  mentionedMemberIds: string[];
}

export interface StoppedVoiceClip {
  /** The recorder's own temp file URI -- not yet claimed into app-owned storage. */
  localUri: string;
  durationMs: number;
}

async function discardLocalFile(uri: string | null | undefined): Promise<void> {
  if (!uri) {
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort -- an already-gone or unreadable temp file is fine to
    // ignore; this is device-local hygiene, not a user-facing failure.
  }
}

export function useVoiceInput(familyMembers: VoiceFamilyMemberPayload[], familyId: string | null) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 500);
  const [errorMessage, setErrorMessage] = useState('');
  const [stoppedClip, setStoppedClip] = useState<StoppedVoiceClip | null>(null);
  const [autoStopped, setAutoStopped] = useState(false);
  const [transcriptionStatus, setTranscriptionStatus] = useState<VoiceTranscriptionStatus>('idle');
  const [transcriptionResult, setTranscriptionResult] = useState<VoiceProcessingResult | null>(null);

  // Guards a stale transcription response (e.g. "Record again" started a new
  // clip before the previous one's call resolved) from clobbering fresher
  // state -- only the response for the currently-relevant clip is applied.
  const activeClipUriRef = useRef<string | null>(null);
  // The in-flight call's own promise, independent of this hook's component
  // lifecycle -- "Keep the sound" can close the modal (unmounting this hook)
  // while the request is still in flight, and the composer still needs the
  // eventual result to backfill the description (docs/plans/
  // audio-memories-v1.md P2.2/P2.3 "if the in-flight call resolves after the
  // memory saves, patch ... in fire-and-forget"). A plain promise keeps
  // resolving after unmount; only the setState calls above are unmount-
  // unsafe, and callers reading this ref get the resolved value directly.
  const transcriptionPromiseRef = useRef<Promise<VoiceProcessingResult | null> | null>(null);

  const kickTranscription = useCallback(
    (uri: string) => {
      activeClipUriRef.current = uri;
      setTranscriptionResult(null);
      setTranscriptionStatus('transcribing');

      const promise = (async (): Promise<VoiceProcessingResult | null> => {
        if (!familyId) {
          if (activeClipUriRef.current === uri) {
            setTranscriptionStatus('failed');
          }
          return null;
        }

        try {
          const base64 = await readLocalFileAsBase64(uri);
          const { data, error } = await processVoiceMemory(base64, familyMembers, familyId);

          if (error || !data) {
            if (activeClipUriRef.current === uri) {
              setTranscriptionStatus('failed');
            }
            return null;
          }

          const result: VoiceProcessingResult = {
            cleanedText: data.cleanedText,
            // `description` is additive to today's process-voice-memory
            // contract (docs/plans/audio-memories-v1.md P1.2) -- guarded
            // here so this hook still degrades gracefully against an
            // edge function that hasn't deployed the field yet.
            description: (data as { description?: string }).description ?? '',
            mentionedMemberIds: data.mentionedMemberIds,
          };

          if (activeClipUriRef.current === uri) {
            setTranscriptionResult(result);
            setTranscriptionStatus('done');
          }
          return result;
        } catch {
          if (activeClipUriRef.current === uri) {
            setTranscriptionStatus('failed');
          }
          return null;
        }
      })();

      transcriptionPromiseRef.current = promise;
    },
    [familyId, familyMembers],
  );

  const stopRecording = useCallback(
    async (autoStop = false): Promise<void> => {
      if (!recorderState.isRecording) {
        return;
      }

      setErrorMessage('');

      try {
        await recorder.stop();
        const uri = recorder.uri;

        if (!uri) {
          setErrorMessage('Recording failed. Try again.');
          return;
        }

        setAutoStopped(autoStop);
        setStoppedClip({ localUri: uri, durationMs: recorderState.durationMillis });
        // Kick immediately -- neither fork branch should ever wait on this
        // (docs/features/audio-memories.md "Zero-wait fork").
        kickTranscription(uri);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Voice processing failed');
      }
    },
    [kickTranscription, recorder, recorderState.durationMillis, recorderState.isRecording],
  );

  // useEffect's auto-stop path needs the latest stopRecording without
  // re-subscribing the duration-watching effect on every render.
  const stopRecordingRef = useRef(stopRecording);
  useEffect(() => {
    stopRecordingRef.current = stopRecording;
  }, [stopRecording]);

  useEffect(() => {
    if (!recorderState.isRecording) {
      return;
    }
    if (recorderState.durationMillis >= MAX_RECORDING_MS) {
      void stopRecordingRef.current(true);
    }
  }, [recorderState.durationMillis, recorderState.isRecording]);

  const startRecording = useCallback(async () => {
    setErrorMessage('');
    setStoppedClip(null);
    setAutoStopped(false);
    setTranscriptionStatus('idle');
    setTranscriptionResult(null);
    activeClipUriRef.current = null;
    transcriptionPromiseRef.current = null;

    try {
      const { permission, didRequest } = await getOrRequestNativePermission(
        () => AudioModule.getRecordingPermissionsAsync(),
        () => AudioModule.requestRecordingPermissionsAsync(),
      );
      if (!permission.granted) {
        setErrorMessage(
          permission.canAskAgain === false
            ? 'Microphone access is required for voice memories. Enable it in Settings.'
            : 'Microphone access is required for voice memories.',
        );
        return;
      }

      if (didRequest) {
        await waitForNativePresentationToSettle();
      }

      // Recording must stop anything currently playing app-wide before the
      // session is reconfigured for capture (docs/plans/audio-memories-v1.md
      // P2.1).
      pauseAllAudioPlayback();
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch {
      setErrorMessage('Could not start voice recording. Please try again.');
    }
  }, [recorder]);

  /**
   * Discards the stopped clip's local file and resets recording state --
   * call on every non-keep exit: turn-into-text (after the result is
   * applied), the modal dismissed/cancelled without keeping, or "Record
   * again". NEVER call this on "Keep the sound" -- the caller claims the
   * file (src/utils/audio-clip-custody.ts) instead.
   */
  const discardStoppedClip = useCallback(async () => {
    const uri = stoppedClip?.localUri ?? null;
    setStoppedClip(null);
    setAutoStopped(false);
    setTranscriptionStatus('idle');
    setTranscriptionResult(null);
    activeClipUriRef.current = null;
    transcriptionPromiseRef.current = null;
    await discardLocalFile(uri);
  }, [stoppedClip]);

  const recordAgain = useCallback(async () => {
    await discardStoppedClip();
    await startRecording();
  }, [discardStoppedClip, startRecording]);

  const durationLabel = useMemo(() => {
    const totalSeconds = Math.floor(recorderState.durationMillis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }, [recorderState.durationMillis]);

  return {
    isRecording: recorderState.isRecording,
    durationMillis: recorderState.durationMillis,
    durationLabel,
    errorMessage,
    stoppedClip,
    autoStopped,
    transcriptionStatus,
    transcriptionResult,
    /**
     * The current clip's in-flight transcription promise, or null once
     * settled/never started. Read this at "Keep the sound" time to hand the
     * composer something it can await even after this hook unmounts (see
     * the comment on transcriptionPromiseRef above).
     */
    transcriptionPromise: transcriptionPromiseRef.current,
    startRecording,
    stopRecording,
    discardStoppedClip,
    recordAgain,
  };
}
