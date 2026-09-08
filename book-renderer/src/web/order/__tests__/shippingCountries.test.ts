import { describe, expect, it } from 'vitest';
import { DEFAULT_SHIPS_TO_COUNTRY_CODE, isShipsToCountryCode, SHIPS_TO_COUNTRIES } from '../shippingCountries';

describe('SHIPS_TO_COUNTRIES', () => {
  it('every entry is a 2-letter ISO code with a non-empty name, no duplicates', () => {
    const seen = new Set<string>();
    for (const country of SHIPS_TO_COUNTRIES) {
      expect(country.code).toMatch(/^[A-Z]{2}$/);
      expect(country.name.length).toBeGreaterThan(0);
      expect(seen.has(country.code)).toBe(false);
      seen.add(country.code);
    }
  });

  it('the default country is itself in the list', () => {
    expect(isShipsToCountryCode(DEFAULT_SHIPS_TO_COUNTRY_CODE)).toBe(true);
  });

  it('rejects a code not on the list', () => {
    expect(isShipsToCountryCode('ZZ')).toBe(false);
  });
});
