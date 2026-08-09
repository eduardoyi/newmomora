import * as FileSystem from 'expo-file-system/legacy';

import { getLocalFileSizeBytes } from './local-files';

/** Positioned byte access shared by media metadata parsers. */
export interface ByteReader {
  readonly size: number;
  /** May return fewer bytes near EOF; parsers that need exact reads enforce it. */
  read(position: number, length: number): Promise<Uint8Array>;
}

export function createInMemoryByteReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    async read(position, length) {
      if (position >= bytes.length || length <= 0) {
        return new Uint8Array(0);
      }
      return bytes.subarray(position, Math.min(bytes.length, position + length));
    },
  };
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP: Record<number, number> = {};
for (let index = 0; index < BASE64_CHARS.length; index += 1) {
  BASE64_LOOKUP[BASE64_CHARS.charCodeAt(index)] = index;
}

/** Hermes-safe base64 decoder for expo-file-system positioned reads. */
function base64ToBytes(base64: string): Uint8Array {
  const withoutPadding = base64.replace(/[\r\n]/g, '').replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((withoutPadding.length * 6) / 8));
  let byteIndex = 0;
  let buffer = 0;
  let bitsInBuffer = 0;

  for (let index = 0; index < withoutPadding.length; index += 1) {
    const charIndex = BASE64_LOOKUP[withoutPadding.charCodeAt(index)];
    if (charIndex === undefined) {
      continue;
    }
    buffer = (buffer << 6) | charIndex;
    bitsInBuffer += 6;
    if (bitsInBuffer >= 8) {
      bitsInBuffer -= 8;
      bytes[byteIndex] = (buffer >> bitsInBuffer) & 0xff;
      byteIndex += 1;
    }
  }

  return byteIndex === bytes.length ? bytes : bytes.subarray(0, byteIndex);
}

/** Creates a production reader without ever loading the complete file. */
export async function createFileByteReader(fileUri: string): Promise<ByteReader | null> {
  const size = await getLocalFileSizeBytes(fileUri);
  if (size === null || size <= 0) return null;

  return {
    size,
    async read(position, length) {
      const clampedLength = Math.max(0, Math.min(length, size - position));
      if (clampedLength <= 0) {
        return new Uint8Array(0);
      }
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length: clampedLength,
      });
      return base64ToBytes(base64);
    },
  };
}
