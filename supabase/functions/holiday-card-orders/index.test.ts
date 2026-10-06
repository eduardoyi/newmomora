import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import { CARD_PRODUCTS } from '../_shared/holiday-card-products.ts';
import { confirmPaidOrder, failPaidOrder, type FulfillmentDeps, type PrintPipelineDeps } from '../_shared/holiday-card-fulfillment.ts';
import { chooseSessionExpiry, handleHolidayCardOrders, SESSION_REUSE_MIN_LEFT_MS, STRIPE_SESSION_TTL_MS, validateCardShippingAddress } from './index.ts';
import {
  cardWorldSeed,
  defaultRenderResponse,
  FakeDb,
  type FakeDbOptions,
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
  /** The function's clock AND the database's `now()` (ms): move it to simulate time passing. */
  clock: { ms: number };
  db: FakeDb;
  world: ReturnType<typeof makeWorldFetch>;
  r2: ReturnType<typeof makeR2Fake>;
  presigned: { keys: string[]; ttl: number[] };
  call: (body: unknown, user?: ReturnType<typeof fakeUser> | null) => Promise<Response>;
}

function harness(seed: Record<string, Row[]>, options: { role?: 'owner' | 'manager' | 'viewer' | null; billing?: Response | null; now?: number; head?: (key: string) => Promise<{ contentLength: number | null } | null>; fetch?: (real: typeof fetch) => typeof fetch; dbOptions?: FakeDbOptions } = {}): Harness {
  const clock = { ms: options.now ?? Date.parse('2026-10-06T12:00:00.000Z') };
  const db = new FakeDb(seed, { nowMs: () => clock.ms, ...options.dbOptions });
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
      now: () => clock.ms,
      createPresignedGetUrls: fakePresign(presigned),
      imageSize: fakeImageSize,
      listKeys: r2.listKeys,
      deleteKey: r2.deleteKey,
      headObject: options.head ?? world.headObject,
      sendEmail: async () => 'sent',
    });
  return { clock, db, world, r2, presigned, call };
}

const orderRow = (db: FakeDb) => db.row('holiday_card_orders', IDS.order);

// ── Address validation ───────────────────────────────────────────────────

Deno.test('validateCardShippingAddress accepts a US address and normalises state and country', () => {
  const result = validateCardShippingAddress({ ...US_ADDRESS, state: ' il ', countryCode: 'us' });
  if (!('address' in result)) throw new Error('expected an address');
  assertEquals(result.address.state, 'IL');
  assertEquals(result.address.countryCode, 'US');
});

Deno.test('validateCardShippingAddress accepts an autofilled spaced ZIP+4 ("12345 - 6789")', () => {
  const ok = validateCardShippingAddress({ ...US_ADDRESS, postalCode: '62704 - 1234' });
  if (!('address' in ok)) throw new Error('expected an address');
  assertEquals(ok.address.postalCode, '62704-1234');
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
    for (const packs of [0, 4, 100, '2', null]) {
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
    assertEquals(row.file_layout, 'one_pdf');
    assertEquals(row.currency, 'USD');
    assertEquals((row.shipping_address as Row).postalCode, '62704');
    // The quote bundle landed in exactly one UPDATE of the order.
    assertEquals(h.db.log.filter((entry) => entry.table === 'holiday_card_orders' && entry.op === 'update').length, 1);
  });
});

Deno.test('quote prices the smallest and largest tiers from the tier table', async () => {
  await withEnv(async () => {
    for (const [packs, cards, price] of [[1, 10, 2990], [3, 30, 6870], [10, 100, 17900]]) {
      const h = harness(cardWorldSeed());
      const response = await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs });
      assertEquals(response.status, 200, `packs ${packs}`);
      const body = await response.json();
      assertEquals(body.packs, packs);
      assertEquals(body.cards, cards);
      assertEquals(body.priceCents, price);
      assertEquals(orderRow(h.db).price_cents, price);
      assertEquals(orderRow(h.db).packs, packs);
    }
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

// ── Pay first: create_checkout only freezes + opens Stripe; the pipeline runs after payment ──

const noPrintWork = (h: Harness) => h.world.renderCalls.length + h.world.gelato.state.calls.length;

interface Fulfilled {
  outcome: Awaited<ReturnType<typeof confirmPaidOrder>>;
  mails: { to: string; subject: string; body: string }[];
}

/** The webhook's part (paid CAS + card claim release) and then the post-payment pipeline (`confirmPaidOrder`), against the harness's fakes. */
async function payAndFulfil(
  h: Harness,
  orderId: string = IDS.order,
  options: { head?: (key: string) => Promise<{ contentLength: number | null } | null>; pipeline?: PrintPipelineDeps | null; skipPay?: boolean; fetch?: typeof fetch; presign?: PrintPipelineDeps['createPresignedGetUrls']; renderTimeoutMs?: number; now?: () => number } = {},
): Promise<Fulfilled> {
  if (!options.skipPay) {
    const row = h.db.row('holiday_card_orders', orderId);
    row.status = 'paid';
    row.stripe_payment_intent_id = 'pi_test_1';
    await h.db.build().rpc('release_holiday_card_checkout', { p_order_id: orderId });
  }
  h.db.users.set(IDS.user, { email: 'buyer@example.com' });
  const mails: Fulfilled['mails'] = [];
  const deps: FulfillmentDeps = {
    fetch: options.fetch ?? h.world.fetch,
    now: options.now,
    sendEmail: async (input) => { mails.push({ to: input.to, subject: input.subject, body: input.htmlBody }); return 'sent'; },
    listKeys: h.r2.listKeys,
    deleteKey: h.r2.deleteKey,
    gelatoApiKey: 'gelato-test-key',
    stripeSecretKey: 'sk_test_x',
    pipeline: options.pipeline === undefined
      ? { renderUrl: 'https://render.test', renderSecret: 'render-secret', createPresignedGetUrls: options.presign ?? fakePresign(h.presigned), headObject: options.head ?? h.world.headObject, renderTimeoutMs: options.renderTimeoutMs }
      : options.pipeline,
  };
  return { outcome: await confirmPaidOrder(deps, h.db.build(), orderId), mails };
}
const draftPosts = (h: Harness) => h.world.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders');
const patchesOf = (h: Harness) => h.world.gelato.state.calls.filter((c) => c.method === 'PATCH');

Deno.test('create_checkout is PAY FIRST: it freezes the snapshot and opens the Stripe session, with no render, no Gelato draft and no print files', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.status, 'checkout');
    assertEquals(body.checkoutUrl.startsWith('https://checkout.stripe.test/'), true);
    assertEquals(typeof body.expiresAt, 'string');

    assertEquals(h.world.renderCalls.length, 0);
    assertEquals(h.world.gelato.state.calls.length, 0);
    assertEquals(h.r2.keys.size, 0);

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

    // Row: checkout, frozen snapshot + hash (what the webhook verifies), session id; no draft, no files, no claim.
    const row = orderRow(h.db);
    assertEquals(row.status, 'checkout');
    assertEquals(row.stripe_session_id, body.sessionId);
    assertEquals(row.snapshot_hash, params.get('metadata[snapshotHash]'));
    assertEquals(typeof (row.card_snapshot as Row).card, 'object');
    assertEquals(row.gelato_order_id ?? null, null);
    const printFiles = row.print_files as { claim?: unknown; files?: unknown; snapshotHash: string; sessionExpiresAt: string };
    assertEquals(printFiles.claim, undefined);
    assertEquals(printFiles.files, undefined);
    assertEquals(printFiles.snapshotHash, row.snapshot_hash);
    // Letter tones in the frozen card are the renderer's (warm -> reflective); the front is the ORIGINAL key.
    const snapshot = row.card_snapshot as { card: { letters: { tone: string }[] }; assets: { key: string }[] };
    assertEquals(snapshot.card.letters.map((l) => l.tone), ['classic', 'reflective']);
    assertEquals(snapshot.assets.some((a) => a.key === 'u1/photos/front-original.jpg'), true);
    assertEquals(snapshot.assets.some((a) => a.key === 'u1/photos/front-preview.jpg'), false);
  });
});

Deno.test('after payment the pipeline renders, creates the draft, and confirms: paid -> submitted (one render, one draft, one PATCH, one email)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    const { outcome, mails } = await payAndFulfil(h);
    assertEquals(outcome, 'submitted');

    // Render: the real format and layout, the front ORIGINAL key (never the preview), signed.
    assertEquals(h.world.renderCalls.length, 1);
    const render = h.world.renderCalls[0];
    assertEquals(render.body.mode, 'render');
    assertEquals(render.body.orderId, IDS.order);
    assertEquals(render.body.format, '5R');
    assertEquals(render.body.fileLayout, 'one_pdf');
    // Content-addressed: the snapshot hash (first 16 hex) is part of the prefix.
    assertEquals(new RegExp(`^print-orders/${IDS.order}/[0-9a-f]{16}/$`).test(String(render.body.outputPrefix)), true);
    assertEquals(String(render.body.outputPrefix).includes(String(orderOf(h).snapshot_hash).slice(0, 16)), true);
    assertEquals(typeof render.headers.get('x-render-signature'), 'string');
    assertEquals(h.presigned.keys.includes('u1/photos/front-original.jpg'), true);
    assertEquals(h.presigned.keys.includes('u1/photos/front-preview.jpg'), false);
    assertEquals(Object.values(render.body.assets as Record<string, string>).some((url) => url.includes('front-original.jpg')), true);
    assertEquals((render.body.card as { letters: { tone: string }[] }).letters.map((l) => l.tone), ['classic', 'reflective']);

    // Gelato: ONE draft, ONE file (the 2-page PDF as `default`), quantity = packs, reference = order id, 7-day URLs.
    assertEquals(draftPosts(h).length, 1);
    const draftBody = draftPosts(h)[0].body as Row;
    assertEquals(draftBody.orderType, 'draft');
    assertEquals(draftBody.orderReferenceId, IDS.order);
    const item = (draftBody.items as Row[])[0];
    assertEquals(item.quantity, 2);
    assertEquals((item.files as Row[]).map((f) => f.type), ['default']);
    assertEquals(String((item.files as Row[])[0].url).includes('card.pdf'), true);
    assertEquals(h.presigned.ttl.includes(7 * 24 * 3600), true);
    assertEquals(patchesOf(h).length, 1);

    const row = orderOf(h);
    assertEquals(row.status, 'submitted');
    assertEquals(typeof row.gelato_order_id, 'string');
    assertEquals((row.print_files as { files: { side: string }[] }).files.map((f) => f.side), ['both']);
    assertEquals(mails.filter((m) => m.to === 'buyer@example.com').length, 1);
    // Idempotent: running it again (the sweep after the webhook) changes nothing.
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'not_paid');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(draftPosts(h).length, 1);
  });
});

