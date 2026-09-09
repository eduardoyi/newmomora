/**
 * Pure mapping from Stripe's Address Element `change` event value to this
 * app's own `ShippingAddressInput` (checkout address-entry Tier 2 plan,
 * Design Decision 6). Deliberately does NOT import `@stripe/stripe-js`
 * types — a minimal local `StripeAddressValue` interface instead — so this
 * module has no DOM/Stripe dependency at all and stays unit-testable under
 * this package's vitest config, which runs with NO jsdom (see
 * `vite.config.ts`'s `test` block, and `orderStatusCopy.ts`'s identical
 * "pulled out to be pure + unit-testable" rationale). The only caller is
 * `StripeAddressForm.tsx`.
 */
import type { ShippingAddressInput } from './types';

/** Minimal local shape of `StripeAddressElementChangeEvent['value']`
 * (`@stripe/stripe-js`) — only the fields this app actually reads. */
export interface StripeAddressValue {
  name: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    state: string;
    postal_code: string;
    country: string;
  };
}

export function toShippingAddressInput(value: StripeAddressValue): ShippingAddressInput {
  const { name, address } = value;
  return {
    name: name.trim(),
    line1: address.line1.trim(),
    line2: address.line2?.trim() || undefined,
    city: address.city.trim() || undefined,
    state: address.state.trim() || undefined,
    postalCode: address.postal_code.trim(),
    countryCode: address.country,
  };
}
