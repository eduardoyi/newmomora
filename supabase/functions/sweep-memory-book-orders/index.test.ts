import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { extractOrderTracking, handleSweepMemoryBookOrders } from './index.ts';

const ORDER_ID_1 = '44444444-4444-4444-8444-444444444441';
const ORDER_ID_2 = '44444444-4444-4444-8444-444444444442';
const ORDER_ID_3 = '44444444-4444-4444-8444-444444444443';
const BUYER_ID = '11111111-1111-4111-8111-111111111111';

/** CAS-aware, predicate-based multi-table stub -- extends the simpler
 * equality-only stub used by the other order-surface test files with real
 * `.in()`/`.lt()`/`.is()` semantics, since the sweep's queries actually
 * depend on those operators (not just `.eq()`). */
function createStubClient(seed: Record<string, Record<string, unknown>[]>, options: { userEmail?: string | null } = {}) {
  const tables = new Map(
    Object.entries(seed).map(([table, rows]) => [table, new Map(rows.map((row) => [row.id as string, { ...row }]))]),
  );
  return () => ({
    from(table: string) {
      const rowsById = tables.get(table) ?? new Map();
      const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
      let pendingPatch: Record<string, unknown> | null = null;
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => { predicates.push((row) => row[col] === val); return chain; },
        in: (col: string, vals: unknown[]) => { predicates.push((row) => vals.includes(row[col])); return chain; },
        lt: (col: string, val: unknown) => { predicates.push((row) => typeof row[col] === 'string' && (row[col] as string) < (val as string)); return chain; },
        is: (col: string, val: unknown) => { predicates.push((row) => (row[col] ?? null) === val); return chain; },
        order: () => chain,
        limit: () => chain,
        returns: () => chain,
        update: (patch: Record<string, unknown>) => { pendingPatch = patch; return chain; },
        maybeSingle: async () => {
          const matches = [...rowsById.values()].filter((row) => predicates.every((p) => p(row)));
          if (pendingPatch) {
            if (matches.length !== 1) return { data: null, error: null };
            Object.assign(matches[0], pendingPatch);
            return { data: { id: matches[0].id }, error: null };
          }
          return { data: matches[0] ?? null, error: null };
        },
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
          const matches = [...rowsById.values()].filter((row) => predicates.every((p) => p(row)));
          if (pendingPatch) for (const match of matches) Object.assign(match, pendingPatch);
          resolve({ data: matches, error: null });
        },
      };
      return chain;
    },
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: options.userEmail ? { email: options.userEmail } : null }, error: null }),
      },
    },
  }) as never;
}

function requestFor(): Request {
  return new Request('http://localhost', { method: 'POST', headers: { 'x-cron-secret': 'test-cron-secret' } });
}

async function withCronSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-cron-secret');
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete('CRON_SECRET'); else Deno.env.set('CRON_SECRET', previous);
  }
}

async function withOrderDispatchEnv<T>(run: () => Promise<T>): Promise<T> {
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

Deno.test('rejects a request without the cron secret', async () => {
  const response = await handleSweepMemoryBookOrders(
    new Request('http://localhost', { method: 'POST' }),
    { createServiceClient: createStubClient({}) },
  );
  assertEquals(response.status, 401);
});

Deno.test('zero-dispatch reconciliation redispatches a paid order that never reached rendering', async () => {
  await withCronSecret(async () => {
    await withOrderDispatchEnv(async () => {
      const client = createStubClient({
        memory_book_orders: [{
          id: ORDER_ID_1, status: 'paid', workflow_instance_id: null, workflow_attempt_id: null, workflow_started_at: null,
        }],
      });
      const dispatched: unknown[] = [];
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url, init) => {
          if (String(url).includes('order-worker.test')) { dispatched.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 202 }); }
          return new Response('{}', { status: 200 });
        },
      });
      const body = await response.json();
      assertEquals(response.status, 200);
      assertEquals(body.reconcile.claimed, 1);
      assertEquals(body.reconcile.redispatched, 1);
      assertEquals(dispatched.length, 1);
    });
  });
});

