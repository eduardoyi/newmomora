import { fireEvent, render, waitFor } from '@testing-library/react-native';

import { useVoiceInput } from '@/hooks/useVoiceInput';

import { VoiceSpeakItModal } from './voice-speak-it-modal';

jest.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: jest.fn(),
}));

const mockedUseVoiceInput = useVoiceInput as jest.MockedFunction<typeof useVoiceInput>;

describe('VoiceSpeakItModal', () => {
  it('waits for the native modal to finish presenting before requesting microphone access', async () => {
    const startRecording = jest.fn().mockResolvedValue(undefined);
    mockedUseVoiceInput.mockReturnValue({
      durationLabel: '0:00',
      errorMessage: '',
      isProcessing: false,
      isRecording: false,
      startRecording,
      stopRecording: jest.fn(),
    });

    const screen = render(
      <VoiceSpeakItModal
        familyMembers={[]}
        onDismiss={jest.fn()}
        onResult={jest.fn()}
        visible
      />,
    );

    expect(startRecording).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('voice-speak-it-modal'), 'show');

    await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(1));
  });
});
