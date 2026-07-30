import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import {
  ABANDONED_ANONYMOUS_USER_TTL_DAYS,
  handleCleanupAbandonedAnonymousUsers,
  isSafeToDelete,
} from './index.ts';

const ANONYMOUS_ID = '11111111-1111-4111-8111-111111111111';
const PERMANENT_ID = '22222222-2222-4222-8222-222222222222';
const CONTENT_OWNING_ID = '33333333-3333-4333-8333-333333333333';
const ALREADY_GONE_ID = '44444444-4444-4444-8444-444444444444';
const DELETE_FAILS_ID = '55555555-5555-4555-8555-555555555555';

interface FakeAuthUser {
  id: string;
  is_anonymous: boolean;
}

interface FakeState {
  candidates: Array<{ id: string; created_at: string }>;
  candidatesError?: { message: string } | null;
  authUsers: Record<string, FakeAuthUser | undefined>;
  memberships: string[]; // user ids with a real family_memberships row
  ownedFamilies: string[]; // user ids that own a family
  deletedUserIds: string[];
  deleteShouldFail: Set<string>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

function baseState(overrides?: Partial<FakeState>): FakeState {
  return {
    candidates: [{ id: ANONYMOUS_ID, created_at: '2020-01-01T00:00:00.000Z' }],
    authUsers: {
      [ANONYMOUS_ID]: { id: ANONYMOUS_ID, is_anonymous: true },
      [PERMANENT_ID]: { id: PERMANENT_ID, is_anonymous: false },
      [CONTENT_OWNING_ID]: { id: CONTENT_OWNING_ID, is_anonymous: true },
      [DELETE_FAILS_ID]: { id: DELETE_FAILS_ID, is_anonymous: true },
      // ALREADY_GONE_ID intentionally absent.
    },
    memberships: [],
    ownedFamilies: [],
    deletedUserIds: [],
    deleteShouldFail: new Set(),
    rpcCalls: [],
    ...overrides,
  };
}

function createFakeServiceClient(state: FakeState) {
  return {
    from(table: 'family_memberships' | 'families') {
      const owners = table === 'family_memberships' ? state.memberships : state.ownedFamilies;
      const column = table === 'family_memberships' ? 'user_id' : 'owner_id';
      return {
        select: (_cols: string, _opts: { count: string; head: boolean }) => ({
          eq: (col: string, value: string) => {
            if (col !== column) throw new Error(`Unexpected column ${col} for ${table}`);
            return Promise.resolve({
              count: owners.includes(value) ? 1 : 0,
              error: null,
            });
          },
        }),
      };
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === 'get_abandoned_anonymous_auth_user_ids') {
        if (state.candidatesError) {
          return Promise.resolve({ data: null, error: state.candidatesError });
        }
        return Promise.resolve({ data: state.candidates, error: null });
      }
      throw new Error(`Unexpected rpc ${name}`);
    },
    auth: {
      admin: {
        getUserById: (id: string) => {
          const user = state.authUsers[id];
          if (!user) {
            return Promise.resolve({ data: { user: null }, error: { message: 'not found' } });
          }
          return Promise.resolve({ data: { user }, error: null });
        },
        deleteUser: (id: string) => {
          if (state.deleteShouldFail.has(id)) {
            return Promise.resolve({ data: null, error: { message: 'delete failed' } });
          }
          state.deletedUserIds.push(id);
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  };
}

function request(): Request {
  return new Request('http://localhost/cleanup-abandoned-anonymous-users', {
    method: 'POST',
    headers: { 'x-cron-secret': 'test-secret' },
  });
}

function withCronSecret(run: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get('CRON_SECRET');
  Deno.env.set('CRON_SECRET', 'test-secret');
  return run().finally(() => {
    if (previous === undefined) Deno.env.delete('CRON_SECRET');
    else Deno.env.set('CRON_SECRET', previous);
  });
}

Deno.test('cleanup-abandoned-anonymous-users rejects missing cron secret', async () => {
  const response = await handleCleanupAbandonedAnonymousUsers(
    new Request('http://localhost/cleanup-abandoned-anonymous-users', { method: 'POST' }),
  );
  assertEquals(response.status, 401);
});

Deno.test('cleanup-abandoned-anonymous-users rejects unsupported methods', async () => {
  const response = await handleCleanupAbandonedAnonymousUsers(
    new Request('http://localhost/cleanup-abandoned-anonymous-users', { method: 'GET' }),
  );
  assertEquals(response.status, 405);
});

Deno.test('happy path: deletes an anonymous candidate with no real content', async () => {
  await withCronSecret(async () => {
    const state = baseState();
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body, { success: true, deletedCount: 1 });
    assertEquals(state.deletedUserIds, [ANONYMOUS_ID]);
  });
});

Deno.test('TTL: the candidate query is called with a cutoff exactly ABANDONED_ANONYMOUS_USER_TTL_DAYS in the past', async () => {
  await withCronSecret(async () => {
    const state = baseState();
    const client = createFakeServiceClient(state);
    const now = new Date('2026-07-29T00:00:00.000Z');

    await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => now,
    });

    assertEquals(state.rpcCalls.length, 1);
    assertEquals(state.rpcCalls[0].name, 'get_abandoned_anonymous_auth_user_ids');
    const expectedCutoff = new Date(
      now.getTime() - ABANDONED_ANONYMOUS_USER_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    assertEquals(state.rpcCalls[0].args.p_older_than, expectedCutoff);
  });
});

Deno.test('THE dangerous failure mode: a permanent (non-anonymous) user is never deleted, even if it appears as a candidate', async () => {
  await withCronSecret(async () => {
    const state = baseState({
      candidates: [
        { id: PERMANENT_ID, created_at: '2020-01-01T00:00:00.000Z' },
        { id: ANONYMOUS_ID, created_at: '2020-01-01T00:00:00.000Z' },
      ],
    });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    // Only the genuinely anonymous candidate is deleted.
    assertEquals(body.deletedCount, 1);
    assertEquals(state.deletedUserIds, [ANONYMOUS_ID]);
    assertEquals(state.deletedUserIds.includes(PERMANENT_ID), false);
  });
});

Deno.test('isSafeToDelete refuses a permanent user directly', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);
  const safe = await isSafeToDelete(client as never, PERMANENT_ID);
  assertEquals(safe, false);
});

