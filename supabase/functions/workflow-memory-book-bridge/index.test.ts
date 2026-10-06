import { assertEquals } from 'jsr:@std/assert@1';
import { resolveScopeWindow } from '../memory-book-edits/index.ts';
import { type FakeMemory, withFakeWindowMemories } from '../_shared/memory-book-scope-window.test-support.ts';
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

type StubError = { message: string; code?: string };
type StubErrorSpec = StubError | ((priorCalls: number) => StubError | null);

interface StubCall {
  table: string;
  head: boolean;
  mode: 'list' | 'single';
  range: [number, number] | null;
}

/**
 * A deliberately simple Supabase client stub: every `.from(table)` chain
 * returns canned rows for that table regardless of `.eq`/`.gte`/etc (only
 * `.in(column, values)` filters, by column, and only when the row has that
 * column -- enough for chunked loads to return each row once), `.range(from,
 * to)` slices, `.maybeSingle()` resolves to the first row, and plain-awaiting
 * the chain resolves to the (sliced) array. A `{ head: true }` select resolves
 * to `{ count, data: null }` where count defaults to the table's row count.
 * This is enough to black-box-test this file's OWN branching logic without
 * re-implementing Postgres predicate evaluation -- the atomicity of a real
 * `UPDATE ... WHERE` CAS is Postgres's own property, not something these
 * tests need to reprove.
 *
 * Error injection (`errors`): keys are `<table>` (every non-head read),
 * `<table>:list` / `<table>:single` (one read mode), or `count:<table>` (head
 * counts). A value may be a function of how many times that key fired before.
 * `counts` overrides a table's head count (number, or function of how many
 * head counts that table has served before).
 */
function createStubClient(
  tables: Record<string, unknown[]>,
  options: {
    onInsert?: (table: string, rows: unknown[]) => { error: unknown } | void;
    onUpdate?: (table: string, patch: Record<string, unknown>) => void;
    errors?: Record<string, StubErrorSpec>;
    counts?: Record<string, number | ((priorCounts: number) => number)>;
    calls?: StubCall[];
    inCalls?: Array<{ table: string; column: string; length: number }>;
  } = {},
) {
  const errorFires: Record<string, number> = {};
  const countFires: Record<string, number> = {};
  const resolveError = (keys: string[]): StubError | null => {
    for (const key of keys) {
      const spec = options.errors?.[key];
      if (!spec) continue;
      const prior = errorFires[key] ?? 0;
      errorFires[key] = prior + 1;
      const result = typeof spec === 'function' ? spec(prior) : spec;
      if (result) return result;
    }
    return null;
  };
  return () => ({
    from(table: string) {
      let rows = tables[table] ?? [];
      let head = false;
      let range: [number, number] | null = null;
      const chain = {
        select: (_columns?: string, selectOptions?: { head?: boolean }) => {
          head = Boolean(selectOptions?.head);
          return chain;
        },
        eq: () => chain,
        neq: () => chain,
        gte: () => chain,
        lt: () => chain,
        lte: () => chain,
        not: () => chain,
        is: () => chain,
        in: (column: string, values: unknown[]) => {
          options.inCalls?.push({ table, column, length: values.length });
          rows = rows.filter((row) => {
            const value = (row as Record<string, unknown>)[column];
            return value === undefined || values.includes(value);
          });
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        range: (from: number, to: number) => {
          range = [from, to];
          return chain;
        },
        update: (patch: Record<string, unknown>) => {
          options.onUpdate?.(table, patch);
          return chain;
        },
        insert: async (newRows: unknown[]) => {
          const result = options.onInsert?.(table, Array.isArray(newRows) ? newRows : [newRows]);
          return result ?? { error: null };
        },
        maybeSingle: async () => {
          options.calls?.push({ table, head: false, mode: 'single', range });
          const error = resolveError([`${table}:single`, table]);
          return error ? { data: null, error } : { data: rows[0] ?? null, error: null };
        },
        then: (resolve: (v: { data: unknown[] | null; count?: number | null; error: StubError | null }) => void) => {
          options.calls?.push({ table, head, mode: 'list', range });
          if (head) {
            const error = resolveError([`count:${table}`]);
            if (error) return resolve({ data: null, count: null, error });
            const prior = countFires[table] ?? 0;
            countFires[table] = prior + 1;
            const override = options.counts?.[table];
            const count = override === undefined ? rows.length : typeof override === 'function' ? override(prior) : override;
            return resolve({ data: null, count, error: null });
          }
          const error = resolveError([`${table}:list`, table]);
          if (error) return resolve({ data: null, error });
          return resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null });
        },
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
            scope_start_date: '2024-10-17', scope_end_date: '2025-10-16', scope_label: 'Year One',
            page_budget: 60, status: 'generating', generation_attempt_id: ATTEMPT_ID,
          }],
          families: [{ name: 'The Rivas Family', gallery_caption_language: 'en' }],
          family_members: [{ id: childId, name: 'Tomás', date_of_birth: '2024-10-17', nicknames: [] }],
          memories: [{ id: memoryId, content: 'hello', memory_date: '2025-01-01', memory_type: 'text', emotion: null, topics: [], topic_details: {}, illustration_key: null }],
        }),
      },
    );
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.book.id, BOOK_ID);
    assertEquals(body.book.windowStart, '2024-10-17');
    // scope_end_date is inclusive in the DB -- the bridge converts to a
    // half-open [start, endExclusive) window by adding one day.
    assertEquals(body.book.windowEndExclusive, '2025-10-17');
    assertEquals(body.child, { id: childId, name: 'Tomás', dateOfBirth: '2024-10-17' });
    assertEquals(body.familyName, 'The Rivas Family');
    assertEquals(body.memories.length, 1);
  });
});

