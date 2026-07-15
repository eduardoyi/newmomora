import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

export async function readLocalFileAsBase64(fileUri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const response = await fetch(fileUri);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';

    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index] ?? 0);
    }

    return btoa(binary);
  }

  return FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/**
 * Reads the byte size of a local file, or `null` if it can't be determined
 * (missing file, unsupported platform info shape, or a thrown error).
 * Shared by video-compression.ts (compression-failure fallback decision)
 * and memory-posting.ts (post-compression upload-cap enforcement) so both
 * read file size the same way.
 */
export async function getLocalFileSizeBytes(fileUri: string): Promise<number | null> {
  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (info.exists && 'size' in info && typeof info.size === 'number') {
      return info.size;
    }
  } catch {
    // Swallow -- callers treat a null size as "unknown", not zero.
  }
  return null;
}
