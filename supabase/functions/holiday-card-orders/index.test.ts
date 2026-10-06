import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { handleHolidayCardOrders, validateCardShippingAddress } from './index.ts';
import {
  cardWorldSeed,
  FakeDb,
  fakeImageSize,
  fakePresign,
  IDS,
  makeR2Fake,
  makeWorldFetch,
  QUOTED_ORDER,
  SHARE_TOKEN,
  US_ADDRESS,
} from '../_shared/holiday-card-orders.test-support.ts';

type Row = Record<string, unknown>;

function fakeUser(email: string | null = 'buyer@example.com', id: string = IDS.user) {
  return { id, is_anonymous: false, email } as never;
}

async function withEnv<T>(run: () => Promise<T>, overrides: Record<string, string | null> = {}): Promise<T> {
  const env: Record<string, string | null> = {
    GELATO_API_KEY: 'gelato-test-key',
    STRIPE_SECRET_KEY: 'sk_test_x',
    HOLIDAY_CARD_CHECKOUT_ORIGIN: 'https://shop.test',
    MEMORY_BOOK_RENDER_WORKER_URL: 'https://render.test',
    MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET: 'render-secret',
    ...overrides,
  };
  const previous = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) if (v === null) Deno.env.delete(k); else Deno.env.set(k, v);
  try {
    return await run();
  } finally {
    for (const [k, v] of previous) if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
}

function request(body: unknown): Request {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) });
}

interface Harness {
  db: FakeDb;
  world: ReturnType<typeof makeWorldFetch>;
  r2: ReturnType<typeof makeR2Fake>;
  presigned: { keys: string[]; ttl: number[] };
  call: (body: unknown, user?: ReturnType<typeof fakeUser> | null) => Promise<Response>;
}

function harness(seed: Record<string, Row[]>, options: { role?: 'owner' | 'manager' | 'viewer' | null; billing?: Response | null; now?: number; head?: (key: string) => Promise<{ contentLength: number | null } | null>; fetch?: (real: typeof fetch) => typeof fetch } = {}): Harness {
  const db = new FakeDb(seed);
  const world = makeWorldFetch();
  const r2 = makeR2Fake();
  const presigned = { keys: [] as string[], ttl: [] as number[] };
  const role = options.role === undefined ? 'owner' : options.role;
  const call = (body: unknown, user: ReturnType<typeof fakeUser> | null = fakeUser()) =>
    handleHolidayCardOrders(request(body), {
      getAuthenticatedUser: async () => user,
      createServiceClient: db.client(),
      getCallerFamilyRole: async () => role,
      checkBillingFamilyWrite: async () => options.billing ?? null,
      fetch: options.fetch ? options.fetch(world.fetch) : world.fetch,
      now: () => options.now ?? Date.parse('2026-10-06T12:00:00.000Z'),
      createPresignedGetUrls: fakePresign(presigned),
      imageSize: fakeImageSize,
      listKeys: r2.listKeys,
      deleteKey: r2.deleteKey,
      headObject: options.head ?? world.headObject,
      sendEmail: async () => 'sent',
    });
  return { db, world, r2, presigned, call };
}

const orderRow = (db: FakeDb) => db.row('holiday_card_orders', IDS.order);

// ── Address validation ───────────────────────────────────────────────────

Deno.test('validateCardShippingAddress accepts a US address and normalises state and country', () => {
  const result = validateCardShippingAddress({ ...US_ADDRESS, state: ' il ', countryCode: 'us' });
  if (!('address' in result)) throw new Error('expected an address');
  assertEquals(result.address.state, 'IL');
  assertEquals(result.address.countryCode, 'US');
});

