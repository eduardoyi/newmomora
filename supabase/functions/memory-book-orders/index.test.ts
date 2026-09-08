import { assertEquals } from 'jsr:@std/assert@1';
import { handleMemoryBookOrders, validateShippingAddress } from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';

function fakeUser(email: string | null = 'buyer@example.com') {
  return { id: USER_ID, is_anonymous: false, email } as never;
}

const VALID_ADDRESS = {
  name: 'Ada Lovelace',
  line1: '1 Analytical Engine Way',
  city: 'London',
  postalCode: 'SW1A 1AA',
  countryCode: 'GB',
};

/**
 * CAS-aware multi-table stub: tracks each table's rows in a closure-owned
 * Map so an `.update(patch).eq('status', x)...maybeSingle()` call only
 * applies (and returns non-null) when the row's CURRENT status matches the
 * recorded `eq('status', ...)` filter -- enough to black-box-test this
 * file's own branching on a CAS outcome without re-implementing Postgres.
 * Same spirit as workflow-memory-book-bridge/index.test.ts's filter-blind
 * stub, extended just enough for `status` CAS realism since several of
 * this file's ops depend on it.
 */
function createStubClient(seed: Record<string, Record<string, unknown>[]>) {
  const tables = new Map(
    Object.entries(seed).map(([table, rows]) => [table, new Map(rows.map((row) => [row.id as string, { ...row }]))]),
  );
  return () => ({
    from(table: string) {
      const rowsById = tables.get(table) ?? new Map();
      let filters: Array<[string, unknown]> = [];
      let pendingPatch: Record<string, unknown> | null = null;
      let isInsert: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return chain; },
        insert: (row: Record<string, unknown>) => {
          isInsert = { id: crypto.randomUUID(), status: 'draft', ...row };
          rowsById.set(isInsert.id as string, isInsert);
          return chain;
        },
        update: (patch: Record<string, unknown>) => { pendingPatch = patch; return chain; },
        maybeSingle: async () => {
          if (isInsert) return { data: isInsert, error: null };
          const matches = [...rowsById.values()].filter((row) => filters.every(([c, v]) => row[c] === v));
          if (pendingPatch) {
            if (matches.length !== 1) return { data: null, error: null };
            Object.assign(matches[0], pendingPatch);
            return { data: { id: matches[0].id }, error: null };
          }
          return { data: matches[0] ?? null, error: null };
        },
        single: async () => {
          if (isInsert) return { data: isInsert, error: null };
          const matches = [...rowsById.values()].filter((row) => filters.every(([c, v]) => row[c] === v));
          return { data: matches[0] ?? null, error: matches[0] ? null : { message: 'not found' } };
        },
      };
      return chain;
    },
  }) as never;
}

Deno.test('validateShippingAddress rejects a missing line1 and accepts a valid address', () => {
  const bad = validateShippingAddress({ ...VALID_ADDRESS, line1: '' });
  assertEquals('error' in bad, true);
  const good = validateShippingAddress(VALID_ADDRESS);
  assertEquals('error' in good, false);
});

Deno.test('validateShippingAddress rejects a non-2-letter country code', () => {
  const bad = validateShippingAddress({ ...VALID_ADDRESS, countryCode: 'GBR' });
  assertEquals('error' in bad, true);
});

Deno.test('rejects an unauthenticated caller before any DB read', async () => {
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_draft', bookId: BOOK_ID }) }),
    { getAuthenticatedUser: async () => null, createServiceClient: createStubClient({}) },
  );
  assertEquals(response.status, 401);
});

Deno.test('create_draft rejects a caller who is not owner/manager', async () => {
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_draft', bookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID, family_id: FAMILY_ID, status: 'ready' }] }),
      getCallerFamilyRole: async () => 'viewer',
    },
  );
  assertEquals(response.status, 403);
});

Deno.test('create_draft rejects a book that is not ready', async () => {
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_draft', bookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID, family_id: FAMILY_ID, status: 'generating' }] }),
      getCallerFamilyRole: async () => 'owner',
    },
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, 'BOOK_NOT_READY');
});

Deno.test('create_draft inserts a bare draft row for an owner/manager', async () => {
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_draft', bookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID, family_id: FAMILY_ID, status: 'ready' }] }),
      getCallerFamilyRole: async () => 'manager',
    },
  );
  assertEquals(response.status, 201);
  const body = await response.json();
  assertEquals(body.status, 'draft');
});

Deno.test('quote 404s for an order belonging to a different buyer', async () => {
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'quote', orderId: ORDER_ID, address: VALID_ADDRESS }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({
        memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: OTHER_USER_ID, status: 'draft' }],
      }),
    },
  );
  assertEquals(response.status, 404);
});

Deno.test('quote rejects an invalid address before touching the render worker', async () => {
  let fetchCalled = false;
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'quote', orderId: ORDER_ID, address: { name: 'x' } }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({
        memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: USER_ID, status: 'draft' }],
      }),
      fetch: async () => { fetchCalled = true; return new Response('{}'); },
    },
  );
  assertEquals(response.status, 400);
  assertEquals(fetchCalled, false);
});

