import type { MouseEvent } from 'react';
import './ShopHeader.css';

export interface ShopHeaderProps {
  /** Navigates to "/" (the keepsakes home). The wordmark and "← Home" call it. */
  onHome: () => void;
  /** Navigates to "/orders". Omit to hide "Your orders" (pages that already are the orders pages). */
  onOrders?: () => void;
  /** Signs this browser out. */
  onSignOut: () => void;
  /** Show "← Home" next to the wordmark (pages that are not the home). */
  showBack?: boolean;
  /** The handoff's "Signed in as … · Not you?" line (or the expired-link notice), shown under the actions. */
  account?: { message: string; actionLabel: string; onAction: () => void } | null;
}

/**
 * The shop's shared page header, purely presentational (no auth or session
 * import, so it is safe in node-env tests): "Momora." (a link to "/"), an
 * optional "← Home", and on the right "Your orders" and "Sign out". Pages use
 * `ConnectedShopHeader`, which wires the session, sign-out and handoff note.
 */
export function ShopHeader({ onHome, onOrders, onSignOut, showBack = false, account }: ShopHeaderProps) {
  function goHome(e: MouseEvent) {
    // Let a modified click (open in a new tab) behave like a normal link.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onHome();
  }

  return (
    <header className="shop-header">
      <div className="shop-header__row">
        <div className="shop-header__left">
          <a className="shop-header__wordmark" href="/" onClick={goHome} aria-label="Momora, home">
            Momora<span className="shop-header__wordmark-dot">.</span>
          </a>
          {showBack && (
            <a className="shop-header__back" href="/" onClick={goHome}>
              ← Home
            </a>
          )}
        </div>
        <nav className="shop-header__actions" aria-label="Account">
          {onOrders && (
            <button type="button" className="shop-header__link" onClick={onOrders}>
              Your orders
            </button>
          )}
          <button type="button" className="shop-header__action" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </div>
      {account && (
        <p className="shop-header__account" role="status">
          {account.message} ·{' '}
          <button type="button" className="shop-header__action" onClick={account.onAction}>
            {account.actionLabel}
          </button>
        </p>
      )}
    </header>
  );
}
