import * as ImagePicker from 'expo-image-picker';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Platform } from 'react-native';

import { MemoryMediaPicker } from './memory-media-picker';

jest.mock('expo-image-picker', () => ({
  getCameraPermissionsAsync: jest.fn(),
  getMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;

describe('MemoryMediaPicker', () => {
  const originalPlatform = Platform.OS;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  });

  function choosePhotoLibrary() {
    const buttons = (Alert.alert as jest.Mock).mock.calls[0]?.[2] as
      | { text: string; onPress?: () => void }[]
      | undefined;
    buttons?.find((button) => button.text === 'Photo library')?.onPress?.();
  }

  it('reports a native gallery launch failure and does not request an existing permission again', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockRejectedValue(new Error('native launch failed'));
    const onError = jest.fn();
    const screen = render(<MemoryMediaPicker onError={onError} onSelect={jest.fn()} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });

    await waitFor(() => {
      expect(onError).toHaveBeenLastCalledWith(
        'Could not open the photo library. Please try again.',
      );
    });
    expect(mockedImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it('prevents concurrent native picker launches', async () => {
    let resolvePicker: ((result: ImagePicker.ImagePickerResult) => void) | undefined;
    mockedImagePicker.launchImageLibraryAsync.mockImplementation(
      () => new Promise((resolve) => { resolvePicker = resolve; }),
    );
    const screen = render(<MemoryMediaPicker onError={jest.fn()} onSelect={jest.fn()} />);

    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    choosePhotoLibrary();
    fireEvent.press(screen.getByTestId('new-memory-attach-media'));
    const secondButtons = (Alert.alert as jest.Mock).mock.calls[1]?.[2] as {
      text: string;
      onPress?: () => void;
    }[];
    secondButtons.find((button) => button.text === 'Photo library')?.onPress?.();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(300);
    });
    expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePicker?.({ canceled: true, assets: null });
    });
  });
});
