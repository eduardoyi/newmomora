import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { CardCheckoutContext } from '../CardRoute';

/**
 * The checkout is its own chunk inside the card route's: the editor never
 * pays for it, and book pages never load either. `App.tsx` renders this from
 * `CardRouteLazy`'s `renderCheckout`.
 */
const CardCheckoutScreen = lazy(() => import('./CardCheckoutScreen').then((m) => ({ default: m.CardCheckoutScreen })));

/**
 * A chunk that fails to load (a deploy replaced it, or the network dropped) must
 * not blank the page: say so, and offer the way back to the editor or a reload.
 * Minimal and local to the checkout; the card route has its own for its chunk.
 */
export class CheckoutChunkBoundary extends Component<{ onBack: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="app-boot">
        <div style={{ textAlign: 'center', maxWidth: 360, padding: 16 }}>
          <p>We could not load the checkout. Check your connection and reload the page, or go back to your card.</p>
          <p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>{' '}
            <button type="button" onClick={this.props.onBack}>
              Back to your card
            </button>
          </p>
        </div>
      </div>
    );
  }
}

export function CardCheckoutLazy({ ctx }: { ctx: CardCheckoutContext }) {
  return (
    <CheckoutChunkBoundary onBack={ctx.onBack}>
      <Suspense
        fallback={
          <div className="app-boot">
            <p>Loading…</p>
          </div>
        }
      >
        <CardCheckoutScreen ctx={ctx} />
      </Suspense>
    </CheckoutChunkBoundary>
  );
}
