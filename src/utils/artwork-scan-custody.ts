// Custody for scanned artwork pages between the native scanner returning and
// a successful upload (docs/plans/artwork-scanning.md, 3.1 / 3.4).
//
// The native scanners write into OS-managed cache locations the OS may purge
// while a failed upload waits for Retry, so `claimArtworkScan` moves every
// page into `documentDirectory/artwork-scans/<claimEpochMs>-<uuid>.jpg`
// immediately. The pending-uploads queue is in-memory only, so a force-quit
// can orphan claimed files; `sweepStaleArtworkScans` is the best-effort
// mitigation. It reads the claim time from the filename (not mtime) because
// moved/copied files keep unreliable modification times.
//
// Sibling of audio-clip-custody.ts rather than a shared helper: the audio
// util is owned by a different branch.
import * as FileSystem from 'expo-file-system/legacy';

const ARTWORK_SCANS_DIR_NAME = 'artwork-scans';
const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_FILE_NAME_PATTERN = /^(\d{10,})-[0-9a-f-]{36}\.jpg$/;

function artworkScansDirectory(): string {
  return `${FileSystem.documentDirectory ?? ''}${ARTWORK_SCANS_DIR_NAME}/`;
}

async function ensureArtworkScansDirectory(): Promise<string> {
  const dir = artworkScansDirectory();
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

/** RFC 4122 v4 id. Also the attachment-id scheme `MemoryMediaPicker` uses. */
export function createArtworkScanId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * True only for a direct child file of `documentDirectory/artwork-scans/`.
 * Every delete goes through this so a stray URI (a library photo, a share
 * file, a path with `..`) can never be removed by scan cleanup.
 */
export function isInsideArtworkScansDirectory(uri: string | null | undefined): boolean {
  if (!uri) {
    return false;
  }
  const dir = artworkScansDirectory();
  if (!FileSystem.documentDirectory || !uri.startsWith(dir)) {
    return false;
  }
  const remainder = uri.slice(dir.length);
  return remainder.length > 0 && !remainder.includes('/') && !remainder.includes('..');
}

/**
 * Moves a native-scanner output file into app-owned storage and returns the
 * new URI. Call once per page, right after the scan resolves. Falls back to
 * copy + delete if a rename across volumes is refused.
 */
export async function claimArtworkScan(tempUri: string, nowMs: number = Date.now()): Promise<string> {
  const dir = await ensureArtworkScansDirectory();
  const destination = `${dir}${nowMs}-${createArtworkScanId()}.jpg`;
  try {
    await FileSystem.moveAsync({ from: tempUri, to: destination });
  } catch {
    await FileSystem.copyAsync({ from: tempUri, to: destination });
    try {
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
    } catch {
      // Best-effort: the source is a scanner cache file the OS will purge.
    }
  }
  return destination;
}

/**
 * Best-effort delete of a claimed scan. A no-op for any URI outside the
 * `artwork-scans/` directory. Never throws.
 */
export async function deleteArtworkScanFile(uri: string | null | undefined): Promise<void> {
  if (!uri || !isInsideArtworkScansDirectory(uri)) {
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Deletes claimed scans whose filename timestamp is older than
 * `olderThanMs` (default 7 days), skipping any URI in `keepUris` (files a
 * pending upload still references). Wire fire-and-forget at app start.
 * Never throws; unparseable names are left alone.
 */
export async function sweepStaleArtworkScans(
  options: { olderThanMs?: number; keepUris?: Iterable<string> } = {},
): Promise<void> {
  try {
    const dir = artworkScansDirectory();
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      return;
    }

    const olderThanMs = options.olderThanMs ?? SWEEP_MAX_AGE_MS;
    const keep = new Set(options.keepUris ?? []);
    const entries = await FileSystem.readDirectoryAsync(dir);
    const now = Date.now();

    await Promise.all(
      entries.map(async (name) => {
        const match = SCAN_FILE_NAME_PATTERN.exec(name);
        if (!match) {
          return;
        }
        const uri = `${dir}${name}`;
        if (keep.has(uri)) {
          return;
        }
        const claimedAtMs = Number(match[1]);
        if (!Number.isFinite(claimedAtMs) || now - claimedAtMs <= olderThanMs) {
          return;
        }
        try {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        } catch {
          // Best-effort per entry -- one bad file shouldn't abort the sweep.
        }
      }),
    );
  } catch {
    // Best-effort -- a sweep failure must never affect app startup.
  }
}
