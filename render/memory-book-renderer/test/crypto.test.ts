import { describe, expect, it } from 'vitest';
import { sign, verifySignedBody } from '../src/crypto';

/**
 * The timestamp+nonce+raw-body HMAC scheme (memory-book-5c plan, Step 3:
 * "mirror cloudflare/memory-book-worker/src/crypto.ts exactly"). These
 * cases mirror that file's own test suite
 * (`cloudflare/memory-book-worker/test/crypto.test.ts`) — valid/expired/
 * bad-signature — using THIS module's `sign()` helper as the caller side.
 */
describe('HMAC verify (valid/expired/bad-sig)', () => {
  const secret = 'test-secret';
  const rawBody = JSON.stringify({ orderId: 'order-1' });

  it('accepts a freshly-signed request', async () => {
    const headers = await sign(secret, rawBody);
    const ok = await verifySignedBody(
      secret,
      headers['x-render-timestamp'],
      headers['x-render-nonce'],
      headers['x-render-signature'],
      rawBody,
    );
    expect(ok).toBe(true);
  });

  it('rejects a request signed more than 5 minutes ago (expired)', async () => {
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    const headers = await sign(secret, rawBody, sixMinutesAgo);
    const ok = await verifySignedBody(
      secret,
      headers['x-render-timestamp'],
      headers['x-render-nonce'],
      headers['x-render-signature'],
      rawBody,
    );
    expect(ok).toBe(false);
  });

  it('rejects a request signed too far in the future (clock-skew window is symmetric)', async () => {
    const sixMinutesAhead = Date.now() + 6 * 60 * 1000;
    const headers = await sign(secret, rawBody, sixMinutesAhead);
    const ok = await verifySignedBody(
      secret,
      headers['x-render-timestamp'],
      headers['x-render-nonce'],
      headers['x-render-signature'],
      rawBody,
    );
    expect(ok).toBe(false);
  });

  it('rejects a bad signature', async () => {
    const headers = await sign(secret, rawBody);
    const ok = await verifySignedBody(secret, headers['x-render-timestamp'], headers['x-render-nonce'], 'deadbeef'.repeat(8), rawBody);
    expect(ok).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const headers = await sign('a-different-secret', rawBody);
    const ok = await verifySignedBody(
      secret,
      headers['x-render-timestamp'],
      headers['x-render-nonce'],
      headers['x-render-signature'],
      rawBody,
    );
    expect(ok).toBe(false);
  });

  it('rejects a signature computed against a different raw body (tamper detection)', async () => {
    const headers = await sign(secret, rawBody);
    const ok = await verifySignedBody(
      secret,
      headers['x-render-timestamp'],
      headers['x-render-nonce'],
      headers['x-render-signature'],
      JSON.stringify({ orderId: 'order-2' }),
    );
    expect(ok).toBe(false);
  });

  it('rejects a missing nonce/timestamp/signature', async () => {
    expect(await verifySignedBody(secret, null, 'a-nonce', 'sig', rawBody)).toBe(false);
    expect(await verifySignedBody(secret, String(Date.now()), null, 'sig', rawBody)).toBe(false);
    expect(await verifySignedBody(secret, String(Date.now()), 'not-a-uuid', 'sig', rawBody)).toBe(false);
  });

  it('rejects reuse of a stale-but-well-formed nonce ONLY insofar as this module checks shape+window, not replay — replay protection is the caller\'s responsibility (documented, matches the Workers original)', async () => {
    // This module has no nonce store — a signature replayed within the
    // 5-minute window verifies again. Documenting the boundary explicitly
    // rather than silently assuming replay protection exists.
    const headers = await sign(secret, rawBody);
    const first = await verifySignedBody(secret, headers['x-render-timestamp'], headers['x-render-nonce'], headers['x-render-signature'], rawBody);
    const second = await verifySignedBody(secret, headers['x-render-timestamp'], headers['x-render-nonce'], headers['x-render-signature'], rawBody);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});
