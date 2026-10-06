import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  cancelOrder,
  confirmDraftIfDraft,
  confirmOrder,
  createDraft,
  deleteDraft,
  GELATO_USER_AGENT,
  GelatoApiError,
  GelatoParseError,
  getOrder,
  normalizeFulfillmentStatus,
  quoteOrder,
  QUOTE_PLACEHOLDER_FILE,
  type GelatoAddress,
} from './gelato.ts';
import { evaluateQuote } from './holiday-card-products.ts';

const KEY = 'test-gelato-key-do-not-log';
const ORDER_ID = '05f43f74-5e83-4fda-8712-b2f64e3d1096';
const UID = 'pack_of_cards_qt_10_pcs_pf_5r_upt_test';

const ADDRESS: GelatoAddress = {
  firstName: 'Marta',
  lastName: 'Rivera Soto',
  addressLine1: '100 Example Street',
  addressLine2: '  ',
  city: 'Springfield',
  state: 'TX',
  postCode: '77000',
  country: 'us',
  email: 'marta@example.com',
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fakeFetch(responses: { status?: number; body?: unknown; text?: string }[]) {
  const calls: Call[] = [];
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    const response = responses[Math.min(calls.length, responses.length - 1)];
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const text = response.text ?? JSON.stringify(response.body ?? {});
    return Promise.resolve(new Response(text === '' ? null : text, { status: response.status ?? 200 }));
  }) as typeof fetch;
  return { fn, calls };
}

const QUOTE_BODY = {
  orderReferenceId: 'q',
  quotes: [{
    id: 'q1',
    fulfillmentCountry: 'US',
    products: [{ itemReferenceId: 'card', productUid: UID, quantity: 2, price: 11.68, currency: 'USD' }],
    shipmentMethods: [
      { name: 'USPS Ground Advantage', shipmentMethodUid: 'usps_ga', price: 7.03, currency: 'USD', minDeliveryDays: 4, maxDeliveryDays: 5, type: 'normal' },
      { name: 'USPS Priority Mail Express', shipmentMethodUid: 'usps_pme', price: 23.62, currency: 'USD', minDeliveryDays: 1, maxDeliveryDays: 2, type: 'express' },
      { name: 'Unpriced', price: null },
    ],
  }],
};

function orderBody(over: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    orderType: 'draft',
    orderReferenceId: 'order-1',
    fulfillmentStatus: 'created',
    financialStatus: 'draft',
    currency: 'USD',
    items: [{ id: 'item-1', itemReferenceId: 'card', quantity: 2, fulfillmentStatus: 'created', files: [{ type: 'default', url: 'https://x/f' }, { type: 'back', url: 'https://x/b' }] }],
    receipts: [{ type: 'order', productsPriceInitial: 11.68, shippingPriceInitial: 7.03, totalInclVat: 18.71, currency: 'USD' }],
    shipment: { shipmentMethodName: 'USPS Ground Advantage', minDeliveryDate: '2026-10-12', maxDeliveryDate: '2026-10-14', fulfillmentCountry: 'US' },
    ...over,
  };
}