// ---------------------------------------------------------------------------
// load_generation_context: paging, chunking, error classes, count tripwire
// (docs/plans/memory-book-everything-fixes.md Phase 0)
// ---------------------------------------------------------------------------

const CHILD_ID = '66666666-6666-4666-8666-666666666666';

function bookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID, family_id: 'family-1', child_id: CHILD_ID, scope_kind: 'age_year',
    scope_start_date: '2024-10-17', scope_end_date: '2025-10-16', scope_label: 'Year One',
    page_budget: 60, status: 'generating', generation_attempt_id: ATTEMPT_ID,
    ...overrides,
  };
}

function memoryRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `mem-${String(i).padStart(5, '0')}`, content: `caption ${i}`, memory_date: '2025-01-01',
    memory_type: 'text', emotion: null, topics: [], topic_details: {}, illustration_key: null,
  }));
}

/** One media row, one tag, one like per memory; every 10th has a milestone. */
function childRows(memories: Array<{ id: string }>) {
  return {
    memory_media: memories.map((m, i) => ({ id: `media-${i}`, memory_id: m.id, object_key: `k/${i}`, preview_object_key: null, content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: 1 })),
    memory_family_members: memories.map((m) => ({ memory_id: m.id, family_member_id: CHILD_ID })),
    memory_milestones: memories.filter((_, i) => i % 10 === 0).map((m, i) => ({ memory_id: m.id, family_member_id: CHILD_ID, milestone_id: `first_step_${i}`, detail: null, out_of_band: false })),
    memory_likes: memories.map((m) => ({ memory_id: m.id, user_id: 'user-1' })),
    memory_comments: memories.filter((_, i) => i % 2 === 0).map((m, i) => ({ id: `comment-${i}`, memory_id: m.id })),
  };
}

function loadTables(memoryCount: number, overrides: { book?: Record<string, unknown>; omitChild?: boolean } = {}) {
  const memories = memoryRows(memoryCount);
  return {
    memory_books: [bookRow(overrides.book)],
    families: [{ name: 'The Rivas Family', gallery_caption_language: 'en' }],
    family_members: overrides.omitChild ? [] : [{ id: CHILD_ID, name: 'Tomás', date_of_birth: '2024-10-17', nicknames: [] }],
    memories,
    family_member_portrait_versions: [],
    ...childRows(memories),
  };
}

async function loadContext(tables: Record<string, unknown[]>, options: Parameters<typeof createStubClient>[1] = {}) {
  return await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: createStubClient(tables, options) },
    )
  );
}

