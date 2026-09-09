import { loadStripe, type Stripe } from '@stripe/stripe-js';

/**
 * Lazy, once-per-session memo around `loadStripe` (checkout address-entry
 * Tier 2 plan, Design Decision 3): the publishable-key check and the
 * `<script>` load it triggers only happen the first time something actually
 * asks for a Stripe instance (`AddressStep.tsx`, when the address step of
 * checkout renders) — never at module eval / app boot — and every later
 * call in the same session reuses the same in-flight/resolved promise
 * rather than injecting Stripe's loader script more than once.
 *
 * `VITE_STRIPE_PUBLISHABLE_KEY` is build-time, public config (see
 * `vite-env.d.ts`'s header comment — a Stripe publishable key is safe to
 * expose client-side by design, same posture as the Supabase anon key in
 * `supabaseClient.ts`). Missing/empty short-circuits to `null` without ever
 * calling `loadStripe` at all; a present-but-bad key, a blocked script, or
 * any other `loadStripe` failure also resolves to `null` rather than
 * rejecting — every caller treats `null` as "fall back to the manual
 * `AddressForm`", never as an error to surface to the parent filling out
 * checkout.
 */

let stripePromise: Promise<Stripe | null> | null = null;

export function resolveStripe(): Promise<Stripe | null> {
  const key = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
  if (!key) return Promise.resolve(null);
  if (!stripePromise) {
    stripePromise = loadStripe(key).catch(() => null);
  }
  return stripePromise;
}
