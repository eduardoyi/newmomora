import * as ImagePicker from 'expo-image-picker';

import {
  getOrRequestNativePermission,
  getSoftPermissionDeniedText,
  showPermissionSettingsPrompt,
  waitForNativePresentationToSettle,
} from '@/utils/native-permissions';
import {
  extractPortraitReferenceDateIso,
  getLocalTodayIso,
  type PortraitDateSource,
} from '@/utils/portrait-versions';

export interface FamilyProfilePhotoSelection {
  uri: string;
  contentType: string;
  captureDate: string | null;
  referenceDate: string;
  dateSource: Extract<PortraitDateSource, 'exif' | 'default_today'>;
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
  exif: true,
  base64: false,
  allowsMultipleSelection: false,
} satisfies ImagePicker.ImagePickerOptions;

const CAMERA_UNAVAILABLE_ERROR = 'Camera is not available on this device.';
const CAMERA_PERMISSION_PURPOSE = 'to take a profile photo';
const LIBRARY_PERMISSION_PURPOSE = 'to choose a profile photo';
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
  includeCaptureDate = true,
): FamilyProfilePhotoSelection {
  const captureDate = includeCaptureDate
    ? extractPortraitReferenceDateIso(asset.exif)
    : null;
  return {
    uri: asset.uri,
    contentType: resolveProfilePhotoContentType(asset),
    captureDate,
    referenceDate: captureDate ?? getLocalTodayIso(),
    dateSource: captureDate ? 'exif' : 'default_today',
  };
}

function parsePickerResult(
  result: ImagePicker.ImagePickerResult,
  includeCaptureDate: boolean,
): FamilyProfilePhotoPickResult {
  if (result.canceled || !result.assets[0]) {
    return {};
  }

  return { selection: assetToSelection(result.assets[0], includeCaptureDate) };
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

  return parsePickerResult(result, true);
}

function isCameraUnavailableError(error: unknown): boolean {
  return error instanceof Error && /unavailable|not available|launchCameraAsync/i.test(error.message);
}

export async function pickFamilyProfilePhotoFromLibrary(): Promise<FamilyProfilePhotoPickResult> {
  try {
    const { permission, didRequest } = await getOrRequestNativePermission(
      () => ImagePicker.getMediaLibraryPermissionsAsync(),
      () => ImagePicker.requestMediaLibraryPermissionsAsync(),
    );
    if (!permission.granted) {
      // Blocked: the Settings prompt is the whole response, so no `error`
      // (callers treat an empty result like a cancel).
      if (permission.canAskAgain === false) {
        showPermissionSettingsPrompt('photos', LIBRARY_PERMISSION_PURPOSE);
        return {};
      }
      return { error: getSoftPermissionDeniedText('photos', LIBRARY_PERMISSION_PURPOSE) };
    }

    if (didRequest) {
      await waitForNativePresentationToSettle();
    }

    const result = await ImagePicker.launchImageLibraryAsync(PROFILE_PHOTO_PICKER_OPTIONS);
    return parsePickerResult(result, true);
  } catch {
    return { error: LIBRARY_PICK_ERROR };
  }
}

export async function pickFamilyProfilePhotoFromCamera(): Promise<FamilyProfilePhotoPickResult> {
  try {
    const { permission, didRequest } = await getOrRequestNativePermission(
      () => ImagePicker.getCameraPermissionsAsync(),
      () => ImagePicker.requestCameraPermissionsAsync(),
    );
    if (!permission.granted) {
      if (permission.canAskAgain === false) {
        showPermissionSettingsPrompt('camera', CAMERA_PERMISSION_PURPOSE);
        return {};
      }
      return { error: getSoftPermissionDeniedText('camera', CAMERA_PERMISSION_PURPOSE) };
    }

    if (didRequest) {
      await waitForNativePresentationToSettle();
    }

    const result = await ImagePicker.launchCameraAsync({
      ...PROFILE_PHOTO_PICKER_OPTIONS,
      exif: false,
      cameraType: ImagePicker.CameraType.front,
    });
    return parsePickerResult(result, false);
  } catch (error) {
    return {
      error: isCameraUnavailableError(error) ? CAMERA_UNAVAILABLE_ERROR : CAMERA_PICK_ERROR,
    };
  }
}

export type PortraitPhotoSource = 'camera' | 'library';

export function pickPortraitVersionPhoto(source: PortraitPhotoSource) {
  return source === 'camera'
    ? pickFamilyProfilePhotoFromCamera()
    : pickFamilyProfilePhotoFromLibrary();
}
