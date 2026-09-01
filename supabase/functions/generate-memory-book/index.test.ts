import { assertEquals } from 'jsr:@std/assert@1';
import {
  handleGenerateMemoryBook,
  isFreshGeneratingMemoryBook,
  MEMORY_BOOK_LEASE_MS,
  MEMORY_BOOK_RECOVERY_GRACE_MS,
} from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_ID = '22222222-2222-4222-8222-222222222222';
const BOOK_ID = '33333333-3333-4333-8333-333333333333';

function fakeUser() {
  return { id: USER_ID, is_anonymous: false } as never;
}

async function withDispatchEnv<T>(run: () => Promise<T>): Promise<T> {
  const urlEnv = 'CLOUDFLARE_MEMORY_BOOK_WORKFLOW_URL';
  const secretEnv = 'CLOUDFLARE_MEMORY_BOOK_DISPATCH_SECRET';
  const previousUrl = Deno.env.get(urlEnv);
  const previousSecret = Deno.env.get(secretEnv);
  Deno.env.set(urlEnv, 'https://worker.test/dispatch');
  Deno.env.set(secretEnv, 'dispatch-test-secret');
  try {
    return await run();
  } finally {
    if (previousUrl === undefined) Deno.env.delete(urlEnv);
    else Deno.env.set(urlEnv, previousUrl);
    if (previousSecret === undefined) Deno.env.delete(secretEnv);
    else Deno.env.set(secretEnv, previousSecret);
  }
}

/** Same filter-blind chain-stub convention as
 * workflow-memory-book-bridge/index.test.ts -- see that file's own comment
 * for why this is an adequate boundary for these tests (the CAS's
 * atomicity is Postgres's own property; these tests exercise this file's
 * OWN branching on top of it). */
