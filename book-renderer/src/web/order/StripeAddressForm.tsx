import { useState, type FormEvent } from 'react';
import { Elements, AddressElement } from '@stripe/react-stripe-js';
import type { Appearance, Stripe, StripeAddressElementChangeEvent } from '@stripe/stripe-js';
import { SHIPS_TO_COUNTRIES } from './shippingCountries';
import { toShippingAddressInput, type StripeAddressValue } from './stripeAddressMapping';
import type { ShippingAddressInput } from './types';

/**
 * Appearance kept minimal (Design Decision 4): just enough for the Element
 * to read as part of the app, not a full re-skin of Stripe's own chrome.
 * `colorPrimary`/`borderRadius` are copied from `theme.ts` (`colors.primary`
 * / `radius.md`, the book-renderer package's own copy of the app's design
 * tokens — see that file's header comment on why it's copied, not
 * imported). `fonts.cssSrc` is the SAME Google Fonts `<link>` `web.html`
 * already loads (Plus Jakarta Sans is this app's `--font-sans`) — nothing
 * new added to the page's font budget, just handed to Stripe's iframe too
 * (fonts don't cross an iframe boundary on their own).
 */
const APPEARANCE: Appearance = {
  variables: {
    colorPrimary: '#D63E78',
    fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
    borderRadius: '12px',
  },
};

const FONTS = [
  {
    cssSrc:
      'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,300;0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,300;1,6..72,400;1,6..72,500&family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Caveat:wght@400;500;600;700&display=swap',
  },
];

/**
 * Tier 2 address entry (checkout address-entry plan): Stripe's Address
 * Element in shipping mode, with the Google-Maps-backed type-ahead
 * autocomplete Stripe provides on the owner's own key
 * (`autocomplete: { mode: 'automatic' }` is actually the default — listed
 * explicitly to document the choice, per Design Decision 4).
 * `allowedCountries` narrows to the SAME `SHIPS_TO_COUNTRIES` list the
 * manual `AddressForm`'s `<select>` uses, so this path can never collect a
 * destination the manual path couldn't quote either. An `<Elements>`
 * provider with no `clientSecret` is fine here — the Address Element
 * doesn't need a PaymentIntent/SetupIntent context, only the manual form's
 * server contract (`quote` op) does anything with the result.
 *
 * `AddressStep.tsx` is the only caller — it already resolved `stripe` (a
 * real, non-null `Stripe` instance) before rendering this component, and
 * falls back to `AddressForm` itself for every failure case, so this
 * component can assume a working Stripe instance throughout its lifetime.
 *
 * Keyboard-safe (repo UX rule, same as `AddressForm.tsx`'s header comment):
 * the Element renders inside an iframe Stripe controls, outside this
 * component's layout control, but the submit button below it stays in
 * normal document flow — never `position: fixed` — identical to the manual
 * form, so it scrolls into view above an on-screen keyboard rather than
 * being pinned behind it.
 */
export function StripeAddressForm({
  stripe,
  submitting,
  onSubmit,
}: {
  stripe: Stripe;
  submitting: boolean;
  onSubmit: (address: ShippingAddressInput) => void;
}) {
  const [value, setValue] = useState<StripeAddressValue | null>(null);

  function handleChange(event: StripeAddressElementChangeEvent) {
    setValue(event.complete ? (event.value as StripeAddressValue) : null);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!value || submitting) return;
    onSubmit(toShippingAddressInput(value));
  }

  return (
    <Elements stripe={stripe} options={{ appearance: APPEARANCE, fonts: FONTS }}>
      <form className="address-form" onSubmit={handleSubmit}>
        <AddressElement
          options={{
            mode: 'shipping',
            display: { name: 'full' },
            allowedCountries: SHIPS_TO_COUNTRIES.map((country) => country.code),
            autocomplete: { mode: 'automatic' },
          }}
          onChange={handleChange}
        />
        <button type="submit" className="address-form__submit" disabled={!value || submitting}>
          {submitting ? 'Getting your quote…' : 'Get quote'}
        </button>
      </form>
    </Elements>
  );
}
