import { describe, expect, it } from 'vitest';
import {
  CA_PROVINCES,
  CARD_COUNTRY_CODES,
  US_STATES,
  addressErrorMessages,
  formatAddressLines,
  normalizePostalCode,
  regionsForCountry,
  validateCardAddress,
} from '../cardAddress';
import type { ShippingAddressInput } from '../types';

const US: ShippingAddressInput = { name: 'Lucía Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' };
const CA: ShippingAddressInput = { name: 'Diego Rivera', line1: '2 Sample Road', city: 'Toronto', state: 'ON', postalCode: 'm5v 3l9', countryCode: 'CA' };

describe('validateCardAddress mirrors the server rule', () => {
  it('accepts a US and a Canadian address, normalizing the postal code and state', () => {
    expect(validateCardAddress(US)).toEqual({ ok: true, address: { ...US } });
    const ca = validateCardAddress({ ...CA, state: 'on' });
    expect(ca).toEqual({ ok: true, address: { ...CA, state: 'ON', postalCode: 'M5V 3L9' } });
  });

  it('US ZIP: 5 digits or ZIP+4 only', () => {
    expect(normalizePostalCode('US', '62701')).toBe('62701');
    expect(normalizePostalCode('US', ' 62701-1234 ')).toBe('62701-1234');
    for (const bad of ['6270', '627011', '62701-12', 'ABCDE', '62701 1234']) expect(normalizePostalCode('US', bad), bad).toBeNull();
  });

  it('Canadian postal code: A1A 1A1 with an optional space or dash', () => {
    expect(normalizePostalCode('CA', 'M5V3L9')).toBe('M5V 3L9');
    expect(normalizePostalCode('CA', 'm5v-3l9')).toBe('M5V 3L9');
    for (const bad of ['12345', 'M5V 3L', '5MV 3L9']) expect(normalizePostalCode('CA', bad), bad).toBeNull();
  });

  it('city and a 2-letter state are required', () => {
    const noCity = validateCardAddress({ ...US, city: '' });
    expect(noCity.ok).toBe(false);
    if (!noCity.ok) expect(noCity.errors.city).toBeDefined();
    const noState = validateCardAddress({ ...US, state: undefined });
    expect(noState.ok).toBe(false);
    if (!noState.ok) expect(noState.errors.state).toMatch(/state/i);
    const longState = validateCardAddress({ ...US, state: 'Illinois' });
    expect(longState.ok).toBe(false);
    const caNoProvince = validateCardAddress({ ...CA, state: '' });
    if (!caNoProvince.ok) expect(caNoProvince.errors.state).toMatch(/province/i);
  });

  it('only the US and Canada', () => {
    const mx = validateCardAddress({ ...US, countryCode: 'MX' });
    expect(mx.ok).toBe(false);
    if (!mx.ok) expect(mx.errors.countryCode).toMatch(/United States and Canada/);
    expect(CARD_COUNTRY_CODES).toEqual(['US', 'CA']);
  });

  it('required text fields, optional line 2', () => {
    expect(validateCardAddress({ ...US, name: '  ' }).ok).toBe(false);
    expect(validateCardAddress({ ...US, line1: '' }).ok).toBe(false);
    const withLine2 = validateCardAddress({ ...US, line2: ' Apt 4 ' });
    expect(withLine2).toMatchObject({ ok: true, address: { line2: 'Apt 4' } });
    const without = validateCardAddress({ ...US, line2: '   ' });
    expect(without.ok && 'line2' in without.address).toBe(false);
  });

  it('reports every problem, in field order', () => {
    const result = validateCardAddress({ name: '', line1: '', city: '', state: '', postalCode: 'x', countryCode: 'US' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(addressErrorMessages(result.errors).length).toBe(5);
  });
});

describe('regions', () => {
  it('lists every US state (50 + DC) and Canadian province/territory (13)', () => {
    expect(US_STATES).toHaveLength(51);
    expect(CA_PROVINCES).toHaveLength(13);
    for (const r of [...US_STATES, ...CA_PROVINCES]) expect(r.code).toMatch(/^[A-Z]{2}$/);
    expect(new Set(US_STATES.map((r) => r.code)).size).toBe(51);
    expect(regionsForCountry('US')).toBe(US_STATES);
    expect(regionsForCountry('CA')).toBe(CA_PROVINCES);
    expect(regionsForCountry('MX')).toEqual([]);
  });
});

describe('formatAddressLines', () => {
  it('names the country and joins city, state and postal code', () => {
    const us = validateCardAddress(US);
    const ca = validateCardAddress(CA);
    if (!us.ok || !ca.ok) throw new Error('fixture invalid');
    expect(formatAddressLines(us.address)).toEqual(['Lucía Rivera', '1 Example Street', 'Springfield, IL 62701', 'United States']);
    expect(formatAddressLines(ca.address).at(-1)).toBe('Canada');
  });
});