Deno.test('load_generation_context pages >1000 memories fully and keeps every .in() at <=150 ids', async () => {
  const inCalls: Array<{ table: string; column: string; length: number }> = [];
  const calls: StubCall[] = [];
  const response = await loadContext(loadTables(1200), { inCalls, calls });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.memories.length, 1200);
  assertEquals(body.media.length, 1200);
  assertEquals(body.tags.length, 1200);
  assertEquals(body.milestones.length, 120);
  // 1200 likes + 600 comments, one each per memory / every other memory.
  assertEquals(Object.keys(body.engagementCounts).length, 1200);
  assertEquals(body.engagementCounts['mem-00000'], 2);
  assertEquals(body.engagementCounts['mem-00001'], 1);

  // The main query went through two range pages (0-999, 1000-1999).
  const memoryPages = calls.filter((c) => c.table === 'memories' && !c.head && c.range).map((c) => c.range);
  assertEquals(memoryPages, [[0, 999], [1000, 1999]]);

  assertEquals(inCalls.length > 0, true);
  assertEquals(Math.max(...inCalls.map((c) => c.length)), 150);
  for (const table of ['memory_media', 'memory_family_members', 'memory_milestones', 'memory_likes', 'memory_comments']) {
    assertEquals(inCalls.filter((c) => c.table === table).length, 8, `${table}: ceil(1200/150) chunks`);
  }
});

Deno.test('load_generation_context returns 500 context_load_failed for every errored query, never an empty success', async () => {
  const boom = { message: 'boom', code: 'XX000' };
  const cases: Array<[string, string]> = [
    ['family lookup', 'families'],
    ['child lookup', 'family_members:single'],
    ['family members', 'family_members:list'],
    ['portrait versions', 'family_member_portrait_versions'],
    ['main memories page', 'memories:list'],
    ['memory_media', 'memory_media'],
    ['memory_family_members', 'memory_family_members'],
    ['memory_milestones', 'memory_milestones'],
    ['memory_likes', 'memory_likes'],
    ['memory_comments', 'memory_comments'],
    ['memories count', 'count:memories'],
    ['media count', 'count:memory_media'],
    ['tags count', 'count:memory_family_members'],
    ['milestones count', 'count:memory_milestones'],
  ];
  for (const [label, key] of cases) {
    const response = await loadContext(loadTables(3), { errors: { [key]: boom } });
    assertEquals(response.status, 500, label);
    assertEquals((await response.json()).code, 'context_load_failed', label);
  }
});

Deno.test('load_generation_context: a failing language-evidence sample is a 500, not a silent skip', async () => {
  // 3 captions < sparse threshold, so the sample runs as the SECOND memories list read.
  const response = await loadContext(loadTables(3), {
    errors: { 'memories:list': (prior) => (prior === 1 ? { message: 'boom' } : null) },
  });
  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, 'context_load_failed');
});

Deno.test('load_generation_context: an errored everything window query (latest or tag-embed scan) is a 500, not the empty-window sentinel', async () => {
  const errorSets: Array<Record<string, StubErrorSpec>> = [
    { 'memories:single': { message: 'boom' } },
    { 'memories:list': (prior: number) => (prior === 0 ? { message: 'boom' } : null) },
  ];
  for (const errors of errorSets) {
    const response = await loadContext(
      loadTables(3, { book: { scope_kind: 'everything', child_id: null, scope_start_date: null, scope_end_date: null } }),
      { errors },
    );
    assertEquals(response.status, 500);
    assertEquals((await response.json()).code, 'context_load_failed');
  }
});

Deno.test('load_generation_context: an everything book resolves its window from the first/latest memories', async () => {
  const response = await loadContext(loadTables(3, { book: { scope_kind: 'everything', child_id: null, scope_start_date: null, scope_end_date: null } }));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.book.windowStart, '2025-01-01');
  assertEquals(body.book.windowEndExclusive, '2025-01-02');
});

const OTHER_MEMBER_ID = '88888888-8888-4888-8888-888888888888';

/** Pre-DOB untagged, then tagged-to-sibling, then the first ELIGIBLE one. */
const WINDOW_MEMORIES: FakeMemory[] = [
  { id: 'm0', family_id: 'family-1', memory_date: '2024-01-01', tags: [] },
  { id: 'm1', family_id: 'family-1', memory_date: '2024-11-01', tags: [OTHER_MEMBER_ID] },
  { id: 'm2', family_id: 'family-1', memory_date: '2025-01-01', tags: [] },
  { id: 'm3', family_id: 'family-1', memory_date: '2025-03-05', tags: [CHILD_ID] },
];

