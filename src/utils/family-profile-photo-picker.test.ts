import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

import {
  assetToSelection,
  parsePendingPickerResult,
  pickFamilyProfilePhotoFromCamera,
  pickFamilyProfilePhotoFromLibrary,
  resolveProfilePhotoContentType,
} from './family-profile-photo-picker';

jest.mock('expo-image-picker', () => ({
  CameraType: {
    back: 'back',
    front: 'front',
  },
  getCameraPermissionsAsync: jest.fn(),
  getMediaLibraryPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(),
  requestMediaLibraryPermissionsAsync: jest.fn(),
}));

const mockedImagePicker = ImagePicker as jest.Mocked<typeof ImagePicker>;

function imageAsset(
  overrides: Partial<ImagePicker.ImagePickerAsset> = {},
): ImagePicker.ImagePickerAsset {
  return {
    uri: 'file:///profile.jpg',
    width: 512,
    height: 512,
    type: 'image',
    ...overrides,
  };
}

describe('family profile photo picker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
  });

  it('returns an error when library permission is denied', async () => {
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
    mockedImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: false,
    } as ImagePicker.MediaLibraryPermissionResponse);

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({
      error: 'Momora needs access to your photos to choose a profile photo. Tap again to allow it.',
    });
    expect(mockedImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('returns an error when camera permission is denied', async () => {
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: false,
    } as ImagePicker.CameraPermissionResponse);

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      error: 'Momora needs your camera to take a profile photo. Tap again to allow it.',
    });
    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('returns no selection when the user cancels', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: true,
      assets: null,
    });

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({});
  });

  it('returns a selected library asset with content type', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [imageAsset({ uri: 'file:///profile.png', mimeType: 'image/png' })],
    });

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({
      selection: expect.objectContaining({
        uri: 'file:///profile.png',
        contentType: 'image/png',
        captureDate: null,
        dateSource: 'default_today',
      }),
    });
  });

  it('launches the camera with the front camera and private-safe options', async () => {
    mockedImagePicker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [imageAsset({ uri: 'file:///camera.jpg' })],
    });

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      selection: expect.objectContaining({
        uri: 'file:///camera.jpg',
        contentType: 'image/jpeg',
        captureDate: null,
        dateSource: 'default_today',
      }),
    });
    expect(mockedImagePicker.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
        exif: false,
        base64: false,
        allowsMultipleSelection: false,
        cameraType: ImagePicker.CameraType.front,
      }),
    );
    expect(mockedImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
  });

  it('returns a safe camera unavailable error when launch throws', async () => {
    mockedImagePicker.launchCameraAsync.mockRejectedValue(new Error('launchCameraAsync unavailable'));

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      error: 'Camera is not available on this device.',
    });
  });

  it('shows the Settings prompt for a permanently denied camera permission, without an error or a second request', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const settingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockedImagePicker.getCameraPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as ImagePicker.CameraPermissionResponse);

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({});
    expect(alertSpy).toHaveBeenCalledWith(
      'Turn on camera access',
      'Momora needs your camera to take a profile photo. You can turn it on in Settings.',
      expect.any(Array),
    );
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((button) => button.text === 'Open Settings')?.onPress?.();
    expect(settingsSpy).toHaveBeenCalledTimes(1);
    expect(mockedImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
    alertSpy.mockRestore();
    settingsSpy.mockRestore();
  });

  it('shows the Settings prompt for a permanently denied library permission, without an error or a second request', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const settingsSpy = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    mockedImagePicker.getMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
    } as ImagePicker.MediaLibraryPermissionResponse);

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({});
    expect(alertSpy).toHaveBeenCalledWith(
      'Turn on photo access',
      'Momora needs access to your photos to choose a profile photo. You can turn it on in Settings.',
      expect.any(Array),
    );
    const buttons = alertSpy.mock.calls[0][2] as { text: string; onPress?: () => void }[];
    buttons.find((button) => button.text === 'Open Settings')?.onPress?.();
    expect(settingsSpy).toHaveBeenCalledTimes(1);
    expect(mockedImagePicker.requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(mockedImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
    alertSpy.mockRestore();
    settingsSpy.mockRestore();
  });

  it('parses pending success, cancel, and error results', () => {
    expect(
      parsePendingPickerResult({
        canceled: false,
        assets: [imageAsset({ uri: 'file:///pending.webp', mimeType: 'image/webp' })],
      }),
    ).toEqual({
      selection: expect.objectContaining({
        uri: 'file:///pending.webp',
        contentType: 'image/webp',
        captureDate: null,
        dateSource: 'default_today',
      }),
    });
    expect(parsePendingPickerResult({ canceled: true, assets: null })).toEqual({});
    expect(parsePendingPickerResult({ code: 'ERR', message: 'Picker failed' })).toEqual({
      error: 'Picker failed',
    });
    expect(parsePendingPickerResult(null)).toEqual({});
  });

  it('falls back to HEIC content type from asset extension', () => {
    expect(resolveProfilePhotoContentType(imageAsset({ uri: 'file:///profile.HEIC' }))).toBe(
      'image/heic',
    );
    expect(assetToSelection(imageAsset({ uri: 'file:///profile.heif?cache=1' }))).toEqual(
      expect.objectContaining({
        uri: 'file:///profile.heif?cache=1',
        contentType: 'image/heic',
        captureDate: null,
        dateSource: 'default_today',
      }),
    );
  });

  it('keeps only a strict EXIF capture date from library selection', async () => {
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [imageAsset({ exif: { DateTimeOriginal: '2024:03:02 10:11:12', GPSLatitude: 1 } })],
    });

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({
      selection: expect.objectContaining({
        captureDate: '2024-03-02',
        referenceDate: '2024-03-02',
        dateSource: 'exif',
      }),
    });
    expect(mockedImagePicker.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ exif: true }),
    );
  });
});
