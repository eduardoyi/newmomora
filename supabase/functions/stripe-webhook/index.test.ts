import { assertEquals } from 'jsr:@std/assert@1';
import { handleStripeWebhook, productRouteOf } from './index.ts';
import { defaultRenderResponse, FakeDb, fakePresign, FROZEN_HASH, IDS, makeGelatoFake, makeR2Fake, makeRenderFake, makeStripeFake, PAY_FIRST_COLUMNS, US_ADDRESS } from '../_shared/holiday-card-orders.test-support.ts';
import { confirmPaidOrder, type FulfillmentDeps } from '../_shared/holiday-card-fulfillment.ts';

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';

const QUOTED_ADDRESS = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Engine Way',
  city: 'London',
  postalCode: 'SW1A 1AA',
  countryCode: 'GB',
};

/** Same CAS-aware multi-table stub as memory-book-orders/index.test.ts,
 * extended with `.is()` (for the refunded_at-is-null guard) -- see that
 * file's own comment for the design rationale. */
function createStubClient(seed: Record<string, Record<string, unknown>[]>) {
  const tables = new Map(
    Object.entries(seed).map(([table, rows]) => [table, new Map(rows.map((row) => [row.id as string, { ...row }]))]),
  );
  return () => ({
    from(table: string) {
      const rowsById = tables.get(table) ?? new Map();
      const filters: Array<[string, unknown]> = [];
      let pendingPatch: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
        is: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
        update: (patch: Record<string, unknown>) => { pendingPatch = patch; return chain; },
        maybeSingle: async () => {
          const matches = [...rowsById.values()].filter((row) => filters.every(([c, v]) => (row[c] ?? null) === v));
          if (pendingPatch) {
            if (matches.length === 0) return { data: null, error: null };
            for (const match of matches) Object.assign(match, pendingPatch);
            return { data: { id: matches[0].id }, error: null };
          }
          return { data: matches[0] ?? null, error: null };
        },
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
          const matches = [...rowsById.values()].filter((row) => filters.every(([c, v]) => (row[c] ?? null) === v));
          if (pendingPatch) {
            for (const match of matches) Object.assign(match, pendingPatch);
          }
          resolve({ data: matches, error: null });
        },
      };
      return chain;
    },
  }) as never;
}

function fakeEvent(type: string, object: Record<string, unknown>, id = 'evt_1') {
  return { id, type, data: { object } };
}

function requestFor(body: unknown): Request {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body), headers: { 'stripe-signature': 't=1,v1=fake' } });
}

async function withWebhookSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  Deno.env.set('STRIPE_WEBHOOK_SECRET', 'whsec_test');
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete('STRIPE_WEBHOOK_SECRET'); else Deno.env.set('STRIPE_WEBHOOK_SECRET', previous);
  }
}

async function withDispatchEnv<T>(run: () => Promise<T>): Promise<T> {
  const urlEnv = 'CLOUDFLARE_MEMORY_BOOK_ORDER_WORKFLOW_URL';
  const secretEnv = 'CLOUDFLARE_MEMORY_BOOK_ORDER_DISPATCH_SECRET';
  const previousUrl = Deno.env.get(urlEnv);
  const previousSecret = Deno.env.get(secretEnv);
  Deno.env.set(urlEnv, 'https://order-worker.test/dispatch');
  Deno.env.set(secretEnv, 'dispatch-secret');
  try {
    return await run();
  } finally {
    if (previousUrl === undefined) Deno.env.delete(urlEnv); else Deno.env.set(urlEnv, previousUrl);
    if (previousSecret === undefined) Deno.env.delete(secretEnv); else Deno.env.set(secretEnv, previousSecret);
  }
}

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    book_id: BOOK_ID,
    family_id: FAMILY_ID,
    status: 'quoted',
    price_cents: 4999,
    shipping_cost_cents: 1234,
    shipping_address: QUOTED_ADDRESS,
    stripe_payment_intent_id: null,
    workflow_attempt_id: null,
    ...overrides,
  };
}

function bookWithResolvableAssets() {
  return {
    id: BOOK_ID,
    family_id: FAMILY_ID,
    book_document: {
      outline: {},
      manifest: {
        memories: {
          'mem-1': {
            assets: [{ file: 'preview.jpg', originalFile: 'raw.jpg', kind: 'photo', width: 100, height: 100, aspectRatio: 1, durationMs: null }],
          },
        },
      },
    },
  };
}

Deno.test('rejects a request with no valid Stripe signature', async () => {
  await withWebhookSecret(async () => {
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: createStubClient({}),
      verifyStripeSignature: async () => null,
    });
    assertEquals(response.status, 401);
  });
});

Deno.test('ignores an unhandled event type', async () => {
  await withWebhookSecret(async () => {
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: createStubClient({}),
      verifyStripeSignature: async () => fakeEvent('customer.created', {}),
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).ignored, true);
  });
});

Deno.test('checkout.session.completed is idempotent on replay once already paid', async () => {
  await withWebhookSecret(async () => {
    const client = createStubClient({ memory_book_orders: [baseOrder({ status: 'paid' })] });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('checkout.session.completed', { metadata: { orderId: ORDER_ID }, amount_subtotal: 6233 }),
    });
    assertEquals(response.status, 200);
    assertEquals((await response.json()).alreadyHandled, true);
  });
});

