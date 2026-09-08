import { useState, type FormEvent } from 'react';
import { SHIPS_TO_COUNTRIES, DEFAULT_SHIPS_TO_COUNTRY_CODE } from './shippingCountries';
import type { ShippingAddressInput } from './types';

/**
 * Shipping address step of the checkout flow (memory-book-5c plan Step 6,
 * Design Decision 5: "address form (keyboard-safe, Stripe-Tax-compatible
 * fields)"). Country is a `<select>` limited to `SHIPS_TO_COUNTRIES`
 * (`shippingCountries.ts`) rather than a free-text field — narrows what a
 * parent can submit to what `memory-book-orders`' `quote` op can actually
 * quote, though the server independently re-validates the code's shape
 * regardless (see that file's own header comment on the real trust
 * boundary).
 *
 * Keyboard-safe (repo UX rule): every input uses 16px+ font (iOS Safari's
 * auto-zoom-on-focus threshold, same pattern as `LoginScreen.css`), the
 * submit button sits in normal document flow — never `position: fixed` —
 * so it scrolls into view above the on-screen keyboard rather than being
 * pinned off-screen behind it, and the screen wrapper (`CheckoutScreen.css`)
 * uses `100dvh`, not `100vh`.
 */
export function AddressForm({
  submitting,
  onSubmit,
}: {
  submitting: boolean;
  onSubmit: (address: ShippingAddressInput) => void;
}) {
  const [name, setName] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [countryCode, setCountryCode] = useState(DEFAULT_SHIPS_TO_COUNTRY_CODE);

  const valid = name.trim().length > 0 && line1.trim().length > 0 && postalCode.trim().length > 0 && countryCode.length > 0;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    onSubmit({
      name: name.trim(),
      line1: line1.trim(),
      line2: line2.trim() || undefined,
      city: city.trim() || undefined,
      state: state.trim() || undefined,
      postalCode: postalCode.trim(),
      countryCode,
    });
  }

  return (
    <form className="address-form" onSubmit={handleSubmit}>
      <label className="address-field">
        <span className="address-field__label">Full name</span>
        <input
          type="text"
          autoComplete="name"
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="address-field__input"
          placeholder="Who's this shipping to?"
        />
      </label>

      <label className="address-field">
        <span className="address-field__label">Address line 1</span>
        <input
          type="text"
          autoComplete="address-line1"
          required
          maxLength={200}
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          className="address-field__input"
          placeholder="Street address"
        />
      </label>

      <label className="address-field">
        <span className="address-field__label">Address line 2 (optional)</span>
        <input
          type="text"
          autoComplete="address-line2"
          maxLength={200}
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
          className="address-field__input"
          placeholder="Apartment, suite, etc."
        />
      </label>

      <div className="address-form__row">
        <label className="address-field address-field--grow">
          <span className="address-field__label">City</span>
          <input
            type="text"
            autoComplete="address-level2"
            maxLength={200}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="address-field__input"
          />
        </label>
        <label className="address-field">
          <span className="address-field__label">State / region</span>
          <input
            type="text"
            autoComplete="address-level1"
            maxLength={200}
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="address-field__input"
          />
        </label>
      </div>

      <div className="address-form__row">
        <label className="address-field">
          <span className="address-field__label">Postal code</span>
          <input
            type="text"
            autoComplete="postal-code"
            required
            maxLength={20}
            value={postalCode}
            onChange={(e) => setPostalCode(e.target.value)}
            className="address-field__input"
          />
        </label>
        <label className="address-field address-field--grow">
          <span className="address-field__label">Country</span>
          <select
            autoComplete="country"
            required
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            className="address-field__input address-field__select"
          >
            {SHIPS_TO_COUNTRIES.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button type="submit" className="address-form__submit" disabled={!valid || submitting}>
        {submitting ? 'Getting your quote…' : 'Get quote'}
      </button>
    </form>
  );
}
