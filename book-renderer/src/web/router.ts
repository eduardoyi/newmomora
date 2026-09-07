import { useEffect, useState } from 'react';

export type Route = { screen: 'list' } | { screen: 'book'; bookId: string };

const BOOK_PATH_PATTERN = /^\/b\/([^/]+)\/?$/;

function parsePath(pathname: string): Route {
  const match = BOOK_PATH_PATTERN.exec(pathname);
  if (match) return { screen: 'book', bookId: decodeURIComponent(match[1]) };
  return { screen: 'list' };
}

/**
 * Minimal client-side router (no dependency added — this app has exactly
 * two screens): `/` is the book list, `/b/<id>` is a single book. The
 * hosting Worker (`cloudflare/memory-book-web`) SPA-falls-back any
 * unmatched path to `web.html`, so a hard reload/deep link on `/b/<id>`
 * still resolves here client-side.
 */
export function useRouter(): [Route, (path: string) => void] {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    function onPopState() {
      setRoute(parsePath(window.location.pathname));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(path: string) {
    window.history.pushState(null, '', path);
    setRoute(parsePath(path));
  }

  return [route, navigate];
}