Deno.test('validateCardShippingAddress normalises a Canadian postal code and rejects bad ones', () => {
  const ok = validateCardShippingAddress({ ...US_ADDRESS, state: 'ON', postalCode: 'k1a0b1', countryCode: 'CA' });
  if (!('address' in ok)) throw new Error('expected an address');
  assertEquals(ok.address.postalCode, 'K1A 0B1');
  assertEquals('error' in validateCardShippingAddress({ ...US_ADDRESS, postalCode: '1234' }), true);
  assertEquals('error' in validateCardShippingAddress({ ...US_ADDRESS, state: 'Illinois' }), true);
  assertEquals('error' in validateCardShippingAddress({ ...US_ADDRESS, city: '' }), true);
});

Deno.test('validateCardShippingAddress reports a country we do not sell to (not a generic error)', () => {
  assertEquals(validateCardShippingAddress({ ...US_ADDRESS, countryCode: 'MX' }), { unsupportedCountry: true });
  assertEquals(validateCardShippingAddress({ ...US_ADDRESS, countryCode: 'GB' }), { unsupportedCountry: true });
});

// ── Auth and create_draft ────────────────────────────────────────────────

Deno.test('rejects an unauthenticated caller before touching the database', async () => {
  const h = harness(cardWorldSeed());
  const response = await h.call({ op: 'status', orderId: IDS.order }, null);
  assertEquals(response.status, 401);
});

Deno.test('create_draft: a viewer is refused, a billing lapse is surfaced, an unready card is a 409', async () => {
  const viewer = harness(cardWorldSeed({ order: null }), { role: 'viewer' });
  assertEquals((await viewer.call({ op: 'create_draft', cardId: IDS.card })).status, 403);

  const lapsed = harness(cardWorldSeed({ order: null }), {
    billing: new Response(JSON.stringify({ error: 'x', code: 'SUBSCRIPTION_REQUIRED' }), { status: 403 }),
  });
  assertEquals((await lapsed.call({ op: 'create_draft', cardId: IDS.card })).status, 403);

  const generating = harness(cardWorldSeed({ order: null, card: { status: 'generating' } }));
  const response = await generating.call({ op: 'create_draft', cardId: IDS.card });
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, 'CARD_NOT_READY');
});

Deno.test('create_draft inserts a bare draft and hands the open draft back on a second call', async () => {
  const h = harness(cardWorldSeed({ order: null }));
  const first = await h.call({ op: 'create_draft', cardId: IDS.card });
  assertEquals(first.status, 201);
  const firstBody = await first.json();
  assertEquals(firstBody.status, 'draft');
  const second = await h.call({ op: 'create_draft', cardId: IDS.card });
  assertEquals(second.status, 200);
  assertEquals((await second.json()).orderId, firstBody.orderId);
  assertEquals(h.db.rows('holiday_card_orders').length, 1);
  assertEquals(h.db.rows('holiday_card_orders')[0].requested_by, IDS.user);
});

// ── quote ────────────────────────────────────────────────────────────────

Deno.test('quote 404s for another buyer\'s order', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: { requested_by: IDS.otherUser } }));
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 });
    assertEquals(response.status, 404);
  });
});

Deno.test('quote rejects a country we do not ship to with COUNTRY_NOT_SUPPORTED, before any Gelato call', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed());
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: { ...US_ADDRESS, countryCode: 'DE' }, packs: 2 });
    assertEquals(response.status, 422);
    assertEquals((await response.json()).code, 'COUNTRY_NOT_SUPPORTED');
    assertEquals(h.world.gelato.state.calls.length, 0);
    assertEquals(orderRow(h.db).status, 'draft');
  });
});

Deno.test('quote rejects packs that are not offered', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed());
    for (const packs of [1, 4, 100, '2', null]) {
      const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs });
      assertEquals(response.status, 400);
      assertEquals((await response.json()).code, 'PACKS_INVALID');
    }
  });
});

