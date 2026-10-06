import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AddressForm } from '../AddressForm';
import { DEFAULT_SHIPS_TO_COUNTRY_CODE, SHIPS_TO_COUNTRIES, resolveShipsToCountries } from '../shippingCountries';
import { addressElementCountries, toStripeDefaultValues } from '../stripeAddressMapping';

const noop = () => {};
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AddressForm, { submitting: false, onSubmit: noop, ...props }));
const optionCodes = (html: string) => {
  const countrySelect = /<select name="country"[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
  return [...countrySelect.matchAll(/<option value="([A-Z]{2})"/g)].map((m) => m[1]);
};

describe('the Memory Book address path is unchanged (no new props)', () => {
  it('resolves to the very same country list, and the Stripe element gets the same codes', () => {
    expect(resolveShipsToCountries()).toBe(SHIPS_TO_COUNTRIES);
    expect(addressElementCountries()).toEqual(SHIPS_TO_COUNTRIES.map((c) => c.code));
    expect(addressElementCountries()).toHaveLength(9);
  });

  it('the manual form still offers every book country, a free-text state, and optional city', () => {
    const html = render();
    expect(optionCodes(html)).toEqual(SHIPS_TO_COUNTRIES.map((c) => c.code));
    expect(html).toContain('<input type="text" name="state"');
    expect(html).not.toContain('<select name="state"');
    // City is not required for books.
    expect(html).toMatch(/name="city"[^>]*/);
    expect(html.match(/<input[^>]*name="city"[^>]*>/)?.[0]).not.toContain('required');
    expect(html).toContain(`<option value="${DEFAULT_SHIPS_TO_COUNTRY_CODE}" selected`);
    expect(html).toContain('State / region');
    expect(html).toContain('Postal code');
    expect(html).not.toContain('address-form__field-error');
  });
});

describe('holiday cards narrow it', () => {
  it('the country list and the Stripe element are limited to the US and Canada', () => {
    expect(resolveShipsToCountries(['US', 'CA']).map((c) => c.code)).toEqual(['US', 'CA']);
    expect(addressElementCountries(['US', 'CA'])).toEqual(['US', 'CA']);
  });

  it('the manual form offers only US/CA, requires city, and picks the state from a list', () => {
    const html = render({ allowedCountries: ['US', 'CA'], requireRegion: true });
    expect(optionCodes(html)).toEqual(['US', 'CA']);
    expect(html).toContain('<select name="state"');
    expect(html).toContain('Illinois');
    expect(html).not.toContain('Ontario'); // US selected by default: only US states.
    expect(html.match(/<input[^>]*name="city"[^>]*>/)?.[0]).toContain('required');
    expect(html).toContain('ZIP code');
    expect(html).not.toContain('>Mexico<');
  });

  it('prefills when coming back to change the address', () => {
    const html = render({
      allowedCountries: ['US', 'CA'],
      requireRegion: true,
      defaultAddress: { name: 'Diego Rivera', line1: '2 Sample Road', city: 'Toronto', state: 'ON', postalCode: 'M5V 3L9', countryCode: 'CA' },
    });
    expect(html).toContain('value="Diego Rivera"');
    expect(html).toContain('value="Toronto"');
    expect(html).toContain('Ontario');
    expect(html).toContain('Province');
  });

  it('the Stripe element gets default values in its own shape', () => {
    expect(toStripeDefaultValues({ name: 'A B', line1: '1 St', line2: undefined, city: 'X', state: 'IL', postalCode: '62701', countryCode: 'US' })).toEqual({
      name: 'A B',
      address: { line1: '1 St', city: 'X', state: 'IL', postal_code: '62701', country: 'US' },
    });
  });
});
