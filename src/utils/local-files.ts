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