Deno.test('isSafeToDelete refuses an anonymous candidate who unexpectedly owns a family membership', async () => {
  const state = baseState({ memberships: [CONTENT_OWNING_ID] });
  const client = createFakeServiceClient(state);
  const safe = await isSafeToDelete(client as never, CONTENT_OWNING_ID);
  assertEquals(safe, false);
});

Deno.test('isSafeToDelete refuses an anonymous candidate who unexpectedly owns a family', async () => {
  const state = baseState({ ownedFamilies: [CONTENT_OWNING_ID] });
  const client = createFakeServiceClient(state);
  const safe = await isSafeToDelete(client as never, CONTENT_OWNING_ID);
  assertEquals(safe, false);
});

Deno.test('a candidate that unexpectedly owns real content is skipped, not deleted', async () => {
  await withCronSecret(async () => {
    const state = baseState({
      candidates: [{ id: CONTENT_OWNING_ID, created_at: '2020-01-01T00:00:00.000Z' }],
      ownedFamilies: [CONTENT_OWNING_ID],
    });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    const body = await response.json();
    assertEquals(body.deletedCount, 0);
    assertEquals(state.deletedUserIds, []);
  });
});

Deno.test('a candidate already gone (race with another run) is skipped without error', async () => {
  await withCronSecret(async () => {
    const state = baseState({
      candidates: [{ id: ALREADY_GONE_ID, created_at: '2020-01-01T00:00:00.000Z' }],
    });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.deletedCount, 0);
  });
});

Deno.test('a deleteUser failure for one candidate does not stop the batch', async () => {
  await withCronSecret(async () => {
    const state = baseState({
      candidates: [
        { id: DELETE_FAILS_ID, created_at: '2020-01-01T00:00:00.000Z' },
        { id: ANONYMOUS_ID, created_at: '2020-01-01T00:00:00.000Z' },
      ],
      deleteShouldFail: new Set([DELETE_FAILS_ID]),
    });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    const body = await response.json();
    assertEquals(body.deletedCount, 1);
    assertEquals(state.deletedUserIds, [ANONYMOUS_ID]);
  });
});

Deno.test('a candidate-lookup RPC failure returns a clean 500 and deletes nothing', async () => {
  await withCronSecret(async () => {
    const state = baseState({ candidatesError: { message: 'db error' } });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assertEquals(response.status, 500);
    assertEquals(state.deletedUserIds, []);
  });
});

Deno.test('no candidates: succeeds with deletedCount 0', async () => {
  await withCronSecret(async () => {
    const state = baseState({ candidates: [] });
    const client = createFakeServiceClient(state);

    const response = await handleCleanupAbandonedAnonymousUsers(request(), {
      createServiceClient: () => client as never,
      now: () => new Date('2026-07-29T00:00:00.000Z'),
    });

    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body, { success: true, deletedCount: 0 });
  });
});

Deno.test('ABANDONED_ANONYMOUS_USER_TTL_DAYS is a conservative, documented constant', () => {
  assertExists(ABANDONED_ANONYMOUS_USER_TTL_DAYS);
  assertEquals(ABANDONED_ANONYMOUS_USER_TTL_DAYS, 7);
});
