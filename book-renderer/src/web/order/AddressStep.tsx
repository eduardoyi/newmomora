import { useEffect, useState } from 'react';
import type { Stripe } from '@stripe/stripe-js';
import { AddressForm } from './AddressForm';
import { StripeAddressForm } from './StripeAddressForm';
import { resolveStripe } from './stripeClient';
import { getFixtureSlug } from '../dev/fixture';
import type { ShippingAddressInput } from './types';

type Mode = { kind: 'checking' } | { kind: 'manual' } | { kind: 'stripe'; stripe: Stripe };

/** DEV fixture mode never talks to Stripe (checked synchronously, before
 * ever calling `resolveStripe()`, so a fixture-mode load never even
 * attempts the network fetch of Stripe's loader script) — there's no real
 * Stripe session behind a fixture order, and the whole point of fixture
 * mode is working fully offline. Same `import.meta.env.DEV &&
 * getFixtureSlug()` gating every other fixture-aware call site in this app
 * already uses (`ordersApi.ts`, `useOrders.ts`, etc.) — dead code in a
 * production build, per `dev/fixture.ts`'s own header comment. */
function fixtureModeActive(): boolean {
  return import.meta.env.DEV && Boolean(getFixtureSlug());
}

/**
 * Chooses between the two address-entry paths (checkout address-entry plan,
 * Design Decision 3): Stripe's Address Element (`StripeAddressForm`, Tier 2
 * — type-ahead autocomplete) when it's actually available, the existing
 * manual `AddressForm` (Tier 1) otherwise. The manual form is the ALWAYS-
 * available fallback: fixture mode, a missing/empty
 * `VITE_STRIPE_PUBLISHABLE_KEY`, or any `loadStripe()` failure (blocked
 * script, bad key, network hiccup) all resolve to 'manual' silently — never
 * a broken checkout step because a third-party script didn't load.
 *
 * `resolveStripe()` (`stripeClient.ts`) is only ever called from here, i.e.
 * lazily, the first time this step actually renders — never at module eval
 * / app boot — and is itself memoized per session, so re-mounting this
 * component (e.g. the parent backs out of checkout and starts over) doesn't
 * reload Stripe's script a second time.
 */
export function AddressStep({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (address: ShippingAddressInput) => void;
}) {
  const [mode, setMode] = useState<Mode>(() => (fixtureModeActive() ? { kind: 'manual' } : { kind: 'checking' }));

  useEffect(() => {
    if (mode.kind !== 'checking') return;
    let cancelled = false;
    resolveStripe().then((stripe) => {
      if (cancelled) return;
      setMode(stripe ? { kind: 'stripe', stripe } : { kind: 'manual' });
    });
    return () => {
      cancelled = true;
    };
  }, [mode.kind]);

  if (mode.kind === 'checking') {
    return <p className="checkout-screen__hint">Loading address form…</p>;
  }
  if (mode.kind === 'stripe') {
    return <StripeAddressForm stripe={mode.stripe} submitting={submitting} onSubmit={onSubmit} />;
  }
  return <AddressForm submitting={submitting} onSubmit={onSubmit} />;
}