Deno.test('quote: request shape, headers, placeholder file, parsed cents', async () => {
  const { fn, calls } = fakeFetch([{ body: QUOTE_BODY }]);
  const q = await quoteOrder(fn, KEY, {
    orderReferenceId: 'order-1',
    customerReferenceId: 'family-1',
    currency: 'USD',
    recipient: ADDRESS,
    items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2 }],
  });
  const call = calls[0];
  assertEquals(call.url, 'https://order.gelatoapis.com/v4/orders:quote');
  assertEquals(call.method, 'POST');
  assertEquals(call.headers['X-API-KEY'], KEY);
  assertEquals(call.headers['User-Agent'], GELATO_USER_AGENT);
  assertEquals(call.headers['Accept'], '*/*');
  assertEquals(call.headers['Content-Type'], 'application/json');
  assertEquals(call.body?.allowMultipleQuotes, false);
  const recipient = call.body?.recipient as Record<string, unknown>;
  assertEquals(recipient.country, 'US');
  assertEquals('addressLine2' in recipient, false); // blank optional dropped
  assertEquals((call.body?.products as { files: unknown[] }[])[0].files, [QUOTE_PLACEHOLDER_FILE]);

  assertEquals(q.quotes.length, 1);
  assertEquals(q.quotes[0].productsCents, 1168);
  assertEquals(q.quotes[0].fulfillmentCountry, 'US');
  assertEquals(q.quotes[0].shipmentMethods.map((m) => m.priceCents), [703, 2362, null]);
  assertEquals(q.quotes[0].shipmentMethods[0].minDeliveryDays, 4);
  assertEquals(q.currency, 'USD');
  // plugs straight into the products guard
  const verdict = evaluateQuote('us_ca', 2, q);
  assert(verdict.ok);
  if (verdict.ok) assertEquals(verdict.shippingCents, 703);
});

Deno.test('quote: a response without quotes is a parse error', async () => {
  const { fn } = fakeFetch([{ body: { message: 'weird' } }]);
  await assertRejects(
    () => quoteOrder(fn, KEY, { orderReferenceId: 'o', customerReferenceId: 'c', currency: 'USD', recipient: ADDRESS, items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2 }] }),
    GelatoParseError,
  );
});

Deno.test('createDraft: draft body with default + back files and the order reference', async () => {
  const { fn, calls } = fakeFetch([{ body: orderBody() }]);
  const order = await createDraft(fn, KEY, {
    orderReferenceId: 'order-1',
    customerReferenceId: 'family-1',
    currency: 'USD',
    items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2, files: [{ type: 'default', url: 'https://x/f' }, { type: 'back', url: 'https://x/b' }] }],
    shippingAddress: ADDRESS,
    shipmentMethodUid: 'usps_ga',
  });
  const call = calls[0];
  assertEquals(call.url, 'https://order.gelatoapis.com/v4/orders');
  assertEquals(call.method, 'POST');
  assertEquals(call.body?.orderType, 'draft');
  assertEquals(call.body?.orderReferenceId, 'order-1');
  assertEquals(call.body?.shipmentMethodUid, 'usps_ga');
  const item = (call.body?.items as { productUid: string; quantity: number; files: { type: string }[] }[])[0];
  assertEquals(item.quantity, 2);
  assertEquals(item.files.map((f) => f.type), ['default', 'back']);

  assertEquals(order.id, ORDER_ID);
  assert(order.isDraft);
  assertEquals(order.fulfillmentStatus, 'created');
  assertEquals(order.items[0].fileTypes, ['default', 'back']);
  assertEquals(order.receipts[0], { type: 'order', currency: 'USD', productsCents: 1168, shippingCents: 703, totalCents: 1871 });
  assertEquals(order.shipment?.methodName, 'USPS Ground Advantage');
  assertEquals(order.tracking, []);
});

Deno.test('createDraft: invalid address or empty files fail before any request, without echoing the address', async () => {
  const { fn, calls } = fakeFetch([{ body: orderBody() }]);
  const bad = { ...ADDRESS, postCode: ' ' };
  const error = await assertRejects(() =>
    createDraft(fn, KEY, { orderReferenceId: 'o', customerReferenceId: 'c', currency: 'USD', items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2, files: [{ type: 'default', url: 'https://x/f' }] }], shippingAddress: bad })
  );
  assertEquals((error as Error).message, 'GELATO_ADDRESS_INVALID:postCode');
  await assertRejects(() => createDraft(fn, KEY, { orderReferenceId: 'o', customerReferenceId: 'c', currency: 'USD', items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2, files: [] }], shippingAddress: ADDRESS }));
  assertEquals(calls.length, 0);
});