Deno.test('checkout.session.completed refuses on an amount mismatch and does not transition the order', async () => {
  await withWebhookSecret(async () => {
    const client = createStubClient({
      memory_book_orders: [baseOrder()],
      memory_books: [bookWithResolvableAssets()],
    });
    const alerts: Array<{ to: string; subject: string }> = [];
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('checkout.session.completed', {
        metadata: { orderId: ORDER_ID },
        amount_subtotal: 999999,
        customer_details: { address: { line1: QUOTED_ADDRESS.line1, postal_code: QUOTED_ADDRESS.postalCode, country: QUOTED_ADDRESS.countryCode } },
      }),
      sendEmail: async (input) => { alerts.push(input); return 'sent'; },
    });
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.refused, 'amount_mismatch');
    assertEquals(alerts.length, 1);
    assertEquals(alerts[0]?.subject.includes('AMOUNT_MISMATCH'), true);
  });
});

Deno.test('checkout.session.completed refuses on an address mismatch', async () => {
  await withWebhookSecret(async () => {
    const client = createStubClient({
      memory_book_orders: [baseOrder()],
      memory_books: [bookWithResolvableAssets()],
    });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('checkout.session.completed', {
        metadata: { orderId: ORDER_ID },
        amount_subtotal: 6233,
        customer_details: { address: { line1: 'A different street', postal_code: '00000', country: 'US' } },
      }),
      fetch: async () => new Response('{"results":1}', { status: 200 }),
    });
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.refused, 'address_mismatch');
  });
});

Deno.test('checkout.session.completed CASes quoted -> paid -> rendering and dispatches the order workflow', async () => {
  await withWebhookSecret(async () => {
    await withDispatchEnv(async () => {
      const client = createStubClient({
        memory_book_orders: [baseOrder()],
        memory_books: [bookWithResolvableAssets()],
        memory_book_edits: [],
      });
      const dispatchedBodies: unknown[] = [];
      const response = await handleStripeWebhook(requestFor({}), {
        createServiceClient: client,
        verifyStripeSignature: async () => fakeEvent('checkout.session.completed', {
          metadata: { orderId: ORDER_ID },
          amount_subtotal: 6233,
          payment_intent: 'pi_123',
          customer_details: { address: { line1: QUOTED_ADDRESS.line1, postal_code: QUOTED_ADDRESS.postalCode, country: QUOTED_ADDRESS.countryCode } },
        }),
        fetch: async (url, init) => {
          if (String(url).includes('order-worker.test')) { dispatchedBodies.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 202 }); }
          return new Response('{"results":1}', { status: 200 });
        },
      });
      const body = await response.json();
      assertEquals(response.status, 200);
      assertEquals(body.status, 'rendering');
      assertEquals(dispatchedBodies.length, 1);
      assertEquals((dispatchedBodies[0] as { orderId: string }).orderId, ORDER_ID);
    });
  });
});

Deno.test('checkout.session.completed refuses and marks the order failed when originalFile cannot be resolved', async () => {
  await withWebhookSecret(async () => {
    const unresolvedBook = {
      id: BOOK_ID,
      family_id: FAMILY_ID,
      book_document: {
        outline: {},
        manifest: { memories: { 'mem-1': { assets: [{ file: 'unknown.jpg', kind: 'photo', width: 100, height: 100, aspectRatio: 1, durationMs: null }] } } },
      },
    };
    const client = createStubClient({
      memory_book_orders: [baseOrder()],
      memory_books: [unresolvedBook],
      memory_book_edits: [],
      memory_media: [],
    });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('checkout.session.completed', {
        metadata: { orderId: ORDER_ID },
        amount_subtotal: 6233,
        payment_intent: 'pi_123',
        customer_details: { address: { line1: QUOTED_ADDRESS.line1, postal_code: QUOTED_ADDRESS.postalCode, country: QUOTED_ADDRESS.countryCode } },
      }),
      fetch: async () => new Response('{"results":1}', { status: 200 }),
    });
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.refused, 'original_file_unresolved');
  });
});

Deno.test('charge.refunded sets refunded_at without changing status', async () => {
  await withWebhookSecret(async () => {
    const client = createStubClient({
      memory_book_orders: [baseOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_123', refunded_at: null })],
    });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('charge.refunded', { payment_intent: 'pi_123' }),
    });
    assertEquals(response.status, 200);
  });
});

Deno.test('checkout.session.expired CASes an abandoned quoted order to cancelled', async () => {
  await withWebhookSecret(async () => {
    const client = createStubClient({ memory_book_orders: [baseOrder({ status: 'quoted' })] });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: client,
      verifyStripeSignature: async () => fakeEvent('checkout.session.expired', { metadata: { orderId: ORDER_ID } }),
    });
    assertEquals(response.status, 200);
  });
});

// ── Routing: legacy book sessions vs holiday-card sessions ───────────────

Deno.test('productRouteOf: absent productType is a book, holiday_card is a card, anything else is unknown', () => {
  const route = (metadata: unknown) => productRouteOf(fakeEvent('checkout.session.completed', { metadata }) as never);
  assertEquals(route({ orderId: 'x' }), 'book');
  assertEquals(route(undefined), 'book');
  assertEquals(route({ orderId: 'x', productType: '' }), 'book');
  assertEquals(route({ orderId: 'x', productType: 'holiday_card' }), 'holiday_card');
  assertEquals(route({ orderId: 'x', productType: 'poster' }), 'unknown');
});

