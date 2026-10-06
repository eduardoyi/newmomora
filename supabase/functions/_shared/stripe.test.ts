import { assertEquals } from 'jsr:@std/assert@1';
import { createCheckoutSession, createGenericCheckoutSession, createStripeCustomer, expireCheckoutSession, retrieveCheckoutSession, verifyStripeSignature } from './stripe.ts';

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

// ── Book request snapshot ────────────────────────────────────────────────
// Golden strings captured from the book call BEFORE createCheckoutSession was
// generalised for the holiday-card shop (docs/plans/holiday-cards-p1.md Step
// 6). The book's Stripe request must stay byte-identical: any change here is a
// change to the live book checkout.

const BOOK_SESSION_GOLDEN_BODY =
  'mode=payment&customer=cus_1&customer_update%5Bshipping%5D=auto' +
  '&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=usd' +
  '&line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Momora+Memory+Book' +
  '&line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Btax_code%5D=txcd_35010000' +
  '&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=4999&line_items%5B0%5D%5Bquantity%5D=1' +
  '&line_items%5B1%5D%5Bprice_data%5D%5Bcurrency%5D=usd' +
  '&line_items%5B1%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=Shipping' +
  '&line_items%5B1%5D%5Bprice_data%5D%5Bproduct_data%5D%5Btax_code%5D=txcd_92010001' +
  '&line_items%5B1%5D%5Bprice_data%5D%5Bunit_amount%5D=1234&line_items%5B1%5D%5Bquantity%5D=1' +
  '&managed_payments%5Benabled%5D=false&automatic_tax%5Benabled%5D=true' +
  '&metadata%5BorderId%5D=ord-1&payment_intent_data%5Bmetadata%5D%5BorderId%5D=ord-1' +
  '&success_url=https%3A%2F%2Fshop.test%2Forder%2Ford-1%3Fcheckout%3Dsuccess' +
  '&cancel_url=https%3A%2F%2Fshop.test%2Fb%2Fbook-1%3Fcheckout%3Dcancelled';

const BOOK_CUSTOMER_GOLDEN_BODY =
  'email=a%40example.com&address%5Bline1%5D=1+Way&address%5Bcity%5D=Springfield' +
  '&address%5Bstate%5D=IL&address%5Bpostal_code%5D=62704&address%5Bcountry%5D=US';

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function capturingFetch(calls: CapturedCall[], responseBody: Record<string, unknown> = { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body ?? '') });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as unknown as typeof fetch;
}

Deno.test('createCheckoutSession (book) sends exactly the pre-generalisation request', async () => {
  const calls: CapturedCall[] = [];
  const result = await createCheckoutSession(capturingFetch(calls), 'sk_test_x', {
    customerId: 'cus_1',
    orderId: 'ord-1',
    priceCents: 4999,
    shippingCostCents: 1234,
    currency: 'usd',
    successUrl: 'https://shop.test/order/ord-1?checkout=success',
    cancelUrl: 'https://shop.test/b/book-1?checkout=cancelled',
  });
  assertEquals(result, { sessionId: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assertEquals(calls[0].headers, {
    Authorization: 'Bearer sk_test_x',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': '2026-08-26.dahlia',
  });
  assertEquals(calls[0].body, BOOK_SESSION_GOLDEN_BODY);
});

Deno.test('createStripeCustomer sends exactly the pre-generalisation request', async () => {
  const calls: CapturedCall[] = [];
  await createStripeCustomer(capturingFetch(calls, { id: 'cus_1' }), 'sk_test_x', {
    email: 'a@example.com',
    address: { line1: '1 Way', city: 'Springfield', state: 'IL', postalCode: '62704', countryCode: 'US' },
  });
  assertEquals(calls[0].body, BOOK_CUSTOMER_GOLDEN_BODY);
  assertEquals('Idempotency-Key' in calls[0].headers, false);
});

// ── Generic (holiday-card) session, retrieve and expire ──────────────────

Deno.test('createGenericCheckoutSession sends one line item, both metadata blocks and the idempotency key', async () => {
  const calls: CapturedCall[] = [];
  const result = await createGenericCheckoutSession(capturingFetch(calls), 'sk_test_x', {
    customerId: 'cus_1',
    currency: 'usd',
    lineItems: [{ name: 'Momora Holiday Cards', taxCode: 'txcd_99999999', unitAmountCents: 4980 }],
    metadata: { productType: 'holiday_card', orderId: 'ord-9', snapshotHash: 'abc123' },
    successUrl: 'https://shop.test/ok',
    cancelUrl: 'https://shop.test/no',
    idempotencyKey: 'hc-sess-1',
  });
  assertEquals(result.sessionId, 'cs_1');
  assertEquals(calls[0].headers['Idempotency-Key'], 'hc-sess-1');
  const params = new URLSearchParams(calls[0].body);
  assertEquals(params.get('line_items[0][price_data][unit_amount]'), '4980');
  assertEquals(params.get('line_items[1][quantity]'), null);
  assertEquals(params.get('metadata[productType]'), 'holiday_card');
  assertEquals(params.get('payment_intent_data[metadata][productType]'), 'holiday_card');
  assertEquals(params.get('payment_intent_data[metadata][snapshotHash]'), 'abc123');
  assertEquals(params.get('automatic_tax[enabled]'), 'true');
  assertEquals(params.get('managed_payments[enabled]'), 'false');
});

Deno.test('createGenericCheckoutSession sends expires_at only when asked (unix seconds); without it the body has no expires_at', async () => {
  const input = {
    customerId: 'cus_1',
    currency: 'usd',
    lineItems: [{ name: 'Momora Holiday Cards', taxCode: 'txcd_99999999', unitAmountCents: 4980 }],
    metadata: { productType: 'holiday_card', orderId: 'ord-9', snapshotHash: 'abc123' },
    successUrl: 'https://shop.test/ok',
    cancelUrl: 'https://shop.test/no',
    idempotencyKey: 'hc-sess-1',
  };
  const without: CapturedCall[] = [];
  await createGenericCheckoutSession(capturingFetch(without), 'sk_test_x', input);
  assertEquals(new URLSearchParams(without[0].body).has('expires_at'), false);
  const withExpiry: CapturedCall[] = [];
  await createGenericCheckoutSession(capturingFetch(withExpiry), 'sk_test_x', { ...input, expiresAt: 1790000000 });
  assertEquals(new URLSearchParams(withExpiry[0].body).get('expires_at'), '1790000000');
  // Everything else is identical: the expiry is the only difference.
  assertEquals(withExpiry[0].body.replace(/&expires_at=\d+$/, ''), without[0].body);
});

Deno.test('retrieveCheckoutSession and expireCheckoutSession parse the session and validate the id', async () => {
  const calls: CapturedCall[] = [];
  const fakeFetch = capturingFetch(calls, { id: 'cs_test_abc123', status: 'open', payment_status: 'unpaid', url: 'https://c.test/x', payment_intent: null, metadata: { orderId: 'o1', n: 5 } });
  const info = await retrieveCheckoutSession(fakeFetch, 'sk_test_x', 'cs_test_abc123');
  assertEquals(info.status, 'open');
  assertEquals(info.metadata, { orderId: 'o1' });
  const expired = await expireCheckoutSession(fakeFetch, 'sk_test_x', 'cs_test_abc123');
  assertEquals(expired.id, 'cs_test_abc123');
  assertEquals(calls[1].url, 'https://api.stripe.com/v1/checkout/sessions/cs_test_abc123/expire');
  let threw = false;
  try {
    await retrieveCheckoutSession(fakeFetch, 'sk_test_x', '../customers');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