function createStubClient(book: Record<string, unknown> | null, options: { onUpdate?: () => void } = {}) {
  return () => ({
    from(table: string) {
      if (table !== 'memory_books') throw new Error(`unexpected table ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: (patch: Record<string, unknown>) => {
          options.onUpdate?.();
          updatedWith = patch;
          return chain;
        },
        is: () => chain,
        maybeSingle: async () => ({ data: updatedWith ? { ...book, ...updatedWith, id: BOOK_ID } : book, error: null }),
        then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
      };
      let updatedWith: Record<string, unknown> | null = null;
      return chain;
    },
  }) as never;
}

Deno.test('rejects an unauthenticated caller before any DB read', async () => {
  const response = await handleGenerateMemoryBook(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
    { getAuthenticatedUser: async () => null, createServiceClient: createStubClient(null) },
  );
  assertEquals(response.status, 401);
});

Deno.test('rejects a caller who is not owner/manager of the book\'s family', async () => {
  const response = await handleGenerateMemoryBook(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'queued', workflow_instance_id: null, generation_attempt_id: null, generation_started_at: null }),
      getCallerFamilyRole: async () => 'viewer',
    },
  );
  assertEquals(response.status, 403);
});

Deno.test('404s for an unknown memory book id', async () => {
  const response = await handleGenerateMemoryBook(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
    { getAuthenticatedUser: async () => fakeUser(), createServiceClient: createStubClient(null) },
  );
  assertEquals(response.status, 404);
});

Deno.test('a ready book returns success without touching the Worker', async () => {
  let dispatched = false;
  const response = await handleGenerateMemoryBook(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'ready', workflow_instance_id: 'x', generation_attempt_id: 'x', generation_started_at: new Date().toISOString() }),
      getCallerFamilyRole: async () => 'owner',
      fetch: async () => { dispatched = true; return new Response('{}', { status: 200 }); },
    },
  );
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, status: 'ready' });
  assertEquals(dispatched, false);
});

Deno.test('a fresh generating book re-dispatches the SAME attempt idempotently', async () => {
  await withDispatchEnv(async () => {
    const dispatchedBodies: unknown[] = [];
    const startedAt = new Date().toISOString();
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient({
          id: BOOK_ID, family_id: FAMILY_ID, status: 'generating',
          workflow_instance_id: 'existing-attempt', generation_attempt_id: 'existing-attempt', generation_started_at: startedAt,
        }),
        getCallerFamilyRole: async () => 'owner',
        fetch: async (_url, init) => { dispatchedBodies.push(JSON.parse(init!.body as string)); return new Response('{}', { status: 202 }); },
      },
    );
    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals(body.attemptId, 'existing-attempt');
    assertEquals(dispatchedBodies, [{ bookId: BOOK_ID, attemptId: 'existing-attempt' }]);
  });
});

Deno.test('a stale generating book (lease + grace expired) is reclaimed with a fresh attempt id', async () => {
  await withDispatchEnv(async () => {
    const staleStartedAt = new Date(Date.now() - (MEMORY_BOOK_LEASE_MS + MEMORY_BOOK_RECOVERY_GRACE_MS + 1000)).toISOString();
    let updateCalls = 0;
    const dispatchedBodies: Array<{ bookId: string; attemptId: string }> = [];
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient(
          { id: BOOK_ID, family_id: FAMILY_ID, status: 'generating', workflow_instance_id: 'old-attempt', generation_attempt_id: 'old-attempt', generation_started_at: staleStartedAt },
          { onUpdate: () => { updateCalls += 1; } },
        ),
        getCallerFamilyRole: async () => 'owner',
        fetch: async (_url, init) => { dispatchedBodies.push(JSON.parse(init!.body as string)); return new Response('{}', { status: 202 }); },
      },
    );
    assertEquals(response.status, 202);
    assertEquals(updateCalls, 1);
    assertEquals(dispatchedBodies.length, 1);
    assertEquals(dispatchedBodies[0].bookId, BOOK_ID);
    // A fresh attempt id was minted -- never reused from the stale attempt.
    assertEquals(dispatchedBodies[0].attemptId === 'old-attempt', false);
  });
});

Deno.test('a queued book is claimed to generating and dispatched with a fresh attempt id', async () => {
  await withDispatchEnv(async () => {
    const dispatchedBodies: Array<{ bookId: string; attemptId: string }> = [];
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'queued', workflow_instance_id: null, generation_attempt_id: null, generation_started_at: null }),
        getCallerFamilyRole: async () => 'manager',
        fetch: async (_url, init) => { dispatchedBodies.push(JSON.parse(init!.body as string)); return new Response('{}', { status: 202 }); },
      },
    );
    assertEquals(response.status, 202);
    const body = await response.json();
    assertEquals(body.queued, true);
    assertEquals(typeof body.attemptId, 'string');
    assertEquals(dispatchedBodies[0].attemptId, body.attemptId);
  });
});

Deno.test('a failed book can be retried the same way as queued', async () => {
  await withDispatchEnv(async () => {
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'failed', workflow_instance_id: 'old', generation_attempt_id: 'old', generation_started_at: null }),
        getCallerFamilyRole: async () => 'owner',
        fetch: async () => new Response('{}', { status: 202 }),
      },
    );
    assertEquals(response.status, 202);
  });
});

Deno.test('treats a 409 duplicate-instance dispatch response as success, not an error', async () => {
  await withDispatchEnv(async () => {
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'queued', workflow_instance_id: null, generation_attempt_id: null, generation_started_at: null }),
        getCallerFamilyRole: async () => 'owner',
        fetch: async () => new Response('{}', { status: 409 }),
      },
    );
    assertEquals(response.status, 202);
  });
});

Deno.test('rolls back to failed and returns 500 when the Worker dispatch genuinely fails', async () => {
  await withDispatchEnv(async () => {
    let rollbackSeen = false;
    const response = await handleGenerateMemoryBook(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
      {
        getAuthenticatedUser: async () => fakeUser(),
        createServiceClient: createStubClient(
          { id: BOOK_ID, family_id: FAMILY_ID, status: 'queued', workflow_instance_id: null, generation_attempt_id: null, generation_started_at: null },
          { onUpdate: () => { rollbackSeen = true; } },
        ),
        getCallerFamilyRole: async () => 'owner',
        fetch: async () => new Response('{}', { status: 502 }),
      },
    );
    assertEquals(response.status, 500);
    assertEquals(rollbackSeen, true);
  });
});

Deno.test('never dispatches when the Cloudflare Worker is unconfigured (missing env)', async () => {
  const response = await handleGenerateMemoryBook(
    new Request('http://localhost', { method: 'POST', body: JSON.stringify({ memoryBookId: BOOK_ID }) }),
    {
      getAuthenticatedUser: async () => fakeUser(),
      createServiceClient: createStubClient({ id: BOOK_ID, family_id: FAMILY_ID, status: 'queued', workflow_instance_id: null, generation_attempt_id: null, generation_started_at: null }),
      getCallerFamilyRole: async () => 'owner',
      fetch: async () => { throw new Error('fetch should never be reached without dispatch config'); },
    },
  );
  assertEquals(response.status, 500);
});

Deno.test('isFreshGeneratingMemoryBook', () => {
  const now = Date.now();
  assertEquals(isFreshGeneratingMemoryBook(null, now), false);
  assertEquals(isFreshGeneratingMemoryBook(new Date(now - 1000).toISOString(), now), true);
  assertEquals(isFreshGeneratingMemoryBook(new Date(now - MEMORY_BOOK_LEASE_MS - MEMORY_BOOK_RECOVERY_GRACE_MS - 1).toISOString(), now), false);
});