Deno.test('a legacy book session WITHOUT productType still takes the book path and never touches a card order with the same id', async () => {
  await withWebhookSecret(async () => {
    await withDispatchEnv(async () => {
      const db = new FakeDb({
        memory_book_orders: [baseOrder()],
        memory_books: [bookWithResolvableAssets()],
        memory_book_edits: [],
        holiday_card_orders: [cardOrder({ id: ORDER_ID })],
      });
      const gelato = makeGelatoFake();
      const dispatched: unknown[] = [];
      const response = await handleStripeWebhook(requestFor({}), {
        createServiceClient: db.client(),
        verifyStripeSignature: async () => fakeEvent('checkout.session.completed', {
          metadata: { orderId: ORDER_ID },
          amount_subtotal: 6233,
          payment_intent: 'pi_book',
          customer_details: { address: { line1: QUOTED_ADDRESS.line1, postal_code: QUOTED_ADDRESS.postalCode, country: QUOTED_ADDRESS.countryCode } },
        }),
        fetch: async (url, init) => {
          if (String(url).includes('order-worker.test')) { dispatched.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 202 }); }
          if (String(url).includes('gelato')) return gelato.fetch(url, init);
          return new Response('{"results":1}', { status: 200 });
        },
      });
      assertEquals((await response.json()).status, 'rendering');
      assertEquals(dispatched.length, 1);
      assertEquals(db.row('memory_book_orders', ORDER_ID).status, 'rendering');
      assertEquals(db.row('holiday_card_orders', ORDER_ID).status, 'checkout');
      assertEquals(gelato.state.calls.length, 0);
    });
  });
});

Deno.test('a legacy book session WITHOUT productType expires on the book path', async () => {
  await withWebhookSecret(async () => {
    const db = new FakeDb({ memory_book_orders: [baseOrder()], holiday_card_orders: [cardOrder({ id: ORDER_ID })] });
    const response = await handleStripeWebhook(requestFor({}), {
      createServiceClient: db.client(),
      verifyStripeSignature: async () => fakeEvent('checkout.session.expired', { id: 'cs_test_000001', metadata: { orderId: ORDER_ID } }),
    });
    assertEquals(response.status, 200);
    assertEquals(db.row('memory_book_orders', ORDER_ID).status, 'cancelled');
    assertEquals(db.row('holiday_card_orders', ORDER_ID).status, 'checkout');
  });
});

Deno.test('a session with an unknown productType is ignored by every handler', async () => {
  await withWebhookSecret(async () => {
    const db = new FakeDb({ memory_book_orders: [baseOrder()], holiday_card_orders: [cardOrder({ id: ORDER_ID })] });
    for (const type of ['checkout.session.completed', 'checkout.session.expired']) {
      const response = await handleStripeWebhook(requestFor({}), {
        createServiceClient: db.client(),
        verifyStripeSignature: async () => fakeEvent(type, { id: 'cs_test_000001', metadata: { orderId: ORDER_ID, productType: 'poster' } }),
      });
      assertEquals((await response.json()).ignored, true);
    }
    assertEquals(db.log.length, 0);
  });
});

// ── Holiday card orders ──────────────────────────────────────────────────

const SESSION_ID = 'cs_test_000001';
const GELATO_DRAFT = 'gel-draft001';

function cardOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.order,
    card_id: IDS.card,
    family_id: IDS.family,
    requested_by: IDS.user,
    status: 'checkout',
    packs: 2,
    price_cents: 4980,
    currency: 'USD',
    shipping_address: US_ADDRESS,
    snapshot_hash: 'hash1',
    stripe_session_id: SESSION_ID,
    stripe_payment_intent_id: null,
    gelato_order_id: GELATO_DRAFT,
    gelato_status: 'created',
    refunded_at: null,
    failure_reason: null,
    print_files: { files: [{ side: 'front', key: `print-orders/${IDS.order}/front.pdf`, sha256: 'a'.repeat(64), bytes: 10 }] },
    updated_at: '2026-10-06T08:00:00.000Z',
    ...overrides,
  };
}

function cardSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    metadata: { productType: 'holiday_card', orderId: IDS.order, snapshotHash: 'hash1' },
    amount_subtotal: 4980,
    currency: 'usd',
    payment_status: 'paid',
    payment_intent: 'pi_card_1',
    customer_details: { address: { line1: US_ADDRESS.line1, postal_code: US_ADDRESS.postalCode, country: US_ADDRESS.countryCode } },
    ...overrides,
  };
}

interface CardRig {
  db: FakeDb;
  render: ReturnType<typeof makeRenderFake>;
  gelato: ReturnType<typeof makeGelatoFake>;
  stripe: ReturnType<typeof makeStripeFake>;
  r2: ReturnType<typeof makeR2Fake>;
  tasks: Promise<void>[];
  mails: { to: string; subject: string }[];
  send: (event: ReturnType<typeof fakeEvent>) => Promise<Response>;
  settle: () => Promise<void>;
}