Deno.test('quote CASes draft -> quoted and persists the whole bundle in one update', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed());
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.priceCents, 4980);
    assertEquals(body.cards, 20);
    assertEquals(body.currency, 'USD');
    assertEquals(body.status, 'quoted');
    const row = orderRow(h.db);
    assertEquals(row.status, 'quoted');
    assertEquals(row.price_cents, 4980);
    assertEquals(row.gelato_cost_cents, 1871);
    assertEquals(row.packs, 2);
    assertEquals(row.region, 'us_ca');
    assertEquals(row.format, '5R');
    assertEquals(row.file_layout, 'two_files');
    assertEquals(row.currency, 'USD');
    assertEquals((row.shipping_address as Row).postalCode, '62704');
    // The quote bundle landed in exactly one UPDATE of the order.
    assertEquals(h.db.log.filter((entry) => entry.table === 'holiday_card_orders' && entry.op === 'update').length, 1);
  });
});

Deno.test('quote maps an undeliverable Gelato quote and the cost guard to clear codes and leaves the order a draft', async () => {
  await withEnv(async () => {
    const undeliverable = harness(cardWorldSeed());
    undeliverable.world.gelato.state.quote = {
      quotes: [{ products: [{ price: 11.68, currency: 'USD' }], shipmentMethods: [{ name: 'Ground', price: null }] }],
    };
    const first = await undeliverable.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 });
    assertEquals(first.status, 422);
    assertEquals((await first.json()).code, 'NOT_DELIVERABLE');
    assertEquals(orderRow(undeliverable.db).status, 'draft');

    const expensive = harness(cardWorldSeed());
    expensive.world.gelato.state.quote = {
      quotes: [{ products: [{ price: 11.68, currency: 'USD' }], shipmentMethods: [{ name: 'Ground', price: 80, type: 'normal' }] }],
    };
    const second = await expensive.call({ op: 'quote', orderId: IDS.order, address: { ...US_ADDRESS, state: 'AK', postalCode: '99501' }, packs: 2 });
    assertEquals(second.status, 422);
    assertEquals((await second.json()).code, 'OVER_COST_GUARD');
    assertEquals(orderRow(expensive.db).status, 'draft');
  });
});

Deno.test('quote answers 502 GELATO_UNAVAILABLE on a Gelato outage and persists nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed());
    h.world.gelato.state.forceStatus.set('POST /orders:quote', 503);
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 });
    assertEquals(response.status, 502);
    assertEquals((await response.json()).code, 'GELATO_UNAVAILABLE');
    assertEquals(orderRow(h.db).status, 'draft');
  });
});

Deno.test('re-quoting a quoted order resets its checkout progress and deletes the old draft', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({
      order: { ...QUOTED_ORDER, gelato_order_id: 'gel-old00001', snapshot_hash: 'h', print_files: { files: [], snapshotHash: 'h' } },
    }));
    h.world.gelato.state.orders.set('gel-old00001', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 3 });
    assertEquals(response.status, 200);
    const row = orderRow(h.db);
    assertEquals(row.packs, 3);
    assertEquals(row.gelato_order_id, null);
    assertEquals(row.snapshot_hash, null);
    assertEquals(row.print_files, null);
    assertEquals(h.world.gelato.state.orders.has('gel-old00001'), false);
  });
});

Deno.test('quote refuses to reset an order whose checkout claim is fresh', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({
      order: { ...QUOTED_ORDER, print_files: { claim: { id: 'c1', at: '2026-10-06T11:58:00.000Z' } } },
    }));
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CHECKOUT_IN_PROGRESS');
    assertEquals(h.world.gelato.state.calls.length, 0);
  });
});

// ── create_checkout ──────────────────────────────────────────────────────