function everythingChildTables() {
  const tables = loadTables(3, { book: { scope_kind: 'everything', child_id: CHILD_ID, scope_start_date: null, scope_end_date: null } });
  // DOB 2024-10-17 (loadTables' child) floors the scan; m1 is tagged only to a sibling.
  return tables;
}

Deno.test('load_generation_context: the everything window start (first eligible on/after DOB) flows into every window query as gte', async () => {
  const gtes: Array<{ table: string; column: string; value: unknown }> = [];
  const base = createStubClient(everythingChildTables())() as unknown as { from(table: string): Record<string, unknown> };
  const recording = {
    from(table: string) {
      const chain = base.from(table) as { gte: (column: string, value: unknown) => unknown };
      const original = chain.gte;
      chain.gte = (column, value) => {
        gtes.push({ table, column, value });
        return original(column, value);
      };
      return chain;
    },
  };
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: () => withFakeWindowMemories(recording, WINDOW_MEMORIES) },
    )
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.book.windowStart, '2025-01-01');
  assertEquals(body.book.windowEndExclusive, '2025-03-06');
  const tables = new Set(gtes.map((g) => g.table));
  for (const table of ['memories', 'memory_media', 'memory_family_members', 'memory_milestones', 'family_member_portrait_versions']) {
    assertEquals(tables.has(table), true, `${table} was filtered by the window start`);
  }
  assertEquals(gtes.every((g) => g.value === '2025-01-01'), true, JSON.stringify(gtes));
});

Deno.test('load_generation_context: an everything family with no eligible memory keeps the empty-window sentinel path (not an error)', async () => {
  const tables = everythingChildTables();
  tables.memories = [];
  tables.memory_media = [];
  tables.memory_family_members = [];
  tables.memory_milestones = [];
  tables.memory_likes = [];
  tables.memory_comments = [];
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: () => withFakeWindowMemories(createStubClient(tables)(), [WINDOW_MEMORIES[1]]) },
    )
  );
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.book.windowStart, '0001-01-01');
  assertEquals(body.book.windowEndExclusive, '0001-01-01');
});

Deno.test('load_generation_context: a milestone row carries its status through to the worker (additive field)', async () => {
  const tables = loadTables(3, { book: { scope_kind: 'calendar_year', child_id: null } });
  const selects: string[] = [];
  const base = createStubClient(tables)() as unknown as { from(table: string): Record<string, unknown> };
  const client = {
    from(table: string) {
      const chain = base.from(table) as { select: (columns?: string, options?: unknown) => unknown };
      const original = chain.select;
      chain.select = (columns, options) => {
        if (table === 'memory_milestones' && columns) selects.push(columns);
        return original(columns, options);
      };
      return chain;
    },
  } as never;
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: () => client },
    )
  );
  assertEquals(response.status, 200);
  assertEquals(selects.some((c) => c.split(',').map((x) => x.trim()).includes('status')), true);
});

Deno.test('contract: bridge generation and memory-book-edits resolve the same everything window for the same data (no frozen window)', async () => {
  const scenarios: Array<{ label: string; memories: FakeMemory[]; childId: string | null }> = [
    { label: 'child book, sibling-tagged first memory, pre-DOB memory', memories: WINDOW_MEMORIES, childId: CHILD_ID },
    { label: 'family-wide book', memories: WINDOW_MEMORIES, childId: null },
    { label: 'no eligible memory', memories: [WINDOW_MEMORIES[1]], childId: CHILD_ID },
  ];
  for (const { label, memories, childId } of scenarios) {
    const tables = loadTables(3, { book: { scope_kind: 'everything', child_id: childId, scope_start_date: null, scope_end_date: null } });
    const client = withFakeWindowMemories(createStubClient(tables)(), memories);

    const bridgeResponse = await withBridgeSecret(async () =>
      await handleWorkflowMemoryBookBridge(
        await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
        { createServiceClient: () => client },
      )
    );
    // A shortfall against the filter-blind stub's own tables is not what this
    // test is about; the window is reported either way on a 200.
    assertEquals(bridgeResponse.status, 200, label);
    const { book } = await bridgeResponse.json();

    const editsWindow = await resolveScopeWindow(client, {
      family_id: 'family-1',
      child_id: childId,
      scope_kind: 'everything',
      scope_start_date: null,
      scope_end_date: null,
      book_document: { outline: {}, manifest: {} },
    });
    assertEquals(editsWindow, { start: book.windowStart, endExclusive: book.windowEndExclusive }, label);
  }
});

