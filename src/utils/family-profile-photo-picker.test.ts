import * as ImagePicker from 'expo-image-picker';

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
  });

  it('returns an error when library permission is denied', async () => {
    mockedImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: false,
    } as ImagePicker.MediaLibraryPermissionResponse);

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({
      error: 'Photo library access is required to choose a profile photo.',
    });
    expect(mockedImagePicker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it('returns an error when camera permission is denied', async () => {
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: false,
    } as ImagePicker.CameraPermissionResponse);

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      error: 'Camera access is required to take a profile photo.',
    });
    expect(mockedImagePicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('returns no selection when the user cancels', async () => {
    mockedImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: true,
      assets: null,
    });

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({});
  });

  it('returns a selected library asset with content type', async () => {
    mockedImagePicker.requestMediaLibraryPermissionsAsync.mockResolvedValue({
      granted: true,
    } as ImagePicker.MediaLibraryPermissionResponse);
    mockedImagePicker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [imageAsset({ uri: 'file:///profile.png', mimeType: 'image/png' })],
    });

    await expect(pickFamilyProfilePhotoFromLibrary()).resolves.toEqual({
      selection: { uri: 'file:///profile.png', contentType: 'image/png' },
    });
  });

  it('launches the camera with the front camera and private-safe options', async () => {
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [imageAsset({ uri: 'file:///camera.jpg' })],
    });

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      selection: { uri: 'file:///camera.jpg', contentType: 'image/jpeg' },
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
  });

  it('returns a safe camera unavailable error when launch throws', async () => {
    mockedImagePicker.requestCameraPermissionsAsync.mockResolvedValue({
      granted: true,
    } as ImagePicker.CameraPermissionResponse);
    mockedImagePicker.launchCameraAsync.mockRejectedValue(new Error('launchCameraAsync unavailable'));

    await expect(pickFamilyProfilePhotoFromCamera()).resolves.toEqual({
      error: 'Camera is not available on this device.',
    });
  });

  it('parses pending success, cancel, and error results', () => {
    expect(
      parsePendingPickerResult({
        canceled: false,
        assets: [imageAsset({ uri: 'file:///pending.webp', mimeType: 'image/webp' })],
      }),
    ).toEqual({
      selection: { uri: 'file:///pending.webp', contentType: 'image/webp' },
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
    expect(assetToSelection(imageAsset({ uri: 'file:///profile.heif?cache=1' }))).toEqual({
      uri: 'file:///profile.heif?cache=1',
      contentType: 'image/heic',
    });
  });
});
