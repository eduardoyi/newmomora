import { assertEquals } from 'jsr:@std/assert@1';
import { handleWorkflowMemoryBookOrderBridge, isSignedOrderWorkflowRequest } from './index.ts';

const BRIDGE_SECRET_ENV = 'CLOUDFLARE_MEMORY_BOOK_ORDER_BRIDGE_SECRET';
const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const BUYER_ID = '11111111-1111-4111-8111-111111111111';

async function sign(timestamp: string, nonce: string, body: string, secret = 'order-bridge-test-secret'): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(body: Record<string, unknown>): Promise<Request> {
  const timestamp = String(Date.now());
  const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
  const rawBody = JSON.stringify(body);
  return new Request('http://localhost/workflow-memory-book-order-bridge', {
    method: 'POST',
    headers: {
      'x-workflow-timestamp': timestamp,
      'x-workflow-nonce': nonce,
      'x-workflow-signature': await sign(timestamp, nonce, rawBody),
    },
    body: rawBody,
  });
}

async function withBridgeSecret<T>(run: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get(BRIDGE_SECRET_ENV);
  Deno.env.set(BRIDGE_SECRET_ENV, 'order-bridge-test-secret');
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete(BRIDGE_SECRET_ENV); else Deno.env.set(BRIDGE_SECRET_ENV, previous);
  }
}

/** Same CAS-aware multi-table stub design as memory-book-orders/index.test.ts. */
function createStubClient(seed: Record<string, Record<string, unknown>[]>, options: { userEmail?: string } = {}) {
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
        update: (patch: Record<string, unknown>) => { pendingPatch = patch; return chain; },
        maybeSingle: async () => {
          const matches = [...rowsById.values()].filter((row) => filters.every(([c, v]) => row[c] === v));
          if (pendingPatch) {
            if (matches.length !== 1) return { data: null, error: null };
            Object.assign(matches[0], pendingPatch);
            return { data: { id: matches[0].id }, error: null };
          }
          return { data: matches[0] ?? null, error: null };
        },
      };
      return chain;
    },
    auth: {
      admin: {
        getUserById: async (_id: string) => ({ data: { user: options.userEmail ? { email: options.userEmail } : null }, error: null }),
      },
    },
  }) as never;
}

function renderingOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    book_id: 'book-1',
    family_id: 'family-1',
    requested_by: BUYER_ID,
    status: 'rendering',
    workflow_attempt_id: ATTEMPT_ID,
    price_cents: 4999,
    shipping_cost_cents: 1234,
    currency: 'usd',
    quoted_page_count: 118,
    shipping_address: { name: 'Ada Lovelace', line1: '1 Way', postalCode: 'X1', countryCode: 'GB' },
    book_document_snapshot: { outline: {}, manifest: {} },
    edits_snapshot: {},
    prodigi_order_id: null,
    ...overrides,
  };
}

Deno.test('rejects an unsigned request', async () => {
  const response = await handleWorkflowMemoryBookOrderBridge(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ operation: 'load_order', orderId: ORDER_ID, attemptId: ATTEMPT_ID }) }),
  );
  assertEquals(response.status, 401);
});

Deno.test('isSignedOrderWorkflowRequest rejects a tampered body', async () => {
  await withBridgeSecret(async () => {
    const timestamp = String(Date.now());
    const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
    const body = JSON.stringify({ operation: 'load_order' });
    const signature = await sign(timestamp, nonce, body);
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'x-workflow-timestamp': timestamp, 'x-workflow-nonce': nonce, 'x-workflow-signature': signature },
      body: 'this is not what was signed',
    });
    const valid = await isSignedOrderWorkflowRequest(request, 'this is not what was signed');
    // Re-derive against the ACTUAL body passed to the verifier, proving a
    // caller who signs one body and sends another is rejected.
    assertEquals(valid, false);
  });
});

Deno.test('load_order 409s when the attempt is no longer current', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'load_order', orderId: ORDER_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_book_orders: [renderingOrder({ status: 'submitted' })] }) },
    );
    assertEquals(response.status, 409);
    assertEquals((await response.json()).code, 'ORDER_SUPERSEDED');
  });
});

Deno.test('load_order returns the frozen snapshot + quote for the current attempt', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'load_order', orderId: ORDER_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_book_orders: [renderingOrder()] }) },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.order.id, ORDER_ID);
    assertEquals(body.order.quotedPageCount, 118);
    assertEquals(body.order.priceCents, 4999);
  });
});

Deno.test('verify_and_presign_output rejects a missing interior PDF', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'verify_and_presign_output', orderId: ORDER_ID, attemptId: ATTEMPT_ID, interiorKey: 'interior.pdf', coverKey: 'cover.pdf' }),
      {
        createServiceClient: createStubClient({ memory_book_orders: [renderingOrder()] }),
        headObject: async (key: string) => key === 'cover.pdf' ? { contentLength: 1000, contentType: 'application/pdf', metadata: {} } : null,
      },
    );
    assertEquals(response.status, 502);
    assertEquals((await response.json()).code, 'RENDER_OUTPUT_MISSING');
  });
});