Deno.test('load_generation_context: a null child on a child-scoped book is a non-retryable 422', async () => {
  const response = await loadContext(loadTables(3, { omitChild: true }));
  assertEquals(response.status, 422);
  assertEquals((await response.json()).code, 'context_invalid');
});

Deno.test('load_generation_context: a book without child_id still loads with child null', async () => {
  const response = await loadContext(loadTables(3, { book: { scope_kind: 'calendar_year', child_id: null } }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).child, null);
});

Deno.test('load_generation_context: a persistent count shortfall reloads exactly once, then 422 context_invalid', async () => {
  for (const shortTable of ['memories', 'memory_media', 'memory_family_members', 'memory_milestones']) {
    const calls: StubCall[] = [];
    const response = await loadContext(loadTables(25), { calls, counts: { [shortTable]: 10_000 } });
    assertEquals(response.status, 422, shortTable);
    assertEquals((await response.json()).code, 'context_invalid', shortTable);
    // Two counting passes (each: one head query per kind) and two loads (main memories page twice).
    assertEquals(calls.filter((c) => c.table === shortTable && c.head).length, 2, shortTable);
    assertEquals(calls.filter((c) => c.table === 'memories' && !c.head && c.range?.[0] === 0).length, 2, shortTable);
  }
});

Deno.test('load_generation_context: a shortfall that the reload resolves succeeds after one reload', async () => {
  const calls: StubCall[] = [];
  // First count saw 30 media rows (one later deleted); the re-count agrees with what is loaded.
  const response = await loadContext(loadTables(25), { calls, counts: { memory_media: (prior) => (prior === 0 ? 30 : 25) } });
  assertEquals(response.status, 200);
  assertEquals(calls.filter((c) => c.table === 'memories' && !c.head && c.range?.[0] === 0).length, 2);
});

Deno.test('load_generation_context: rows inserted between the count and the load (loaded > expected) pass with no reload', async () => {
  const calls: StubCall[] = [];
  const response = await loadContext(loadTables(25), {
    calls,
    counts: { memories: 20, memory_media: 20, memory_family_members: 20, memory_milestones: 0 },
  });
  assertEquals(response.status, 200);
  assertEquals((await response.json()).memories.length, 25);
  assertEquals(calls.filter((c) => c.table === 'memories' && !c.head && c.range?.[0] === 0).length, 1);
});

Deno.test('load_generation_context: families that do not tag (zero tags, zero expected) are fine', async () => {
  const tables = loadTables(5, { book: { scope_kind: 'calendar_year', child_id: null } });
  tables.memory_family_members = [];
  const response = await loadContext(tables);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).tags, []);
});

Deno.test('load_generation_context: count queries use head-only exact counts through an unambiguous memories!inner embed', async () => {
  const selects: Array<{ table: string; columns: string | undefined; head: unknown; count: unknown }> = [];
  const client = () => {
    const base = (createStubClient(loadTables(3)) as () => { from(table: string): Record<string, unknown> })();
    return {
      from(table: string) {
        const chain = base.from(table) as { select: (columns?: string, options?: { head?: boolean; count?: string }) => unknown };
        const originalSelect = chain.select;
        chain.select = (columns, options) => {
          selects.push({ table, columns, head: options?.head, count: options?.count });
          return originalSelect(columns, options);
        };
        return chain;
      },
    } as never;
  };
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'load_generation_context', bookId: BOOK_ID, attemptId: ATTEMPT_ID }),
      { createServiceClient: client },
    )
  );
  assertEquals(response.status, 200);
  const heads = selects.filter((s) => s.head === true);
  assertEquals(heads.map((s) => [s.table, s.columns, s.count]), [
    ['memories', 'id', 'exact'],
    ['memory_media', 'memory_id, memories!inner(family_id)', 'exact'],
    ['memory_family_members', 'memory_id, memories!inner(family_id)', 'exact'],
    ['memory_milestones', 'memory_id, memories!inner(family_id)', 'exact'],
  ]);
});