function cardRig(seedOrder: Record<string, unknown> | null = cardOrder(), extra: Record<string, Record<string, unknown>[]> = {}): CardRig {
  const db = new FakeDb({ holiday_card_orders: seedOrder ? [seedOrder] : [], memory_book_orders: [], ...extra });
  db.users.set(IDS.user, { email: 'buyer@example.com' });
  const gelato = makeGelatoFake();
  gelato.state.orders.set(GELATO_DRAFT, { orderType: 'draft', fulfillmentStatus: 'created', tracking: [] });
  const stripe = makeStripeFake();
  const render = makeRenderFake();
  const routed = ((input: Request | URL | string, init?: RequestInit) => {
    const host = new URL(String(input)).hostname;
    if (host === 'api.stripe.com') return stripe.fetch(input, init);
    if (host === 'render.test') return render.fetchRender(init);
    return gelato.fetch(input, init);
  }) as typeof fetch;
  const r2 = makeR2Fake([`print-orders/${IDS.order}/front.pdf`, `print-orders/${IDS.order}/back.pdf`]);
  const tasks: Promise<void>[] = [];
  const mails: { to: string; subject: string }[] = [];
  return {
    db, render, gelato, stripe, r2, tasks, mails,
    send: (event) => handleStripeWebhook(requestFor({}), {
      createServiceClient: db.client(),
      verifyStripeSignature: async () => event,
      fetch: routed,
      sendEmail: async (input) => { mails.push({ to: input.to, subject: input.subject }); return 'sent'; },
      waitUntil: (task) => { tasks.push(task); },
      listKeys: r2.listKeys,
      deleteKey: r2.deleteKey,
      createPresignedGetUrls: fakePresign(),
      headObject: render.headObject,
    }),
    settle: async () => { await Promise.all(tasks); },
  };
}

async function withGelatoEnv<T>(run: () => Promise<T>): Promise<T> {
  const names = ['GELATO_API_KEY', 'STRIPE_SECRET_KEY', 'MEMORY_BOOK_RENDER_WORKER_URL', 'MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET'];
  const previous = new Map(names.map((n) => [n, Deno.env.get(n)]));
  Deno.env.set('GELATO_API_KEY', 'gelato-test-key');
  Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_x');
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_URL', 'https://render.test');
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET', 'render-secret');
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value);
  }
}

const patches = (rig: CardRig) => rig.gelato.state.calls.filter((c) => c.method === 'PATCH');

Deno.test('card checkout.session.completed: checkout -> paid, then the draft is confirmed ONCE and the order is submitted + emailed', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    const response = await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals(response.status, 200);
    assertEquals((await response.json()).status, 'paid');
    // Paid is recorded before any background work runs.
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).stripe_payment_intent_id, 'pi_card_1');
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'submitted');
    assertEquals(row.gelato_status, 'pending');
    assertEquals(patches(rig).length, 1);
    assertEquals(patches(rig)[0].path, `/orders/${GELATO_DRAFT}`);
    assertEquals(patches(rig)[0].body, { orderType: 'order' });
    assertEquals(rig.mails.filter((m) => m.to === 'buyer@example.com').length, 1);
  }));
});

Deno.test('card completed replay is idempotent: no second confirm, no second email', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    const replay = await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals((await replay.json()).alreadyHandled, true);
    await rig.settle();
    assertEquals(patches(rig).length, 1);
    assertEquals(rig.mails.length, 1);
  }));
});

Deno.test('card confirm only PATCHes while Gelato still reports a draft', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    // Already confirmed at Gelato (e.g. a previous attempt's PATCH landed but the CAS did not).
    rig.gelato.state.orders.set(GELATO_DRAFT, { orderType: 'order', fulfillmentStatus: 'passed', tracking: [] });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'submitted');
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).gelato_status, 'passed');
  }));
});

for (
  const [name, override, reason] of [
    ['amount', { amount_subtotal: 4000 }, 'PAYMENT_MISMATCH_AMOUNT'],
    ['currency', { currency: 'cad' }, 'PAYMENT_MISMATCH_CURRENCY'],
    ['address', { customer_details: { address: { line1: 'Somewhere else', postal_code: '00000', country: 'US' } } }, 'PAYMENT_MISMATCH_ADDRESS'],
    ['missing address', { customer_details: {} }, 'PAYMENT_MISMATCH_ADDRESS'],
    ['snapshot hash', { metadata: { productType: 'holiday_card', orderId: IDS.order, snapshotHash: 'tampered' } }, 'PAYMENT_MISMATCH_SNAPSHOT'],
    ['session id', { id: 'cs_test_999999' }, 'PAYMENT_MISMATCH_SESSION'],
    ['payment status', { payment_status: 'unpaid' }, 'PAYMENT_NOT_PAID'],
  ] as [string, Record<string, unknown>, string][]
) {
  Deno.test(`card completed with a ${name} mismatch: recorded paid, flagged, NOT confirmed, owner alerted`, async () => {
    await withWebhookSecret(() => withGelatoEnv(async () => {
      const rig = cardRig();
      const response = await rig.send(fakeEvent('checkout.session.completed', cardSession(override)));
      assertEquals(response.status, 200);
      assertEquals(typeof (await response.json()).refused, 'string');
      await rig.settle();
      const row = rig.db.row('holiday_card_orders', IDS.order);
      assertEquals(row.status, 'paid');
      assertEquals(row.failure_reason, reason);
      assertEquals(row.stripe_payment_intent_id, 'pi_card_1');
      assertEquals(rig.gelato.state.calls.length, 0);
      assertEquals(rig.mails.length, 1);
      assertEquals(rig.mails[0].subject.includes(reason), true);
      assertEquals(rig.mails[0].to.includes('buyer'), false);
    }));
  });
}

Deno.test('card payment for an order that is not in checkout (cancelled) alerts the owner and changes nothing', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'cancelled' }));
    const response = await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals((await response.json()).refused, 'order_not_in_checkout');
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'cancelled');
    assertEquals(rig.mails[0].subject.includes('PAID_ORDER_NOT_FULFILLABLE'), true);
    assertEquals(rig.gelato.state.calls.length, 0);
  }));
});

