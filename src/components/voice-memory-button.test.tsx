import { act, fireEvent, render } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { VoiceMemoryButton } from './voice-memory-button';

const mockRecorder = {
  prepareToRecordAsync: jest.fn().mockResolvedValue(undefined),
  record: jest.fn(),
  stop: jest.fn().mockResolvedValue(undefined),
  uri: 'file:///cache/recording-tmp.m4a',
};
const mockGetRecordingPermissionsAsync = jest.fn();
const mockRequestRecordingPermissionsAsync = jest.fn();

jest.mock('expo-audio', () => ({
  RecordingPresets: { HIGH_QUALITY: {} },
  useAudioRecorder: () => mockRecorder,
  useAudioRecorderState: () => ({ isRecording: false, durationMillis: 0 }),
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  AudioModule: {
    getRecordingPermissionsAsync: (...args: unknown[]) => mockGetRecordingPermissionsAsync(...args),
    requestRecordingPermissionsAsync: (...args: unknown[]) => mockRequestRecordingPermissionsAsync(...args),
  },
}));

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

jest.mock('@/hooks/use-family', () => ({
  useFamily: () => ({ familyId: 'family-1' }),
}));

jest.mock('@/services/ai', () => ({
  processVoiceMemory: jest.fn(),
}));

jest.mock('@/utils/local-files', () => ({
  readLocalFileAsBase64: jest.fn(),
}));

async function pressVoiceButton(onError: jest.Mock) {
  const screen = render(
    <VoiceMemoryButton familyMembers={[]} onError={onError} onResult={jest.fn()} />,
  );
  await act(async () => {
    fireEvent.press(screen.getByTestId('new-memory-voice-button'));
  });
}

describe('VoiceMemoryButton microphone permission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('blocked: shows the Settings prompt and no inline error', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const settingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockGetRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const onError = jest.fn();

    await pressVoiceButton(onError);

    expect(alertSpy).toHaveBeenCalledWith(
      'Turn on microphone access',
      'Momora needs your microphone to record voice memories. You can turn it on in Settings.',
      expect.any(Array),
    );
    expect(onError).toHaveBeenLastCalledWith('');
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((button) => button.text === 'Open Settings')?.onPress?.();
    expect(settingsSpy).toHaveBeenCalledTimes(1);
    expect(mockRequestRecordingPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRecorder.record).not.toHaveBeenCalled();
  });

  it('soft denial: shows the tap-again text and no prompt', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockGetRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    mockRequestRecordingPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    const onError = jest.fn();

    await pressVoiceButton(onError);

    expect(onError).toHaveBeenLastCalledWith(
      'Momora needs your microphone to record voice memories. Tap again to allow it.',
    );
    expect(alertSpy).not.toHaveBeenCalled();
    expect(mockRecorder.record).not.toHaveBeenCalled();
  });
});
