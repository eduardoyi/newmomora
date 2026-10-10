// Custody for a "kept" audio-memory clip between the fork's stop-recording
// moment and a successful upload (docs/plans/audio-memories-v1.md P2.2).
//
// expo-audio's recorder writes into an OS-managed temp/cache location. A
// later `prepareToRecordAsync` call in the same composer session ("Record
// again" was tried before, or the user reopens the mic after keeping a
// clip) or an OS cache purge before a deferred retry can invalidate that
// temp URI out from under the pending-uploads queue. `claimAudioClip` is
// called the instant the user chooses "Keep the sound," copying the clip
// into an app-owned directory Momora controls for as long as the memory's
// posting is pending.
//
// This is also the one child-voice-recording surface with no queue-backed
// cleanup: the pending-uploads queue is in-memory only (see
// use-pending-memory-uploads.tsx), so a force-quit between "Keep the sound"
// and a successful upload leaves a claimed clip on disk with nothing left
// to delete it. `sweepAudioRecordingsDirectory` is the accepted mitigation
// (rather than a documented-forever risk) -- see the plan's "Orphaned
// child-voice recordings on device" risk row.
import * as FileSystem from 'expo-file-system/legacy';

const RECORDINGS_DIR_NAME = 'audio-recordings';
const SWEEP_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function recordingsDirectory(): string {
  return `${FileSystem.documentDirectory ?? ''}${RECORDINGS_DIR_NAME}/`;
}

async function ensureRecordingsDirectory(): Promise<string> {
  const dir = recordingsDirectory();
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return dir;
}

function createClipId(): string {
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
 * Every file in `audio-recordings/` is named `<claimEpochMs>-<uuid>.<ext>`.
 * The sweep reads the timestamp from the name because a copied file can keep
 * its source's old modification time (an imported voice note recorded last
 * month would otherwise be swept the instant it is claimed). Legacy
 * `<uuid>.m4a` names have no timestamp and fall back to mtime.
 */
const CLAIM_NAME_PATTERN = /^(\d{13})-[A-Za-z0-9-]+\.[A-Za-z0-9]+$/;

function normalizeExtension(extension: string): string {
  const cleaned = extension.replace(/^\./, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return cleaned || 'm4a';
}

/**
 * Builds a fresh `audio-recordings/` destination URI (and makes sure the
 * directory exists). Use it for every file Momora writes there: claimed
 * recordings, imported copies, trim/convert renders and transcription
 * excerpts -- the 48 h sweep then covers all of them.
 */
export async function newAudioRecordingUri(extension = 'm4a'): Promise<string> {
  const dir = await ensureRecordingsDirectory();
  return `${dir}${Date.now()}-${createClipId()}.${normalizeExtension(extension)}`;
}

/** True when `uri` lives inside the app-owned `audio-recordings/` directory. */
export function isInsideAudioRecordingsDirectory(uri: string): boolean {
  return uri.startsWith(recordingsDirectory());
}

/**
 * Copies the recorder's temp clip into `documentDirectory/audio-recordings/`
 * under a fresh `<claimEpochMs>-<uuid>` filename and returns the new URI.
 * Call this exactly once, at "Keep the sound" time -- the returned URI is what
 * the composer and the pending-uploads queue read from then on, never the
 * recorder's original temp URI.
 */
export async function claimAudioClip(tempUri: string, extension = 'm4a'): Promise<string> {
  const destination = await newAudioRecordingUri(extension);
  await FileSystem.copyAsync({ from: tempUri, to: destination });
  return destination;
}

/**
 * Best-effort delete of a clip file (claimed or still-temp). Never throws --
 * an already-gone or unreadable file is fine to ignore.
 */
export async function discardAudioClip(uri: string | null | undefined): Promise<void> {
  if (!uri) {
    return;
  }
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort.
  }
}

/**
 * Deletes claimed clips older than 48h from the app-owned recordings
 * directory. Wire this fire-and-forget once at app start (see
 * src/components/app-providers.tsx) -- it is the mitigation for the
 * post-enqueue orphan window described above. Never throws.
 */
export async function sweepAudioRecordingsDirectory(): Promise<void> {
  try {
    const dir = recordingsDirectory();
    const dirInfo = await FileSystem.getInfoAsync(dir);
    if (!dirInfo.exists) {
      return;
    }

    const entries = await FileSystem.readDirectoryAsync(dir);
    const now = Date.now();

    await Promise.all(
      entries.map(async (name) => {
        const uri = `${dir}${name}`;
        try {
          const fileInfo = await FileSystem.getInfoAsync(uri);
          if (!fileInfo.exists) {
            return;
          }
          const claimedMatch = CLAIM_NAME_PATTERN.exec(name);
          const ageReferenceMs = claimedMatch
            ? Number(claimedMatch[1])
            : fileInfo.modificationTime * 1000;
          if (now - ageReferenceMs > SWEEP_MAX_AGE_MS) {
            await FileSystem.deleteAsync(uri, { idempotent: true });
          }
        } catch {
          // Best-effort per-entry -- one bad file shouldn't abort the sweep.
        }
      }),
    );
  } catch {
    // Best-effort -- a sweep failure must never affect app startup.
  }
}
