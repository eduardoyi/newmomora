import type { ShippingAddressInput } from './types';

/**
 * Pure address rules for HOLIDAY CARD orders (docs/plans/holiday-cards-p2.md
 * Step 5). Mirrors `validateCardShippingAddress` in
 * `supabase/functions/holiday-card-orders/index.ts` so a typo is caught on the
 * form instead of after a quote round trip: US and Canada only; name, line 1,
 * city and a 2-letter state/province are required; a US ZIP is 5 digits or
 * 5-4; a Canadian postal code is A1A 1A1 (normalized to that shape, upper
 * case). The server stays the authority: it re-validates every field.
 *
 * Kept separate from the book address path (`AddressForm` only applies these
 * when a caller opts in with `requireRegion`), so Memory Book checkout is
 * unchanged.
 */

export type CardCountryCode = 'US' | 'CA';

/** The countries a holiday card ships to (matches the server's `regionForCountry`). */
export const CARD_COUNTRY_CODES: readonly CardCountryCode[] = ['US', 'CA'];

export interface RegionOption {
  code: string;
  name: string;
}

export const US_STATES: readonly RegionOption[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

export const CA_PROVINCES: readonly RegionOption[] = [
  { code: 'AB', name: 'Alberta' },
  { code: 'BC', name: 'British Columbia' },
  { code: 'MB', name: 'Manitoba' },
  { code: 'NB', name: 'New Brunswick' },
  { code: 'NL', name: 'Newfoundland and Labrador' },
  { code: 'NS', name: 'Nova Scotia' },
  { code: 'NT', name: 'Northwest Territories' },
  { code: 'NU', name: 'Nunavut' },
  { code: 'ON', name: 'Ontario' },
  { code: 'PE', name: 'Prince Edward Island' },
  { code: 'QC', name: 'Quebec' },
  { code: 'SK', name: 'Saskatchewan' },
  { code: 'YT', name: 'Yukon' },
];

/** The state/province options for a country (empty for any other country). */
export function regionsForCountry(countryCode: string): readonly RegionOption[] {
  if (countryCode === 'US') return US_STATES;
  if (countryCode === 'CA') return CA_PROVINCES;
  return [];
}

/** Same patterns as the server (`US_POSTAL`, `CA_POSTAL`, `REGION_CODE`). */
export const US_POSTAL = /^\d{5}(-\d{4})?$/;
export const CA_POSTAL = /^([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)$/;
export const REGION_CODE = /^[A-Z]{2}$/;
const MAX_FIELD = 200;
const MAX_POSTAL = 20;

export interface CardShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: CardCountryCode;
}

export type CardAddressField = 'name' | 'line1' | 'line2' | 'city' | 'state' | 'postalCode' | 'countryCode';
export type CardAddressErrors = Partial<Record<CardAddressField, string>>;

export type CardAddressValidation = { ok: true; address: CardShippingAddress } | { ok: false; errors: CardAddressErrors };

/** US ZIP / Canadian postal code check; returns the normalized code (CA: `A1A 1A1`) or null when invalid. */
export function normalizePostalCode(countryCode: string, raw: string): string | null {
  const value = raw.trim();
  // Autofill writes ZIP+4 as "12345 - 6789"; accept it and send "12345-6789".
  if (countryCode === 'US') {
    const zip = value.replace(/\s*-\s*/, '-');
    return US_POSTAL.test(zip) ? zip : null;
  }
  if (countryCode === 'CA') {
    const match = CA_POSTAL.exec(value);
    return match ? `${match[1]} ${match[2]}`.toUpperCase() : null;
  }
  return null;
}

function bounded(value: string | undefined, max: number): boolean {
  return value !== undefined && value.trim().length > 0 && value.length <= max;
}

/** Validates a form address against the server's card rules; on success returns the normalized address the server will accept. */
export function validateCardAddress(input: ShippingAddressInput): CardAddressValidation {
  const errors: CardAddressErrors = {};
  const countryCode = (input.countryCode ?? '').trim().toUpperCase();

  if (!bounded(input.name, MAX_FIELD)) errors.name = 'Enter the full name for the delivery.';
  if (!bounded(input.line1, MAX_FIELD)) errors.line1 = 'Enter the street address.';
  if (input.line2 && input.line2.length > MAX_FIELD) errors.line2 = 'That line is too long.';
  if (!bounded(input.city, MAX_FIELD)) errors.city = 'Enter the city.';

  if (!CARD_COUNTRY_CODES.includes(countryCode as CardCountryCode)) {
    errors.countryCode = 'Holiday cards ship to the United States and Canada for now.';
  }

  const state = (input.state ?? '').trim().toUpperCase();
  if (!REGION_CODE.test(state)) errors.state = countryCode === 'CA' ? 'Choose the province.' : 'Choose the state.';

  let postalCode: string | null = null;
  if (!bounded(input.postalCode, MAX_POSTAL)) {
    errors.postalCode = countryCode === 'CA' ? 'Enter the postal code.' : 'Enter the ZIP code.';
  } else if (CARD_COUNTRY_CODES.includes(countryCode as CardCountryCode)) {
    postalCode = normalizePostalCode(countryCode, input.postalCode);
    if (!postalCode) errors.postalCode = countryCode === 'CA' ? 'Use a Canadian postal code like A1A 1A1.' : 'Use a 5-digit ZIP code (or ZIP+4, like 12345-6789).';
  }

  if (Object.keys(errors).length > 0 || postalCode === null) return { ok: false, errors };
  const line2 = input.line2?.trim() || undefined;
  return {
    ok: true,
    address: {
      name: input.name.trim(),
      line1: input.line1.trim(),
      ...(line2 ? { line2 } : {}),
      city: (input.city ?? '').trim(),
      state,
      postalCode,
      countryCode: countryCode as CardCountryCode,
    },
  };
}

/** One line per error, for a banner (field order). */
export function addressErrorMessages(errors: CardAddressErrors): string[] {
  const order: CardAddressField[] = ['name', 'line1', 'line2', 'city', 'state', 'postalCode', 'countryCode'];
  return order.flatMap((f) => (errors[f] ? [errors[f] as string] : []));
}

/** A multi-line "ship to" block for the order summary. */
export function formatAddressLines(address: CardShippingAddress): string[] {
  return [
    address.name,
    address.line1,
    ...(address.line2 ? [address.line2] : []),
    `${address.city}, ${address.state} ${address.postalCode}`,
    address.countryCode === 'CA' ? 'Canada' : 'United States',
  ];
}
