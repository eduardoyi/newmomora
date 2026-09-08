import { assertEquals } from 'jsr:@std/assert@1';
import { verifyStripeSignature } from './stripe.ts';

const SECRET = 'whsec_test_secret';

async function sign(secret: string, timestamp: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function eventPayload(): string {
  return JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
}

Deno.test('verifyStripeSignature accepts a correctly-signed payload within tolerance', async () => {
  const payload = eventPayload();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(SECRET, timestamp, payload);
  const event = await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, SECRET);
  assertEquals(event?.id, 'evt_1');
  assertEquals(event?.type, 'checkout.session.completed');
});

Deno.test('verifyStripeSignature accepts a matching v1 among multiple rotation candidates', async () => {
  const payload = eventPayload();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(SECRET, timestamp, payload);
  const event = await verifyStripeSignature(payload, `t=${timestamp},v1=deadbeef,v1=${signature}`, SECRET);
  assertEquals(event?.id, 'evt_1');
});

Deno.test('verifyStripeSignature rejects a tampered payload', async () => {
  const payload = eventPayload();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(SECRET, timestamp, payload);
  const event = await verifyStripeSignature(payload + 'x', `t=${timestamp},v1=${signature}`, SECRET);
  assertEquals(event, null);
});

Deno.test('verifyStripeSignature rejects a signature computed with the wrong secret', async () => {
  const payload = eventPayload();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign('whsec_wrong', timestamp, payload);
  const event = await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, SECRET);
  assertEquals(event, null);
});

Deno.test('verifyStripeSignature rejects a stale timestamp outside tolerance', async () => {
  const payload = eventPayload();
  const timestamp = String(Math.floor(Date.now() / 1000) - 600);
  const signature = await sign(SECRET, timestamp, payload);
  const event = await verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, SECRET);
  assertEquals(event, null);
});

Deno.test('verifyStripeSignature rejects a missing header', async () => {
  const event = await verifyStripeSignature(eventPayload(), null, SECRET);
  assertEquals(event, null);
});

Deno.test('verifyStripeSignature rejects a malformed header', async () => {
  const event = await verifyStripeSignature(eventPayload(), 'not-a-valid-header', SECRET);
  assertEquals(event, null);
});
