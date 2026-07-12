import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { SymbolView } from 'expo-symbols';
import { useRef } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
} from 'react-native';

import { colors } from '@/constants/theme';
import { extractCaptureDateIso } from '@/utils/media-capture-date';
import {
  getMediaExtensionFromContentType,
  isVideoContentType,
  validateMediaFile,
} from '@/utils/media-validation';
import {
  getOrRequestNativePermission,
  runAfterNativeChooserDismisses,
  waitForNativePresentationToSettle,
} from '@/utils/native-permissions';

export interface MediaAttachment {
  id: string;
  uri: string;
  contentType: string;
  durationMs?: number;
  sizeBytes: number;
  objectKey?: string;
  /** Derived `YYYY-MM-DD` EXIF capture date for library photos, when
   * `includeCaptureDate` requested it and a valid date was found. Never the
   * raw EXIF object -- see `src/utils/media-capture-date.ts`. */
  capturedAtIso?: string;
}

interface MemoryMediaPickerProps {
  onSelect: (attachments: MediaAttachment[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  /** Render as a circular icon-only toolbar button instead of the full-width button */
  compact?: boolean;
  remainingSlots?: number;
  /**
   * Requests EXIF from the native library picker so capture dates can be
   * derived client-side. Off by default -- the picker is shared with the
   * edit-memory flow, which must never request EXIF. Only the create screen
   * opts in. Has no effect on `launchCameraAsync`, which never requests EXIF.
   */
  includeCaptureDate?: boolean;
}

function createAttachmentId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function resolveContentType(asset: ImagePicker.ImagePickerAsset): string | null {
  if (asset.mimeType) {
    return asset.mimeType;
  }

  const extension = asset.uri.split('.').pop()?.toLowerCase();

  switch (extension) {
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    default:
      return 'image/jpeg';
  }
}

async function resolveFileSize(asset: ImagePicker.ImagePickerAsset): Promise<number | null> {
  if (asset.fileSize != null && asset.fileSize > 0) {
    return asset.fileSize;
  }

  if (Platform.OS === 'web') {
    try {
      const response = await fetch(asset.uri);
      const blob = await response.blob();
      return blob.size;
    } catch {
      return null;
    }
  }

  try {
    const info = await FileSystem.getInfoAsync(asset.uri);
    if (info.exists && 'size' in info && typeof info.size === 'number') {
      return info.size;
    }
  } catch {
    return null;
  }

  return null;
}

export function MemoryMediaPicker({
  onSelect,
  onError,
  disabled = false,
  compact = false,
  remainingSlots = 10,
  includeCaptureDate = false,
}: MemoryMediaPickerProps) {
  const isPickerOpeningRef = useRef(false);

  const runPicker = async (picker: () => Promise<void>, fallbackError: string) => {
    if (isPickerOpeningRef.current) {
      return;
    }

    isPickerOpeningRef.current = true;
    try {
      await picker();
    } catch {
      onError(fallbackError);
    } finally {
      isPickerOpeningRef.current = false;
    }
  };

  const handlePickMedia = async () => {
    await runPicker(async () => {
      onError('');

      if (remainingSlots <= 0) {
        onError('You can attach up to 10 photos or videos.');
        return;
      }

      const { permission, didRequest } = await getOrRequestNativePermission(
        () => ImagePicker.getMediaLibraryPermissionsAsync(),
        () => ImagePicker.requestMediaLibraryPermissionsAsync(),
      );
      if (!permission.granted) {
        onError(
          permission.canAskAgain === false
            ? 'Photo library permission is required to attach media. Enable it in Settings.'
            : 'Photo library permission is required to attach media.',
        );
        return;
      }

      if (didRequest) {
        await waitForNativePresentationToSettle();
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        selectionLimit: remainingSlots,
        orderedSelection: true,
        allowsEditing: false,
        quality: 0.85,
        videoMaxDuration: 60,
        exif: includeCaptureDate,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const attachments: MediaAttachment[] = [];

      for (const asset of result.assets.slice(0, remainingSlots)) {
        const contentType = resolveContentType(asset);

        if (!contentType || !getMediaExtensionFromContentType(contentType)) {
          onError('Unsupported file type. Use JPEG, PNG, HEIC, WEBP, MP4, or MOV.');
          return;
        }

        const sizeBytes = await resolveFileSize(asset);
        const isVideo = isVideoContentType(contentType);
        const durationMs = isVideo ? asset.duration ?? null : null;
        const validationError = validateMediaFile({
          sizeBytes,
          durationMs,
          contentType,
        });

        if (validationError) {
          onError(validationError);
          return;
        }

        // Only image assets are candidates for a capture-date suggestion;
        // the extracted value is a plain YYYY-MM-DD scalar -- asset.exif
        // itself (which can include GPS/device fields) is never retained.
        const capturedAtIso =
          includeCaptureDate && !isVideo
            ? extractCaptureDateIso(asset.exif) ?? undefined
            : undefined;

        attachments.push({
          id: createAttachmentId(),
          uri: asset.uri,
          contentType,
          durationMs: durationMs ?? undefined,
          sizeBytes: sizeBytes as number,
          capturedAtIso,
        });
      }

      if (attachments.length > 0) {
        onSelect(attachments);
      }
    }, 'Could not open the photo library. Please try again.');
  };

  const handleTakePhoto = async () => {
    await runPicker(async () => {
      onError('');

      if (remainingSlots <= 0) {
        onError('You can attach up to 10 photos or videos.');
        return;
      }

      const { permission, didRequest } = await getOrRequestNativePermission(
        () => ImagePicker.getCameraPermissionsAsync(),
        () => ImagePicker.requestCameraPermissionsAsync(),
      );
      if (!permission.granted) {
        onError(
          permission.canAskAgain === false
            ? 'Camera permission is required to take a photo. Enable it in Settings.'
            : 'Camera permission is required to take a photo.',
        );
        return;
      }

      if (didRequest) {
        await waitForNativePresentationToSettle();
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.85,
      });

      if (result.canceled || result.assets.length === 0) {
        return;
      }

      const asset = result.assets[0];
      const contentType = resolveContentType(asset);

      if (!contentType || !getMediaExtensionFromContentType(contentType)) {
        onError('Unsupported file type. Use JPEG, PNG, HEIC, WEBP, MP4, or MOV.');
        return;
      }

      const sizeBytes = await resolveFileSize(asset);
      const validationError = validateMediaFile({
        sizeBytes,
        contentType,
      });

      if (validationError) {
        onError(validationError);
        return;
      }

      onSelect([{
        id: createAttachmentId(),
        uri: asset.uri,
        contentType,
        sizeBytes: sizeBytes as number,
      }]);
    }, 'Could not open the camera. Please try again.');
  };

  const handleAttachPress = () => {
    if (Platform.OS === 'web') {
      void handlePickMedia();
      return;
    }

    const options = [
      { text: 'Photo library', action: handlePickMedia },
      { text: 'Take photo', action: handleTakePhoto },
    ];

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...options.map((option) => option.text), 'Cancel'],
          cancelButtonIndex: options.length,
        },
        (buttonIndex) => {
          const selected = options[buttonIndex];
          if (selected) {
            runAfterNativeChooserDismisses(() => { void selected.action(); });
          }
        },
      );
      return;
    }

    Alert.alert(
      'Add media',
      undefined,
      [
        ...options.map((option) => ({
          text: option.text,
          onPress: () => {
            runAfterNativeChooserDismisses(() => { void option.action(); });
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  if (compact) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Attach photo or video"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={handleAttachPress}
        style={({ pressed }) => [
          styles.compactBtn,
          disabled && styles.compactBtnDisabled,
          pressed && !disabled && styles.compactBtnPressed,
        ]}
        testID="new-memory-attach-media"
      >
        <SymbolView
          name={{ ios: 'photo', android: 'photo_library' }}
          size={20}
          tintColor={colors.ink2}
          fallback={<Text style={styles.compactBtnIcon}>▣</Text>}
        />
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={handleAttachPress}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
      testID="new-memory-attach-media"
    >
      <SymbolView
        name={{ ios: 'photo.badge.plus', android: 'add_a_photo' }}
        size={18}
        tintColor={colors.primary}
        fallback={<Text style={styles.buttonIcon}>⊕</Text>}
      />
      <Text style={styles.buttonText}>Attach photo or video</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
  },
  buttonIcon: {
    fontSize: 17,
    color: colors.primary,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  // compact / toolbar variant
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
  compactBtnDisabled: {
    opacity: 0.4,
  },
  compactBtnPressed: {
    opacity: 0.7,
  },
  compactBtnIcon: {
    fontSize: 20,
    color: colors.ink2,
  },
});