Deno.test('confirmOrder: PATCH orderType order', async () => {
  const { fn, calls } = fakeFetch([{ body: orderBody({ orderType: 'order', fulfillmentStatus: 'passed', financialStatus: 'paid' }) }]);
  const order = await confirmOrder(fn, KEY, ORDER_ID);
  assertEquals(calls[0].url, `https://order.gelatoapis.com/v4/orders/${ORDER_ID}`);
  assertEquals(calls[0].method, 'PATCH');
  assertEquals(calls[0].body, { orderType: 'order' });
  assert(!order.isDraft);
  assertEquals(order.fulfillmentStatus, 'passed');
  assertEquals(order.financialStatus, 'paid');
});

Deno.test('confirmDraftIfDraft: PATCHes only while Gelato reports a draft', async () => {
  const draft = fakeFetch([{ body: orderBody() }, { body: orderBody({ orderType: 'order', fulfillmentStatus: 'passed' }) }]);
  const first = await confirmDraftIfDraft(draft.fn, KEY, ORDER_ID);
  assertEquals(draft.calls.map((c) => c.method), ['GET', 'PATCH']);
  assert(first.confirmed);

  const already = fakeFetch([{ body: orderBody({ orderType: 'order', fulfillmentStatus: 'passed' }) }]);
  const second = await confirmDraftIfDraft(already.fn, KEY, ORDER_ID);
  assertEquals(already.calls.map((c) => c.method), ['GET']);
  assert(!second.confirmed);
});