Deno.test('card confirm is skipped when the order was refunded before the confirm ran', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ refunded_at: '2026-10-06T09:00:00.000Z' }));
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(rig.gelato.state.calls.length, 0);
  }));
});

Deno.test('card confirm leaves the order paid for the sweep when Gelato is down', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.gelato.state.forceStatus.set(`GET /orders/${GELATO_DRAFT}`, 503);
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(rig.mails.length, 0);
  }));
});

Deno.test('card confirm: a recorded draft that Gelato lost is forgotten and the order retried (never failed): the pipeline rebuilds it', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.gelato.state.orders.clear();
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, null);
    assertEquals(row.gelato_order_id, null);
    assertEquals(rig.mails.length, 0);
  }));
});

Deno.test('card checkout.session.expired cancels the order and deletes the Gelato draft and the print files', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    const response = await rig.send(fakeEvent('checkout.session.expired', { id: SESSION_ID, metadata: { productType: 'holiday_card', orderId: IDS.order } }));
    assertEquals(response.status, 200);
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'cancelled');
    assertEquals(row.gelato_order_id, null);
    assertEquals(typeof (row.print_files as { purgedAt?: string }).purgedAt, 'string'); // marker: purged again >= 1 h later
    assertEquals(rig.gelato.state.orders.size, 0);
    assertEquals(rig.r2.keys.size, 0);
  }));
});

Deno.test('card expiry from a session that is not the order\'s own does nothing, and never cancels a paid order', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    await rig.send(fakeEvent('checkout.session.expired', { id: 'cs_test_other', metadata: { productType: 'holiday_card', orderId: IDS.order } }));
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'checkout');
    const paid = cardRig(cardOrder({ status: 'paid' }));
    await paid.send(fakeEvent('checkout.session.expired', { id: SESSION_ID, metadata: { productType: 'holiday_card', orderId: IDS.order } }));
    await paid.settle();
    assertEquals(paid.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(paid.gelato.state.calls.length, 0);
  }));
});

// ── charge.refunded: both tables ─────────────────────────────────────────

Deno.test('charge.refunded finds the payment intent in the BOOK table (unchanged) and ignores card orders', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_card_1' }), {
      memory_book_orders: [baseOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_book_1', refunded_at: null })],
    });
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_book_1' }));
    assertEquals(typeof rig.db.row('memory_book_orders', ORDER_ID).refunded_at, 'string');
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).refunded_at, null);
  }));
});

Deno.test('charge.refunded finds the payment intent in the CARD table', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_card_1' }), {
      memory_book_orders: [baseOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_book_1', refunded_at: null })],
    });
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    assertEquals(typeof rig.db.row('holiday_card_orders', IDS.order).refunded_at, 'string');
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'shipped'); // nothing to cancel
    assertEquals(rig.db.row('memory_book_orders', ORDER_ID).refunded_at ?? null, null);
    assertEquals(rig.gelato.state.calls.length, 0);
  }));
});

Deno.test('a full refund of a paid, not yet confirmed order deletes the draft and cancels it: it is never produced', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1' }));
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true, amount: 4980, amount_refunded: 4980 }));
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'cancelled');
    assertEquals(typeof row.refunded_at, 'string');
    assertEquals(rig.gelato.state.orders.size, 0);
    assertEquals(patches(rig).length, 0);
  }));
});

Deno.test('a full refund of a confirmed order cancels it at Gelato', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'submitted', stripe_payment_intent_id: 'pi_card_1' }));
    rig.gelato.state.orders.set(GELATO_DRAFT, { orderType: 'order', fulfillmentStatus: 'pending', tracking: [] });
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    assertEquals(rig.gelato.state.calls.some((c) => c.method === 'POST' && c.path === `/orders/${GELATO_DRAFT}:cancel`), true);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'cancelled');
  }));
});

Deno.test('a refund that Gelato cannot cancel (already in production) alerts the owner and keeps the status', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'in_production', stripe_payment_intent_id: 'pi_card_1' }));
    rig.gelato.state.orders.set(GELATO_DRAFT, { orderType: 'order', fulfillmentStatus: 'in_production', tracking: [] });
    rig.gelato.state.forceStatus.set(`POST /orders/${GELATO_DRAFT}:cancel`, 400);
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'in_production');
    assertEquals(typeof rig.db.row('holiday_card_orders', IDS.order).refunded_at, 'string');
    assertEquals(rig.mails[0].subject.includes('REFUND_NOT_CANCELLED'), true);
  }));
});

Deno.test('a PARTIAL refund of a card order changes nothing', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'submitted', stripe_payment_intent_id: 'pi_card_1' }));
    const response = await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: false, amount: 4980, amount_refunded: 500 }));
    assertEquals((await response.json()).partialRefund, true);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).refunded_at, null);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'submitted');
    assertEquals(rig.gelato.state.calls.length, 0);
  }));
});

// ── Out-of-order refunds, concurrent confirms, refund fallbacks ──────────

Deno.test('a payment refunded BEFORE the confirm ran is never produced: refunded_at, draft deleted, cancelled, owner alerted', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.stripe.state.paymentIntents.set('pi_card_1', { amount: 4980, amount_refunded: 4980 });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'cancelled');
    assertEquals(typeof row.refunded_at, 'string');
    assertEquals(rig.gelato.state.orders.size, 0);
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.mails.filter((m) => m.subject.includes('REFUNDED_BEFORE_CONFIRM')).length, 1);
    assertEquals(rig.mails.some((m) => m.to === 'buyer@example.com'), false);
  }));
});

