const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Minimal, dependency-free `Uint8Array` -> base64 encoder for React Native.
 *
 * Hermes has no global `btoa` (see the platform check already in
 * `src/utils/local-files.ts`'s web-only branch), and this repo does not
 * declare a `buffer` polyfill as a direct dependency -- `base64-js` only
 * shows up transitively via other packages' lockfile entries, which is not
 * safe to import from directly. Used by `useShareMemoryCard`
 * (docs/plans/offline-awareness-and-share-cards.md S4) to turn the
 * compose-share-card function's raw PNG bytes (`response.arrayBuffer()`)
 * into the base64 string `expo-file-system/legacy`'s `writeAsStringAsync`
 * needs.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  const length = bytes.length;

  for (let i = 0; i < length; i += 3) {
    const byte1 = bytes[i] ?? 0;
    const hasByte2 = i + 1 < length;
    const hasByte3 = i + 2 < length;
    const byte2 = hasByte2 ? bytes[i + 1] : 0;
    const byte3 = hasByte3 ? bytes[i + 2] : 0;

    const triple = (byte1 << 16) | ((byte2 ?? 0) << 8) | (byte3 ?? 0);

    result += BASE64_CHARS[(triple >> 18) & 0x3f];
    result += BASE64_CHARS[(triple >> 12) & 0x3f];
    result += hasByte2 ? BASE64_CHARS[(triple >> 6) & 0x3f] : '=';
    result += hasByte3 ? BASE64_CHARS[triple & 0x3f] : '=';
  }

  return result;
}
