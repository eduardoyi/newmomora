import { useEffect, useState } from 'react';
import type { Stripe } from '@stripe/stripe-js';
import { AddressForm } from './AddressForm';
import { StripeAddressForm } from './StripeAddressForm';
import { resolveStripe } from './stripeClient';
import { getFixtureSlug } from '../dev/fixture';
import { addressErrorMessages, validateCardAddress } from './cardAddress';
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
  allowedCountries,
  requireRegion,
  defaultAddress,
}: {
  submitting: boolean;
  onSubmit: (address: ShippingAddressInput) => void;
  /** Narrows the country list (ISO codes). Omitted = the Memory Book list. Holiday cards pass `['US', 'CA']`. */
  allowedCountries?: readonly string[];
  /** Holiday cards: city and a 2-letter state/province are required and the postal code is checked (see `cardAddress.ts`). Omitted = the book rules. */
  requireRegion?: boolean;
  /** Pre-fills the form (coming back to change the address). */
  defaultAddress?: ShippingAddressInput;
}) {
  const [mode, setMode] = useState<Mode>(() => (fixtureModeActive() ? { kind: 'manual' } : { kind: 'checking' }));
  const [formError, setFormError] = useState<string | null>(null);

  // Card orders re-check what the Stripe element returns against the server's
  // rules (the manual form does the same field by field); books pass through.
  function handleSubmit(address: ShippingAddressInput) {
    if (requireRegion) {
      const result = validateCardAddress(address);
      if (!result.ok) {
        setFormError(addressErrorMessages(result.errors).join(' '));
        return;
      }
      setFormError(null);
      onSubmit(result.address);
      return;
    }
    onSubmit(address);
  }

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
  const form =
    mode.kind === 'stripe' ? (
      <StripeAddressForm
        stripe={mode.stripe}
        submitting={submitting}
        onSubmit={handleSubmit}
        allowedCountries={allowedCountries}
        defaultAddress={defaultAddress}
      />
    ) : (
      <AddressForm
        submitting={submitting}
        onSubmit={handleSubmit}
        allowedCountries={allowedCountries}
        requireRegion={requireRegion}
        defaultAddress={defaultAddress}
      />
    );
  // Always a fragment with the notice in slot 0 (so the form keeps its place, and its
  // typed values, when the notice appears).
  return (
    <>
      {formError && (
        <p className="checkout-screen__error" role="alert">
          {formError}
        </p>
      )}
      {form}
    </>
  );
}
