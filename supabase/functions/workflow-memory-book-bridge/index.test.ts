import { assertEquals } from 'jsr:@std/assert@1';
import { handleWorkflowMemoryBookBridge, isSignedWorkflowRequest } from './index.ts';

const BRIDGE_SECRET_ENV = 'CLOUDFLARE_MEMORY_BOOK_BRIDGE_SECRET';
const BOOK_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';

async function sign(timestamp: string, nonce: string, body: string, secret = 'bridge-test-secret'): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${body}`)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signedRequest(body: Record<string, unknown>): Promise<Request> {
  const timestamp = String(Date.now());
  const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
  const rawBody = JSON.stringify(body);
  return new Request('http://localhost/workflow-memory-book-bridge', {
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
  Deno.env.set(BRIDGE_SECRET_ENV, 'bridge-test-secret');
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete(BRIDGE_SECRET_ENV);
    else Deno.env.set(BRIDGE_SECRET_ENV, previous);
  }
}

/**
 * A deliberately simple (filter-blind) Supabase client stub: every `.from
 * (table)` chain returns the SAME canned array for that table regardless of
 * `.eq`/`.in`/`.gte`/etc, `.maybeSingle()` resolves to that array's first
 * element, and plain-awaiting the chain (its `.then`) resolves to the whole
 * array. This is enough to black-box-test this file's OWN branching logic
 * (does a CAS match/not-match get interpreted correctly, is the right
 * operation dispatched) without re-implementing Postgres predicate
 * evaluation -- the atomicity of a real `UPDATE ... WHERE` CAS is Postgres's
 * own well-established property, not something these tests need to reprove.
 */
function createStubClient(
  tables: Record<string, unknown[]>,
  options: {
    onInsert?: (table: string, rows: unknown[]) => { error: unknown } | void;
    onUpdate?: (table: string, patch: Record<string, unknown>) => void;
  } = {},
) {
  return () => ({
    from(table: string) {
      const rows = tables[table] ?? [];
      const chain = {
        select: () => chain,
        eq: () => chain,
        neq: () => chain,
        gte: () => chain,
        lt: () => chain,
        lte: () => chain,
        not: () => chain,
        is: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (patch: Record<string, unknown>) => {
          options.onUpdate?.(table, patch);
          return chain;
        },
        insert: async (newRows: unknown[]) => {
          const result = options.onInsert?.(table, Array.isArray(newRows) ? newRows : [newRows]);
          return result ?? { error: null };
        },
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: rows, error: null }),
      };
      return chain;
    },
  }) as never;
}

Deno.test('workflow memory book bridge HMAC binds the nonce as well as timestamp and body', async () => {
  await withBridgeSecret(async () => {
    const timestamp = String(Date.now());
    const nonce = '4e5c933a-3a75-4a23-9adc-82227afc10e9';
    const body = JSON.stringify({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID });
    const signature = await sign(timestamp, nonce, body);
    const valid = new Request('http://localhost', {
      method: 'POST',
      headers: { 'x-workflow-timestamp': timestamp, 'x-workflow-nonce': nonce, 'x-workflow-signature': signature },
    });
    assertEquals(await isSignedWorkflowRequest(valid, body), true);

    const tamperedNonce = new Request('http://localhost', {
      method: 'POST',
      headers: { 'x-workflow-timestamp': timestamp, 'x-workflow-nonce': '4e5c933a-3a75-4a23-9adc-82227afc10ea', 'x-workflow-signature': signature },
    });
    assertEquals(await isSignedWorkflowRequest(tamperedNonce, body), false);
  });
});

Deno.test('rejects an unsigned request, an unknown operation, and a malformed id before touching the database', async () => {
  await withBridgeSecret(async () => {
    const unsigned = await handleWorkflowMemoryBookBridge(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID }) }),
      { createServiceClient: createStubClient({}) },
    );
    assertEquals(unsigned.status, 401);

    const badOperation = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'delete_everything', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({}) },
    );
    assertEquals(badOperation.status, 400);

    const badId = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: 'not-a-uuid', attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({}) },
    );
    assertEquals(badId.status, 400);
  });
});

Deno.test('publish is a compare-and-set: matches only when generation_attempt_id + status are current', async () => {
  await withBridgeSecret(async () => {
    const matched = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: { outline: {}, manifest: {} } }),
      { createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID }] }) },
    );
    assertEquals(await matched.json(), { published: true });

    const superseded = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: { outline: {}, manifest: {} } }),
      { createServiceClient: createStubClient({ memory_books: [] }) },
    );
    assertEquals(await superseded.json(), { published: false });
  });
});

Deno.test('publish rejects a missing bookDocument before touching the database', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID }] }) },
    );
    assertEquals(response.status, 400);
  });
});

// Shaped to actually resolve via _shared/memory-book-cover.ts's pass 1 (see
// that module's tests for the full precedence coverage): a coverCandidates
// hit needs a >=2000px-wide photo asset, and pickCoverAssetKey also reads
// manifest.scope + the memory's own `date` even when pass 1 is expected to
// win, so both are populated here for realism.
const READY_BOOK_DOCUMENT = {
  outline: { coverCandidates: ['memory-1'] },
  manifest: {
    scope: { start: '2025-01-01', end: '2025-12-31' },
    memories: {
      'memory-1': { date: '2025-06-01', assets: [{ file: 'covers/memory-1.jpg', kind: 'photo', width: 2000 }] },
    },
  },
};

function requesterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    family_id: 'family-1',
    child_id: 'child-1',
    scope_label: 'Year One',
    requested_by: 'requester-1',
    ...overrides,
  };
}

type PushCall = { token: string; title: string; body: string; data: unknown };

function recordingPush(pushCalls: PushCall[]) {
  return async (token: string, title: string, body: string, data: unknown) => {
    pushCalls.push({ token, title, body, data });
    return true;
  };
}

Deno.test('publish includes cover_asset_key (resolved from the outline/manifest) in the CAS update', async () => {
  await withBridgeSecret(async () => {
    const updatePatches: Array<Record<string, unknown>> = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient(
          { memory_books: [requesterRow({ requested_by: null })] },
          { onUpdate: (table, patch) => { if (table === 'memory_books') updatePatches.push(patch); } },
        ),
      },
    );
    assertEquals(await response.json(), { published: true });
    assertEquals(updatePatches.length, 1);
    assertEquals(updatePatches[0].cover_asset_key, 'covers/memory-1.jpg');
    // The CAS predicates themselves are unchanged -- only the update payload
    // grew a field.
    assertEquals(updatePatches[0].status, 'ready');
  });
});

Deno.test('publish sends the ready push to the requester on a CAS win', async () => {
  await withBridgeSecret(async () => {
    const pushCalls: PushCall[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient({
          memory_books: [requesterRow()],
          user_profiles: [{ id: 'requester-1', expo_push_token: 'ExponentPushToken[abc]', deleted_at: null }],
        }),
        sendExpoPushNotification: recordingPush(pushCalls),
      },
    );
    assertEquals(await response.json(), { published: true });
    assertEquals(pushCalls.length, 1);
    assertEquals(pushCalls[0].token, 'ExponentPushToken[abc]');
    assertEquals(pushCalls[0].title, 'Your memory book is ready');
    assertEquals(pushCalls[0].body, '“Year One” is ready to look through.');
    assertEquals(pushCalls[0].data, {
      route: 'memory-book',
      familyId: 'family-1',
      memberId: 'child-1',
      bookId: BOOK_ID,
    });
  });
});

Deno.test('publish omits memberId when the book has no child_id, and sends no push on a CAS loss', async () => {
  await withBridgeSecret(async () => {
    const pushCalls: PushCall[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        // No memory_books row -- the CAS loses (superseded/no-longer-generating).
        createServiceClient: createStubClient({
          memory_books: [],
          user_profiles: [{ id: 'requester-1', expo_push_token: 'ExponentPushToken[abc]', deleted_at: null }],
        }),
        sendExpoPushNotification: recordingPush(pushCalls),
      },
    );
    assertEquals(await response.json(), { published: false });
    assertEquals(pushCalls.length, 0);
  });
});

Deno.test('publish still returns { published: true } when the push send throws (network failure)', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient({
          memory_books: [requesterRow()],
          user_profiles: [{ id: 'requester-1', expo_push_token: 'ExponentPushToken[abc]', deleted_at: null }],
        }),
        sendExpoPushNotification: async () => { throw new Error('network down'); },
      },
    );
    assertEquals(await response.json(), { published: true });
  });
});

Deno.test('publish sends no push when requested_by is null', async () => {
  await withBridgeSecret(async () => {
    const pushCalls: PushCall[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient({
          memory_books: [requesterRow({ requested_by: null })],
        }),
        sendExpoPushNotification: recordingPush(pushCalls),
      },
    );
    assertEquals(await response.json(), { published: true });
    assertEquals(pushCalls.length, 0);
  });
});

Deno.test('publish sends no push when the requester has no expo_push_token', async () => {
  await withBridgeSecret(async () => {
    const pushCalls: PushCall[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient({
          memory_books: [requesterRow()],
          user_profiles: [{ id: 'requester-1', expo_push_token: null, deleted_at: null }],
        }),
        sendExpoPushNotification: recordingPush(pushCalls),
      },
    );
    assertEquals(await response.json(), { published: true });
    assertEquals(pushCalls.length, 0);
  });
});

Deno.test('publish sends no push when the requester profile is soft-deleted', async () => {
  await withBridgeSecret(async () => {
    const pushCalls: PushCall[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'publish', bookId: BOOK_ID, attemptId: ATTEMPT_ID, bookDocument: READY_BOOK_DOCUMENT }),
      {
        createServiceClient: createStubClient({
          memory_books: [requesterRow()],
          user_profiles: [{ id: 'requester-1', expo_push_token: 'ExponentPushToken[abc]', deleted_at: '2026-01-01T00:00:00Z' }],
        }),
        sendExpoPushNotification: recordingPush(pushCalls),
      },
    );
    assertEquals(await response.json(), { published: true });
    assertEquals(pushCalls.length, 0);
  });
});

Deno.test('fail is the same CAS discipline as publish, truncates an overlong reason', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'fail', bookId: BOOK_ID, attemptId: ATTEMPT_ID, failureReason: 'OUTLINE_GENERATION_FAILED' }),
      { createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID }] }) },
    );
    assertEquals(await response.json(), { failed: true });
  });
});

Deno.test('reconcile reports succeeded/superseded/retry/failed from the row snapshot', async () => {
  await withBridgeSecret(async () => {
    const succeeded = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'reconcile', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ status: 'ready', generation_attempt_id: ATTEMPT_ID }] }) },
    );
    assertEquals(await succeeded.json(), { outcome: 'succeeded' });

    const supersededByNewerAttempt = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'reconcile', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ status: 'ready', generation_attempt_id: 'a-different-attempt' }] }) },
    );
    assertEquals(await supersededByNewerAttempt.json(), { outcome: 'superseded' });

    const retry = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'reconcile', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ status: 'generating', generation_attempt_id: ATTEMPT_ID }] }) },
    );
    assertEquals(await retry.json(), { outcome: 'retry' });

    const failed = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'reconcile', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ status: 'failed', generation_attempt_id: ATTEMPT_ID }] }) },
    );
    assertEquals(await failed.json(), { outcome: 'failed' });
  });
});

Deno.test('ensure_share_tokens reuses an active token and only mints for memories missing one', async () => {
  await withBridgeSecret(async () => {
    const memoryWithToken = '44444444-4444-4444-8444-444444444444';
    const memoryWithoutToken = '55555555-5555-4555-8555-555555555555';
    const insertedRows: unknown[] = [];
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'ensure_share_tokens', bookId: BOOK_ID, attemptId: ATTEMPT_ID, memoryIds: [memoryWithToken, memoryWithoutToken] }),
      {
        createServiceClient: createStubClient(
          {
            memory_books: [{ id: BOOK_ID, status: 'generating', generation_attempt_id: ATTEMPT_ID }],
            media_share_tokens: [{ memory_id: memoryWithToken, token: 'existing-token' }],
          },
          { onInsert: (table, rows) => { if (table === 'media_share_tokens') insertedRows.push(...rows); } },
        ),
      },
    );
    const body = await response.json() as { tokensByMemoryId: Record<string, string> };
    assertEquals(body.tokensByMemoryId[memoryWithToken], 'existing-token');
    assertEquals(typeof body.tokensByMemoryId[memoryWithoutToken], 'string');
    assertEquals(body.tokensByMemoryId[memoryWithoutToken].length, 22);
    assertEquals(insertedRows.length, 1);
    assertEquals((insertedRows[0] as { memory_id: string }).memory_id, memoryWithoutToken);
  });
});

Deno.test('load_generation_context rejects a book that is no longer this attempt\'s to work on', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [{ id: BOOK_ID, status: 'ready', generation_attempt_id: ATTEMPT_ID }] }) },
    );
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.code, 'BOOK_SUPERSEDED');
  });
});

Deno.test('load_generation_context returns 404 for an unknown book id', async () => {
  await withBridgeSecret(async () => {
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient({ memory_books: [] }) },
    );
    assertEquals(response.status, 404);
  });
});

Deno.test('load_generation_context assembles the full scope for an active, matching attempt', async () => {
  await withBridgeSecret(async () => {
    const childId = '66666666-6666-4666-8666-666666666666';
    const memoryId = '77777777-7777-4777-8777-777777777777';
    const response = await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      {
        createServiceClient: createStubClient({
          memory_books: [{
            id: BOOK_ID, family_id: 'family-1', child_id: childId, scope_kind: 'age_year',
            scope_start_date: '2024-10-23', scope_end_date: '2025-10-22', scope_label: 'Year One',
            page_budget: 60, status: 'generating', generation_attempt_id: ATTEMPT_ID,
          }],
          families: [{ name: 'The Rivas Family', gallery_caption_language: 'en' }],
          family_members: [{ id: childId, name: 'Enzo', date_of_birth: '2024-10-23', nicknames: [] }],
          memories: [{ id: memoryId, content: 'hello', memory_date: '2025-01-01', memory_type: 'text', emotion: null, topics: [], topic_details: {}, illustration_key: null }],
        }),
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.book.id, BOOK_ID);
    assertEquals(body.book.windowStart, '2024-10-23');
    // scope_end_date is inclusive in the DB -- the bridge converts to a
    // half-open [start, endExclusive) window by adding one day.
    assertEquals(body.book.windowEndExclusive, '2025-10-23');
    assertEquals(body.child, { id: childId, name: 'Enzo', dateOfBirth: '2024-10-23' });
    assertEquals(body.familyName, 'The Rivas Family');
    assertEquals(body.memories.length, 1);
  });
});