Deno.test('zero-dispatch reconciliation redispatches a stale rendering order using its EXISTING attempt id', async () => {
  await withCronSecret(async () => {
    await withOrderDispatchEnv(async () => {
      const staleStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
      const client = createStubClient({
        memory_book_orders: [{
          id: ORDER_ID_1, status: 'rendering', workflow_instance_id: 'existing-attempt', workflow_attempt_id: 'existing-attempt', workflow_started_at: staleStartedAt,
        }],
      });
      const dispatched: Array<{ attemptId: string }> = [];
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url, init) => {
          if (String(url).includes('order-worker.test')) { dispatched.push(JSON.parse(String(init?.body))); return new Response('{}', { status: 409 }); }
          return new Response('{}', { status: 200 });
        },
      });
      const body = await response.json();
      assertEquals(response.status, 200);
      assertEquals(body.reconcile.claimed, 0);
      assertEquals(body.reconcile.redispatched, 1);
      assertEquals(dispatched[0]?.attemptId, 'existing-attempt');
    });
  });
});

Deno.test('a fresh rendering order (within grace) is left alone', async () => {
  await withCronSecret(async () => {
    await withOrderDispatchEnv(async () => {
      const freshStartedAt = new Date(Date.now() - 5_000).toISOString();
      const client = createStubClient({
        memory_book_orders: [{ id: ORDER_ID_1, status: 'rendering', workflow_instance_id: 'a', workflow_attempt_id: 'a', workflow_started_at: freshStartedAt }],
      });
      const response = await handleSweepMemoryBookOrders(requestFor(), { createServiceClient: client, fetch: async () => new Response('{}', { status: 200 }) });
      const body = await response.json();
      assertEquals(body.reconcile.redispatched, 0);
    });
  });
});

