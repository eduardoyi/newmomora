/**
 * Pure helpers for the app -> shop sign-in handoff fragment
 * (`https://shop.usemomora.com/b/<id>#h=<code>`; docs/plans/holiday-cards-p2.md
 * Step 2b). The code travels only in the URL fragment, so it never reaches the
 * shop Worker, Cloudflare logs or a Referer; `main.tsx` reads it before React
 * mounts and strips it from the address bar immediately.
 */

/** 32 random bytes as unpadded base64url (may contain '-' and '_'). */
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function paramsOf(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
}

/** True when the fragment carries an `h` parameter at all (even a malformed one). */
export function hasHandoffParam(hash: string): boolean {
  return paramsOf(hash).has('h');
}

/** The handoff code in a location hash, or null when absent / malformed. */
export function parseHandoffCode(hash: string): string | null {
  const value = paramsOf(hash).get('h');
  return value !== null && CODE_PATTERN.test(value) ? value : null;
}

/**
 * The hash with the `h` parameter removed (other fragment parameters are kept;
 * an otherwise-empty fragment becomes ''). Built by filtering the raw `&`
 * segments, so `-`/`_` in other values are never re-encoded.
 */
export function stripHandoffParam(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const kept = raw.split('&').filter((segment) => segment !== '' && segment.split('=')[0] !== 'h');
  return kept.length > 0 ? `#${kept.join('&')}` : '';
}
