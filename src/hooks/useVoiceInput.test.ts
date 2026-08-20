import * as FileSystem from 'expo-file-system/legacy';
import { act, renderHook } from '@testing-library/react-native';

import { pauseAllAudioPlayback } from '@/hooks/audio-playback-coordinator';
import { processVoiceMemory } from '@/services/ai';

import { useVoiceInput } from './useVoiceInput';

let mockRecorderState: { isRecording: boolean; durationMillis: number } = {
  isRecording: false,
  durationMillis: 0,
};

const mockRecorder = {
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  record: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  uri: 'file:///cache/recording-tmp.m4a',
};

const mockSetAudioModeAsync = jest.fn().mockResolvedValue(undefined);
const mockGetRecordingPermissionsAsync = jest.fn();
const mockRequestRecordingPermissionsAsync = jest.fn();

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => mockRecorderState,
  setAudioModeAsync: (...args: unknown[]) => mockSetAudioModeAsync(...args),
  AudioModule: {
    getRecordingPermissionsAsync: (...args: unknown[]) => mockGetRecordingPermissionsAsync(...args),
    requestRecordingPermissionsAsync: (...args: unknown[]) => mockRequestRecordingPermissionsAsync(...args),
  },
}));

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn().mockResolvedValue('base64-audio-data'),
}));

jest.mock('@/hooks/audio-playback-coordinator', () => ({
  pauseAllAudioPlayback: jest.fn(),
}));

jest.mock('@/services/ai', () => ({
  processVoiceMemory: jest.fn(),
}));

jest.mock('@/utils/native-permissions', () => ({
  getOrRequestNativePermission: jest.fn(async (getPermission: () => Promise<unknown>) => ({
    permission: await getPermission(),
    didRequest: false,
  })),
  waitForNativePresentationToSettle: jest.fn().mockResolvedValue(undefined),
}));

const mockedFileSystem = FileSystem as jest.Mocked<typeof FileSystem>;
const mockedProcessVoiceMemory = processVoiceMemory as jest.MockedFunction<typeof processVoiceMemory>;
const mockedPauseAllAudioPlayback = pauseAllAudioPlayback as jest.MockedFunction<typeof pauseAllAudioPlayback>;

const FAMILY_MEMBERS = [{ id: 'member-1', name: 'Lila' }];

describe('useVoiceInput', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecorderState = { isRecording: false, durationMillis: 0 };
    mockRecorder.uri = 'file:///cache/recording-tmp.m4a';
    mockGetRecordingPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    mockedProcessVoiceMemory.mockResolvedValue({
      data: { cleanedText: 'Lila laughed', description: 'Lila laughing in the bath', mentionedMemberIds: ['member-1'] },
      error: null,
    });
  });

  it('pauses app-wide playback and configures the recording session before starting', async () => {
    const { result } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(mockedPauseAllAudioPlayback).toHaveBeenCalledTimes(1);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith({ allowsRecording: true, playsInSilentMode: true });
    // pauseAllAudioPlayback must run before the session is reconfigured.
    const pauseOrder = mockedPauseAllAudioPlayback.mock.invocationCallOrder[0];
    const modeOrder = mockSetAudioModeAsync.mock.invocationCallOrder[0];
    expect(pauseOrder).toBeLessThan(modeOrder);
    expect(mockRecorder.prepareToRecordAsync).toHaveBeenCalledTimes(1);
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
  });

  it('sets an error and never starts recording when permission is denied', async () => {
    mockGetRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    const { result } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.errorMessage).toContain('Microphone access');
    expect(mockRecorder.record).not.toHaveBeenCalled();
  });

  it('stop kicks transcription immediately and resolves into transcriptionResult', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });

    expect(result.current.stoppedClip).toEqual({
      localUri: 'file:///cache/recording-tmp.m4a',
      durationMs: 4200,
    });
    expect(mockedProcessVoiceMemory).toHaveBeenCalledWith(
      'base64-audio-data',
      FAMILY_MEMBERS,
      'family-1',
    );
    expect(result.current.transcriptionStatus).toBe('done');
    expect(result.current.transcriptionResult).toEqual({
      cleanedText: 'Lila laughed',
      description: 'Lila laughing in the bath',
      mentionedMemberIds: ['member-1'],
    });
    // Stopping (either fork branch) never deletes the file on its own.
    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('transcription failure never touches the stopped clip -- keep-the-sound must still work', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    mockedProcessVoiceMemory.mockResolvedValue({ data: null, error: { message: 'offline' } });
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });

    expect(result.current.transcriptionStatus).toBe('failed');
    expect(result.current.stoppedClip).not.toBeNull();
    expect(mockedFileSystem.deleteAsync).not.toHaveBeenCalled();
  });

  it('empty/unusable speech yields an empty description, not a failure', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    mockedProcessVoiceMemory.mockResolvedValue({
      data: { cleanedText: '', description: '', mentionedMemberIds: [] },
      error: null,
    });
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });

    expect(result.current.transcriptionStatus).toBe('done');
    expect(result.current.transcriptionResult?.description).toBe('');
  });

  it('auto-stops at the 2-minute cap and reports autoStopped', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 119999 };
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    mockRecorderState = { isRecording: true, durationMillis: 120000 };
    await act(async () => {
      rerender({});
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockRecorder.stop).toHaveBeenCalledTimes(1);
    expect(result.current.autoStopped).toBe(true);
  });

  it('discardStoppedClip deletes the file and resets transcription state', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });

    await act(async () => {
      await result.current.discardStoppedClip();
    });

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///cache/recording-tmp.m4a',
      { idempotent: true },
    );
    expect(result.current.stoppedClip).toBeNull();
    expect(result.current.transcriptionStatus).toBe('idle');
    expect(result.current.transcriptionResult).toBeNull();
  });

  it('recordAgain discards the current clip then starts a fresh recording', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });

    mockedFileSystem.deleteAsync.mockClear();
    mockRecorder.record.mockClear();

    await act(async () => {
      await result.current.recordAgain();
    });

    expect(mockedFileSystem.deleteAsync).toHaveBeenCalledWith(
      'file:///cache/recording-tmp.m4a',
      { idempotent: true },
    );
    expect(mockRecorder.record).toHaveBeenCalledTimes(1);
  });

  it('a stale transcription response is dropped once superseded by a newer recording', async () => {
    mockRecorderState = { isRecording: true, durationMillis: 4200 };
    let resolveFirst!: (value: Awaited<ReturnType<typeof processVoiceMemory>>) => void;
    mockedProcessVoiceMemory.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );

    const { result, rerender } = renderHook(() => useVoiceInput(FAMILY_MEMBERS, 'family-1'));
    rerender({});

    await act(async () => {
      await result.current.stopRecording();
    });
    expect(result.current.transcriptionStatus).toBe('transcribing');

    mockRecorder.uri = 'file:///cache/recording-tmp-2.m4a';
    await act(async () => {
      await result.current.recordAgain();
    });

    await act(async () => {
      resolveFirst({
        data: { cleanedText: 'stale', description: 'stale description', mentionedMemberIds: [] },
        error: null,
      });
      await Promise.resolve();
    });

    // The stale response for the discarded clip must not populate state for
    // the new recording session.
    expect(result.current.transcriptionResult).not.toEqual(
      expect.objectContaining({ cleanedText: 'stale' }),
    );
  });
});
