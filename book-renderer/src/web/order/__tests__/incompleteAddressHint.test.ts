import { describe, expect, it } from 'vitest';
import { incompleteAddressHint } from '../StripeAddressForm';
import { normalizePostalCode } from '../cardAddress';

const draft = (postal: string, country = 'US') => ({
  name: 'Ana Rivera',
  address: { line1: '1 Example Street', line2: null, city: 'Springfield', state: 'IL', postal_code: postal, country },
});

describe('incompleteAddressHint', () => {
  it('is silent before anything is typed', () => {
    expect(incompleteAddressHint(null)).toBeNull();
    expect(incompleteAddressHint({ name: '', address: { line1: '', line2: null, city: '', state: '', postal_code: '', country: 'US' } })).toBeNull();
  });
  it('points at the autofilled spaced ZIP+4', () => {
    expect(incompleteAddressHint(draft('62701 - 1234'))).toMatch(/Remove the spaces in the ZIP code/);
  });
  it('falls back to a general hint otherwise', () => {
    expect(incompleteAddressHint(draft('6270'))).toMatch(/Complete the address/);
    expect(incompleteAddressHint(draft('K1A 0B1', 'CA'))).toMatch(/Complete the address/);
  });
});

describe('normalizePostalCode (US spacing)', () => {
  it('accepts "12345 - 6789" as 12345-6789', () => {
    expect(normalizePostalCode('US', '62701 - 1234')).toBe('62701-1234');
    expect(normalizePostalCode('US', ' 62701-1234 ')).toBe('62701-1234');
    expect(normalizePostalCode('US', '62701')).toBe('62701');
    expect(normalizePostalCode('US', '6270 1')).toBeNull();
  });
});
