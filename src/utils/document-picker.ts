import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

// `expo-document-picker` ships a native module, so it only exists in store
// binaries built from 1.5.0 on. OTAs deliver this JS to older binaries too:
// a static `import 'expo-document-picker'` would call `requireNativeModule`
// at load time and crash them. Check for the native module first and only
// then `require` the JS package lazily (docs/plans/audio-trim-import.md,
// "Feature detection & OTA safety").

type DocumentPickerModule = typeof import('expo-document-picker');

export interface PickedAudioDocument {
  /** Local `file://` copy in the app cache (the caller owns deleting it). */
  uri: string;
  name: string;
  mimeType: string | null;
  size: number | null;
}

/** Audio types the system picker offers; `probe` makes the final call on the content. */
export const AUDIO_DOCUMENT_TYPES = ['audio/*', 'application/ogg', 'audio/ogg', 'audio/opus'];

/** True when this binary contains the document-picker native module. */
export function isDocumentPickerAvailable(): boolean {
  if (Platform.OS === 'web') {
    return false;
  }
  try {
    // Expo modules register through expo-modules-core (JSI), not React
    // Native's NativeModules, so this is the only reliable presence check.
    return requireOptionalNativeModule('ExpoDocumentPicker') != null;
  } catch {
    return false;
  }
}

/**
 * Opens the system file picker for one sound or voice note. Resolves null when
 * the user cancels, the module is missing, or the picker fails. The picked file
 * is copied into the app cache; the caller (audio import) deletes that copy
 * once the clip is claimed.
 */
export async function pickAudioDocument(): Promise<PickedAudioDocument | null> {
  if (!isDocumentPickerAvailable()) {
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay lazy (see top)
    const DocumentPicker: DocumentPickerModule = require('expo-document-picker');
    const result = await DocumentPicker.getDocumentAsync({
      type: AUDIO_DOCUMENT_TYPES,
      copyToCacheDirectory: true,
      multiple: false,
    });

    if (result.canceled) {
      return null;
    }
    const asset = result.assets?.[0];
    if (!asset?.uri) {
      return null;
    }
    return {
      uri: asset.uri,
      name: asset.name ?? '',
      mimeType: asset.mimeType ?? null,
      size: typeof asset.size === 'number' ? asset.size : null,
    };
  } catch {
    return null;
  }
}
