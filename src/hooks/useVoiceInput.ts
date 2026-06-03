import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { processVoiceMemory, type VoiceFamilyMemberPayload } from '@/services/ai';
import { readLocalFileAsBase64 } from '@/utils/local-files';

const MAX_RECORDING_MS = 2 * 60 * 1000;

export interface VoiceProcessingResult {
  cleanedText: string;
  mentionedMemberIds: string[];
}

export function useVoiceInput(familyMembers: VoiceFamilyMemberPayload[]) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 500);
  const [errorMessage, setErrorMessage] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    void setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    });
  }, []);

  useEffect(() => {
    if (!recorderState.isRecording) {
      return;
    }

    if (recorderState.durationMillis >= MAX_RECORDING_MS) {
      void recorder.stop();
    }
  }, [recorder, recorderState.durationMillis, recorderState.isRecording]);

  const startRecording = useCallback(async () => {
    setErrorMessage('');

    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage('Microphone access is required for voice memories.');
      return;
    }

    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [recorder]);

  const stopRecording = useCallback(async (): Promise<VoiceProcessingResult | null> => {
    if (!recorderState.isRecording) {
      return null;
    }

    setErrorMessage('');
    setIsProcessing(true);

    try {
      await recorder.stop();
      const uri = recorder.uri;

      if (!uri) {
        setErrorMessage('Recording failed. Try again.');
        return null;
      }

      const base64 = await readLocalFileAsBase64(uri);

      const { data, error } = await processVoiceMemory(base64, familyMembers);

      if (error || !data) {
        setErrorMessage(error?.message ?? 'Voice processing failed');
        return null;
      }

      return data;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Voice processing failed');
      return null;
    } finally {
      setIsProcessing(false);
    }
  }, [familyMembers, recorder, recorderState.isRecording]);

  const durationLabel = useMemo(() => {
    const totalSeconds = Math.floor(recorderState.durationMillis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }, [recorderState.durationMillis]);

  return {
    isRecording: recorderState.isRecording,
    isProcessing,
    durationLabel,
    errorMessage,
    startRecording,
    stopRecording,
  };
}