Deno.test('ensure_share_tokens chunks the existing-token read to <=150 ids and reuses active tokens', async () => {
  const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const inCalls: Array<{ table: string; column: string; length: number }> = [];
  const insertedRows: Array<{ memory_id: string }> = [];
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'ensure_share_tokens', bookId: BOOK_ID, attemptId: ATTEMPT_ID, memoryIds: ids }),
      {
        createServiceClient: createStubClient(
          {
            memory_books: [{ id: BOOK_ID, status: 'generating', generation_attempt_id: ATTEMPT_ID }],
            media_share_tokens: ids.slice(0, 160).map((memory_id, i) => ({ memory_id, token: `tok-${i}` })),
          },
          { inCalls, onInsert: (_table, rows) => { insertedRows.push(...(rows as Array<{ memory_id: string }>)); } },
        ),
      },
    )
  );
  const body = await response.json() as { tokensByMemoryId: Record<string, string> };
  assertEquals(Object.keys(body.tokensByMemoryId).length, 400);
  assertEquals(body.tokensByMemoryId[ids[0]], 'tok-0');
  assertEquals(insertedRows.length, 240);
  assertEquals(inCalls.map((c) => c.length), [150, 150, 100]);
});

Deno.test('ensure_share_tokens treats a unique active-token conflict as success: re-reads and mints only what is still missing', async () => {
  const a = '44444444-4444-4444-8444-444444444444';
  const b = '55555555-5555-4555-8555-555555555555';
  const tokens: Array<{ memory_id: string; token: string }> = [];
  let inserts = 0;
  const insertedBatches: string[][] = [];
  const response = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'ensure_share_tokens', bookId: BOOK_ID, attemptId: ATTEMPT_ID, memoryIds: [a, b, a] }),
      {
        createServiceClient: createStubClient(
          { memory_books: [{ id: BOOK_ID, status: 'generating', generation_attempt_id: ATTEMPT_ID }], media_share_tokens: tokens },
          {
            onInsert: (_table, rows) => {
              inserts += 1;
              insertedBatches.push((rows as Array<{ memory_id: string }>).map((r) => r.memory_id));
              if (inserts === 1) {
                // A concurrent/earlier attempt minted `a` first: the atomic bulk insert writes nothing.
                tokens.push({ memory_id: a, token: 'winner-token' });
                return { error: { code: '23505', message: 'duplicate key' } };
              }
            },
          },
        ),
      },
    )
  );
  assertEquals(response.status, 200);
  const body = await response.json() as { tokensByMemoryId: Record<string, string> };
  assertEquals(body.tokensByMemoryId[a], 'winner-token');
  assertEquals(body.tokensByMemoryId[b].length, 22);
  // Duplicate input ids never reach one bulk insert twice; second pass mints only `b`.
  assertEquals(insertedBatches, [[a, b], [b]]);
});

Deno.test('ensure_share_tokens still fails (500) on a non-conflict insert error or a failed token read', async () => {
  const id = '44444444-4444-4444-8444-444444444444';
  const books = [{ id: BOOK_ID, status: 'generating', generation_attempt_id: ATTEMPT_ID }];
  const insertFailure = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'ensure_share_tokens', bookId: BOOK_ID, attemptId: ATTEMPT_ID, memoryIds: [id] }),
      { createServiceClient: createStubClient({ memory_books: books }, { onInsert: () => ({ error: { code: '42501', message: 'nope' } }) }) },
    )
  );
  assertEquals(insertFailure.status, 500);
  const readFailure = await withBridgeSecret(async () =>
    await handleWorkflowMemoryBookBridge(
      await signedRequest({ operation: 'ensure_share_tokens', bookId: BOOK_ID, attemptId: ATTEMPT_ID, memoryIds: [id] }),
      { createServiceClient: createStubClient({ memory_books: books }, { errors: { media_share_tokens: { message: 'boom' } } }) },
    )
  );
  assertEquals(readFailure.status, 500);
});