Deno.test('a PARTIALLY refunded payment is held before the confirm (flagged, alerted, not printed, not cancelled)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.stripe.state.paymentIntents.set('pi_card_1', { amount: 4980, amount_refunded: 500 });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, 'PARTIAL_REFUND_BEFORE_CONFIRM');
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.gelato.state.orders.size, 1);
    assertEquals(rig.mails.filter((m) => m.subject.includes('PARTIAL_REFUND_BEFORE_CONFIRM')).length, 1);
  }));
});

Deno.test('when Stripe cannot be asked about refunds the confirm fails closed (stays paid, nothing PATCHed)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.stripe.state.paymentIntentStatus = 503;
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(patches(rig).length, 0);
  }));
});

Deno.test('concurrent confirm: a rejected PATCH is success when Gelato says the order is no longer a draft (never failed)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.gelato.state.patchConfirmsThenFails = true;
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'submitted');
    assertEquals(row.failure_reason, null);
    assertEquals(row.gelato_status, 'pending');
  }));
});

Deno.test('a PATCH rejected while the order is STILL a draft does fail the order', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig();
    rig.gelato.state.forceStatus.set(`PATCH /orders/${GELATO_DRAFT}`, 400);
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'failed');
  }));
});

Deno.test('a refund that beat the paid event is found through the payment intent metadata, recorded, and the later paid event is never confirmed', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'checkout' }), {
      memory_book_orders: [baseOrder({ status: 'shipped', stripe_payment_intent_id: 'pi_other', refunded_at: null })],
    });
    await rig.send(fakeEvent('charge.refunded', {
      payment_intent: 'pi_card_1',
      refunded: true,
      metadata: { productType: 'holiday_card', orderId: IDS.order },
    }));
    const marked = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(typeof marked.refunded_at, 'string');
    assertEquals(marked.stripe_payment_intent_id, 'pi_card_1');
    assertEquals(marked.status, 'checkout');

    // Now the (late) paid event: recorded as paid, but the refund blocks the confirm.
    rig.stripe.state.paymentIntents.set('pi_card_1', { amount: 4980, amount_refunded: 4980 });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(rig.db.row('memory_book_orders', ORDER_ID).refunded_at ?? null, null);
  }));
});

Deno.test('the metadata fallback only applies to holiday_card charges and ignores unknown orders', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'checkout' }));
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true, metadata: { orderId: IDS.order } }));
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).refunded_at, null);
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true, metadata: { productType: 'holiday_card', orderId: '00000000-0000-4000-8000-000000000000' } }));
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).refunded_at, null);
  }));
});

Deno.test('a refund while Gelato is unreachable records refunded_at and leaves the finishing to the sweep (no alert yet)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'submitted', stripe_payment_intent_id: 'pi_card_1' }));
    rig.gelato.state.forceStatus.set(`GET /orders/${GELATO_DRAFT}`, 503);
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(typeof row.refunded_at, 'string');
    assertEquals(row.status, 'submitted');
    assertEquals(rig.mails.length, 0);
  }));
});


// ── Card-level checkout claim: released when the order leaves `checkout` ──

const CLAIMED_CARD = { id: IDS.card, checkout_order_id: IDS.order, checkout_claimed_at: '2026-10-06T08:05:00.000Z' };
const claimOf = (rig: CardRig) => rig.db.row('holiday_cards', IDS.card).checkout_order_id;

Deno.test('card paid: the card claim is released with the paid CAS (also when the payment mismatches), and another order\'s claim is never touched', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const ok = cardRig(cardOrder(), { holiday_cards: [{ ...CLAIMED_CARD }] });
    await ok.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals(claimOf(ok), null);
    assertEquals(ok.db.row('holiday_cards', IDS.card).checkout_claimed_at, null);
    assertEquals(ok.db.rpcCalls.filter((c) => c.name === 'release_holiday_card_checkout').length, 1);

    const mismatch = cardRig(cardOrder(), { holiday_cards: [{ ...CLAIMED_CARD }] });
    await mismatch.send(fakeEvent('checkout.session.completed', cardSession({ amount_subtotal: 100 })));
    assertEquals(mismatch.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(claimOf(mismatch), null);

    const other = cardRig(cardOrder(), { holiday_cards: [{ ...CLAIMED_CARD, checkout_order_id: '99999999-0000-4000-8000-000000000001' }] });
    await other.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals(claimOf(other), '99999999-0000-4000-8000-000000000001');
  }));
});

Deno.test('card paid replay or an order not in checkout does not release anything', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'cancelled' }), { holiday_cards: [{ ...CLAIMED_CARD }] });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals(rig.db.rpcCalls.filter((c) => c.name === 'release_holiday_card_checkout').length, 0);
    assertEquals(claimOf(rig), IDS.order);
  }));
});

Deno.test('card checkout.session.expired releases the card claim; an expiry from another session does not', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder(), { holiday_cards: [{ ...CLAIMED_CARD }] });
    await rig.send(fakeEvent('checkout.session.expired', { id: 'cs_test_other', metadata: { productType: 'holiday_card', orderId: IDS.order } }));
    assertEquals(claimOf(rig), IDS.order);
    await rig.send(fakeEvent('checkout.session.expired', { id: SESSION_ID, metadata: { productType: 'holiday_card', orderId: IDS.order } }));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'cancelled');
    assertEquals(claimOf(rig), null);
  }));
});

