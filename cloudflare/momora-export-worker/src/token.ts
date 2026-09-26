// Download links carry a random 256-bit token; only its SHA-256 is stored
// (export_jobs.download_token_hash), so a database read can't be replayed
// into a working link.

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateDownloadToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time comparison of two 64-char hex digests. */
export function hexDigestsEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function tokenMatches(token: string | null, storedHash: string | null): Promise<boolean> {
  if (!token || !storedHash || !/^[0-9a-f]{64}$/.test(token)) return false;
  return hexDigestsEqual(await sha256Hex(token), storedHash);
}
