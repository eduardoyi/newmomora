import { describe, expect, it } from 'vitest';

import { hmacSha256Hex, verifySignedBody } from '../src/crypto';

describe('workflow HMAC authentication', () => {
  const secret = 'test-secret';
  const timestamp = '1800000000000';
  const nonce = '50abcc52-5c0d-4b7b-86d4-1b3a0a661111';
  const body = JSON.stringify({ jobId: '50abcc52-5c0d-4b7b-86d4-1b3a0a661112' });

  it('accepts the timestamp + nonce + raw body canonical signature', async () => {
    const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${body}`);
    await expect(verifySignedBody(secret, timestamp, nonce, signature, body, Number(timestamp))).resolves.toBe(true);
  });

  it('rejects a tampered nonce or body', async () => {
    const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${body}`);
    await expect(
      verifySignedBody(secret, timestamp, '50abcc52-5c0d-4b7b-86d4-1b3a0a661113', signature, body, Number(timestamp)),
    ).resolves.toBe(false);
    await expect(verifySignedBody(secret, timestamp, nonce, signature, `${body}x`, Number(timestamp))).resolves.toBe(false);
  });

  it('rejects a stale replay even with a valid signature', async () => {
    const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${body}`);
    await expect(
      verifySignedBody(secret, timestamp, nonce, signature, body, Number(timestamp) + 5 * 60 * 1000 + 1),
    ).resolves.toBe(false);
  });
});