Deno.test('a full refund that cancels an order releases the card claim', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1' }), { holiday_cards: [{ ...CLAIMED_CARD }] });
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'cancelled');
    assertEquals(claimOf(rig), null);
  }));
});

// ── Held canary ──────────────────────────────────────────────────────────

const HOLD = { holiday_card_settings: [{ id: true, mode: 'canary', orders_enabled: true, hold_confirm_family_ids: [IDS.family], canary_family_ids: [IDS.family] }] };
const HELD_ORDER = () => cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1' });
const heldMails = (rig: CardRig) => rig.mails.filter((m) => m.subject.includes('HELD_FOR_CANARY'));

Deno.test('held canary: a paid order of a listed family is flagged HELD_FOR_CANARY, alerted once, and NEVER touches Stripe or Gelato', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder(), { ...HOLD, holiday_cards: [{ ...CLAIMED_CARD }] });
    const response = await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    assertEquals(response.status, 200);
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, 'HELD_FOR_CANARY');
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.gelato.state.calls.length, 0); // not even a GET
    assertEquals(rig.stripe.state.calls.length, 0); // no refund check either: the hold is first
    assertEquals(heldMails(rig).length, 1);
    assertEquals(rig.mails.some((m) => m.to === 'buyer@example.com'), false); // no confirmation email
    assertEquals(claimOf(rig), null); // paid -> the card claim is released as usual
    assertEquals(rig.gelato.state.orders.size, 1); // the draft is kept for inspection
  }));
});

Deno.test('held canary: webhook and sweep racing on the same order produce exactly one alert and zero PATCHes', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(HELD_ORDER(), HOLD);
    const deps: FulfillmentDeps = {
      fetch: ((input: Request | URL | string, init?: RequestInit) =>
        new URL(String(input)).hostname === 'api.stripe.com' ? rig.stripe.fetch(input, init) : rig.gelato.fetch(input, init)) as typeof fetch,
      sendEmail: async (input) => { rig.mails.push({ to: input.to, subject: input.subject }); return 'sent'; },
      listKeys: rig.r2.listKeys,
      deleteKey: rig.r2.deleteKey,
      gelatoApiKey: 'gelato-test-key',
      stripeSecretKey: 'sk_test_x',
    };
    const outcomes = await Promise.all([
      confirmPaidOrder(deps, rig.db.build(), IDS.order),
      confirmPaidOrder(deps, rig.db.build(), IDS.order),
      confirmPaidOrder(deps, rig.db.build(), IDS.order),
    ]);
    assertEquals(outcomes, ['blocked', 'blocked', 'blocked']);
    assertEquals(heldMails(rig).length, 1);
    assertEquals(patches(rig).length, 0);
    assertEquals(rig.gelato.state.calls.length, 0);
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).failure_reason, 'HELD_FOR_CANARY');
    // Later calls (the sweep tick) see the flag and stay quiet.
    assertEquals(await confirmPaidOrder(deps, rig.db.build(), IDS.order), 'blocked');
    assertEquals(heldMails(rig).length, 1);
  }));
});

Deno.test('held canary fails closed: an unreadable hold list (error or no answer) is a retry, never a PATCH', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const errored = cardRig(HELD_ORDER(), HOLD);
    errored.db.rpcFailures.set('holiday_card_hold_confirm', { message: 'boom', code: 'XX000' });
    const deps = (rig: CardRig): FulfillmentDeps => ({
      fetch: ((input: Request | URL | string, init?: RequestInit) =>
        new URL(String(input)).hostname === 'api.stripe.com' ? rig.stripe.fetch(input, init) : rig.gelato.fetch(input, init)) as typeof fetch,
      sendEmail: async () => 'sent',
      listKeys: rig.r2.listKeys,
      deleteKey: rig.r2.deleteKey,
      gelatoApiKey: 'gelato-test-key',
      stripeSecretKey: 'sk_test_x',
    });
    assertEquals(await confirmPaidOrder(deps(errored), errored.db.build(), IDS.order), 'retry');
    assertEquals(errored.gelato.state.calls.length, 0);
    assertEquals(errored.stripe.state.calls.length, 0);
    assertEquals(errored.db.row('holiday_card_orders', IDS.order).failure_reason, null);
    assertEquals(errored.db.row('holiday_card_orders', IDS.order).status, 'paid');

    const silent = cardRig(HELD_ORDER(), HOLD);
    silent.db.rpcHandlers.set('holiday_card_hold_confirm', () => null);
    assertEquals(await confirmPaidOrder(deps(silent), silent.db.build(), IDS.order), 'retry');
    assertEquals(silent.gelato.state.calls.length, 0);

    // Through the webhook: the order stays paid, nothing PATCHed, nothing flagged.
    const viaWebhook = cardRig(cardOrder(), HOLD);
    viaWebhook.db.rpcFailures.set('holiday_card_hold_confirm', { message: 'boom' });
    await viaWebhook.send(fakeEvent('checkout.session.completed', cardSession()));
    await viaWebhook.settle();
    assertEquals(viaWebhook.db.row('holiday_card_orders', IDS.order).status, 'paid');
    assertEquals(viaWebhook.db.row('holiday_card_orders', IDS.order).failure_reason, null);
    assertEquals(patches(viaWebhook).length, 0);
  }));
});

Deno.test('held canary: a family that is not listed is confirmed as before', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder(), { holiday_card_settings: [{ id: true, mode: 'canary', orders_enabled: true, hold_confirm_family_ids: ['99999999-0000-4000-8000-000000000009'] }] });
    await rig.send(fakeEvent('checkout.session.completed', cardSession()));
    await rig.settle();
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'submitted');
    assertEquals(patches(rig).length, 1);
    assertEquals(heldMails(rig).length, 0);
  }));
});