Deno.test('post-submission tracking advances a submitted order to in_production and does not regress it', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient({
        memory_book_orders: [{
          id: ORDER_ID_1, status: 'submitted', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
          workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }],
      });
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ order: { status: { stage: 'InProgress' }, shipments: [] } }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
      });
      const body = await response.json();
      assertEquals(body.track.polled, 1);
      assertEquals(body.track.advanced, 1);
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('post-submission tracking sends a tracking email on the shipped transition', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'in_production', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let trackingEmailSent = false;
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          const href = String(url);
          if (href.includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({
              order: { status: { stage: 'Complete' }, shipments: [{ carrier: 'DPD', trackingNumber: 'TRACK123', trackingUrl: 'https://track.test/TRACK123' }] },
            }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async () => { trackingEmailSent = true; return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.advanced, 1);
      assertEquals(trackingEmailSent, true);
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('alarms on a submitted order stuck past the 4h not-in-production threshold', async () => {
  await withCronSecret(async () => {
    const client = createStubClient({
      memory_book_orders: [{
        id: ORDER_ID_2, status: 'submitted', prodigi_order_id: null, requested_by: null,
        workflow_completed_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
        updated_at: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      }],
    });
    let alertSent = false;
    const response = await handleSweepMemoryBookOrders(requestFor(), {
      createServiceClient: client,
      sendEmail: async () => { alertSent = true; return 'sent'; },
    });
    const body = await response.json();
    assertEquals(body.track.alarmed >= 1, true);
    assertEquals(alertSent, true);
  });
});

Deno.test('ages an abandoned quoted order past the 48h backstop to cancelled', async () => {
  await withCronSecret(async () => {
    const client = createStubClient({
      memory_book_orders: [
        { id: ORDER_ID_1, status: 'quoted', updated_at: new Date(Date.now() - 72 * 60 * 60_000).toISOString() },
        { id: ORDER_ID_3, status: 'quoted', updated_at: new Date().toISOString() },
      ],
    });
    const response = await handleSweepMemoryBookOrders(requestFor(), { createServiceClient: client, fetch: async () => new Response('{}', { status: 200 }) });
    const body = await response.json();
    assertEquals(body.cancelledAbandonedQuotes, 1);
  });
});

// ---------------------------------------------------------------------------
// Order-status UX round, item 3: tracking extraction + persistence.
// ---------------------------------------------------------------------------

Deno.test('extractOrderTracking: empty shipments -> everything null', () => {
  assertEquals(extractOrderTracking([]), { tracking_number: null, tracking_url: null, carrier: null });
});

Deno.test('extractOrderTracking: a shipment with no tracking number -> everything null (never fabricated)', () => {
  assertEquals(
    extractOrderTracking([{ carrier: 'DPD', trackingUrl: null, trackingNumber: null }]),
    { tracking_number: null, tracking_url: null, carrier: null },
  );
});

Deno.test('extractOrderTracking: tracking number present but url/carrier absent -> only the number is set', () => {
  assertEquals(
    extractOrderTracking([{ trackingNumber: 'TRACK123' }]),
    { tracking_number: 'TRACK123', tracking_url: null, carrier: null },
  );
});

Deno.test('extractOrderTracking: full shipment shape -> all three persisted verbatim', () => {
  assertEquals(
    extractOrderTracking([{ carrier: 'DPD', trackingUrl: 'https://track.test/TRACK123', trackingNumber: 'TRACK123' }]),
    { tracking_number: 'TRACK123', tracking_url: 'https://track.test/TRACK123', carrier: 'DPD' },
  );
});

Deno.test('extractOrderTracking: picks the first shipment that actually has a tracking number', () => {
  assertEquals(
    extractOrderTracking([
      { carrier: 'UPS', trackingUrl: null, trackingNumber: null },
      { carrier: 'DPD', trackingUrl: 'https://track.test/TRACK456', trackingNumber: 'TRACK456' },
    ]),
    { tracking_number: 'TRACK456', tracking_url: 'https://track.test/TRACK456', carrier: 'DPD' },
  );
});

Deno.test('post-submission tracking persists carrier/url/number on the shipped transition and includes them in the email', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'in_production', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let emailHtml = '';
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({
              order: { status: { stage: 'Complete' }, shipments: [{ carrier: 'DPD', trackingNumber: 'TRACK123', trackingUrl: 'https://track.test/TRACK123' }] },
            }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async (input) => { emailHtml = input.htmlBody; return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.advanced, 1);
      assertStringIncludes(emailHtml, 'https://track.test/TRACK123');
      assertStringIncludes(emailHtml, 'DPD');

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'shipped');
      assertEquals(row.data?.tracking_number, 'TRACK123');
      assertEquals(row.data?.tracking_url, 'https://track.test/TRACK123');
      assertEquals(row.data?.carrier, 'DPD');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('post-submission tracking: a shipped stage with no tracking number yet persists nothing (never fabricated) and sends no tracking line', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'submitted', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let emailHtml = '';
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            // "Complete" stage, but shipments carry no tracking number at all.
            return new Response(JSON.stringify({
              order: { status: { stage: 'Complete' }, shipments: [] },
            }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async (input) => { emailHtml = input.htmlBody; return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.advanced, 1);
      assertEquals(emailHtml.includes('Track your delivery'), false);
      assertEquals(emailHtml.includes('Tracking number'), false);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'shipped');
      assertEquals(row.data?.tracking_number ?? null, null);
      assertEquals(row.data?.tracking_url ?? null, null);
      assertEquals(row.data?.carrier ?? null, null);
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('auto-cancel: a Prodigi 404 (EntityNotFound) past the grace window cancels the row and alerts the owner', async () => {
  // Cancelled orders VANISH from Prodigi's Orders API (owner-proven live
  // 2026-09-09: GET on a dashboard-cancelled production order answers 404
  // EntityNotFound, never a Cancelled stage) — the 404 IS the signal.
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'submitted', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            // Submitted well past the 15-minute not-found grace window.
            workflow_completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            updated_at: new Date(Date.now() - 60 * 60_000).toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      const emails: Array<{ subject: string }> = [];
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ outcome: 'EntityNotFound' }), { status: 404 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async (input) => { emails.push(input); return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.autoCancelled, 1);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'cancelled');
      assertEquals(emails.length, 1);
      assertStringIncludes(emails[0].subject, 'CANCELLED_AT_PRODIGI');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('auto-cancel: a Prodigi 404 within the grace window is treated as read-model lag, not cancellation', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'submitted', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            // JUST submitted — a transient 404 here must never cancel.
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let emailSent = false;
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ outcome: 'EntityNotFound' }), { status: 404 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async () => { emailSent = true; return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.autoCancelled, 0);
      assertEquals(emailSent, false);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'submitted');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('auto-cancel: a Prodigi 404 never regresses an already-shipped order', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'shipped', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date(Date.now() - 60 * 60_000).toISOString(),
            updated_at: new Date(Date.now() - 60 * 60_000).toISOString(), tracking_number: 'TRACK123',
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ outcome: 'EntityNotFound' }), { status: 404 });
          }
          return new Response('{}', { status: 200 });
        },
      });
      const body = await response.json();
      assertEquals(body.track.autoCancelled, 0);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'shipped');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('auto-cancel: a Prodigi Cancelled stage cancels the row and alerts the owner', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'in_production', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      const emails: Array<{ subject: string; htmlBody: string }> = [];
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ order: { status: { stage: 'Cancelled' }, shipments: [] } }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async (input) => { emails.push(input); return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.autoCancelled, 1);
      assertEquals(body.track.advanced, 0);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'cancelled');
      // Exactly one email: the owner alert -- never a buyer "shipped" email.
      assertEquals(emails.length, 1);
      assertStringIncludes(emails[0].subject, 'CANCELLED_AT_PRODIGI');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('auto-cancel: a Cancelled stage never regresses an already-shipped order', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'shipped', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: 'TRACK123',
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let emailSent = false;
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({ order: { status: { stage: 'Cancelled' }, shipments: [] } }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async () => { emailSent = true; return 'sent'; },
      });
      const body = await response.json();
      assertEquals(body.track.autoCancelled, 0);
      assertEquals(emailSent, false);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'shipped');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});

