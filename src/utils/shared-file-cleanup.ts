// Cleanup for files shared INTO Momora through the iOS / Android share sheet.
//
// expo-sharing hands us a private COPY of every shared file and never deletes
// it: the iOS share extension writes into the ROOT of the app-group container
// `group.com.memora.app.shared`, and the Android share parser writes into the
// ROOT of the app cache directory. `clearSharedPayloads()` only forgets the
// payload list. Those copies are a family's photos and videos (child PII), so
// they must not linger on the device once Momora is done with them.
//
// `isShareCopyUri` is the single "is this ours to delete?" check; every
// deletion goes through `deleteShareCopies`, which re-checks the path, so a
// picker file, a document-directory file or anything else can never be removed
// by a mistaken call. Audio shares are handled by src/services/audio-import.ts
// (it deletes the copy after claiming it); this helper is compatible with them
// but they keep their own flow.
//
// Privacy: never log file names or paths from this module.
import { Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { getSharedPayloads } from 'expo-sharing';
import { Platform } from 'react-native';

/**
 * iOS app group the share extension writes into. MUST match the `appGroupId`
 * of the expo-sharing plugin entry in app.json (a Jest test asserts it).
 */
export const SHARE_APP_GROUP_ID = 'group.com.memora.app.shared';

/** A share copy younger than this is never swept (it may be consumed right now). */
export const SHARE_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Entries of the app-group container root that are not share copies. The
// share extension only ever writes regular files here, so anything with one of
// these names is a system / preferences directory (UserDefaults lives under
// Library/Preferences) and must never be touched.
const RESERVED_ROOT_NAMES = new Set(['library', 'documents', 'tmp', 'caches', 'systemdata']);

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `file:///a/b/` or `/a/b` -> `/a/b` (decoded, no query/hash, no trailing
 * slash, `/private/var` -> `/var`, `/data/data` -> `/data/user/0`). Returns
 * null for anything that is not a plain absolute file path.
 */
function toNormalizedPath(uri: string | null | undefined): string | null {
  if (typeof uri !== 'string' || uri.length === 0) {
    return null;
  }
  let path: string;
  if (uri.startsWith('file://')) {
    path = uri.slice('file://'.length);
  } else if (uri.startsWith('/')) {
    path = uri;
  } else {
    return null;
  }
  path = path.split(/[?#]/)[0] ?? '';
  path = safeDecode(path).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!path.startsWith('/')) {
    return null;
  }
  if (path.startsWith('/private/var/')) {
    path = path.slice('/private'.length);
  }
  if (path.startsWith('/data/data/')) {
    path = `/data/user/0/${path.slice('/data/data/'.length)}`;
  }
  return path;
}

function shareRootUri(): string | null {
  try {
    if (Platform.OS === 'ios') {
      return Paths.appleSharedContainers?.[SHARE_APP_GROUP_ID]?.uri ?? null;
    }
    if (Platform.OS === 'android') {
      return FileSystem.cacheDirectory ?? null;
    }
  } catch {
    // The container getter throws when the entitlement is missing (some
    // simulators / unsigned builds); treat that as "no share container".
  }
  return null;
}

/**
 * True only for a file directly in the iOS share-container root, or directly
 * in the Android cache root -- never a subdirectory (expo-image-picker writes
 * to `cache/ImagePicker/...`, the document picker to `cache/DocumentPicker/...`)
 * and never the container's `Library/` and friends.
 */
export function isShareCopyUri(uri: string | null | undefined): boolean {
  const path = toNormalizedPath(uri);
  const root = toNormalizedPath(shareRootUri());
  if (!path || !root) {
    return false;
  }
  const slash = path.lastIndexOf('/');
  const directory = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (directory !== root || name.length === 0 || name === '.' || name === '..') {
    return false;
  }
  if (Platform.OS === 'ios' && RESERVED_ROOT_NAMES.has(name.toLowerCase())) {
    return false;
  }
  return true;
}

/**
 * Best-effort, idempotent delete of share copies. URIs that are not share
 * copies (see `isShareCopyUri`) are ignored, duplicates are deleted once, and
 * nothing is ever thrown or logged.
 */
export async function deleteShareCopies(
  uris: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const targets = [...new Set(uris)].filter(
    (uri): uri is string => typeof uri === 'string' && isShareCopyUri(uri),
  );
  await Promise.all(
    targets.map(async (uri) => {
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {
        // Best-effort: the startup sweep retries on iOS.
      }
    }),
  );
}

function pendingSharePayloadNames(): Set<string> {
  const names = new Set<string>();
  try {
    for (const payload of getSharedPayloads()) {
      const value = (payload as { value?: unknown }).value;
      const path = typeof value === 'string' ? toNormalizedPath(value) : null;
      if (path) {
        names.add(path.slice(path.lastIndexOf('/') + 1));
      }
    }
  } catch {
    // Native module unavailable -- the age threshold is the only guard then.
  }
  return names;
}

/**
 * iOS only: deletes regular files sitting directly in the share container
 * root that are older than `olderThanMs`. Covers a force-quit between a share
 * landing and the composer cleaning up, and shares dismissed some other way.
 * Directories (notably `Library/`, which holds UserDefaults) are skipped, as
 * are files an unconsumed share still points at: `copyItem` can preserve the
 * source's old modification time, so age alone is not proof a copy is stale.
 * No-op elsewhere or when the container is unavailable. Never throws.
 */
export async function sweepShareContainer(
  options: { now?: number; olderThanMs?: number } = {},
): Promise<void> {
  if (Platform.OS !== 'ios') {
    return;
  }
  try {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? SHARE_SWEEP_MAX_AGE_MS;
    const rootUri = shareRootUri();
    if (!rootUri) {
      return;
    }
    const root = rootUri.replace(/\/+$/, '');
    // Captured BEFORE the first await: on a cold start from the share sheet the
    // composer may consume and clear the payload while the directory is being
    // listed, and a copy with an old (preserved) mtime must stay protected.
    const protectedNames = pendingSharePayloadNames();
    const names = await FileSystem.readDirectoryAsync(`${root}/`);

    await Promise.all(
      names.map(async (name) => {
        if (RESERVED_ROOT_NAMES.has(name.toLowerCase()) || protectedNames.has(name)) {
          return;
        }
        try {
          const uri = `${root}/${encodeURIComponent(name)}`;
          const info = await FileSystem.getInfoAsync(uri);
          if (!info.exists || info.isDirectory) {
            return;
          }
          if (now - info.modificationTime * 1000 > olderThanMs) {
            await FileSystem.deleteAsync(uri, { idempotent: true });
          }
        } catch {
          // Best-effort per entry.
        }
      }),
    );
  } catch {
    // Best-effort -- a sweep failure must never affect app startup.
  }
}