Deno.test('getOrder: shipped order with tracking, deduplicated', async () => {
  const body = orderBody({
    orderType: 'order',
    fulfillmentStatus: 'shipped',
    items: [{
      id: 'item-1',
      quantity: 2,
      fulfillmentStatus: 'shipped',
      fulfillments: [
        { trackingCode: '9400111899223', trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223', shipmentMethodName: 'USPS Ground Advantage' },
        { trackingCode: '9400111899223', trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223' },
        { shipmentMethodName: 'no tracking yet' },
      ],
    }],
  });
  const { fn } = fakeFetch([{ body }]);
  const order = await getOrder(fn, KEY, ORDER_ID);
  assertEquals(order.fulfillmentStatus, 'shipped');
  assertEquals(order.tracking.length, 1);
  assertEquals(order.tracking[0].carrier, 'USPS Ground Advantage');
  assertEquals(order.tracking[0].trackingCode, '9400111899223');
});

Deno.test('getOrder: refusal reason is surfaced and rejects a malformed id before fetching', async () => {
  const { fn, calls } = fakeFetch([{ body: orderBody({ orderType: 'order', fulfillmentStatus: 'failed', refusalReasonCode: 'capability' }) }]);
  const order = await getOrder(fn, KEY, ORDER_ID);
  assertEquals(order.fulfillmentStatus, 'failed');
  assertEquals(order.refusalReasonCode, 'capability');
  await assertRejects(() => getOrder(fn, KEY, '../orders/x'), Error, 'GELATO_ORDER_ID_INVALID');
  assertEquals(calls.length, 1);
});

Deno.test('status normalization: known values, aliases and unknowns keep the raw string', () => {
  const cases: [string, string][] = [
    ['created', 'created'], ['pending', 'pending'], ['passed', 'passed'], ['printed', 'printed'], ['shipped', 'shipped'],
    ['delivered', 'delivered'], ['canceled', 'canceled'], ['cancelled', 'canceled'], ['failed', 'failed'], ['refused', 'failed'],
    ['on_hold', 'on_hold'], ['on-hold', 'on_hold'], ['pending_approval', 'on_hold'], ['in_production', 'in_production'],
    ['PASSED', 'passed'], ['something_new', 'unknown'],
  ];
  for (const [raw, expected] of cases) assertEquals(normalizeFulfillmentStatus(raw), expected, raw);
  assertEquals(normalizeFulfillmentStatus(null), 'unknown');
  assertEquals(normalizeFulfillmentStatus(undefined), 'unknown');
});

Deno.test('order keeps the raw fulfillment status next to the normalized one', async () => {
  const { fn } = fakeFetch([{ body: orderBody({ fulfillmentStatus: 'In_Transit_Maybe' }) }]);
  const order = await getOrder(fn, KEY, ORDER_ID);
  assertEquals(order.fulfillmentStatus, 'unknown');
  assertEquals(order.rawFulfillmentStatus, 'In_Transit_Maybe');
});

Deno.test('errors carry status + Gelato code only; no key, address or message leaks', async () => {
  const { fn } = fakeFetch([{ status: 400, body: { code: 'invalid_shipping_address', message: 'Address 100 Example Street, Springfield is invalid' } }]);
  const error = await assertRejects(
    () => createDraft(fn, KEY, { orderReferenceId: 'o', customerReferenceId: 'c', currency: 'USD', items: [{ itemReferenceId: 'card', productUid: UID, quantity: 2, files: [{ type: 'default', url: 'https://x/f' }] }], shippingAddress: ADDRESS }),
    GelatoApiError,
  ) as GelatoApiError;
  assertEquals(error.status, 400);
  assertEquals(error.code, 'invalid_shipping_address');
  assertEquals(error.message, 'Gelato createDraft failed (400: invalid_shipping_address)');
  assert(!error.message.includes('Example Street'));
  assert(!error.message.includes(KEY));
  assert(!error.retryable);
});

Deno.test('errors: Cloudflare 1010 block page becomes cf_1010; 5xx and 429 are retryable', async () => {
  const cf = fakeFetch([{ status: 403, text: 'error code: 1010' }]);
  const blocked = await assertRejects(() => getOrder(cf.fn, KEY, ORDER_ID), GelatoApiError) as GelatoApiError;
  assertEquals(blocked.code, 'cf_1010');
  assert(!blocked.retryable);
  for (const status of [429, 500, 503]) {
    const r = fakeFetch([{ status, body: {} }]);
    const e = await assertRejects(() => getOrder(r.fn, KEY, ORDER_ID), GelatoApiError) as GelatoApiError;
    assert(e.retryable, String(status));
    assertEquals(e.code, null);
  }
});

Deno.test('errors: a network failure is status 0 with no underlying detail', async () => {
  const fn = (() => Promise.reject(new TypeError(`fetch failed for https://order.gelatoapis.com with ${KEY}`))) as typeof fetch;
  const error = await assertRejects(() => getOrder(fn, KEY, ORDER_ID), GelatoApiError) as GelatoApiError;
  assertEquals(error.status, 0);
  assertEquals(error.code, 'network');
  assert(error.retryable);
  assert(!error.message.includes(KEY));
});

Deno.test('deleteDraft: DELETE; a missing draft (404) is not an error', async () => {
  const ok = fakeFetch([{ status: 204, text: '' }]);
  assertEquals(await deleteDraft(ok.fn, KEY, ORDER_ID), { deleted: true });
  assertEquals(ok.calls[0].method, 'DELETE');
  assertEquals(ok.calls[0].url, `https://order.gelatoapis.com/v4/orders/${ORDER_ID}`);
  const gone = fakeFetch([{ status: 404, body: { code: 'order_not_found' } }]);
  assertEquals(await deleteDraft(gone.fn, KEY, ORDER_ID), { deleted: false });
  const boom = fakeFetch([{ status: 500, body: {} }]);
  await assertRejects(() => deleteDraft(boom.fn, KEY, ORDER_ID), GelatoApiError);
});

Deno.test('cancelOrder: POST :cancel', async () => {
  const { fn, calls } = fakeFetch([{ body: {} }]);
  await cancelOrder(fn, KEY, ORDER_ID);
  assertEquals(calls[0].url, `https://order.gelatoapis.com/v4/orders/${ORDER_ID}:cancel`);
  assertEquals(calls[0].method, 'POST');
});
