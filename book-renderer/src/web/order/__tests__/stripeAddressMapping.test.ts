import { describe, expect, it } from 'vitest';
import { toShippingAddressInput, type StripeAddressValue } from '../stripeAddressMapping';

function value(overrides: Partial<StripeAddressValue['address']> = {}, name = '  Jane Doe  '): StripeAddressValue {
  return {
    name,
    address: {
      line1: '123 Main St',
      line2: null,
      city: 'Springfield',
      state: 'IL',
      postal_code: '62701',
      country: 'US',
      ...overrides,
    },
  };
}

describe('toShippingAddressInput', () => {
  it('maps a fully populated Address Element value', () => {
    expect(toShippingAddressInput(value())).toEqual({
      name: 'Jane Doe',
      line1: '123 Main St',
      line2: undefined,
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      countryCode: 'US',
    });
  });

  it('trims name and line1/postal_code', () => {
    const result = toShippingAddressInput(value({ line1: '  456 Oak Ave  ', postal_code: '  90210  ' }));
    expect(result.name).toBe('Jane Doe');
    expect(result.line1).toBe('456 Oak Ave');
    expect(result.postalCode).toBe('90210');
  });

  it('maps a null line2 to undefined', () => {
    expect(toShippingAddressInput(value({ line2: null })).line2).toBeUndefined();
  });

  it('maps a whitespace-only line2/city/state to undefined', () => {
    const result = toShippingAddressInput(value({ line2: '   ', city: '', state: '  ' }));
    expect(result.line2).toBeUndefined();
    expect(result.city).toBeUndefined();
    expect(result.state).toBeUndefined();
  });

  it('keeps a real line2 value, trimmed', () => {
    expect(toShippingAddressInput(value({ line2: '  Apt 4B  ' })).line2).toBe('Apt 4B');
  });

  it('passes country through untouched as countryCode', () => {
    expect(toShippingAddressInput(value({ country: 'GB' })).countryCode).toBe('GB');
  });
});