Deno.test('the pipeline still supports a two_files product: front + back rendered, Gelato gets default + back', async () => {
  await withEnv(async () => {
    const product = CARD_PRODUCTS.us_ca;
    const original = product.fileLayout;
    (product as { fileLayout: string }).fileLayout = 'two_files';
    try {
      const h = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, file_layout: 'two_files' } }));
      assertEquals((await h.call(body())).status, 200);
      assertEquals((await payAndFulfil(h)).outcome, 'submitted');
      assertEquals(h.world.renderCalls[0].body.fileLayout, 'two_files');
      assertEquals(((draftPosts(h)[0].body as Row).items as Row[]).map((i) => (i.files as Row[]).map((f) => f.type)), [['default', 'back']]);
      assertEquals((orderOf(h).print_files as { files: Row[] }).files.map((f) => f.side), ['front', 'back']);
    } finally {
      (product as { fileLayout: string }).fileLayout = original;
    }
  });
});

Deno.test('create_checkout is idempotent: a second call returns the open session and creates nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const first = await (await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).json();
    const second = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(second.status, 200);
    const secondBody = await second.json();
    assertEquals(secondBody.checkoutUrl, first.checkoutUrl);
    assertEquals(secondBody.resumed, true);
    assertEquals(noPrintWork(h), 0);
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path === '/checkout/sessions' && c.method === 'POST').length, 1);
  });
});

Deno.test('create_checkout after a Stripe failure just retries Stripe: nothing was rendered or created, the claim is released', async () => {
  await withEnv(async () => {
    let stripeDown = true;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => ((input: Request | URL | string, init?: RequestInit) =>
        stripeDown && new URL(String(input)).hostname === 'api.stripe.com' ? Promise.resolve(new Response('{}', { status: 500 })) : real(input, init)) as typeof fetch,
    });
    const failed = await h.call(body());
    assertEquals(failed.status, 502);
    assertEquals((await failed.json()).code, 'STRIPE_UNAVAILABLE');
    assertEquals(orderOf(h).status, 'quoted');
    assertEquals(orderOf(h).gelato_order_id ?? null, null);
    assertEquals(hasOrderClaim(h), false);
    assertEquals(typeof orderOf(h).snapshot_hash, 'string'); // frozen already
    stripeDown = false;
    assertEquals((await h.call(body())).status, 200);
    assertEquals(noPrintWork(h), 0);
    assertEquals(orderOf(h).status, 'checkout');
  });
});

Deno.test('create_checkout purges leftovers of an older pre-payment render (another snapshot, or a layout the product no longer uses) and keeps nothing stale', async () => {
  await withEnv(async () => {
    const files = [{ side: 'front', key: `print-orders/${IDS.order}/oldhash000000000/front.pdf`, sha256: 'a'.repeat(64), bytes: 10 }, { side: 'back', key: `print-orders/${IDS.order}/oldhash000000000/back.pdf`, sha256: 'b'.repeat(64), bytes: 10 }];
    const h = harness(cardWorldSeed({
      order: { ...QUOTED_ORDER, file_layout: 'two_files', gelato_order_id: 'gel-old00001', snapshot_hash: 'a'.repeat(64), print_files: { files, snapshotHash: 'a'.repeat(64) } },
    }));
    h.world.gelato.state.orders.set('gel-old00001', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
    for (const f of files) h.r2.keys.add(f.key);
    assertEquals((await h.call(body())).status, 200);
    const row = orderOf(h);
    assertEquals(row.gelato_order_id ?? null, null);
    assertEquals(h.world.gelato.state.orders.has('gel-old00001'), false);
    assertEquals(h.r2.keys.size, 0);
    assertEquals((row.print_files as { files?: unknown }).files, undefined);
    assertEquals(row.file_layout, 'one_pdf');
    assertEquals(h.world.renderCalls.length, 0);
  });
});

// ── The post-payment pipeline: failures, retries, idempotent re-entry ────

Deno.test('pipeline: print files missing from storage (or the wrong size) are a RETRY, never a draft pointing at nothing', async () => {
  await withEnv(async () => {
    for (const head of [async () => null, async () => ({ contentLength: 7 })]) {
      const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
      assertEquals((await h.call(body())).status, 200);
      const { outcome } = await payAndFulfil(h, IDS.order, { head });
      assertEquals(outcome, 'retry');
      assertEquals(draftPosts(h).length, 0);
      assertEquals(orderOf(h).status, 'paid');
      assertEquals(orderOf(h).failure_reason ?? null, null);
    }
  });
});

Deno.test('pipeline: a render 422 after payment FAILS the order with the code and alerts the owner (like the book: no buyer email, no automatic refund)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.setRender(() => new Response(JSON.stringify({ ok: false, code: 'LETTER_OVERFLOW', message: 'too long' }), { status: 422 }));
    const { outcome, mails } = await payAndFulfil(h);
    assertEquals(outcome, 'failed');
    const row = orderOf(h);
    assertEquals(row.status, 'failed');
    assertEquals(row.failure_reason, 'RENDER_REFUSED:LETTER_OVERFLOW');
    assertEquals(draftPosts(h).length, 0);
    assertEquals(patchesOf(h).length, 0);
    assertEquals(mails.length, 1);
    assertEquals(mails[0].to, 'hello@usemomora.com');
    assertEquals(mails[0].subject.includes('RENDER_REFUSED:LETTER_OVERFLOW'), true);
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path.includes('refund')).length, 0);
  });
});

Deno.test('pipeline: a render outage is retried (the order stays paid), and the next run completes it with exactly one draft', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.setRender(() => new Response('boom', { status: 503 }));
    assertEquals((await payAndFulfil(h)).outcome, 'retry');
    assertEquals(orderOf(h).status, 'paid');
    assertEquals(orderOf(h).failure_reason ?? null, null);
    assertEquals(draftPosts(h).length, 0);
    h.world.setRender((call) => defaultRenderResponse(call));
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'submitted');
    assertEquals(draftPosts(h).length, 1);
    assertEquals(orderOf(h).status, 'submitted');
  });
});

Deno.test('pipeline: Gelato refusing the draft fails the order (files kept); Gelato being down is a retry', async () => {
  await withEnv(async () => {
    const refused = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await refused.call(body())).status, 200);
    refused.world.gelato.state.forceStatus.set('POST /orders', 400);
    const { outcome, mails } = await payAndFulfil(refused);
    assertEquals(outcome, 'failed');
    assertEquals(orderOf(refused).status, 'failed');
    assertEquals(String(orderOf(refused).failure_reason).startsWith('GELATO_DRAFT_REJECTED'), true);
    assertEquals(((orderOf(refused).print_files as { files?: unknown[] }).files ?? []).length, 1);
    assertEquals(mails.length, 1);

    const down = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await down.call(body())).status, 200);
    down.world.gelato.state.forceStatus.set('POST /orders', 503);
    assertEquals((await payAndFulfil(down)).outcome, 'retry');
    assertEquals(orderOf(down).status, 'paid');
    assertEquals(orderOf(down).failure_reason ?? null, null);
  });
});

Deno.test('pipeline re-entry: files already rendered are reused (no second render) when only the draft step failed before', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.gelato.state.forceStatus.set('POST /orders', 503);
    assertEquals((await payAndFulfil(h)).outcome, 'retry');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals((orderOf(h).print_files as { files: unknown[] }).files.length, 1); // persisted for the resume
    h.world.gelato.state.forceStatus.clear();
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'submitted');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(draftPosts(h).length, 2); // the failed attempt + the one that worked
    assertEquals(h.world.gelato.state.orders.size, 1);
  });
});

Deno.test('pipeline re-entry: an existing draft is reused (no render, no second draft); one that is already confirmed is not PATCHed again', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    // A draft recorded by an earlier run that died before confirming.
    h.world.gelato.state.orders.set('gel-prior001', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
    orderOf(h).gelato_order_id = 'gel-prior001';
    assertEquals((await payAndFulfil(h)).outcome, 'submitted');
    assertEquals(h.world.renderCalls.length, 0);
    assertEquals(draftPosts(h).length, 0);
    assertEquals(patchesOf(h).length, 1);

    const confirmed = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await confirmed.call(body())).status, 200);
    confirmed.world.gelato.state.orders.set('gel-prior002', { orderType: 'order', fulfillmentStatus: 'passed', tracking: [] });
    orderOf(confirmed).gelato_order_id = 'gel-prior002';
    assertEquals((await payAndFulfil(confirmed)).outcome, 'submitted');
    assertEquals(patchesOf(confirmed).length, 0);
    assertEquals(confirmed.world.renderCalls.length, 0);
  });
});

Deno.test('pipeline re-entry: two runs at once (webhook + sweep) leave exactly one live draft and one submission', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    const first = payAndFulfil(h);
    const second = payAndFulfil(h, IDS.order, { skipPay: true });
    const outcomes = (await Promise.all([first, second])).map((r) => r.outcome).sort();
    assertEquals(outcomes.includes('submitted'), true);
    assertEquals(h.world.gelato.state.orders.size, 1);
    assertEquals(orderOf(h).status, 'submitted');
    assertEquals(h.world.gelato.state.orders.has(orderOf(h).gelato_order_id as string), true);
    assertEquals(patchesOf(h).length, 1);
  });
});