Deno.test('post-submission tracking: backfills tracking onto an already-shipped order once Prodigi supplies it, without regressing status or re-emailing', async () => {
  await withCronSecret(async () => {
    const previousKey = Deno.env.get('PRODIGI_API_KEY');
    Deno.env.set('PRODIGI_API_KEY', 'prodigi-test-key');
    try {
      const client = createStubClient(
        {
          memory_book_orders: [{
            id: ORDER_ID_1, status: 'shipped', prodigi_order_id: 'prodigi-1', requested_by: BUYER_ID,
            workflow_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), tracking_number: null,
          }],
        },
        { userEmail: 'buyer@example.com' },
      );
      let emailSent = false;
      const response = await handleSweepMemoryBookOrders(requestFor(), {
        createServiceClient: client,
        fetch: async (url) => {
          if (String(url).includes('/v4.0/Orders/')) {
            return new Response(JSON.stringify({
              order: { status: { stage: 'Complete' }, shipments: [{ carrier: 'UPS', trackingNumber: 'LATE-TRACK', trackingUrl: 'https://track.test/LATE-TRACK' }] },
            }), { status: 200 });
          }
          return new Response('{}', { status: 200 });
        },
        sendEmail: async () => { emailSent = true; return 'sent'; },
      });
      const body = await response.json();
      // Not counted as an "advance" -- the order was already `shipped`.
      assertEquals(body.track.advanced, 0);
      assertEquals(emailSent, false);

      const row = await (client() as unknown as { from: (t: string) => any }).from('memory_book_orders').select().eq('id', ORDER_ID_1).maybeSingle();
      assertEquals(row.data?.status, 'shipped');
      assertEquals(row.data?.tracking_number, 'LATE-TRACK');
      assertEquals(row.data?.carrier, 'UPS');
    } finally {
      if (previousKey === undefined) Deno.env.delete('PRODIGI_API_KEY'); else Deno.env.set('PRODIGI_API_KEY', previousKey);
    }
  });
});
