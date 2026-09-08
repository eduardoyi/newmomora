import { assertEquals } from 'jsr:@std/assert@1';
import { handleStripeWebhook } from './index.ts';

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