Deno.test('pipeline: rendered files that do not fit the product layout (a P1 two_files order meets one_pdf) are re-rendered, never reused', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    const hash = orderOf(h).snapshot_hash as string;
    const old = [{ side: 'front', key: `print-orders/${IDS.order}/${hash.slice(0, 16)}/front.pdf`, sha256: 'a'.repeat(64), bytes: 1000 }, { side: 'back', key: `print-orders/${IDS.order}/${hash.slice(0, 16)}/back.pdf`, sha256: 'b'.repeat(64), bytes: 1000 }];
    for (const f of old) { h.world.objects.set(f.key, f.bytes); h.r2.keys.add(f.key); }
    orderOf(h).print_files = { snapshotHash: hash, files: old, sessionExpiresAt: '2026-10-06T12:35:00.000Z' };
    assertEquals((await payAndFulfil(h)).outcome, 'submitted');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(h.world.renderCalls[0].body.fileLayout, 'one_pdf');
    assertEquals((orderOf(h).print_files as { files: { side: string }[] }).files.map((f) => f.side), ['both']);
    for (const f of old) assertEquals(h.r2.deleted.includes(f.key), true);
  });
});

Deno.test('pipeline: missing render configuration, or an unreadable buyer email, is a retry that creates nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    assertEquals((await payAndFulfil(h, IDS.order, { pipeline: null })).outcome, 'retry');
    assertEquals(noPrintWork(h), 0);
    assertEquals(orderOf(h).status, 'paid');

    const noEmail = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await noEmail.call(body())).status, 200);
    noEmail.db.users.set(IDS.user, { email: null });
    const row = noEmail.db.row('holiday_card_orders', IDS.order);
    row.status = 'paid';
    row.stripe_payment_intent_id = 'pi_test_1';
    const deps: FulfillmentDeps = {
      fetch: noEmail.world.fetch, sendEmail: async () => 'sent', listKeys: noEmail.r2.listKeys, deleteKey: noEmail.r2.deleteKey,
      gelatoApiKey: 'k', stripeSecretKey: 'sk_test_x',
      pipeline: { renderUrl: 'https://render.test', renderSecret: 's', createPresignedGetUrls: fakePresign(), headObject: noEmail.world.headObject },
    };
    assertEquals(await confirmPaidOrder(deps, noEmail.db.build(), IDS.order), 'retry');
    assertEquals(draftPosts(noEmail).length, 0);
  });
});

Deno.test('pipeline: the held canary stops AFTER the files and the draft exist (for inspection) and before any confirm', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, settings: { hold_confirm_family_ids: [IDS.family] } }));
    assertEquals((await h.call(body())).status, 200);
    const { outcome, mails } = await payAndFulfil(h);
    assertEquals(outcome, 'blocked');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(draftPosts(h).length, 1);
    assertEquals(patchesOf(h).length, 0);
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path.startsWith('/payment_intents')).length, 0);
    const row = orderOf(h);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, 'HELD_FOR_CANARY');
    assertEquals(typeof row.gelato_order_id, 'string');
    assertEquals(mails.filter((m) => m.subject.includes('HELD_FOR_CANARY')).length, 1);
    // A later run is quiet and creates nothing more.
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'blocked');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(draftPosts(h).length, 1);
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
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
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
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CARD_CHANGED');
  });
});

Deno.test('two simultaneous create_checkout calls: one wins, the other is told it is in progress, one Stripe session', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const [a, b] = await Promise.all([
      h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 }),
      h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 }),
    ]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assertEquals((await loser.json()).code, 'CHECKOUT_IN_PROGRESS');
    assertEquals(h.world.gelato.state.calls.length, 0); // pay first: no draft before payment
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path === '/checkout/sessions' && c.method === 'POST').length, 1);
  });
});

Deno.test('create_checkout film gate: a still-rendering film blocks, a published one passes, one that can never publish (blocked/ended) or QR off or no film prints without a QR', async () => {
  await withEnv(async () => {
    const neverPublished = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'rendering', video_key: null, ready_at: null } }));
    const blocked = await neverPublished.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(blocked.status, 409);
    assertEquals((await blocked.json()).code, 'FILM_NOT_READY');
    assertEquals(neverPublished.world.renderCalls.length, 0);

    // A film that can never publish (ended / gave up) prints WITHOUT a QR rather than blocking the order.
    const ended = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'ended', video_key: null } }));
    assertEquals((await ended.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    assertEquals(((orderOf(ended).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);

    // Published and now re-rendering (or a failed re-render that left the video in place): the printed link still works.
    for (const status of ['rendering', 'queued', 'failed']) {
      const republishing = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status } }));
      assertEquals((await republishing.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    }

    const filmBlocked = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { blocked: true } }));
    assertEquals((await filmBlocked.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    assertEquals(((orderOf(filmBlocked).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);

    const qrOff = harness(cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'ended', video_key: null }, card: { edits: { choices: { layout: 'bordered', tone: 'classic', qr: false } } } }));
    assertEquals((await qrOff.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    assertEquals(((orderOf(qrOff).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);

    const noFilm = harness(cardWorldSeed({ order: QUOTED_ORDER, film: null }));
    assertEquals((await noFilm.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    assertEquals(((orderOf(noFilm).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);
  });
});

Deno.test('create_checkout prints the QR when the film is ready and drops it when disable_link revoked the token', async () => {
  await withEnv(async () => {
    const live = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    await live.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    const liveQr = ((orderOf(live).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean; url: string } }).qr;
    assertEquals(liveQr.enabled, true);
    assertEquals(liveQr.url, `https://m.usemomora.com/f/${SHARE_TOKEN}`);

    // disable_link revokes the token WITHOUT touching edits.choices.qr: the QR is off, and
    // the film state no longer matters (a film that is not even ready still lets the order through).
    const revoked = harness(cardWorldSeed({ order: QUOTED_ORDER, token: { revoked_at: '2026-10-05T00:00:00Z' }, film: { status: 'failed', video_key: null } }));
    assertEquals((await revoked.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
    assertEquals(((orderOf(revoked).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);
  });
});

Deno.test('create_checkout: an unreadable chosen front photo is refused, never swapped for another', async () => {
  await withEnv(async () => {
    // A photo of ANOTHER family (ownership check) chosen by the editor.
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { edits: { frontImage: IDS.mediaOther } } }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(response.status, 422);
    assertEquals((await response.json()).code, 'FRONT_PHOTO_UNREADABLE');
    assertEquals(h.world.renderCalls.length, 0);
    assertEquals(orderRow(h.db).status, 'quoted');
  });
});

Deno.test('create_checkout: preconditions on the card and the quote', async () => {
  await withEnv(async () => {
    const generating = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { status: 'generating' } }));
    assertEquals((await generating.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 409);

    const deleted = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { deleted_at: '2026-10-05T00:00:00Z' } }));
    assertEquals((await deleted.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 404);

    const stale = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, price_cents: 100 } }));
    const response = await stale.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'QUOTE_STALE');

    // A quote priced before the 2026-10-06 tier table (10 packs at the old flat $2.49) is stale.
    const preTiers = harness(cardWorldSeed({ order: { ...QUOTED_ORDER, packs: 10, price_cents: 24900 } }));
    const old = await preTiers.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(old.status, 409);
    assertEquals((await old.json()).code, 'QUOTE_STALE');
    assertEquals(stale.world.renderCalls.length, 0);

    const draft = harness(cardWorldSeed());
    assertEquals((await draft.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 409);

    const viewer = harness(cardWorldSeed({ order: QUOTED_ORDER }), { role: 'viewer' });
    assertEquals((await viewer.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 403);

    const deletedFamily = harness(cardWorldSeed({ order: QUOTED_ORDER, family: { deleted_at: '2026-10-05T00:00:00Z' } }));
    assertEquals((await deletedFamily.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 404);
  });
});

Deno.test('create_checkout reports missing configuration as a server error and creates nothing', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const response = await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 });
    assertEquals(response.status, 500);
    assertEquals(h.world.renderCalls.length, 0);
  }, { STRIPE_SECRET_KEY: null });

  // Pay first: no Gelato key or render service is needed to open a checkout.
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).status, 200);
  }, { GELATO_API_KEY: null, MEMORY_BOOK_RENDER_WORKER_URL: null, MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET: null });
});

// ── cancel_checkout and status ───────────────────────────────────────────

Deno.test('cancel_checkout expires the session, cancels the order and deletes the draft and print files', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const checkout = await (await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).json();
    h.r2.keys.add(`print-orders/${IDS.order}/card.pdf`);
    const gelatoId = orderRow(h.db).gelato_order_id as string;

    const response = await h.call({ op: 'cancel_checkout', orderId: IDS.order });
    assertEquals(response.status, 200);
    const row = orderRow(h.db);
    assertEquals(row.status, 'cancelled');
    assertEquals(row.gelato_order_id, null);
    assertEquals(typeof (row.print_files as { purgedAt?: string }).purgedAt, 'string');
    assertEquals(h.world.stripe.state.sessions.get(checkout.sessionId)?.status, 'expired');
    assertEquals(h.world.gelato.state.orders.has(gelatoId), false);
    assertEquals(h.r2.keys.size, 0);
  });
});

