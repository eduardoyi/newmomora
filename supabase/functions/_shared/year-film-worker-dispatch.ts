/**
 * HMAC-signed POST to the year-film Cloudflare worker (`CLOUDFLARE_YEAR_FILM_WORKFLOW_URL`).
 * One signing scheme for every dispatch the worker accepts: `/dispatch`
 * (schedule-year-films) and `/holiday-cards/generate` (holiday-cards).
 *
 * Signature = hex(HMAC-SHA256(secret, `${timestamp}.${nonce}.${body}`)), sent as
 * `x-dispatch-timestamp` / `x-dispatch-nonce` / `x-dispatch-signature`.
 * Returns true on any 2xx (202 = accepted, including a duplicate), false when the
 * env is not configured or the worker answers non-2xx. Network errors and the
 * 15 s timeout reject; callers decide how to treat a throw (both current callers
 * treat it like false).
 *
 * Bodies carry ids only. Never log the body or the signature.
 */
export async function postSignedToYearFilmWorker(path: string, payload: Record<string, unknown>): Promise<boolean> {
  const endpoint = Deno.env.get('CLOUDFLARE_YEAR_FILM_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_YEAR_FILM_WORKFLOW_SECRET');
  if (!endpoint || !secret) return false;
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`));
  const signature = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const response = await fetch(`${endpoint.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok;
}