Deno.test('create_checkout: render, Gelato draft and Stripe session, then quoted -> checkout', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, 'checkout');
    assertEquals(body.checkoutUrl.startsWith('https://checkout.stripe.test/'), true);

    // Render: the real format and layout, the front ORIGINAL key (never the preview), signed.
    assertEquals(h.world.renderCalls.length, 1);
    const render = h.world.renderCalls[0];
    assertEquals(render.body.mode, 'render');
    assertEquals(render.body.format, '5R');
    assertEquals(render.body.fileLayout, 'two_files');
    // Content-addressed: the snapshot hash (first 16 hex) is part of the prefix.
    assertEquals(new RegExp(`^print-orders/${IDS.order}/[0-9a-f]{16}/$`).test(String(render.body.outputPrefix)), true);
    assertEquals(typeof render.headers.get('x-render-signature'), 'string');
    assertEquals(h.presigned.keys.includes('u1/photos/front-original.jpg'), true);
    assertEquals(h.presigned.keys.includes('u1/photos/front-preview.jpg'), false);
    const assets = render.body.assets as Record<string, string>;
    assertEquals(Object.values(assets).some((url) => url.includes('front-original.jpg')), true);

    // Letter tones are the renderer's (warm -> reflective).
    const letters = (render.body.card as { letters: { tone: string }[] }).letters.map((l) => l.tone);
    assertEquals(letters, ['classic', 'reflective']);

    // Gelato: ONE draft, two files (front = default, back), quantity = packs, reference = order id.
    const posts = h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders');
    assertEquals(posts.length, 1);
    const draftBody = posts[0].body as Row;
    assertEquals(draftBody.orderType, 'draft');
    assertEquals(draftBody.orderReferenceId, IDS.order);
    const item = (draftBody.items as Row[])[0];
    assertEquals(item.quantity, 2);
    assertEquals((item.files as Row[]).map((f) => f.type), ['default', 'back']);
    assertEquals(h.presigned.ttl.includes(7 * 24 * 3600), true);

    // Stripe: one line item, general tangible goods code, metadata on session AND payment intent.
    const sessionCall = h.world.stripe.state.calls.find((c) => c.path === '/checkout/sessions')!;
    const params = new URLSearchParams(sessionCall.body);
    assertEquals(params.get('line_items[0][price_data][unit_amount]'), '4980');
    assertEquals(params.get('line_items[0][price_data][currency]'), 'usd');
    assertEquals(params.get('line_items[0][price_data][product_data][tax_code]'), 'txcd_99999999');
    assertEquals(params.get('line_items[1][price_data][unit_amount]'), null);
    assertEquals(params.get('metadata[productType]'), 'holiday_card');
    assertEquals(params.get('metadata[orderId]'), IDS.order);
    assertEquals(params.get('payment_intent_data[metadata][productType]'), 'holiday_card');
    assertEquals(params.get('payment_intent_data[metadata][snapshotHash]'), params.get('metadata[snapshotHash]'));
    assertEquals(sessionCall.idempotencyKey?.startsWith('hc-sess-'), true);

    // Row: checkout, frozen snapshot + hash, draft id, session id, files without the claim.
    const row = orderRow(h.db);
    assertEquals(row.status, 'checkout');
    assertEquals(row.stripe_session_id, body.sessionId);
    assertEquals(row.snapshot_hash, params.get('metadata[snapshotHash]'));
    assertEquals(typeof (row.card_snapshot as Row).card, 'object');
    assertEquals(typeof row.gelato_order_id, 'string');
    const printFiles = row.print_files as { claim?: unknown; files: Row[] };
    assertEquals(printFiles.claim, undefined);
    assertEquals(printFiles.files.map((f) => f.side), ['front', 'back']);
  });
});

Deno.test('create_checkout is idempotent: a second call returns the open session and creates nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const first = await (await h.call({ op: 'create_checkout', orderId: IDS.order })).json();
    const second = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(second.status, 200);
    const secondBody = await second.json();
    assertEquals(secondBody.checkoutUrl, first.checkoutUrl);
    assertEquals(secondBody.resumed, true);
    assertEquals(h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders').length, 1);
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path === '/checkout/sessions' && c.method === 'POST').length, 1);
  });
});