Deno.test('cancel_checkout refuses when the customer already paid', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const checkout = await (await h.call({ op: 'create_checkout', orderId: IDS.order, expectedEditsVersion: 0 })).json();
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


// ═══ Holiday cards P2: kill switch, card claim, version pin, expiry, reorders ═══

const ORDER_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_BUYER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const START = Date.parse('2026-10-06T12:00:00.000Z');
const body = (extra: Row = {}, orderId: string = IDS.order) => ({ op: 'create_checkout', orderId, expectedEditsVersion: 0, ...extra });
const cardOf = (h: Harness) => h.db.row('holiday_cards', IDS.card);
const claimHolder = (h: Harness) => cardOf(h).checkout_order_id;
const orderOf = (h: Harness, id: string = IDS.order) => h.db.row('holiday_card_orders', id);
const hasOrderClaim = (h: Harness, id: string = IDS.order) => Boolean((orderOf(h, id).print_files as { claim?: unknown } | null)?.claim);
const sessionPosts = (h: Harness) => h.world.stripe.state.calls.filter((c) => c.method === 'POST' && c.path === '/checkout/sessions');
const customerPosts = (h: Harness) => h.world.stripe.state.calls.filter((c) => c.method === 'POST' && c.path === '/customers');
const secondOrder = (overrides: Row = {}): Row => ({
  id: ORDER_B, card_id: IDS.card, family_id: IDS.family, requested_by: IDS.user, created_at: '2026-10-06T09:00:00.000Z', updated_at: '2026-10-06T09:00:00.000Z', ...QUOTED_ORDER, ...overrides,
});

// ── Orders kill switch ───────────────────────────────────────────────────

Deno.test('kill switch: create_draft, quote and create_checkout answer 403 HOLIDAY_CARD_ORDERS_PAUSED and do nothing; cancel_checkout and status still work', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, settings: { orders_enabled: false } }));
    for (const request of [{ op: 'create_draft', cardId: IDS.card }, { op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 }, body()]) {
      const response = await h.call(request);
      assertEquals(response.status, 403, String(request.op));
      assertEquals((await response.json()).code, 'HOLIDAY_CARD_ORDERS_PAUSED');
    }
    assertEquals(h.db.rows('holiday_card_orders').length, 1); // no draft inserted
    assertEquals(orderOf(h).status, 'quoted');
    assertEquals(orderOf(h).print_files ?? null, null);
    assertEquals(h.world.gelato.state.calls.length + h.world.stripe.state.calls.length + h.world.renderCalls.length, 0);
    assertEquals(h.db.rpcCalls.every((c) => c.name === 'holiday_card_orders_enabled'), true); // never reached the claim
    // Paused ordering must not trap a buyer in an open checkout, nor hide their orders.
    assertEquals((await h.call({ op: 'status', orderId: IDS.order })).status, 200);
    assertEquals((await h.call({ op: 'cancel_checkout', orderId: IDS.order })).status, 200);
    assertEquals(orderOf(h).status, 'cancelled');
  });
});

Deno.test('kill switch fails closed: an unreadable setting (RPC error, or no settings row) never lets an order through', async () => {
  await withEnv(async () => {
    const broken = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    broken.db.rpcFailures.set('holiday_card_orders_enabled', { message: 'boom', code: 'XX000' });
    for (const request of [{ op: 'create_draft', cardId: IDS.card }, { op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 2 }, body()]) {
      const response = await broken.call(request);
      assertEquals(response.status, 500, String(request.op));
      assertEquals((await response.json()).code, 'internal_error');
    }
    assertEquals(broken.world.renderCalls.length + broken.world.stripe.state.calls.length + broken.world.gelato.state.calls.length, 0);
    assertEquals(broken.db.rows('holiday_card_orders').length, 1);

    const noAnswer = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    noAnswer.db.rpcHandlers.set('holiday_card_orders_enabled', () => null);
    assertEquals((await noAnswer.call(body())).status, 500);

    // No settings row: the database function answers false (paused), like the real one.
    const seed = cardWorldSeed({ order: QUOTED_ORDER });
    delete seed.holiday_card_settings;
    const missing = harness(seed);
    assertEquals((await missing.call(body())).status, 403);
  });
});

Deno.test('kill switch: with ordering on, everything works as before', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: null }));
    assertEquals((await h.call({ op: 'create_draft', cardId: IDS.card })).status, 201);
  });
});

// ── expectedEditsVersion ─────────────────────────────────────────────────

Deno.test('create_checkout requires expectedEditsVersion (an integer >= 0): 400 validation_error before any claim', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    for (const bad of [undefined, null, '0', 1.5, -1, true, {}]) {
      const response = await h.call({ op: 'create_checkout', orderId: IDS.order, ...(bad === undefined ? {} : { expectedEditsVersion: bad }) });
      assertEquals(response.status, 400, JSON.stringify(bad));
      assertEquals((await response.json()).code, 'validation_error');
    }
    assertEquals(h.db.rpcCalls.filter((c) => c.name === 'claim_holiday_card_checkout').length, 0);
    assertEquals(orderOf(h).print_files ?? null, null);
    // 0 is a valid version (a card starts at 0).
    assertEquals((await h.call(body())).status, 200);
  });
});

Deno.test('create_checkout: a version that is not the card\'s is CARD_CHANGED; nothing is rendered or created and no claim is left', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { edits_version: 4 } }));
    const stale = await h.call(body({ expectedEditsVersion: 3 }));
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, 'CARD_CHANGED');
    assertEquals(h.world.renderCalls.length + h.world.stripe.state.calls.length + h.world.gelato.state.calls.length, 0);
    assertEquals(orderOf(h).status, 'quoted');
    assertEquals(hasOrderClaim(h), false);
    assertEquals(claimHolder(h), null);
    // The next version-pinned call goes through.
    assertEquals((await h.call(body({ expectedEditsVersion: 4 }))).status, 200);
  });
});

// ── The card-level claim ─────────────────────────────────────────────────

Deno.test('create_checkout takes the card claim FIRST, keeps it while the order is in checkout, and builds the snapshot from the row the claim returned', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    // The row the claim RPC re-reads under its lock is what gets printed (here: a letter edited just before).
    h.db.rpcHandlers.set('claim_holiday_card_checkout', () => {
      const card = cardOf(h);
      card.edits = { letters: { classic: 'The letter as the claim re-read it' }, choices: { layout: 'bordered', tone: 'classic' } };
      card.checkout_order_id = IDS.order;
      card.checkout_claimed_at = new Date(START).toISOString();
      return [{ ...card }];
    });
    const response = await h.call(body());
    assertEquals(response.status, 200);
    const claimCalls = h.db.rpcCalls.filter((c) => c.name === 'claim_holiday_card_checkout');
    assertEquals(claimCalls, [{ name: 'claim_holiday_card_checkout', args: { p_order_id: IDS.order, p_expected_version: 0 } }]);
    const rendered = (orderOf(h).card_snapshot as { edits: { letters: Record<string, string> } }).edits;
    assertEquals(rendered.letters.classic, 'The letter as the claim re-read it');
    // Kept: the order is the card's open checkout; the order-level claim is gone.
    assertEquals(orderOf(h).status, 'checkout');
    assertEquals(claimHolder(h), IDS.order);
    assertEquals(hasOrderClaim(h), false);
    assertEquals(h.db.rpcCalls.filter((c) => c.name === 'release_holiday_card_checkout').length, 0);
  });
});

Deno.test('CHECKOUT_OPEN_ELSEWHERE: another order in checkout, or another order\'s fresh claim; a stale claim of another order is taken over', async () => {
  await withEnv(async () => {
    const inCheckout = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    inCheckout.db.rows('holiday_card_orders').push(secondOrder({ status: 'checkout', requested_by: OTHER_BUYER, stripe_session_id: 'cs_test_other01' }));
    const first = await inCheckout.call(body());
    assertEquals(first.status, 409);
    assertEquals((await first.json()).code, 'CHECKOUT_OPEN_ELSEWHERE');
    assertEquals(orderOf(inCheckout).status, 'quoted');
    assertEquals(hasOrderClaim(inCheckout), false);
    assertEquals(claimHolder(inCheckout), null);
    assertEquals(inCheckout.world.renderCalls.length + inCheckout.world.gelato.state.calls.length + inCheckout.world.stripe.state.calls.length, 0);

    const freshClaim = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { checkout_order_id: ORDER_B, checkout_claimed_at: new Date(START - 3 * 60_000).toISOString() } }));
    const second = await freshClaim.call(body());
    assertEquals(second.status, 409);
    assertEquals((await second.json()).code, 'CHECKOUT_OPEN_ELSEWHERE');
    assertEquals(claimHolder(freshClaim), ORDER_B); // the other order's claim is untouched by our failure path

    const staleClaim = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { checkout_order_id: ORDER_B, checkout_claimed_at: new Date(START - 11 * 60_000).toISOString() } }));
    assertEquals((await staleClaim.call(body())).status, 200);
    assertEquals(claimHolder(staleClaim), IDS.order);
  });
});

Deno.test('two different orders of one card racing: exactly one wins, one Stripe session, the loser leaves the winner\'s claim alone', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    h.db.rows('holiday_card_orders').push(secondOrder());
    const [a, b] = await Promise.all([h.call(body()), h.call(body({}, ORDER_B))]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    const loserBody = await (a.status === 409 ? a : b).json();
    assertEquals(loserBody.code, 'CHECKOUT_OPEN_ELSEWHERE');
    const winner = a.status === 200 ? IDS.order : ORDER_B;
    const loser = winner === IDS.order ? ORDER_B : IDS.order;
    assertEquals(orderOf(h, winner).status, 'checkout');
    assertEquals(orderOf(h, loser).status, 'quoted');
    assertEquals(claimHolder(h), winner);
    assertEquals(hasOrderClaim(h, loser), false);
    assertEquals(h.world.gelato.state.calls.length, 0);
    assertEquals(sessionPosts(h).length, 1);
  });
});

Deno.test('two simultaneous calls on ONE order: the loser must not release the winner\'s card claim', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const [a, b] = await Promise.all([h.call(body()), h.call(body())]);
    assertEquals([a.status, b.status].sort(), [200, 409]);
    assertEquals(orderOf(h).status, 'checkout');
    assertEquals(claimHolder(h), IDS.order);
    assertEquals(h.db.rpcCalls.filter((c) => c.name === 'claim_holiday_card_checkout').length, 1); // the loser never got that far
    assertEquals(h.db.rpcCalls.filter((c) => c.name === 'release_holiday_card_checkout').length, 0);
  });
});

