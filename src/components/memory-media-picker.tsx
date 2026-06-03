import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { SymbolView } from 'expo-symbols';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/constants/theme';
import {
  getMediaExtensionFromContentType,
  isVideoContentType,
  validateMediaFile,
} from '@/utils/media-validation';

export interface MediaAttachment {
  id: string;
  uri: string;
  contentType: string;
  durationMs?: number;
  sizeBytes: number;
  objectKey?: string;
}

interface MemoryMediaPickerProps {
  onSelect: (attachments: MediaAttachment[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  /** Render as a circular icon-only toolbar button instead of the full-width button */
  compact?: boolean;
  remainingSlots?: number;
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
}: MemoryMediaPickerProps) {
  const handlePickMedia = async () => {
    onError('');

    if (remainingSlots <= 0) {
      onError('You can attach up to 10 photos or videos.');
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      onError('Photo library permission is required to attach media.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: remainingSlots,
      orderedSelection: true,
      allowsEditing: false,
      quality: 0.85,
      videoMaxDuration: 60,
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
      const durationMs = isVideoContentType(contentType) ? asset.duration ?? null : null;
      const validationError = validateMediaFile({
        sizeBytes,
        durationMs,
        contentType,
      });

      if (validationError) {
        onError(validationError);
        return;
      }

      attachments.push({
        id: createAttachmentId(),
        uri: asset.uri,
        contentType,
        durationMs: durationMs ?? undefined,
        sizeBytes: sizeBytes as number,
      });
    }

    if (attachments.length > 0) {
      onSelect(attachments);
    }
  };

  const handleTakePhoto = async () => {
    onError('');

    if (remainingSlots <= 0) {
      onError('You can attach up to 10 photos or videos.');
      return;
    }

    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      onError('Camera permission is required to take a photo.');
      return;
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
  };

  const handleAttachPress = () => {
    if (Platform.OS === 'web') {
      void handlePickMedia();
      return;
    }

    Alert.alert(
      'Add media',
      undefined,
      [
        { text: 'Photo library', onPress: () => { void handlePickMedia(); } },
        { text: 'Take photo', onPress: () => { void handleTakePhoto(); } },
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
