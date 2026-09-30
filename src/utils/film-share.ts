// Cache housekeeping for the Year Film share download (docs/plans/
// year-film-p2.md Step 6.7). The player downloads the 25-65 MB MP4 into
// `cacheDirectory/film-share/` before handing it to the OS share sheet and
// deletes it on every exit path; this sweep covers what those paths cannot --
// a force-quit or crash mid-download / mid-share. Legacy file-system API, as
// everywhere else in the repo (see local-files.ts).
import * as FileSystem from 'expo-file-system/legacy';

const FILM_SHARE_DIR_NAME = 'film-share';

/** `cacheDirectory/film-share/` (trailing slash), or null where there is no cache directory. */
export function filmShareDirectory(): string | null {
  return FileSystem.cacheDirectory ? `${FileSystem.cacheDirectory}${FILM_SHARE_DIR_NAME}/` : null;
}

/** Creates the folder if needed and returns the destination for a film's MP4. */
export async function prepareFilmShareFile(filmId: string): Promise<string | null> {
  const dir = filmShareDirectory();
  if (!dir || !/^[a-zA-Z0-9-]{1,64}$/.test(filmId)) return null;
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
  return `${dir}${filmId}.mp4`;
}

/** Best-effort delete of a share download. Never throws. */
export async function deleteFilmShareFile(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort: cacheDirectory is OS-managed and the startup sweep retries.
  }
}

/**
 * Deletes the whole `film-share/` folder. Called once, fire-and-forget, at
 * app start (AppProviders) when no share can be in flight. Idempotent and
 * never throws.
 */
export async function sweepFilmShareCache(): Promise<void> {
  const dir = filmShareDirectory();
  if (!dir) return;
  try {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } catch {
    // Best-effort: retried on the next launch.
  }
}
