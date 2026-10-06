/**
 * Pure logic for a lazy chunk that failed to load. After a redeploy, a tab
 * opened before it still points at hashed `/assets/*.js` files that no longer
 * exist, and the Worker answers a missing path with `web.html` (HTML where a
 * module was expected), so the dynamic `import()` rejects. The fix is always
 * the same: reload and get the new `web.html`.
 */

const CHUNK_ERROR_PATTERNS: readonly RegExp[] = [
  /Failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari
  /Loading (CSS )?chunk [^\s]+ failed/i, // webpack-style
  /Unable to preload CSS/i, // Vite CSS preload
  /Failed to load module script/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown };
  if (e.name === 'ChunkLoadError') return true;
  const message = typeof e.message === 'string' ? e.message : '';
  return CHUNK_ERROR_PATTERNS.some((p) => p.test(message));
}

/** An automatic reload happens at most once in this window, so a genuinely broken deploy cannot loop. */
export const AUTO_RELOAD_MIN_GAP_MS = 60_000;

export function shouldAutoReload(lastReloadAtMs: number | null, nowMs: number): boolean {
  return lastReloadAtMs === null || nowMs - lastReloadAtMs >= AUTO_RELOAD_MIN_GAP_MS;
}

export const RELOAD_STORAGE_KEY = 'momora-shop-chunk-reload-at';

export interface ReloadDeps {
  read: () => string | null;
  write: (value: string) => void;
  reload: () => void;
  now: () => number;
}

/** Reloads unless we already did a moment ago. Returns whether it reloaded. Storage failures count as "not yet reloaded" once. */
export function reloadOnce(deps: ReloadDeps): boolean {
  let last: number | null = null;
  try {
    const raw = deps.read();
    last = raw === null ? null : Number(raw);
    if (last !== null && !Number.isFinite(last)) last = null;
  } catch {
    last = null;
  }
  const now = deps.now();
  if (!shouldAutoReload(last, now)) return false;
  try {
    deps.write(String(now));
  } catch {
    // Without storage we cannot rate-limit; the manual button still works.
  }
  deps.reload();
  return true;
}