Deno.test('a card that was deleted is 404 CARD_NOT_FOUND from the claim, and the order claim is given back', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { deleted_at: '2026-10-05T00:00:00Z' } }));
    const response = await h.call(body());
    assertEquals(response.status, 404);
    assertEquals((await response.json()).code, 'CARD_NOT_FOUND');
    assertEquals(hasOrderClaim(h), false);
    assertEquals(h.world.renderCalls.length, 0);
  });
});

Deno.test('an unexpected claim RPC error is a 500 (code only in the log) and leaves no claim behind', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    h.db.rpcFailures.set('claim_holiday_card_checkout', { message: 'connection reset', code: '08006' });
    const response = await h.call(body());
    assertEquals(response.status, 500);
    assertEquals((await response.json()).code, 'internal_error');
    assertEquals(hasOrderClaim(h), false);
    assertEquals(claimHolder(h), null);
  });
});

// Every way create_checkout can fail after the claim gives BOTH claims back.
type FailureCase = { name: string; seed: () => Record<string, Row[]>; setup?: (h: Harness) => void; hookFetch?: (db: () => FakeDb) => (real: typeof fetch) => typeof fetch; dbOptions?: FakeDbOptions; status: number };
const FAILURE_CASES: FailureCase[] = [
  { name: 'Stripe down', seed: () => cardWorldSeed({ order: QUOTED_ORDER }), hookFetch: () => (real) => ((input: Request | URL | string, init?: RequestInit) =>
    new URL(String(input)).hostname === 'api.stripe.com' ? Promise.resolve(new Response('{}', { status: 500 })) : real(input, init)) as typeof fetch, status: 502 },
  { name: 'film not ready', seed: () => cardWorldSeed({ order: QUOTED_ORDER, film: { status: 'rendering', video_key: null, ready_at: null } }), status: 409 },
  { name: 'unreadable front photo', seed: () => cardWorldSeed({ order: QUOTED_ORDER, card: { edits: { frontImage: IDS.mediaOther } } }), status: 422 },
  { name: 'card not ready', seed: () => cardWorldSeed({ order: QUOTED_ORDER, card: { status: 'generating' } }), status: 409 },
  { name: 'deleted family', seed: () => cardWorldSeed({ order: QUOTED_ORDER, family: { deleted_at: '2026-10-05T00:00:00Z' } }), status: 404 },
  { name: 'final CAS database error', seed: () => cardWorldSeed({ order: QUOTED_ORDER }), dbOptions: { failWrite: (table, _op, patch) => table === 'holiday_card_orders' && patch.status === 'checkout' }, status: 500 },
];
for (const failure of FAILURE_CASES) {
  Deno.test(`release on every failure path: ${failure.name} leaves no card claim and no order claim`, async () => {
    await withEnv(async () => {
      let db: FakeDb | null = null;
      const h = harness(failure.seed(), {
        dbOptions: failure.dbOptions,
        fetch: failure.hookFetch?.(() => db!),
      });
      db = h.db;
      failure.setup?.(h);
      const response = await h.call(body());
      assertEquals(response.status, failure.status);
      assertEquals(claimHolder(h), null);
      assertEquals(cardOf(h).checkout_claimed_at, null);
      assertEquals(hasOrderClaim(h), false);
      assertEquals(orderOf(h).status === 'quoted' || orderOf(h).status === 'checkout', true);
      assertEquals(orderOf(h).status, 'quoted');
    });
  });
}

Deno.test('release on every failure path: the card changed at the last look gives the claim back', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions') {
          db!.row('holiday_cards', IDS.card).deleted_at = '2026-10-06T12:00:30.000Z';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    assertEquals((await h.call(body())).status, 409);
    assertEquals(claimHolder(h), null);
    assertEquals(hasOrderClaim(h), false);
  });
});

Deno.test('the edits changing while the checkout was prepared (a claim older than 10 minutes no longer blocks edits) is CARD_CHANGED: session expired, claim released', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions') {
          db!.row('holiday_cards', IDS.card).edits_version = 1;
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    const response = await h.call(body());
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CARD_CHANGED');
    assertEquals([...h.world.stripe.state.sessions.values()].every((session) => session.status === 'expired'), true);
    assertEquals(claimHolder(h), null);
    assertEquals(orderOf(h).status, 'quoted');
    assertEquals(h.world.gelato.state.orders.size, 0);
  });
});

Deno.test('a 23505 at the final CAS (another order won checkout meanwhile): the new Stripe session is expired, both claims released, 409 CHECKOUT_OPEN_ELSEWHERE', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions') {
          // Another buyer's order reaches `checkout` while we are talking to Stripe.
          db!.row('holiday_card_orders', ORDER_B).status = 'checkout';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    h.db.rows('holiday_card_orders').push(secondOrder({ requested_by: OTHER_BUYER }));
    const response = await h.call(body());
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'CHECKOUT_OPEN_ELSEWHERE');
    assertEquals([...h.world.stripe.state.sessions.values()].every((session) => session.status === 'expired'), true);
    assertEquals(claimHolder(h), null);
    assertEquals(hasOrderClaim(h), false);
    assertEquals(orderOf(h).status, 'quoted');
    assertEquals(orderOf(h).stripe_session_id ?? null, null);
  });
});

Deno.test('an order cancelled while the session was being made: ORDER_NOT_QUOTED, the session is expired and the claim released', async () => {
  await withEnv(async () => {
    let db: FakeDb | null = null;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions') {
          db!.row('holiday_card_orders', IDS.order).status = 'cancelled';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    const response = await h.call(body());
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'ORDER_NOT_QUOTED');
    assertEquals([...h.world.stripe.state.sessions.values()].every((session) => session.status === 'expired'), true);
    assertEquals(claimHolder(h), null);
  });
});

Deno.test('cancel_checkout releases the card claim (checkout and quoted orders); another order\'s claim is never touched', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    assertEquals(claimHolder(h), IDS.order);
    assertEquals((await h.call({ op: 'cancel_checkout', orderId: IDS.order })).status, 200);
    assertEquals(orderOf(h).status, 'cancelled');
    assertEquals(claimHolder(h), null);

    const quoted = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { checkout_order_id: ORDER_B, checkout_claimed_at: new Date(START).toISOString() } }));
    assertEquals((await quoted.call({ op: 'cancel_checkout', orderId: IDS.order })).status, 200);
    assertEquals(claimHolder(quoted), ORDER_B);
  });
});

Deno.test('re-quoting gives back a card claim a crashed attempt of this order left', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER, card: { checkout_order_id: IDS.order, checkout_claimed_at: new Date(START - 60_000).toISOString() } }));
    assertEquals((await h.call({ op: 'quote', orderId: IDS.order, address: US_ADDRESS, packs: 3 })).status, 200);
    assertEquals(claimHolder(h), null);
  });
});

// ── Stripe expires_at + idempotency ──────────────────────────────────────

Deno.test('chooseSessionExpiry: a stored expiry is reused only while >= 10 minutes remain, otherwise now + 35 minutes', () => {
  const now = START;
  const fresh = chooseSessionExpiry(undefined, now);
  assertEquals(fresh, { seconds: Math.floor((now + STRIPE_SESSION_TTL_MS) / 1000), iso: new Date(now + 35 * 60_000).toISOString(), reused: false });
  const stored = new Date(now + SESSION_REUSE_MIN_LEFT_MS).toISOString();
  assertEquals(chooseSessionExpiry(stored, now).reused, true);
  assertEquals(chooseSessionExpiry(stored, now).iso, stored);
  assertEquals(chooseSessionExpiry(stored, now + 1000).reused, false);
  assertEquals(chooseSessionExpiry('not a date', now).reused, false);
  assertEquals(chooseSessionExpiry(new Date(now - 1).toISOString(), now).reused, false);
});

Deno.test('Stripe expires_at is now + 35 minutes (unix seconds), recorded on the order, returned to the client and part of the idempotency key', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    const response = await h.call(body());
    const result = await response.json();
    const expectedSeconds = Math.floor((START + 35 * 60_000) / 1000);
    const posted = sessionPosts(h)[0];
    assertEquals(new URLSearchParams(posted.body).get('expires_at'), String(expectedSeconds));
    const expectedIso = new Date(expectedSeconds * 1000).toISOString();
    assertEquals(result.expiresAt, expectedIso);
    assertEquals((orderOf(h).print_files as { sessionExpiresAt?: string }).sessionExpiresAt, expectedIso);
    assertEquals(posted.idempotencyKey?.startsWith('hc-sess-'), true);
    // Resuming the open checkout hands the same expiry back.
    const resumed = await (await h.call(body())).json();
    assertEquals(resumed.resumed, true);
    assertEquals(resumed.expiresAt, expectedIso);
  });
});

function failFinalCasOnce(): FakeDbOptions {
  let failures = 1;
  return { failWrite: (table, _op, patch) => (table === 'holiday_card_orders' && patch.status === 'checkout' && failures-- > 0) };
}

Deno.test('a retry of the SAME attempt sends an identical Stripe request (same body, same keys) and gets the same session', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), { dbOptions: failFinalCasOnce() });
    const first = await h.call(body());
    assertEquals(first.status, 500); // Stripe made the session, but recording it failed
    assertEquals(claimHolder(h), null);
    assertEquals(hasOrderClaim(h), false);
    h.clock.ms = START + 2 * 60_000; // the buyer taps again two minutes later
    const second = await h.call(body());
    assertEquals(second.status, 200);

    const sessions = sessionPosts(h);
    assertEquals(sessions.length, 2);
    assertEquals(sessions[1].body, sessions[0].body); // byte-identical, expires_at included
    assertEquals(sessions[1].idempotencyKey, sessions[0].idempotencyKey);
    const customers = customerPosts(h);
    assertEquals(customers.length, 2);
    assertEquals(customers[1].body, customers[0].body);
    assertEquals(customers[1].idempotencyKey, customers[0].idempotencyKey);
    // Stripe handed back the one session it had made; no second render, no second draft.
    assertEquals(h.world.stripe.state.sessions.size, 1);
    assertEquals((await second.json()).sessionId, orderOf(h).stripe_session_id);
    assertEquals(noPrintWork(h), 0); // pay first: no render, no draft
    assertEquals(new URLSearchParams(sessions[0].body).get('expires_at'), String(Math.floor((START + 35 * 60_000) / 1000)));
  });
});