Deno.test('create_checkout resumes after a Stripe failure without a second render or a second Gelato draft', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    // Stripe is down for the first attempt (customers endpoint fails).
    const realFetch = h.world.fetch;
    let stripeDown = true;
    const flaky = (async (input: Request | URL | string, init?: RequestInit) => {
      if (stripeDown && new URL(String(input)).hostname === 'api.stripe.com') return new Response('{}', { status: 500 });
      return realFetch(input, init);
    }) as typeof fetch;
    const call = (body: unknown) => handleHolidayCardOrders(request(body), {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: h.db.client(),
      getCallerFamilyRole: async () => 'owner',
      checkBillingFamilyWrite: async () => null,
      fetch: flaky,
      now: () => Date.parse('2026-10-06T12:00:00.000Z'),
      createPresignedGetUrls: fakePresign(),
      imageSize: fakeImageSize,
      listKeys: h.r2.listKeys,
      deleteKey: h.r2.deleteKey,
      headObject: h.world.headObject,
      sendEmail: async () => 'sent',
    });
    const failed = await call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(failed.status, 502);
    assertEquals((await failed.json()).code, 'STRIPE_UNAVAILABLE');
    const afterFailure = orderRow(h.db);
    assertEquals(afterFailure.status, 'quoted');
    assertEquals(typeof afterFailure.gelato_order_id, 'string');
    assertEquals((afterFailure.print_files as { claim?: unknown }).claim, undefined); // claim released

    stripeDown = false;
    const retried = await call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(retried.status, 200);
    assertEquals(h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders').length, 1);
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(orderRow(h.db).status, 'checkout');
  });
});

Deno.test('create_checkout re-creates a Gelato draft that vanished, never a second live one', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, gelato_order_id: 'gel-gone0001' } }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 200);
    assertNotEquals(orderRow(h.db).gelato_order_id, 'gel-gone0001');
    assertEquals(h.world.gelato.state.orders.size, 1);
  });
});

Deno.test('create_checkout re-rendering for a CHANGED snapshot deletes the old draft, renders to a new prefix and creates a fresh draft', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    // First attempt: Stripe is down, so the order keeps a rendered snapshot + draft.
    const real = h.world.fetch;
    let stripeDown = true;
    const flaky = ((input: Request | URL | string, init?: RequestInit) =>
      stripeDown && new URL(String(input)).hostname === 'api.stripe.com' ? Promise.resolve(new Response('{}', { status: 500 })) : real(input, init)) as typeof fetch;
    const call = (body: unknown) => handleHolidayCardOrders(request(body), {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: h.db.client(),
      getCallerFamilyRole: async () => 'owner',
      checkBillingFamilyWrite: async () => null,
      fetch: flaky,
      now: () => Date.parse('2026-10-06T12:00:00.000Z'),
      createPresignedGetUrls: fakePresign(),
      imageSize: fakeImageSize,
      listKeys: h.r2.listKeys,
      deleteKey: h.r2.deleteKey,
      headObject: h.world.headObject,
      sendEmail: async () => 'sent',
    });
    assertEquals((await call({ op: 'create_checkout', orderId: IDS.order })).status, 502);
    const first = orderRow(h.db);
    const firstDraft = first.gelato_order_id as string;
    const firstPrefix = String(h.world.renderCalls[0].body.outputPrefix);
    const firstKeys = (first.print_files as { files: { key: string }[] }).files.map((f) => f.key);
    for (const key of firstKeys) h.r2.keys.add(key);

    // The parent edits the letter, then retries.
    h.db.row('holiday_cards', IDS.card).edits = { letters: { classic: 'A different letter' }, choices: { layout: 'bordered', tone: 'classic' } };
    stripeDown = false;
    const retried = await call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(retried.status, 200);
    assertEquals(h.world.renderCalls.length, 2);
    const secondPrefix = String(h.world.renderCalls[1].body.outputPrefix);
    assertNotEquals(secondPrefix, firstPrefix);
    const row = orderRow(h.db);
    assertNotEquals(row.gelato_order_id, firstDraft);
    assertEquals(h.world.gelato.state.orders.has(firstDraft), false); // the old draft is gone
    assertEquals(h.world.gelato.state.orders.size, 1);
    assertEquals((row.print_files as { files: { key: string }[] }).files.every((f) => f.key.startsWith(secondPrefix)), true);
    for (const key of firstKeys) assertEquals(h.r2.deleted.includes(key), true); // old files released
    // The new draft points at the NEW files.
    const draftPosts = h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders');
    assertEquals(draftPosts.length, 2);
    assertEquals(JSON.stringify(draftPosts[1].body).includes(secondPrefix.slice(0, -1).split('/').pop()!), true);
  });
});

