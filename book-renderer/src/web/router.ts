import { useEffect, useState } from 'react';

export type Route =
  | { screen: 'list' }
  | { screen: 'book'; bookId: string }
  | { screen: 'order'; orderId: string }
  | { screen: 'orders' };

const BOOK_PATH_PATTERN = /^\/b\/([^/]+)\/?$/;
// memory-book-5c plan Step 6 routing correction: the hosting Worker already
// serves deep paths in place (test-covered) -- the real gap was this router
// only knowing '/' and '/b/<id>'. `/order/<id>` is also Stripe Checkout's
// `success_url` target (`?checkout=success` query string, ignored by this
// pathname-only matcher -- OrderStatusScreen reads that param itself).
const ORDER_PATH_PATTERN = /^\/order\/([^/]+)\/?$/;
// order-status UX round, item 2: the buyer's order HISTORY list -- plural,
// no id segment, deliberately checked AFTER `ORDER_PATH_PATTERN` below so
// there's no ambiguity even though the two patterns can't actually collide
// (`/order/<id>` always has a segment after `order`, `/orders` never does).
const ORDERS_PATH_PATTERN = /^\/orders\/?$/;

function parsePath(pathname: string): Route {
  const bookMatch = BOOK_PATH_PATTERN.exec(pathname);
  if (bookMatch) return { screen: 'book', bookId: decodeURIComponent(bookMatch[1]) };
  const orderMatch = ORDER_PATH_PATTERN.exec(pathname);
  if (orderMatch) return { screen: 'order', orderId: decodeURIComponent(orderMatch[1]) };
  if (ORDERS_PATH_PATTERN.test(pathname)) return { screen: 'orders' };
  return { screen: 'list' };
}

/**
 * Minimal client-side router (no dependency added — this app has exactly
 * three screens): `/` is the book list, `/b/<id>` is a single book,
 * `/order/<id>` is one order's status. The hosting Worker
 * (`cloudflare/memory-book-web`) SPA-falls-back any unmatched path to
 * `web.html`, so a hard reload/deep link on `/b/<id>` or `/order/<id>`
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
    // Re-read from `window.location.pathname` (the browser's own parse of
    // what `pushState` just set) rather than routing off the raw `path`
    // argument directly: `path` may carry a query string (e.g. fixture
    // mode's own `?fixture=<slug>` -- see App.tsx's `navigateInFixture`),
    // and `BOOK_PATH_PATTERN`/`ORDER_PATH_PATTERN` are anchored with `$`, so
    // a trailing `?...` would make them fail to match a path that is
    // otherwise perfectly valid.
    setRoute(parsePath(window.location.pathname));
  }

  return [route, navigate];
}