Deno.test('a NEW attempt (the stored expiry has under 10 minutes left) gets a new expires_at and a new session key; the customer is reused', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), { dbOptions: failFinalCasOnce() });
    assertEquals((await h.call(body())).status, 500);
    h.clock.ms = START + 30 * 60_000; // 5 minutes of the old session are left
    const second = await h.call(body());
    assertEquals(second.status, 200);

    const sessions = sessionPosts(h);
    assertEquals(sessions.length, 2);
    assertNotEquals(sessions[1].body, sessions[0].body);
    assertNotEquals(sessions[1].idempotencyKey, sessions[0].idempotencyKey);
    assertEquals(new URLSearchParams(sessions[1].body).get('expires_at'), String(Math.floor((START + 65 * 60_000) / 1000)));
    // Everything but the expiry is the same request.
    const strip = (value: string) => value.replace(/&?expires_at=\d+/, '');
    assertEquals(strip(sessions[1].body), strip(sessions[0].body));
    assertEquals(h.world.stripe.state.sessions.size, 2);
    assertEquals(orderOf(h).stripe_session_id, [...h.world.stripe.state.sessions.keys()][1]);
    assertEquals((orderOf(h).print_files as { sessionExpiresAt: string }).sessionExpiresAt, new Date(Math.floor((START + 65 * 60_000) / 1000) * 1000).toISOString());
    // The Stripe customer does not depend on the attempt.
    assertEquals(customerPosts(h)[1].idempotencyKey, customerPosts(h)[0].idempotencyKey);
    assertEquals(h.world.stripe.state.calls.filter((c) => c.path === '/customers' && c.method === 'POST').length, 2);
  });
});

Deno.test('a reused expiry that Stripe refuses (under its 30-minute minimum: the first attempt never reached Stripe) starts a new attempt once', async () => {
  await withEnv(async () => {
    let stripeDown = true;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => ((input: Request | URL | string, init?: RequestInit) =>
        stripeDown && new URL(String(input)).hostname === 'api.stripe.com' ? Promise.resolve(new Response('{}', { status: 500 })) : real(input, init)) as typeof fetch,
    });
    h.world.stripe.state.now = () => h.clock.ms;
    const first = await h.call(body());
    assertEquals(first.status, 502); // never reached Stripe
    stripeDown = false;
    h.clock.ms = START + 15 * 60_000; // 20 minutes of the stored expiry are left: reused, but under Stripe's minimum
    const second = await h.call(body());
    assertEquals(second.status, 200);
    const posts = sessionPosts(h);
    assertEquals(posts.length, 2); // the refused one, then the fresh attempt
    assertEquals(new URLSearchParams(posts[0].body).get('expires_at'), String(Math.floor((START + 35 * 60_000) / 1000)));
    assertEquals(new URLSearchParams(posts[1].body).get('expires_at'), String(Math.floor((START + 50 * 60_000) / 1000)));
    assertNotEquals(posts[1].idempotencyKey, posts[0].idempotencyKey);
    assertEquals(orderOf(h).status, 'checkout');
    assertEquals(h.world.stripe.state.sessions.size, 1);
  });
});

Deno.test('a 400 from Stripe on a FRESH expiry is not retried (a plain failure)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => ((input: Request | URL | string, init?: RequestInit) =>
        new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions'
          ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 400 }))
          : real(input, init)) as typeof fetch,
    });
    const response = await h.call(body());
    assertEquals(response.status, 502);
    assertEquals((await response.json()).code, 'STRIPE_UNAVAILABLE');
    assertEquals(claimHolder(h), null);
    assertEquals(hasOrderClaim(h), false);
  });
});

Deno.test('closing a session we made (23505, or a failed re-check) forgets its expiry: the retry is a NEW attempt and ends with an OPEN session, never a replayed dead one', async () => {
  await withEnv(async () => {
    // 23505: another order reaches checkout while we talk to Stripe; later it goes away.
    let db: FakeDb | null = null;
    let race = true;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      fetch: (real) => (async (input: Request | URL | string, init?: RequestInit) => {
        if (race && new URL(String(input)).hostname === 'api.stripe.com' && new URL(String(input)).pathname === '/v1/checkout/sessions') {
          db!.row('holiday_card_orders', ORDER_B).status = 'checkout';
        }
        return real(input, init);
      }) as typeof fetch,
    });
    db = h.db;
    h.db.rows('holiday_card_orders').push(secondOrder({ requested_by: OTHER_BUYER }));
    assertEquals((await h.call(body())).status, 409);
    assertEquals((orderOf(h).print_files as { sessionExpiresAt?: string }).sessionExpiresAt, undefined);
    race = false;
    orderOf(h, ORDER_B).status = 'cancelled';
    h.clock.ms = START + 60_000;
    const retried = await h.call(body());
    assertEquals(retried.status, 200);
    const posts = sessionPosts(h);
    assertEquals(posts.length, 2);
    assertNotEquals(posts[1].idempotencyKey, posts[0].idempotencyKey);
    assertEquals(h.world.stripe.state.sessions.size, 2);
    assertEquals(h.world.stripe.state.sessions.get(orderOf(h).stripe_session_id as string)?.status, 'open');
    assertEquals(orderOf(h).status, 'checkout');

    // A database error at the last look: same rule.
    let failRead = true;
    const g = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      dbOptions: { failRead: (table, columns) => failRead && table === 'holiday_cards' && columns === 'id, edits_version' },
    });
    assertEquals((await g.call(body())).status, 500);
    assertEquals((orderOf(g).print_files as { sessionExpiresAt?: string }).sessionExpiresAt, undefined);
    failRead = false;
    g.clock.ms = START + 60_000;
    assertEquals((await g.call(body())).status, 200);
    assertEquals(g.world.stripe.state.sessions.get(orderOf(g).stripe_session_id as string)?.status, 'open');
    assertEquals(g.world.stripe.state.sessions.size, 2);
  });
});

Deno.test('a re-render for a changed snapshot starts a new attempt too (the old expiry is not carried over)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), { dbOptions: failFinalCasOnce() });
    assertEquals((await h.call(body())).status, 500);
    h.db.row('holiday_cards', IDS.card).edits = { letters: { classic: 'A different letter' }, choices: { layout: 'bordered', tone: 'classic' } };
    h.db.row('holiday_cards', IDS.card).edits_version = 1;
    h.clock.ms = START + 60_000;
    assertEquals((await h.call(body({ expectedEditsVersion: 1 }))).status, 200);
    const sessions = sessionPosts(h);
    assertNotEquals(sessions[1].idempotencyKey, sessions[0].idempotencyKey);
    assertEquals(new URLSearchParams(sessions[1].body).get('expires_at'), String(Math.floor((START + 60_000 + 35 * 60_000) / 1000)));
  });
});

// ── Reorders: the first paid order's frozen snapshot ─────────────────────

/** Order A goes through checkout and is "paid" (shipped, claim released like the webhook does); order B is quoted for the same card. */
async function orderedCard(options: { seed?: Parameters<typeof cardWorldSeed>[0]; firstStatus?: string } = {}) {
  const h = harness(cardWorldSeed({ order: QUOTED_ORDER, ...options.seed }));
  const first = await h.call(body());
  assertEquals(first.status, 200);
  const a = orderOf(h);
  const firstOrder = { snapshot: JSON.stringify(a.card_snapshot), hash: a.snapshot_hash as string };
  const firstStatus = options.firstStatus ?? 'shipped';
  if (firstStatus === 'shipped') {
    // Paid for real: the webhook's CAS + the pipeline (render, draft, confirm) print it.
    assertEquals((await payAndFulfil(h)).outcome, 'submitted');
  } else {
    a.stripe_payment_intent_id = 'pi_test_first';
    cardOf(h).checkout_order_id = null; // the claim is released when the order leaves checkout
    cardOf(h).checkout_claimed_at = null;
  }
  a.status = firstStatus;
  h.db.rows('holiday_card_orders').push(secondOrder({ created_at: '2026-10-06T13:00:00.000Z' }));
  return { h, firstRender: h.world.renderCalls.find((c) => c.body.orderId === IDS.order)?.body as Row, firstOrder };
}
const renderFor = (h: Harness, orderId: string): Row => h.world.renderCalls.find((c) => c.body.orderId === orderId)!.body;

Deno.test('a reorder prints exactly what the first paid order printed (frozen snapshot, same hash), whatever the live card says now', async () => {
  await withEnv(async () => {
    const { h, firstRender, firstOrder } = await orderedCard();
    // The live card drifts: new letter, no front candidates at all (the live path would refuse with NO_FRONT_PHOTO).
    Object.assign(cardOf(h), { edits: { letters: { classic: 'Edited after the order' }, choices: { layout: 'bordered', tone: 'classic' } }, front_candidates: [], signature: 'Someone else' });
    const response = await h.call(body({}, ORDER_B));
    assertEquals(response.status, 200);
    const b = orderOf(h, ORDER_B);
    assertEquals(b.snapshot_hash, firstOrder.hash);
    assertEquals(JSON.stringify(b.card_snapshot), firstOrder.snapshot);
    assertEquals(new URLSearchParams(sessionPosts(h)[1].body).get('metadata[snapshotHash]'), firstOrder.hash);
    assertEquals(b.status, 'checkout');
    assertEquals(claimHolder(h), ORDER_B);
    assertEquals(h.world.renderCalls.length, 1); // still only the first order's render: pay first
    // After payment the pipeline renders the SAME card, edits and assets as the first order did.
    assertEquals((await payAndFulfil(h, ORDER_B)).outcome, 'submitted');
    const second = renderFor(h, ORDER_B);
    assertEquals(JSON.stringify(second.card), JSON.stringify(firstRender.card));
    assertEquals(JSON.stringify(second.edits), JSON.stringify(firstRender.edits));
    assertEquals(JSON.stringify(second.assets), JSON.stringify(firstRender.assets));
    // The front is signed from its ORIGINAL again.
    assertEquals(h.presigned.keys.filter((k) => k === 'u1/photos/front-original.jpg').length >= 2, true);
  });
});