Deno.test('create_checkout refuses to point a draft at print files that are not in storage at the size the renderer reported', async () => {
  await withEnv(async () => {
    const missing = harness(cardWorldSeed({ order: QUOTED_ORDER }), { head: async () => null });
    const first = await missing.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(first.status, 502);
    assertEquals((await first.json()).code, 'RENDER_UNAVAILABLE');
    assertEquals(missing.world.gelato.state.calls.length, 0);
    assertEquals(orderRow(missing.db).status, 'quoted');

    const wrongSize = harness(cardWorldSeed({ order: QUOTED_ORDER }), { head: async () => ({ contentLength: 7 }) });
    assertEquals((await wrongSize.call({ op: 'create_checkout', orderId: IDS.order })).status, 502);
    assertEquals(wrongSize.world.gelato.state.orders.size, 0);
  });
});

Deno.test('create_checkout: a card deleted while it was being prepared is CARD_CHANGED; session, draft and files are released', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === 'api.stripe.com' && url.pathname === '/v1/checkout/sessions') {
          db!.row('holiday_cards', IDS.card).deleted_at = '2026-10-06T12:00:30.000Z';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CARD_CHANGED');
    const row = orderRow(h.db);
    assertEquals(row.status, 'quoted');
    assertEquals(row.gelato_order_id ?? null, null);
    assertEquals(row.print_files ?? null, null);
    assertEquals(h.world.gelato.state.orders.size, 0);
    assertEquals([...h.world.stripe.state.sessions.values()].every((session) => session.status === 'expired'), true);
  });
});

Deno.test('create_checkout: a link disabled while preparing (the QR was on) is CARD_CHANGED', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).hostname === 'api.stripe.com') {
          db!.rows('film_share_tokens')[0].revoked_at = '2026-10-06T12:00:30.000Z';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CARD_CHANGED');
  });
});

Deno.test('two simultaneous create_checkout calls: one wins, the other is told it is in progress, one draft exists', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const [a, b] = await Promise.all([
      h.call({ op: 'create_checkout', orderId: IDS.order }),
      h.call({ op: 'create_checkout', orderId: IDS.order }),
    ]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assertEquals((await loser.json()).code, 'CHECKOUT_IN_PROGRESS');
    assertEquals(h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders').length, 1);
  });
});

Deno.test('create_checkout: a 422 from the render service is returned as its code and the order stays quoted with nothing created', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    h.world.setRender(() => new Response(JSON.stringify({ ok: false, code: 'LETTER_OVERFLOW', message: 'the letter is too long for this size' }), { status: 422 }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 422);
    const body = await response.json();
    assertEquals(body.code, 'LETTER_OVERFLOW');
    const row = orderRow(h.db);
    assertEquals(row.status, 'quoted');
    assertEquals(row.gelato_order_id ?? null, null);
    assertEquals(row.stripe_session_id ?? null, null);
    assertEquals(row.print_files ?? null, null); // the claim was released
    assertEquals(h.world.gelato.state.calls.length, 0);
    assertEquals(h.world.stripe.state.calls.length, 0);
  });
});

Deno.test('create_checkout: a render service outage is a retryable 502, not a content error', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    h.world.setRender(() => new Response('boom', { status: 503 }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 502);
    assertEquals((await response.json()).code, 'RENDER_UNAVAILABLE');
    assertEquals(orderRow(h.db).status, 'quoted');
  });
});

Deno.test('create_checkout: a Gelato refusal of the draft is a 422 and leaves the order quoted with the files kept', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    h.world.gelato.state.forceStatus.set('POST /orders', 400);
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 422);
    assertEquals((await response.json()).code, 'DRAFT_REJECTED');
    const row = orderRow(h.db);
    assertEquals(row.status, 'quoted');
    assertEquals(h.world.stripe.state.calls.length, 0);
    assertEquals(((row.print_files as { files?: unknown[] }).files ?? []).length, 2);
  });
});

