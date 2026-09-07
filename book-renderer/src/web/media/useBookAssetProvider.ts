import { useEffect, useReducer, useRef } from 'react';
import { setAssetUrlProvider } from '../../model/loader';
import { getMediaUrls } from './coalescer';

/**
 * Wires `loader.ts`'s pluggable `assetUrlProvider` (Design Decision 8) to
 * this book's resolved presigned URLs, respecting the module's own
 * documented constraint: "the web app renders ONE book's templates at a
 * time... provider swapped on book open, stale in-flight fetches guarded by
 * book id." `bookId` re-runs the swap; a fetch whose book id has since
 * changed (the parent navigated to a different book before this one's
 * `get-media-url` batch returned) is discarded rather than clobbering the
 * new book's URLs.
 *
 * The provider itself reads from a `ref` (not React state) so it can be set
 * ONCE per book id and stay a stable closure — freshly-resolved URLs are
 * written into the same ref the provider reads, and `forceRender` (a no-op
 * state bump) makes the currently-mounted template tree call `assetUrl()`
 * again, picking up the ref's latest contents without needing to know the
 * provider changed underneath it.
 */
export function useBookAssetProvider(bookId: string | null, keys: string[]) {
  const mapRef = useRef(new Map<string, string>());
  const urlToFileRef = useRef(new Map<string, string>());
  const bookIdRef = useRef(bookId);
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    bookIdRef.current = bookId;
    mapRef.current = new Map();
    urlToFileRef.current = new Map();
    setAssetUrlProvider(bookId ? (_slug, file) => mapRef.current.get(file) ?? '' : null);
    return () => {
      setAssetUrlProvider(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  const keysSignature = keys.join('\n');
  useEffect(() => {
    if (!bookId || keys.length === 0) return;
    const requestedBookId = bookId;
    const missing = keys.filter((k) => !mapRef.current.has(k));
    if (missing.length === 0) return;

    getMediaUrls(missing)
      .then((urls) => {
        if (bookIdRef.current !== requestedBookId) return; // stale-book guard
        for (const [key, url] of urls) {
          mapRef.current.set(key, url);
          urlToFileRef.current.set(url, key);
        }
        forceRender();
      })
      .catch(() => {
        // A failed batch simply leaves those keys unresolved — the
        // affected <img>s render broken and their onErrorCapture path
        // below retries individually.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, keysSignature]);

  /** Attach as `onErrorCapture` on the wrapping element around the rendered
   * pages (React's capture-phase media-error handling — `error` events on
   * `<img>` don't bubble, but DO fire during capture, so this reaches every
   * descendant `<img>` without any template needing its own `onError`
   * prop). Re-requests that one key bypassing the client cache (Design
   * Decision 3's "on image load error, re-request URLs through the
   * coalescer"). */
  function onImageErrorCapture(event: React.SyntheticEvent<HTMLElement, Event>) {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const failedUrl = target.currentSrc || target.src;
    const key = urlToFileRef.current.get(failedUrl);
    if (!key || !bookId) return;
    const requestedBookId = bookId;
    getMediaUrls([key], { forceRefresh: true })
      .then((urls) => {
        if (bookIdRef.current !== requestedBookId) return;
        const url = urls.get(key);
        if (url) {
          mapRef.current.set(key, url);
          urlToFileRef.current.set(url, key);
          forceRender();
        }
      })
      .catch(() => {
        // Leave it broken — nothing further to try automatically.
      });
  }

  const resolvedCount = keys.filter((k) => mapRef.current.has(k)).length;

  return {
    onImageErrorCapture,
    /** True once every requested key has SOME URL (may still 404 — presign
     * success only means "we asked", not "the object exists"). */
    allRequested: keys.length === 0 || resolvedCount === keys.length,
  };
}