Deno.test('held canary: a full refund of the held order deletes the draft, cancels it and releases the card claim', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1', failure_reason: 'HELD_FOR_CANARY' }), { ...HOLD, holiday_cards: [{ ...CLAIMED_CARD }] });
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true, amount: 4980, amount_refunded: 4980 }));
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'cancelled');
    assertEquals(typeof row.refunded_at, 'string');
    assertEquals(rig.gelato.state.orders.size, 0); // the draft is gone: Gelato never prints
    assertEquals(patches(rig).length, 0);
    assertEquals(claimOf(rig), null);
  }));
});

Deno.test('held canary: a refunded held order whose draft Gelato will not delete is flagged REFUND_NOT_CANCELLED (the hold marker does not hide it)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1', failure_reason: 'HELD_FOR_CANARY' }), HOLD);
    rig.gelato.state.forceStatus.set(`DELETE /orders/${GELATO_DRAFT}`, 400);
    await rig.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, 'REFUND_NOT_CANCELLED');
    assertEquals(rig.mails.filter((m) => m.subject.includes('REFUND_NOT_CANCELLED')).length, 1);
    // A different reason is never overwritten.
    const other = cardRig(cardOrder({ status: 'paid', stripe_payment_intent_id: 'pi_card_1', failure_reason: 'PAYMENT_MISMATCH_AMOUNT' }), HOLD);
    other.gelato.state.forceStatus.set(`DELETE /orders/${GELATO_DRAFT}`, 400);
    await other.send(fakeEvent('charge.refunded', { payment_intent: 'pi_card_1', refunded: true }));
    assertEquals(other.db.row('holiday_card_orders', IDS.order).failure_reason, 'PAYMENT_MISMATCH_AMOUNT');
  }));
});


// ── Pay first: the webhook kicks the whole print pipeline ────────────────

const payFirstOrder = (overrides: Record<string, unknown> = {}) =>
  cardOrder({ ...PAY_FIRST_COLUMNS, snapshot_hash: FROZEN_HASH, print_files: { snapshotHash: FROZEN_HASH }, ...overrides });
const payFirstSession = () => cardSession({ metadata: { productType: 'holiday_card', orderId: IDS.order, snapshotHash: FROZEN_HASH } });
const drafts = (rig: CardRig) => rig.gelato.state.calls.filter((c) => c.method === 'POST' && c.path === '/orders');

Deno.test('pay first: paid -> the webhook renders the print files, creates the draft, confirms and emails (nothing existed before payment)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(payFirstOrder(), { holiday_cards: [{ ...CLAIMED_CARD }] });
    assertEquals(rig.render.renderCalls.length, 0);
    const response = await rig.send(fakeEvent('checkout.session.completed', payFirstSession()));
    assertEquals((await response.json()).status, 'paid');
    assertEquals(rig.db.row('holiday_card_orders', IDS.order).status, 'paid'); // recorded before the background work
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'submitted');
    assertEquals(rig.render.renderCalls.length, 1);
    assertEquals(drafts(rig).length, 1);
    assertEquals(patches(rig).length, 1);
    assertEquals(typeof row.gelato_order_id, 'string');
    assertEquals(rig.mails.filter((m) => m.to === 'buyer@example.com').length, 1);
    assertEquals(claimOf(rig), null);
  }));
});

Deno.test('pay first: a render 422 after payment fails the order and alerts the owner (book policy: manual refund, no buyer email)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(payFirstOrder());
    rig.render.setRender(() => new Response(JSON.stringify({ ok: false, code: 'IMAGE_MISSING', message: 'gone' }), { status: 422 }));
    await rig.send(fakeEvent('checkout.session.completed', payFirstSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'failed');
    assertEquals(row.failure_reason, 'RENDER_REFUSED:IMAGE_MISSING');
    assertEquals(drafts(rig).length, 0);
    assertEquals(rig.mails.map((m) => m.to), ['hello@usemomora.com']);
    assertEquals(rig.stripe.state.calls.length, 0); // no automatic refund
  }));
});

Deno.test('pay first: a render outage leaves the order paid for the sweep to retry (no failure, no alert yet)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(payFirstOrder());
    rig.render.setRender(() => new Response('down', { status: 503 }));
    await rig.send(fakeEvent('checkout.session.completed', payFirstSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'paid');
    assertEquals(row.failure_reason, null);
    assertEquals(rig.mails.length, 0);
    assertEquals(drafts(rig).length, 0);
    rig.render.setRender(defaultRenderResponse);
  }));
});

Deno.test('pay first: a payment refunded while the print files were being made is never confirmed (draft deleted, cancelled)', async () => {
  await withWebhookSecret(() => withGelatoEnv(async () => {
    const rig = cardRig(payFirstOrder());
    rig.stripe.state.paymentIntents.set('pi_card_1', { amount: 4980, amount_refunded: 4980 });
    await rig.send(fakeEvent('checkout.session.completed', payFirstSession()));
    await rig.settle();
    const row = rig.db.row('holiday_card_orders', IDS.order);
    assertEquals(row.status, 'cancelled');
    assertEquals(patches(rig).length, 0);
    assertEquals(drafts(rig).length, 1); // made for the render-time snapshot, then removed by the refund path
    assertEquals(rig.gelato.state.orders.has(String(row.gelato_order_id)), false);
  }));
});
