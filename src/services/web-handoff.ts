// App -> shop sign-in handoff client (docs/plans/holiday-cards-p2.md Step 2b).
// `openShopUrl(url)` opens a `https://shop.usemomora.com/...` URL already
// signed in: it asks the `web-handoff` Edge Function (`create`) for a
// single-use code and opens `<url>#h=<code>` (the code travels only in the
// URL fragment, so it never reaches the shop Worker, its logs or a Referer).
// Anything that goes wrong -- no network, a slow server, an error, a bad
// response -- opens the plain URL, i.e. today's behaviour (the shop then shows
// its own email-code sign-in). Never logs the code.
import { Linking } from 'react-native';

import { invokeEdgeFunction } from '@/services/ai';

export const SHOP_ORIGIN = 'https://shop.usemomora.com';
export const WEB_HANDOFF_TIMEOUT_MS = 3000;

const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TIMED_OUT = Symbol('web-handoff-timed-out');

/** Only https://shop.usemomora.com/... gets a code; the trailing slash pins the host. */
export function isShopUrl(url: string): boolean {
  return url.startsWith(`${SHOP_ORIGIN}/`);
}

async function requestHandoffCode(): Promise<string | null> {
  try {
    const { data, error } = await invokeEdgeFunction<{ code?: unknown }>('web-handoff', { op: 'create' });
    if (error || !data || typeof data.code !== 'string' || !CODE_PATTERN.test(data.code)) return null;
    return data.code;
  } catch {
    return null;
  }
}

async function createHandoffCodeWithTimeout(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      requestHandoffCode(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), WEB_HANDOFF_TIMEOUT_MS);
      }),
    ]);
    return result === TIMED_OUT ? null : result;
  } finally {
    clearTimeout(timer);
  }
}

let inFlight: Promise<void> | null = null;

async function openWithHandoff(url: string): Promise<void> {
  try {
    // A URL that already has a fragment keeps it as-is (no code appended).
    const code = url.includes('#') ? null : await createHandoffCodeWithTimeout();
    await Linking.openURL(code ? `${url}#h=${code}` : url);
  } catch {
    // openURL itself failing (no browser, blocked scheme) is not recoverable here.
  }
}

/**
 * Opens a shop URL signed in when possible. Non-shop URLs are opened as-is
 * with no network call. While one handoff is in flight, further calls (a
 * double tap) join it and open nothing extra.
 */
export function openShopUrl(url: string): Promise<void> {
  if (!isShopUrl(url)) {
    return Linking.openURL(url).then(
      () => undefined,
      () => undefined,
    );
  }
  if (inFlight) return inFlight;
  const run = openWithHandoff(url).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Test seam: forget any in-flight handoff. */
export function resetWebHandoffForTests(): void {
  inFlight = null;
}