Deno.test('quote CASes draft -> quoted and persists price/shipping/page count from the render worker + Prodigi', async () => {
  const previousPrice = Deno.env.get('PRICE_USD_CENTS');
  const previousRenderUrl = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_URL');
  const previousRenderSecret = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET');
  const previousProdigiKey = Deno.env.get('PRODIGI_API_KEY');
  Deno.env.set('PRICE_USD_CENTS', '4999');
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_URL', 'https://render.test');
  Deno.env.set('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET', 'render-secret');
  Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
  try {
    const client = createStubClient({
      memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: USER_ID, status: 'draft' }],
      memory_books: [{ id: BOOK_ID, family_id: FAMILY_ID, book_document: { outline: {}, manifest: { memories: {} } } }],
      memory_book_edits: [],
    });
    const response = await handleMemoryBookOrders(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'quote', orderId: ORDER_ID, address: VALID_ADDRESS }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: client,
        fetch: async (url) => {
          const href = String(url);
          if (href.includes('/fit')) return new Response(JSON.stringify({ pageCount: 118 }), { status: 200 });
          if (href.includes('/v4.0/quotes')) {
            return new Response(JSON.stringify({
              quotes: [{ costSummary: { items: { amount: '40.00', currency: 'USD' }, shipping: { amount: '12.34', currency: 'USD' } } }],
            }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.priceCents, 4999);
    assertEquals(body.shippingCostCents, 1234);
    assertEquals(body.totalCents, 4999 + 1234);
    assertEquals(body.pageCount, 118);
  } finally {
    if (previousPrice === undefined) Deno.env.delete('PRICE_USD_CENTS'); else Deno.env.set('PRICE_USD_CENTS', previousPrice);
    if (previousRenderUrl === undefined) Deno.env.delete('MEMORY_BOOK_RENDER_WORKER_URL'); else Deno.env.set('MEMORY_BOOK_RENDER_WORKER_URL', previousRenderUrl);
    if (previousRenderSecret === undefined) Deno.env.delete('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET'); else Deno.env.set('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET', previousRenderSecret);
    if (previousProdigiKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousProdigiKey);
  }
});

Deno.test('quote refuses a re-quote of an already-quoted order (CAS guard)', async () => {
  const client = createStubClient({
    memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: USER_ID, status: 'quoted' }],
  });
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'quote', orderId: ORDER_ID, address: VALID_ADDRESS }) }),
    { getAuthenticatedUser: async () => fakeUser(), createServiceClient: client },
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, 'ORDER_NOT_DRAFT');
});

Deno.test('create_checkout requires the order to already be quoted', async () => {
  const client = createStubClient({
    memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: USER_ID, status: 'draft' }],
  });
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_checkout', orderId: ORDER_ID }) }),
    { getAuthenticatedUser: async () => fakeUser(), createServiceClient: client },
  );
  assertEquals(response.status, 409);
  assertEquals((await response.json()).code, 'ORDER_NOT_QUOTED');
});

Deno.test('create_checkout builds a Stripe session pinned to the quoted address and never re-derives price', async () => {
  const previousKey = Deno.env.get('STRIPE_SECRET_KEY');
  const previousOrigin = Deno.env.get('MEMORY_BOOK_CHECKOUT_ORIGIN');
  Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_123');
  Deno.env.set('MEMORY_BOOK_CHECKOUT_ORIGIN', 'https://shop.usemomora.com');
  try {
    const client = createStubClient({
      memory_book_orders: [{
        id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: USER_ID, status: 'quoted',
        price_cents: 4999, shipping_cost_cents: 1234, shipping_address: VALID_ADDRESS,
      }],
    });
    const calls: Array<{ url: string; body: string }> = [];
    const response = await handleMemoryBookOrders(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'create_checkout', orderId: ORDER_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: client,
        fetch: async (url, init) => {
          const href = String(url);
          calls.push({ url: href, body: String(init?.body ?? '') });
          if (href.endsWith('/customers')) return new Response(JSON.stringify({ id: 'cus_123' }), { status: 200 });
          if (href.endsWith('/checkout/sessions')) return new Response(JSON.stringify({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' }), { status: 200 });
          return new Response('{}', { status: 200 });
        },
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.sessionId, 'cs_123');
    assertEquals(body.checkoutUrl, 'https://checkout.stripe.com/cs_123');
    const sessionCall = calls.find((call) => call.url.endsWith('/checkout/sessions'));
    // The customer id (not a raw address) is what pins the session's
    // destination -- shipping_address_collection is never present at all.
    assertEquals(sessionCall?.body.includes('customer=cus_123'), true);
    assertEquals(sessionCall?.body.includes('unit_amount%5D=4999') || sessionCall?.body.includes('unit_amount]=4999'), true);
    assertEquals(sessionCall?.body.includes('shipping_address_collection'), false);
  } finally {
    if (previousKey === undefined) Deno.env.delete('STRIPE_SECRET_KEY'); else Deno.env.set('STRIPE_SECRET_KEY', previousKey);
    if (previousOrigin === undefined) Deno.env.delete('MEMORY_BOOK_CHECKOUT_ORIGIN'); else Deno.env.set('MEMORY_BOOK_CHECKOUT_ORIGIN', previousOrigin);
  }
});

Deno.test('status is scoped to the requesting buyer', async () => {
  const client = createStubClient({
    memory_book_orders: [{ id: ORDER_ID, book_id: BOOK_ID, family_id: FAMILY_ID, requested_by: OTHER_USER_ID, status: 'paid' }],
  });
  const response = await handleMemoryBookOrders(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ op: 'status', orderId: ORDER_ID }) }),
    { getAuthenticatedUser: async () => fakeUser(), createServiceClient: client },
  );
  assertEquals(response.status, 404);
});