Deno.test('create_checkout film gate: an unpublished film blocks, a published one (even re-rendering) passes, QR off or no film allows', async () => {
  await withEnv(async () => {
    const neverPublished = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'rendering', video_key: null, ready_at: null } }));
    const blocked = await neverPublished.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(blocked.status, 409);
    assertEquals((await blocked.json()).code, 'FILM_NOT_READY');
    assertEquals(neverPublished.world.renderCalls.length, 0);

    const ended = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'ended', video_key: null } }));
    assertEquals((await (await ended.call({ op: 'create_checkout', orderId: IDS.order })).json()).code, 'FILM_NOT_READY');

    // Published and now re-rendering (or a failed re-render that left the video in place): the printed link still works.
    for (const status of ['rendering', 'queued', 'failed']) {
      const republishing = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status } }));
      assertEquals((await republishing.call({ op: 'create_checkout', orderId: IDS.order })).status, 200);
    }

    const filmBlocked = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { blocked: true } }));
    assertEquals((await (await filmBlocked.call({ op: 'create_checkout', orderId: IDS.order })).json()).code, 'FILM_BLOCKED');

    const qrOff = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'ended', video_key: null }, card: { edits: { choices: { layout: 'bordered', tone: 'classic', qr: false } } } }));
    assertEquals((await qrOff.call({ op: 'create_checkout', orderId: IDS.order })).status, 200);
    assertEquals((qrOff.world.renderCalls[0].body.card as { qr: { enabled: boolean } }).qr.enabled, false);

    const noFilm = harness(cardWorldSeed({ order: QUOTED_ORDER, film: null }));
    assertEquals((await noFilm.call({ op: 'create_checkout', orderId: IDS.order })).status, 200);
    assertEquals((noFilm.world.renderCalls[0].body.card as { qr: { enabled: boolean } }).qr.enabled, false);
  });
});

Deno.test('create_checkout prints the QR when the film is ready and drops it when disable_link revoked the token', async () => {
  await withEnv(async () => {
    const live = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    await live.call({ op: 'create_checkout', orderId: IDS.order });
    const liveQr = (live.world.renderCalls[0].body.card as { qr: { enabled: boolean; url: string } }).qr;
    assertEquals(liveQr.enabled, true);
    assertEquals(liveQr.url, `https://m.usemomora.com/f/${SHARE_TOKEN}`);

    // disable_link revokes the token WITHOUT touching edits.choices.qr: the QR is off, and
    // the film state no longer matters (a film that is not even ready still lets the order through).
    const revoked = harness(cardWorldSeed({ order: QUOTED_ORDER, token: { revoked_at: '2026-10-05T00:00:00Z' }, film: { status: 'failed', video_key: null } }));
    assertEquals((await revoked.call({ op: 'create_checkout', orderId: IDS.order })).status, 200);
    assertEquals((revoked.world.renderCalls[0].body.card as { qr: { enabled: boolean } }).qr.enabled, false);
  });
});

Deno.test('create_checkout: an unreadable chosen front photo is refused, never swapped for another', async () => {
  await withEnv(async () => {
    // A photo of ANOTHER family (ownership check) chosen by the editor.
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { edits: { frontImage: IDS.mediaOther } } }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 422);
    assertEquals((await response.json()).code, 'FRONT_PHOTO_UNREADABLE');
    assertEquals(h.world.renderCalls.length, 0);
    assertEquals(orderRow(h.db).status, 'quoted');
  });
});