Deno.test('a reorder still pins the version, and a first order that was cancelled or failed does not make a card "ordered"', async () => {
  await withEnv(async () => {
    const { h } = await orderedCard();
    const stale = await h.call(body({ expectedEditsVersion: 5 }, ORDER_B));
    assertEquals(stale.status, 409);
    assertEquals((await stale.json()).code, 'CARD_CHANGED');
    assertEquals(claimHolder(h), null);

    // Cancelled first order: B is an ordinary first order built from the LIVE card.
    for (const status of ['cancelled', 'failed']) {
      const world = await orderedCard({ firstStatus: status });
      Object.assign(cardOf(world.h), { edits: { letters: { classic: 'The live letter' }, choices: { layout: 'bordered', tone: 'classic' } } });
      assertEquals((await world.h.call(body({}, ORDER_B))).status, 200, status);
      assertEquals((await payAndFulfil(world.h, ORDER_B)).outcome, 'submitted');
      const edits = renderFor(world.h, ORDER_B).edits as { letters: Record<string, string> };
      assertEquals(edits.letters.classic, 'The live letter');
    }
  });
});

Deno.test('a reorder never prints a QR that no longer works: a disabled link is QR_LINK_DISABLED, a blocked film FILM_BLOCKED, a missing film FILM_NOT_READY', async () => {
  await withEnv(async () => {
    const refusals: [string, (h: Harness) => void, string][] = [
      ['token revoked', (h) => { h.db.rows('film_share_tokens')[0].revoked_at = '2026-10-06T10:00:00Z'; }, 'QR_LINK_DISABLED'],
      ['token row gone', (h) => { h.db.tables.set('film_share_tokens', []); }, 'QR_LINK_DISABLED'],
      ['token replaced on the card', (h) => { cardOf(h).share_token = 'ZzZzZzZzZzZzZzZzZzZzZz'; }, 'QR_LINK_DISABLED'],
      ['film detached', (h) => { cardOf(h).film_id = null; }, 'QR_LINK_DISABLED'],
      ['film blocked', (h) => { h.db.rows('year_films')[0].blocked = true; }, 'FILM_BLOCKED'],
      ['film gave up (failed, no video)', (h) => { Object.assign(h.db.rows('year_films')[0], { status: 'failed', video_key: null, ready_at: null }); }, 'FILM_NOT_READY'],
      ['film ended', (h) => { Object.assign(h.db.rows('year_films')[0], { status: 'ended', video_key: null }); }, 'FILM_NOT_READY'],
    ];
    for (const [name, change, code] of refusals) {
      const { h } = await orderedCard();
      change(h);
      const response = await h.call(body({}, ORDER_B));
      assertEquals(response.status, 409, name);
      assertEquals((await response.json()).code, code, name);
      assertEquals(h.world.renderCalls.length, 1, name); // nothing new was rendered
      assertEquals(sessionPosts(h).length, 1, name);
      assertEquals(claimHolder(h), null, name);
      assertEquals(hasOrderClaim(h, ORDER_B), false, name);
      assertEquals(orderOf(h, ORDER_B).status, 'quoted', name);
    }
    // Healthy: same QR, same token.
    const { h, firstRender } = await orderedCard();
    assertEquals((await h.call(body({}, ORDER_B))).status, 200);
    assertEquals((await payAndFulfil(h, ORDER_B)).outcome, 'submitted');
    assertEquals(JSON.stringify((renderFor(h, ORDER_B).card as { qr: unknown }).qr), JSON.stringify((firstRender.card as { qr: unknown }).qr));
    assertEquals((renderFor(h, ORDER_B).card as { qr: { enabled: boolean } }).qr.enabled, true);
  });
});

Deno.test('a reorder of a card that printed NO QR is not affected by the link or the film', async () => {
  await withEnv(async () => {
    const { h } = await orderedCard({ seed: { card: { edits: { choices: { layout: 'bordered', tone: 'classic', qr: false } } } } });
    assertEquals(((orderOf(h).card_snapshot as { card: unknown }).card as { qr: { enabled: boolean } }).qr.enabled, false);
    h.db.rows('film_share_tokens')[0].revoked_at = '2026-10-06T10:00:00Z';
    h.db.rows('year_films')[0].blocked = true;
    assertEquals((await h.call(body({}, ORDER_B))).status, 200);
    assertEquals((await payAndFulfil(h, ORDER_B)).outcome, 'submitted');
    assertEquals((renderFor(h, ORDER_B).card as { qr: { enabled: boolean } }).qr.enabled, false);
  });
});

Deno.test('a reorder whose frozen snapshot is unusable is REORDER_UNAVAILABLE (never a rebuild from live data); claims are given back', async () => {
  await withEnv(async () => {
    const { h } = await orderedCard();
    orderOf(h).card_snapshot = { card: 'garbage' };
    const response = await h.call(body({}, ORDER_B));
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'REORDER_UNAVAILABLE');
    assertEquals(h.world.renderCalls.length, 1);
    assertEquals(claimHolder(h), null);
    assertEquals(hasOrderClaim(h, ORDER_B), false);

    // A database error reading it is a 500, not "unavailable" (the card may be fine).
    const failing = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      dbOptions: { failRead: (table, columns) => table === 'holiday_card_orders' && (columns ?? '').includes('card_snapshot') },
    });
    const blip = await failing.call(body());
    assertEquals(blip.status, 500);
    assertEquals((await blip.json()).code, 'internal_error');
    assertEquals(claimHolder(failing), null);
    assertEquals(failing.world.renderCalls.length, 0);
  });
});

Deno.test('a reorder keeps the whole money path: the order is quoted -> checkout, one new draft, one new session, and the old order is untouched', async () => {
  await withEnv(async () => {
    const { h } = await orderedCard();
    const firstDraft = orderOf(h).gelato_order_id;
    const response = await h.call(body({}, ORDER_B));
    assertEquals(response.status, 200);
    const b = orderOf(h, ORDER_B);
    assertEquals(b.status, 'checkout');
    assertEquals(b.gelato_order_id ?? null, null); // pay first: no draft yet
    assertEquals(draftPosts(h).length, 1);
    assertEquals(new URLSearchParams(sessionPosts(h)[1].body).get('metadata[orderId]'), ORDER_B);
    assertEquals((await payAndFulfil(h, ORDER_B)).outcome, 'submitted');
    assertNotEquals(orderOf(h, ORDER_B).gelato_order_id, firstDraft);
    assertEquals(draftPosts(h).length, 2);
    assertEquals(orderOf(h).status, 'shipped');
    assertEquals(new RegExp(`^print-orders/${ORDER_B}/`).test(String(renderFor(h, ORDER_B).outputPrefix)), true);
  });
});


// ═══ Post-payment pipeline hardening (review round) ═══

/** A fetch that runs `hook(method, path)` before every Gelato call (to simulate another run / a refund landing mid-pipeline). */
function withGelatoHook(h: Harness, hook: (method: string, path: string) => Response | void): typeof fetch {
  return ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'order.gelatoapis.com') {
      const forced = hook(init?.method ?? 'GET', url.pathname.replace(/^\/v4/, ''));
      if (forced) return Promise.resolve(forced);
    }
    return h.world.fetch(input, init);
  }) as typeof fetch;
}

Deno.test('pre-confirm CAS: a refund or a flag that lands between the first read and the PATCH stops the confirm (nothing is PATCHed)', async () => {
  await withEnv(async () => {
    for (const change of [{ refunded_at: '2026-10-06T12:01:00.000Z' }, { failure_reason: 'PARTIAL_REFUND_BEFORE_CONFIRM' }]) {
      const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
      assertEquals((await h.call(body())).status, 200);
      // The draft is created, then (while Stripe and Gelato are still being asked) the order changes.
      const fetch = withGelatoHook(h, (method, path) => {
        if (method === 'POST' && path === '/orders') Object.assign(orderOf(h), change);
      });
      const { outcome } = await payAndFulfil(h, IDS.order, { fetch });
      assertEquals(outcome, 'blocked', JSON.stringify(change));
      assertEquals(patchesOf(h).length, 0);
      assertEquals(orderOf(h).status, 'paid');
    }
  });
});

Deno.test('a draft refused by Gelato while another run already recorded one: the recorded draft is used, the order is not failed', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.gelato.state.orders.set('gel-other001', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
    const fetch = withGelatoHook(h, (method, path) => {
      if (method === 'POST' && path === '/orders') {
        orderOf(h).gelato_order_id = 'gel-other001'; // the other run's draft lands
        return new Response(JSON.stringify({ code: 'duplicate_reference' }), { status: 400 });
      }
    });
    const { outcome } = await payAndFulfil(h, IDS.order, { fetch });
    assertEquals(outcome, 'submitted');
    assertEquals(orderOf(h).gelato_order_id, 'gel-other001');
    assertEquals(patchesOf(h).map((c) => c.path), ['/orders/gel-other001']);
  });
});

Deno.test('a failed draft-id write that actually LANDED keeps the draft the row references (only a draft the row does not hold is deleted)', async () => {
  await withEnv(async () => {
    const landed = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      dbOptions: { failWrite: (table, _op, patch) => table === 'holiday_card_orders' && 'gelato_order_id' in patch && patch.gelato_status === 'draft' ? { code: '08006', applied: true } : false },
    });
    assertEquals((await landed.call(body())).status, 200);
    const { outcome } = await payAndFulfil(landed);
    assertEquals(outcome, 'submitted');
    const draftId = orderOf(landed).gelato_order_id as string;
    assertEquals(landed.world.gelato.state.calls.some((c) => c.method === 'DELETE'), false);
    assertEquals(landed.world.gelato.state.orders.has(draftId), true);

    // The write did NOT land: the orphan draft is deleted and the run is retried.
    const lost = harness(cardWorldSeed({ order: QUOTED_ORDER }), {
      dbOptions: { failWrite: (table, _op, patch) => table === 'holiday_card_orders' && 'gelato_order_id' in patch && patch.gelato_status === 'draft' ? { code: '08006' } : false },
    });
    assertEquals((await lost.call(body())).status, 200);
    assertEquals((await payAndFulfil(lost)).outcome, 'retry');
    assertEquals(lost.world.gelato.state.orders.size, 0);
    assertEquals(orderOf(lost).gelato_order_id ?? null, null);
  });
});

