import * as ImagePicker from 'expo-image-picker';

export interface FamilyProfilePhotoSelection {
  uri: string;
  contentType: string;
}

export interface FamilyProfilePhotoPickResult {
  selection?: FamilyProfilePhotoSelection;
  error?: string;
}

export const PROFILE_PHOTO_PICKER_OPTIONS = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.85,
  exif: false,
  base64: false,
  allowsMultipleSelection: false,
} satisfies ImagePicker.ImagePickerOptions;

const CAMERA_UNAVAILABLE_ERROR = 'Camera is not available on this device.';
const CAMERA_PERMISSION_ERROR = 'Camera access is required to take a profile photo.';
const LIBRARY_PERMISSION_ERROR = 'Photo library access is required to choose a profile photo.';
const CAMERA_PICK_ERROR = 'Could not open the camera. Please try again.';
const LIBRARY_PICK_ERROR = 'Could not open the photo library. Please try again.';

function getAssetExtension(asset: ImagePicker.ImagePickerAsset): string | undefined {
  const source = asset.fileName ?? asset.uri.split(/[?#]/)[0];
  return source.split('.').pop()?.toLowerCase();
}

export function resolveProfilePhotoContentType(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;

  switch (getAssetExtension(asset)) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    default:
      return 'image/jpeg';
  }
}

export function assetToSelection(
  asset: ImagePicker.ImagePickerAsset,
): FamilyProfilePhotoSelection {
  return {
    uri: asset.uri,
    contentType: resolveProfilePhotoContentType(asset),
  };
}

function parsePickerResult(result: ImagePicker.ImagePickerResult): FamilyProfilePhotoPickResult {
  if (result.canceled || !result.assets[0]) {
    return {};
  }

  return { selection: assetToSelection(result.assets[0]) };
}

export function parsePendingPickerResult(
  result: ImagePicker.ImagePickerResult | ImagePicker.ImagePickerErrorResult | null,
): FamilyProfilePhotoPickResult {
  if (!result) {
    return {};
  }

  if ('code' in result) {
    return { error: result.message || 'Could not recover the selected profile photo.' };
  }

  return parsePickerResult(result);
}

function isCameraUnavailableError(error: unknown): boolean {
  return error instanceof Error && /unavailable|not available|launchCameraAsync/i.test(error.message);
}

export async function pickFamilyProfilePhotoFromLibrary(): Promise<FamilyProfilePhotoPickResult> {
  try {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return { error: LIBRARY_PERMISSION_ERROR };
    }

    const result = await ImagePicker.launchImageLibraryAsync(PROFILE_PHOTO_PICKER_OPTIONS);
    return parsePickerResult(result);
  } catch {
    return { error: LIBRARY_PICK_ERROR };
  }
}

export async function pickFamilyProfilePhotoFromCamera(): Promise<FamilyProfilePhotoPickResult> {
  try {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return { error: CAMERA_PERMISSION_ERROR };
    }

    const result = await ImagePicker.launchCameraAsync({
      ...PROFILE_PHOTO_PICKER_OPTIONS,
      cameraType: ImagePicker.CameraType.front,
    });
    return parsePickerResult(result);
  } catch (error) {
    return {
      error: isCameraUnavailableError(error) ? CAMERA_UNAVAILABLE_ERROR : CAMERA_PICK_ERROR,
    };
  }
}