Deno.test('verify_and_presign_output HEADs both PDFs and returns 7-day presigned URLs', async () => {
  await withBridgeSecret(async () => {
    let presignExpiry: number | undefined;
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'verify_and_presign_output', orderId: ORDER_ID, attemptId: ATTEMPT_ID, interiorKey: 'interior.pdf', coverKey: 'cover.pdf' }),
      {
        createServiceClient: createStubClient({ memory_book_orders: [renderingOrder()] }),
        headObject: async () => ({ contentLength: 2048, contentType: 'application/pdf', metadata: {} }),
        createPresignedGetUrls: async (keys: string[], expiresIn?: number) => {
          presignExpiry = expiresIn;
          return Object.fromEntries(keys.map((key) => [key, `https://r2.test/${key}`]));
        },
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.interiorUrl, 'https://r2.test/interior.pdf');
    assertEquals(body.coverUrl, 'https://r2.test/cover.pdf');
    assertEquals(presignExpiry, 7 * 24 * 60 * 60);
  });
});

Deno.test('mark_submitted CASes rendering -> submitted and is a no-op on a second call', async () => {
  await withBridgeSecret(async () => {
    const client = createStubClient({ memory_book_orders: [renderingOrder()] });
    const first = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'mark_submitted', orderId: ORDER_ID, attemptId: ATTEMPT_ID, prodigiOrderId: 'prodigi-1' }),
      { createServiceClient: client },
    );
    assertEquals((await first.json()).submitted, true);

    const second = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'mark_submitted', orderId: ORDER_ID, attemptId: ATTEMPT_ID, prodigiOrderId: 'prodigi-1' }),
      { createServiceClient: client },
    );
    // Second call finds status is no longer 'rendering' -- CAS guard, no
    // double-submit.
    assertEquals((await second.json()).submitted, false);
  });
});

Deno.test('mark_failed is guarded by workflow_attempt_id (a superseded attempt cannot fail a NEWER attempt\'s row)', async () => {
  await withBridgeSecret(async () => {
    const client = createStubClient({ memory_book_orders: [renderingOrder({ workflow_attempt_id: 'a-different-attempt' })] });
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'mark_failed', orderId: ORDER_ID, attemptId: ATTEMPT_ID, failureReason: 'RENDER_FAILED' }),
      { createServiceClient: client },
    );
    assertEquals((await response.json()).failed, false);
  });
});

Deno.test('send_order_email paid_confirmation resolves the buyer email via auth.admin.getUserById', async () => {
  await withBridgeSecret(async () => {
    const sent: Array<{ to: string }> = [];
    const response = await handleWorkflowMemoryBookOrderBridge(
      await signedRequest({ operation: 'send_order_email', orderId: ORDER_ID, emailKind: 'paid_confirmation' }),
      {
        createServiceClient: createStubClient(
          { memory_book_orders: [renderingOrder({ status: 'submitted', prodigi_order_id: 'prodigi-1' })] },
          { userEmail: 'buyer@example.com' },
        ),
        sendEmail: async (input: { to: string }) => { sent.push(input); return 'sent'; },
      },
    );
    assertEquals((await response.json()).sent, true);
    assertEquals(sent[0]?.to, 'buyer@example.com');
  });
});

Deno.test('send_order_email owner_alarm sends to the configured alert recipient with PDF links', async () => {
  await withBridgeSecret(async () => {
    const previous = Deno.env.get('MEMORY_BOOK_ORDER_ALERT_EMAIL');
    Deno.env.set('MEMORY_BOOK_ORDER_ALERT_EMAIL', 'owner@example.com');
    try {
      const sent: Array<{ to: string; htmlBody: string }> = [];
      const response = await handleWorkflowMemoryBookOrderBridge(
        await signedRequest({
          operation: 'send_order_email',
          orderId: ORDER_ID,
          emailKind: 'owner_alarm',
          pdfLinks: { interiorUrl: 'https://r2.test/interior.pdf', coverUrl: 'https://r2.test/cover.pdf' },
        }),
        {
          createServiceClient: createStubClient({ memory_book_orders: [renderingOrder({ status: 'submitted', prodigi_order_id: 'prodigi-1' })] }),
          sendEmail: async (input: { to: string; htmlBody: string }) => { sent.push(input); return 'sent'; },
        },
      );
      assertEquals((await response.json()).sent, true);
      assertEquals(sent[0]?.to, 'owner@example.com');
      assertEquals(sent[0]?.htmlBody.includes('interior.pdf'), true);
    } finally {
      if (previous === undefined) Deno.env.delete('MEMORY_BOOK_ORDER_ALERT_EMAIL'); else Deno.env.set('MEMORY_BOOK_ORDER_ALERT_EMAIL', previous);
    }
  });
});