Deno.test('a recorded draft that Gelato lost is cleared and the pipeline rebuilds it on the next run (retry, never failed)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    orderOf(h).gelato_order_id = 'gel-gone0001'; // not at Gelato
    assertEquals((await payAndFulfil(h)).outcome, 'retry');
    assertEquals(orderOf(h).status, 'paid');
    assertEquals(orderOf(h).failure_reason ?? null, null);
    assertEquals(orderOf(h).gelato_order_id ?? null, null);
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'submitted');
    assertEquals(draftPosts(h).length, 1);
    assertNotEquals(orderOf(h).gelato_order_id, 'gel-gone0001');
  });
});

Deno.test('create_checkout keeps a legacy leftover draft only if Gelato still has it AND it is still a draft', async () => {
  await withEnv(async () => {
    const attempts: [string, (h: Harness) => void, boolean][] = [
      ['draft still open', (h) => h.world.gelato.state.orders.set('gel-legacy01', { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] }) && undefined, true],
      ['draft gone (404)', () => undefined, false],
      ['already confirmed', (h) => h.world.gelato.state.orders.set('gel-legacy01', { orderType: 'order', fulfillmentStatus: 'passed', tracking: [] }) && undefined, false],
    ];
    for (const [name, setup, kept] of attempts) {
      const h = harness(cardWorldSeed({ order: QUOTED_ORDER }), { dbOptions: failFinalCasOnce() });
      assertEquals((await h.call(body())).status, 500); // snapshot frozen, Stripe session made, final CAS failed
      const hash = orderOf(h).snapshot_hash as string;
      const files = [{ side: 'both', key: `print-orders/${IDS.order}/${hash.slice(0, 16)}/card.pdf`, sha256: 'c'.repeat(64), bytes: 2000 }];
      Object.assign(orderOf(h), { gelato_order_id: 'gel-legacy01', print_files: { ...(orderOf(h).print_files as Row), files, snapshotHash: hash } });
      setup(h);
      h.clock.ms = START + 60_000;
      assertEquals((await h.call(body())).status, 200, name);
      assertEquals(orderOf(h).gelato_order_id === 'gel-legacy01', kept, name);
    }
  });
});

Deno.test('failPaidOrder never fails a refunded order (the refund path owns it)', async () => {
  const db = new FakeDb({ holiday_card_orders: [{ id: IDS.order, status: 'paid', refunded_at: '2026-10-06T12:00:00.000Z', failure_reason: null }] });
  const deps: FulfillmentDeps = { fetch, sendEmail: async () => 'sent', listKeys: async () => [], deleteKey: async () => undefined, gelatoApiKey: 'k', stripeSecretKey: 's' };
  assertEquals(await failPaidOrder(deps, db.build(), IDS.order, 'X'), false);
  assertEquals(db.row('holiday_card_orders', IDS.order).status, 'paid');
  db.row('holiday_card_orders', IDS.order).refunded_at = null;
  assertEquals(await failPaidOrder(deps, db.build(), IDS.order, 'X'), true);
});

Deno.test('a partial refund holds the order; the owner sets PARTIAL_REFUND_OK and the next run prints it (and keeps printing it after a transient failure)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.stripe.state.paymentIntents.set('pi_test_1', { amount: 4980, amount_refunded: 500 });
    const first = await payAndFulfil(h);
    assertEquals(first.outcome, 'blocked');
    assertEquals(orderOf(h).failure_reason, 'PARTIAL_REFUND_BEFORE_CONFIRM');
    assertEquals(first.mails.some((m) => m.body.includes('PARTIAL_REFUND_OK')), true); // the alert says how to release it
    assertEquals(patchesOf(h).length, 0);
    // Still held on later runs.
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'blocked');

    // The owner acknowledges: the next run proceeds; a transient Gelato failure afterwards does not re-hold it.
    orderOf(h).failure_reason = 'PARTIAL_REFUND_OK';
    h.world.gelato.state.forceStatus.set(`PATCH /orders/${orderOf(h).gelato_order_id}`, 503);
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'retry');
    assertEquals(orderOf(h).failure_reason ?? null, null); // the marker was consumed by the confirm CAS
    assertEquals(typeof (orderOf(h).print_files as { partialRefundAckAt?: string }).partialRefundAckAt, 'string');
    h.world.gelato.state.forceStatus.clear();
    assertEquals((await payAndFulfil(h, IDS.order, { skipPay: true })).outcome, 'submitted');
    assertEquals(orderOf(h).status, 'submitted');
  });
});

Deno.test('a FULL refund is never overridden by PARTIAL_REFUND_OK', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    orderOf(h).failure_reason = 'PARTIAL_REFUND_OK';
    h.world.stripe.state.paymentIntents.set('pi_test_1', { amount: 4980, amount_refunded: 4980 });
    assertEquals((await payAndFulfil(h)).outcome, 'blocked');
    assertEquals(orderOf(h).status, 'cancelled');
    assertEquals(patchesOf(h).length, 0);
  });
});

Deno.test('only a NON-retryable Gelato refusal rejects the draft; our own exceptions (presign, bad input) are retried, never failing a paid order', async () => {
  await withEnv(async () => {
    // A presign that throws while building the draft URLs.
    const presignFails = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await presignFails.call(body())).status, 200);
    let calls = 0;
    const flaky: PrintPipelineDeps['createPresignedGetUrls'] = (keys, ttl) => {
      calls += 1;
      if (calls === 2) throw new TypeError('presign broke'); // 1st call: assets for the render; 2nd: the draft's file urls
      return fakePresign()(keys, ttl);
    };
    assertEquals((await payAndFulfil(presignFails, IDS.order, { presign: flaky })).outcome, 'retry');
    assertEquals(orderOf(presignFails).status, 'paid');
    assertEquals(orderOf(presignFails).failure_reason ?? null, null);

    // An address our own validation refuses inside createDraft (a plain Error, not a Gelato answer).
    const badInput = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await badInput.call(body())).status, 200);
    orderOf(badInput).shipping_address = { ...US_ADDRESS, city: '' };
    assertEquals((await payAndFulfil(badInput)).outcome, 'retry');
    assertEquals(orderOf(badInput).status, 'paid');
    assertEquals(orderOf(badInput).failure_reason ?? null, null);

    // A Gelato 404 on create is not a refusal either; a 400 is.
    const notFound = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await notFound.call(body())).status, 200);
    notFound.world.gelato.state.forceStatus.set('POST /orders', 404);
    assertEquals((await payAndFulfil(notFound)).outcome, 'retry');
  });
});

Deno.test('the pipeline uses the ORDER\'s frozen product (uid, layout, format, currency), not today\'s catalogue', async () => {
  await withEnv(async () => {
    const product = CARD_PRODUCTS.us_ca;
    const original = product.fileLayout;
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200); // freezes file_layout = one_pdf on the row
    orderOf(h).product_uid = 'frozen_product_uid_from_the_quote';
    (product as { fileLayout: string }).fileLayout = 'two_files'; // the catalogue changes after the quote
    try {
      assertEquals((await payAndFulfil(h)).outcome, 'submitted');
    } finally {
      (product as { fileLayout: string }).fileLayout = original;
    }
    assertEquals(h.world.renderCalls[0].body.fileLayout, 'one_pdf');
    assertEquals(h.world.renderCalls[0].body.format, '5R');
    const item = ((draftPosts(h)[0].body as Row).items as Row[])[0];
    assertEquals(item.productUid, 'frozen_product_uid_from_the_quote');
    assertEquals((item.files as Row[]).map((f) => f.type), ['default']);
    // An order row without its frozen product is unusable: failed (not guessed from the catalogue).
    const broken = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await broken.call(body())).status, 200);
    orderOf(broken).product_uid = null;
    assertEquals((await payAndFulfil(broken)).outcome, 'failed');
    assertEquals(orderOf(broken).failure_reason, 'PRINT_PREPARE_ORDER_INCOMPLETE');
  });
});

Deno.test('a photo deleted after payment (render IMAGE_MISSING) fails the order with a clear owner alert: refund or re-pick', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    h.world.setRender(() => new Response(JSON.stringify({ ok: false, code: 'IMAGE_MISSING', message: 'gone' }), { status: 422 }));
    const { outcome, mails } = await payAndFulfil(h);
    assertEquals(outcome, 'failed');
    assertEquals(orderOf(h).failure_reason, 'RENDER_REFUSED:IMAGE_MISSING');
    assertEquals(mails.length, 1);
    assertEquals(mails[0].body.includes('deleted after payment'), true);
    assertEquals(mails[0].body.includes('refund'), true);
  });
});

Deno.test('the render timeout is the pipeline\'s (a hung render service is a retry after the sweep\'s short timeout, not a hang)', async () => {
  await withEnv(async () => {
    const h = harness(cardWorldSeed({ order: QUOTED_ORDER }));
    assertEquals((await h.call(body())).status, 200);
    const hanging = ((input: Request | URL | string, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'render.test') {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return h.world.fetch(input, init);
    }) as typeof fetch;
    const started = Date.now();
    assertEquals((await payAndFulfil(h, IDS.order, { fetch: hanging, renderTimeoutMs: 30 })).outcome, 'retry');
    assertEquals(Date.now() - started < 5000, true);
    assertEquals(orderOf(h).status, 'paid');
  });
});