Deno.test('create_checkout: preconditions on the card and the quote', async () => {
  await withEnv(async () => {
    const generating = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { status: 'generating' } }));
    assertEquals((await generating.call({ op: 'create_checkout', orderId: IDS.order })).status, 409);

    const deleted = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { deleted_at: '2026-10-05T00:00:00Z' } }));
    assertEquals((await deleted.call({ op: 'create_checkout', orderId: IDS.order })).status, 404);

    const stale = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, price_cents: 100 } }));
    const response = await stale.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'QUOTE_STALE');
    assertEquals(stale.world.renderCalls.length, 0);

    const draft = harness(cardWorldSeed());
    assertEquals((await draft.call({ op: 'create_checkout', orderId: IDS.order })).status, 409);

    const viewer = harness(cardWorldSeed({ order: QUOTED_ORDER }), { role: 'viewer' });
    assertEquals((await viewer.call({ op: 'create_checkout', orderId: IDS.order })).status, 403);

    const deletedFamily = harness(cardWorldSeed({ order: QUOTED_ORDER, family: { deleted_at: '2026-10-05T00:00:00Z' } }));
    assertEquals((await deletedFamily.call({ op: 'create_checkout', orderId: IDS.order })).status, 404);
  });
});

Deno.test('create_checkout reports missing configuration as a server error and creates nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order });
    assertEquals(response.status, 500);
    assertEquals(h.world.renderCalls.length, 0);
  }, { GELATO_API_KEY: null });
});

// ── cancel_checkout and status ───────────────────────────────────────────

Deno.test('cancel_checkout expires the session, cancels the order and deletes the draft and print files', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const checkout = await (await h.call({ op: 'create_checkout', orderId: IDS.order })).json();
    h.r2.keys.add(`print-orders/${IDS.order}/front.pdf`);
    h.r2.keys.add(`print-orders/${IDS.order}/back.pdf`);
    const gelatoId = orderRow(h.db).gelato_order_id as string;

    const response = await h.call({ op: 'cancel_checkout', orderId: IDS.order });
    assertEquals(response.status, 200);
    const row = orderRow(h.db);
    assertEquals(row.status, 'cancelled');
    assertEquals(row.gelato_order_id, null);
    assertEquals(row.print_files, null);
    assertEquals(h.world.stripe.state.sessions.get(checkout.sessionId)?.status, 'expired');
    assertEquals(h.world.gelato.state.orders.has(gelatoId), false);
    assertEquals(h.r2.keys.size, 0);
  });
});

Deno.test('cancel_checkout refuses when the customer already paid', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const checkout = await (await h.call({ op: 'create_checkout', orderId: IDS.order })).json();
    const session = h.world.stripe.state.sessions.get(checkout.sessionId)!;
    session.status = 'complete';
    session.payment_status = 'paid';
    h.world.stripe.state.expireStatus = 400;
    const response = await h.call({ op: 'cancel_checkout', orderId: IDS.order });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'ORDER_ALREADY_PAID');
    assertEquals(orderRow(h.db).status, 'checkout');
  });
});

Deno.test('status returns the buyer\'s view and nothing internal', async () => {
  const h = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, status: 'shipped', tracking_number: 'TRK123', carrier: 'USPS', gelato_cost_cents: 1871 } }));
  const response = await h.call({ op: 'status', orderId: IDS.order });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, 'shipped');
  assertEquals(body.trackingNumber, 'TRK123');
  assertEquals(body.cards, 20);
  assertEquals('gelato_cost_cents' in body, false);
  assertEquals('shipping_address' in body, false);
});

Deno.test('quote cannot overwrite a row a create_checkout claimed while the Gelato quote was in flight', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith('/orders:quote')) {
          // A create_checkout takes its claim (and bumps updated_at) while we wait for Gelato.
          const row = db!.row('holiday_card_orders', IDS.order);
          row.print_files = { claim: { id: 'other', at: '2026-10-06T12:00:00.000Z' } };
          row.updated_at = '2026-10-06T12:00:00.500Z';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 3 });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CHECKOUT_IN_PROGRESS');
    const row = orderRow(h.db);
    assertEquals(row.packs, 2); // untouched
    assertEquals((row.print_files as { claim?: unknown }).claim !== undefined, true);
  });
});
