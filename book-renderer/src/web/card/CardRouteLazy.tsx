import { lazy, Suspense } from 'react';
import { ChunkErrorBoundary, registerPreloadErrorReload } from './ChunkErrorBoundary';
import type { CardRouteProps } from './CardRoute';

/**
 * The only card import the shell needs. `React.lazy` makes the whole card
 * editor (its CSS, the card components, the aliased font loader and the
 * vendored font files) a separate chunk that is fetched only on `/c/<id>`, so
 * book pages never load or restyle anything for it. A chunk that fails to load
 * (a tab left open across a deploy) shows "The shop was updated" with a Reload
 * button instead of a blank page.
 */
const CardRoute = lazy(() => import('./CardRoute'));

registerPreloadErrorReload();

export function CardRouteLazy(props: CardRouteProps) {
  return (
    <ChunkErrorBoundary>
      <Suspense
        fallback={
          <div className="app-boot">
            <p>Loading…</p>
          </div>
        }
      >
        <CardRoute {...props} />
      </Suspense>
    </ChunkErrorBoundary>
  );
}
