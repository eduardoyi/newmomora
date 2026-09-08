/**
 * HMAC signing/verification for the render worker's public HTTP ops
 * (memory-book-5c plan, Step 3: "HMAC-gated (timestamp+nonce+raw-body SHA-256
 * scheme — mirror cloudflare/memory-book-worker/src/crypto.ts exactly)").
 *
 * This file's `hmacSha256Hex`/`timingSafeEqualHex`/`verifySignedBody` are a
 * VERBATIM port of that file — same algorithm, same construction
 * (`${timestamp}.${nonce}.${rawBody}`), same 5-minute clock-skew window,
 * same nonce shape (a UUID) — not a reimplementation. It compiles unchanged
 * here because Node 22's global `crypto` object implements the identical
 * Web Crypto API (`crypto.subtle`, `crypto.randomUUID`) the Cloudflare
 * Workers runtime does; no Node-specific `node:crypto` import is needed or
 * used, on purpose, so the two files can be diffed directly against each
 * other as this scheme evolves.
 *
 * `sign()` below has no counterpart in the Workers file (that side only
 * ever verifies — see `cloudflare/memory-book-worker/src/index.ts`'s
 * `handleDispatch`); it exists here because THIS module's test suite (and
 * the future order-workflow caller, plan step 5, a separate change) needs to
 * construct signed requests, mirroring `cloudflare/memory-book-worker/src/
 * bridge.ts`'s `callBridge` signing shape exactly (timestamp = `Date.now()`
 * string, nonce = `crypto.randomUUID()`).
 */

const encoder = new TextEncoder();

export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare fixed-size HMAC digests without exposing the first differing byte.
 * Malformed input is decoded to zero bytes and still completes the same loop.
 */
export function timingSafeEqualHex(left: string, right: string): boolean {
  const decodeDigest = (value: string): { bytes: Uint8Array; valid: boolean } => {
    const bytes = new Uint8Array(32);
    const valid = /^[0-9a-f]{64}$/i.test(value);
    if (!valid) return { bytes, valid: false };
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return { bytes, valid: true };
  };

  const first = decodeDigest(left);
  const second = decodeDigest(right);

  let difference = 0;
  for (let index = 0; index < first.bytes.length; index += 1) {
    difference |= first.bytes[index] ^ second.bytes[index];
  }
  return first.valid && second.valid && difference === 0;
}

export async function verifySignedBody(
  secret: string,
  timestamp: string | null,
  nonce: string | null,
  signature: string | null,
  rawBody: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !timestamp ||
    !nonce ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    return false;
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > 5 * 60 * 1000) {
    return false;
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${rawBody}`);
  return timingSafeEqualHex(expected, signature ?? '');
}

export interface SignedRequestHeaders {
  'x-render-timestamp': string;
  'x-render-nonce': string;
  'x-render-signature': string;
}

/**
 * Signs a raw request body the same way `verifySignedBody` above expects to
 * verify it — the caller-side counterpart (order workflow, plan step 5; this
 * module's own tests; `scripts/parity-proof.mts`).
 */
export async function sign(secret: string, rawBody: string, now = Date.now()): Promise<SignedRequestHeaders> {
  const timestamp = String(now);
  const nonce = crypto.randomUUID();
  const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${rawBody}`);
  return {
    'x-render-timestamp': timestamp,
    'x-render-nonce': nonce,
    'x-render-signature': signature,
  };
}
