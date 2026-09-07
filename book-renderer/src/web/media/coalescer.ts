import { supabase } from '../supabaseClient';
import { getFixtureSlug, fixtureMediaUrls } from '../dev/fixture';

/**
 * Batched `get-media-url` request coalescer for the web app (memory-book-5b
 * plan Design Decision 3: "reuses the mobile app's batched coalescer
 * pattern... ~5 calls for ~234 keys at MAX_KEYS=50... 1h expiry, 50-min
 * client cache"). Deliberately re-implemented here rather than imported —
 * `src/services/media.ts` is Expo/React-Native code (uses
 * `expo-file-system`, `react-native`'s `Platform`) that this isolated
 * browser package cannot depend on; this module keeps the same SHAPE
 * (same-microtask key coalescing across concurrent callers, 50-key server
 * batch cap, presigned-URL client cache) without the RN-specific upload
 * helpers or the mobile app's own omitted-key retry-with-backoff self-heal
 * (a targeted fix for a specific production race in the mobile client — see
 * that file's own header comment; not carried over here as a deliberate
 * scope trim, noted in this change's report).
 */

const MAX_BATCH_KEYS = 50;
/** Server presigns for 3600s (`R2_URL_EXPIRY.download`); cache for less than
 * that so a URL is never served past its real expiry, matching the app's
 * own 50-minute client cache. */
const CLIENT_CACHE_MS = 50 * 60 * 1000;

interface CacheEntry {
  url: string;
  cachedAt: number;
}

const urlCache = new Map<string, CacheEntry>();

interface PendingCaller {
  keys: string[];
  resolve: (urls: Map<string, string>) => void;
  reject: (error: Error) => void;
}

let pendingKeys: Set<string> | null = null;
let pendingCallers: PendingCaller[] = [];
let flushScheduled = false;

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CLIENT_CACHE_MS;
}

async function invokeChunk(keys: string[]): Promise<Record<string, string>> {
  const { data, error } = await supabase.functions.invoke<{ urls: Record<string, string>; expiresIn: number }>(
    'get-media-url',
    { body: { keys } },
  );
  if (error) throw new Error(error.message);
  return data?.urls ?? {};
}

async function flush(): Promise<void> {
  const keys = pendingKeys ? Array.from(pendingKeys) : [];
  const callers = pendingCallers;
  pendingKeys = null;
  pendingCallers = [];

  if (keys.length === 0 || callers.length === 0) return;

  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_BATCH_KEYS) {
    chunks.push(keys.slice(i, i + MAX_BATCH_KEYS));
  }

  let chunkResults: Array<Record<string, string> | Error>;
  try {
    chunkResults = await Promise.all(
      chunks.map((chunk) => invokeChunk(chunk).catch((e: Error) => e)),
    );
  } catch (e) {
    const error = e instanceof Error ? e : new Error('Failed to load media URLs');
    for (const caller of callers) caller.reject(error);
    return;
  }

  const resolvedUrls = new Map<string, string>();
  const now = Date.now();
  chunks.forEach((chunk, i) => {
    const result = chunkResults[i];
    if (result instanceof Error) return; // Per-chunk failure: those keys simply stay unresolved for this flush.
    for (const [key, url] of Object.entries(result)) {
      urlCache.set(key, { url, cachedAt: now });
      resolvedUrls.set(key, url);
    }
  });

  for (const caller of callers) {
    const out = new Map<string, string>();
    for (const key of caller.keys) {
      const cached = urlCache.get(key);
      if (cached && isFresh(cached)) out.set(key, cached.url);
      else if (resolvedUrls.has(key)) out.set(key, resolvedUrls.get(key)!);
    }
    caller.resolve(out);
  }
}

/**
 * Resolves presigned URLs for `keys`, coalescing same-microtask calls from
 * independently-mounted callers (a book render + a list of thumbnails both
 * calling this in the same tick end up as ONE (or a few, at 50/chunk)
 * `get-media-url` invocations) and serving from the 50-minute client cache
 * when fresh. `forceRefresh` bypasses the cache for a specific key set —
 * used by the image-error re-request path (Design Decision 3: "on image
 * load error, re-request URLs through the coalescer").
 */
export function getMediaUrls(keys: string[], options?: { forceRefresh?: boolean }): Promise<Map<string, string>> {
  if (keys.length === 0) return Promise.resolve(new Map());

  // DEV-ONLY fixture mode (owner-approved follow-up round) — no `bookId`
  // parameter exists on this function (see this module's own header
  // comment: exactly one book's assets are ever in play at a time), so the
  // active fixture slug is read directly rather than threaded through;
  // resolves synchronously to a local static URL, no `get-media-url`
  // Edge Function call at all. See `dev/fixture.ts`'s header comment for
  // the tree-shaking contract this whole branch relies on.
  if (import.meta.env.DEV) {
    const fixtureSlug = getFixtureSlug();
    if (fixtureSlug) return Promise.resolve(fixtureMediaUrls(fixtureSlug, keys));
  }

  const uncachedKeys = options?.forceRefresh
    ? keys
    : keys.filter((k) => {
        const cached = urlCache.get(k);
        return !cached || !isFresh(cached);
      });

  if (uncachedKeys.length === 0) {
    const out = new Map<string, string>();
    for (const k of keys) {
      const cached = urlCache.get(k);
      if (cached) out.set(k, cached.url);
    }
    return Promise.resolve(out);
  }

  if (options?.forceRefresh) {
    for (const k of uncachedKeys) urlCache.delete(k);
  }

  return new Promise((resolve, reject) => {
    if (!pendingKeys) pendingKeys = new Set();
    for (const k of uncachedKeys) pendingKeys.add(k);
    pendingCallers.push({
      keys,
      resolve: (freshlyResolved) => {
        // Merge in anything already-cached (not part of this flush's
        // uncached set) so the caller's result covers every requested key.
        const out = new Map(freshlyResolved);
        for (const k of keys) {
          if (!out.has(k)) {
            const cached = urlCache.get(k);
            if (cached) out.set(k, cached.url);
          }
        }
        resolve(out);
      },
      reject,
    });

    if (!flushScheduled) {
      flushScheduled = true;
      void Promise.resolve().then(() => {
        flushScheduled = false;
        void flush();
      });
    }
  });
}

/** Test-only: clears the module-level cache/batcher state between tests. */
export function resetCoalescerForTests(): void {
  urlCache.clear();
  pendingKeys = null;
  pendingCallers = [];
  flushScheduled = false;
}
