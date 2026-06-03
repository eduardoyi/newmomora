import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { colors } from '@/constants/theme';
import { processVoiceMemory, type VoiceFamilyMemberPayload } from '@/services/ai';
import { readLocalFileAsBase64 } from '@/utils/local-files';

const MAX_RECORDING_MS = 2 * 60 * 1000;
const MIN_RECORDING_MS = 1000;

interface VoiceMemoryButtonProps {
  familyMembers: VoiceFamilyMemberPayload[];
  onResult: (result: { cleanedText: string; mentionedMemberIds: string[] }) => void;
  onError: (message: string) => void;
  /** Render as a circular icon-only toolbar button instead of the full-width button */
  compact?: boolean;
}

export function VoiceMemoryButton({
  familyMembers,
  onResult,
  onError,
  compact = false,
}: VoiceMemoryButtonProps) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 500);
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

  const durationLabel = useMemo(() => {
    const totalSeconds = Math.floor(recorderState.durationMillis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }, [recorderState.durationMillis]);

  const startRecording = useCallback(async () => {
    onError('');

    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      onError('Microphone access is required for voice memories.');
      return;
    }

    await recorder.prepareToRecordAsync();
    recorder.record();
  }, [onError, recorder]);

  const stopRecording = useCallback(async () => {
    if (!recorderState.isRecording) {
      return;
    }

    if (recorderState.durationMillis < MIN_RECORDING_MS) {
      await recorder.stop();
      onError('Record at least one second before stopping.');
      return;
    }

    onError('');
    setIsProcessing(true);

    try {
      await recorder.stop();
      const uri = recorder.uri;

      if (!uri) {
        onError('Recording failed. Try again.');
        return;
      }

      const base64 = await readLocalFileAsBase64(uri);

      const { data, error } = await processVoiceMemory(base64, familyMembers);

      if (error || !data) {
        onError(error?.message ?? 'Voice processing failed');
        return;
      }

      onResult(data);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Voice processing failed');
    } finally {
      setIsProcessing(false);
    }
  }, [familyMembers, onError, onResult, recorder, recorderState.durationMillis, recorderState.isRecording]);

  const handlePress = () => {
    if (recorderState.isRecording) {
      void stopRecording();
      return;
    }

    void startRecording();
  };

  if (compact) {
    return (
      <Pressable
        accessibilityLabel={
          recorderState.isRecording
            ? `Stop recording (${durationLabel})`
            : 'Record voice memory'
        }
        accessibilityRole="button"
        disabled={isProcessing}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.compactBtn,
          recorderState.isRecording && styles.compactBtnRecording,
          isProcessing && styles.compactBtnDisabled,
          pressed && !isProcessing && styles.compactBtnPressed,
        ]}
        testID="new-memory-voice-button"
      >
        {isProcessing ? (
          <ActivityIndicator color={colors.primary} size="small" />
        ) : (
          <SymbolView
            name={{ ios: 'mic.fill', android: 'mic' }}
            size={20}
            tintColor={recorderState.isRecording ? colors.white : colors.ink2}
            fallback={<Text style={styles.compactBtnIcon}>♪</Text>}
          />
        )}
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isProcessing}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.voiceButton,
        recorderState.isRecording && styles.voiceButtonRecording,
        pressed && styles.voiceButtonPressed,
      ]}
      testID="new-memory-voice-button"
    >
      {isProcessing ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text style={styles.voiceButtonText}>
          {recorderState.isRecording ? `Stop recording (${durationLabel})` : 'Tap to record voice memory'}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  voiceButton: {
    alignItems: 'center',
    backgroundColor: colors.text,
    borderRadius: 12,
    paddingVertical: 16,
  },
  voiceButtonRecording: {
    backgroundColor: colors.error,
  },
  voiceButtonPressed: {
    opacity: 0.9,
  },
  voiceButtonText: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '700',
  },
  compactBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactBtnRecording: {
    backgroundColor: colors.error,
    borderColor: colors.error,
  },
  compactBtnDisabled: {
    opacity: 0.6,
  },
  compactBtnPressed: {
    opacity: 0.7,
  },
  compactBtnIcon: {
    fontSize: 20,
    color: colors.ink2,
  },
});
