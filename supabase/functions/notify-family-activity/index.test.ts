import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleNotifyFamilyActivity, processNotifyFamilyActivity } from './index.ts';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const NO_TOKEN_MEMBER_ID = '55555555-5555-4555-8555-555555555555';
const OPTED_OUT_MEMBER_ID = '66666666-6666-4666-8666-666666666666';
const OUTSIDER_ID = '77777777-7777-4777-8777-777777777777';
const FAMILY_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const MEMORY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface FakeProfile {
  id: string;
  name?: string;
  expo_push_token?: string | null;
  notify_new_memories: boolean;
}

interface FakeState {
  memories: Array<{ id: string; user_id: string | null; family_id: string }>;
  families: Array<{ id: string; name: string; owner_id: string; deleted_at: string | null }>;
  memberships: Array<{ family_id: string; user_id: string; role: string }>;
  profiles: FakeProfile[];
  activityLog: Array<{ family_id: string; actor_id: string; kind: string; created_at: string }>;
  blocks: Array<{ family_id: string; blocker_user_id: string; blocked_user_id: string }>;
}

function baseState(overrides?: Partial<FakeState>): FakeState {
  return {
    memories: [{ id: MEMORY_ID, user_id: OWNER_ID, family_id: FAMILY_ID }],
    families: [
      { id: FAMILY_ID, name: "Rosa's family", owner_id: OWNER_ID, deleted_at: null },
      { id: OTHER_FAMILY_ID, name: 'Other family', owner_id: OUTSIDER_ID, deleted_at: null },
    ],
    memberships: [
      { family_id: FAMILY_ID, user_id: OWNER_ID, role: 'owner' },
      { family_id: FAMILY_ID, user_id: MANAGER_ID, role: 'manager' },
      { family_id: FAMILY_ID, user_id: VIEWER_ID, role: 'viewer' },
      { family_id: FAMILY_ID, user_id: OTHER_MEMBER_ID, role: 'viewer' },
      { family_id: FAMILY_ID, user_id: NO_TOKEN_MEMBER_ID, role: 'viewer' },
      { family_id: FAMILY_ID, user_id: OPTED_OUT_MEMBER_ID, role: 'viewer' },
      { family_id: OTHER_FAMILY_ID, user_id: OUTSIDER_ID, role: 'owner' },
    ],
    profiles: [
      { id: OWNER_ID, name: 'Rosa', expo_push_token: 'ExponentPushToken[rosa]', notify_new_memories: true },
      { id: MANAGER_ID, name: 'Manny', expo_push_token: 'ExponentPushToken[manny]', notify_new_memories: true },
      { id: VIEWER_ID, name: 'Vera', expo_push_token: 'ExponentPushToken[vera]', notify_new_memories: true },
      {
        id: OTHER_MEMBER_ID,
        name: 'Otto',
        expo_push_token: 'ExponentPushToken[otto]',
        notify_new_memories: true,
      },
      { id: NO_TOKEN_MEMBER_ID, name: 'NoToken', expo_push_token: null, notify_new_memories: true },
      {
        id: OPTED_OUT_MEMBER_ID,
        name: 'OptedOut',
        expo_push_token: 'ExponentPushToken[optedout]',
        notify_new_memories: false,
      },
    ],
    activityLog: [],
    blocks: [],
    ...overrides,
  };
}

function createFakeServiceClient(state: FakeState) {
  return {
    from(table: string) {
      if (table === 'memories') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.memories.find((memory) => memory.id === id) ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }

      if (table === 'families') {
        return {
          select: () => ({
            // getCallerFamilyRole path: .select(...).in('id', ids)
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: state.families.filter((family) => ids.includes(family.id)),
                error: null,
              }),
            // family-name lookup: .select('name').eq('id', ...).maybeSingle()
            eq: (_col: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.families.find((family) => family.id === id) ?? null,
                  error: null,
                }),
            }),
          }),
        };
      }

      if (table === 'family_memberships') {
        return {
          select: () => ({
            eq: (col: string, value: string) => {
              if (col === 'user_id') {
                // getCallerFamilyRole path: .eq('user_id', caller).in('family_id', ids)
                return {
                  in: (_famCol: string, familyIds: string[]) =>
                    Promise.resolve({
                      data: state.memberships.filter(
                        (m) => m.user_id === value && familyIds.includes(m.family_id),
                      ),
                      error: null,
                    }),
                };
              }

              // recipients path: .eq('family_id', fam).neq('user_id', actor)
              return {
                neq: (_userCol: string, excludeUserId: string) =>
                  Promise.resolve({
                    data: state.memberships
                      .filter((m) => m.family_id === value && m.user_id !== excludeUserId)
                      .map((m) => ({ user_id: m.user_id })),
                    error: null,
                  }),
              };
            },
          }),
        };
      }

      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.profiles.find((profile) => profile.id === id) ?? null,
                  error: null,
                }),
            }),
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: state.profiles.filter((profile) => ids.includes(profile.id)),
                error: null,
              }),
          }),
        };
      }

      if (table === 'blocked_family_accounts') {
        return {
          select: () => ({
            eq: (_familyCol: string, familyId: string) => ({
              eq: (_blockedCol: string, blockedUserId: string) =>
                Promise.resolve({
                  data: state.blocks
                    .filter((row) => row.family_id === familyId && row.blocked_user_id === blockedUserId)
                    .map((row) => ({ blocker_user_id: row.blocker_user_id })),
                  error: null,
                }),
            }),
          }),
        };
      }

      if (table === 'family_activity_log') {
        return {
          select: () => ({
            eq: (_c1: string, familyId: string) => ({
              eq: (_c2: string, actorId: string) => ({
                eq: (_c3: string, kind: string) => ({
                  gte: (_c4: string, cutoff: string) => ({
                    limit: (_n: number) =>
                      Promise.resolve({
                        data: state.activityLog.filter(
                          (row) =>
                            row.family_id === familyId &&
                            row.actor_id === actorId &&
                            row.kind === kind &&
                            row.created_at >= cutoff,
                        ),
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }),
          insert: (row: { family_id: string; actor_id: string; kind: string }) => {
            state.activityLog.push({ ...row, created_at: new Date().toISOString() });
            return Promise.resolve({ error: null });
          },
          delete: () => ({
            lt: (_col: string, cutoff: string) => {
              state.activityLog = state.activityLog.filter((row) => row.created_at >= cutoff);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function withMockedPush(run: () => Promise<void>): Promise<Array<{ to: string; title: string; body: string; data?: unknown }>> {
  const originalFetch = globalThis.fetch;
  const pushCalls: Array<{ to: string; title: string; body: string; data?: unknown }> = [];

  globalThis.fetch = (_url: string | URL | Request, init?: RequestInit) => {
    pushCalls.push(JSON.parse(init?.body as string));
    return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  };

  return run()
    .then(() => pushCalls)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

Deno.test('notify-family-activity rejects unauthenticated requests', async () => {
  const response = await handleNotifyFamilyActivity(
    new Request('http://localhost/notify-family-activity', {
      method: 'POST',
      body: JSON.stringify({ memoryId: MEMORY_ID }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('unknown memory id returns 404', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processNotifyFamilyActivity(
    client as never,
    OWNER_ID,
    '00000000-0000-4000-8000-000000000000',
  );

  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test('a caller who is not the memory creator is rejected, even a manager', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processNotifyFamilyActivity(client as never, MANAGER_ID, MEMORY_ID);

  assertEquals(response.status, 403);
  const body = await response.json();
  assertEquals(body.code, 'forbidden');
});

Deno.test('a creator whose role has since been demoted to viewer is rejected', async () => {
  const state = baseState({
    memories: [{ id: MEMORY_ID, user_id: VIEWER_ID, family_id: FAMILY_ID }],
  });
  const client = createFakeServiceClient(state);

  const response = await processNotifyFamilyActivity(client as never, VIEWER_ID, MEMORY_ID);

  assertEquals(response.status, 403);
  const body = await response.json();
  assertEquals(body.code, 'forbidden');
});

Deno.test('a creator from an unrelated family cannot announce a memory that is not theirs', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processNotifyFamilyActivity(client as never, OUTSIDER_ID, MEMORY_ID);

  assertEquals(response.status, 403);
});

Deno.test('a manager creator sends pushes to eligible members and excludes the actor, opted-out, and tokenless members', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { sent: true });
  // Eligible: MANAGER_ID, VIEWER_ID, OTHER_MEMBER_ID (3). Excluded: actor
  // (OWNER_ID), NO_TOKEN_MEMBER_ID (no token), OPTED_OUT_MEMBER_ID (opted
  // out).
  assertEquals(pushCalls.length, 3);

  const recipients = pushCalls.map((call) => call.to).sort();
  assertEquals(recipients, [
    'ExponentPushToken[manny]',
    'ExponentPushToken[otto]',
    'ExponentPushToken[vera]',
  ]);

  for (const call of pushCalls) {
    assertEquals(call.title, "Rosa's family");
    assertStringIncludes(call.body, 'Rosa');
    assertStringIncludes(call.body, 'added a new memory');
    assertEquals(call.data, { route: 'memory', familyId: FAMILY_ID, memoryId: MEMORY_ID });
  }

  // Activity log row written for the debounce window.
  assertEquals(state.activityLog.length, 1);
  assertEquals(state.activityLog[0].family_id, FAMILY_ID);
  assertEquals(state.activityLog[0].actor_id, OWNER_ID);
  assertEquals(state.activityLog[0].kind, 'new_memory');
});

Deno.test('a second memory from the same actor within 15 minutes is debounced (no push, no new log row)', async () => {
  const state = baseState({
    activityLog: [
      {
        family_id: FAMILY_ID,
        actor_id: OWNER_ID,
        kind: 'new_memory',
        created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ],
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { sent: false, reason: 'debounced' });
  assertEquals(pushCalls.length, 0);
  // No new row was inserted -- still exactly the one seeded row.
  assertEquals(state.activityLog.length, 1);
});

Deno.test('members who blocked the actor receive no alert and the response is indistinguishable', async () => {
  const unblockedState = baseState();
  const unblockedClient = createFakeServiceClient(unblockedState);
  let unblockedResponse!: Response;
  await withMockedPush(async () => {
    unblockedResponse = await processNotifyFamilyActivity(unblockedClient as never, OWNER_ID, MEMORY_ID);
  });

  const state = baseState({
    blocks: [{ family_id: FAMILY_ID, blocker_user_id: VIEWER_ID, blocked_user_id: OWNER_ID }],
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
  });

  const body = await response.json();
  assertEquals(body, await unblockedResponse.json());
  assertEquals(body, { sent: true });
  assertEquals(pushCalls.some((call) => call.to === 'ExponentPushToken[vera]'), false);
});

Deno.test('a log row older than 15 minutes does not debounce a new notification', async () => {
  const state = baseState({
    activityLog: [
      {
        family_id: FAMILY_ID,
        actor_id: OWNER_ID,
        kind: 'new_memory',
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      },
    ],
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.sent, true);
  assertEquals(pushCalls.length, 3);
});

Deno.test('a debounce row for a DIFFERENT actor in the same family does not debounce this actor', async () => {
  const state = baseState({
    activityLog: [
      {
        family_id: FAMILY_ID,
        actor_id: MANAGER_ID,
        kind: 'new_memory',
        created_at: new Date().toISOString(),
      },
    ],
  });
  const client = createFakeServiceClient(state);

  const response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.sent, true);
});

Deno.test('opportunistically prunes activity log rows older than 24h', async () => {
  const state = baseState({
    activityLog: [
      {
        family_id: FAMILY_ID,
        actor_id: MANAGER_ID,
        kind: 'new_memory',
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const client = createFakeServiceClient(state);

  await withMockedPush(async () => {
    const response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
    await response.body?.cancel();
  });

  // The stale MANAGER_ID row was pruned; only this call's fresh OWNER_ID row remains.
  assertEquals(state.activityLog.length, 1);
  assertEquals(state.activityLog[0].actor_id, OWNER_ID);
});

Deno.test('no recipients (solo family) still returns generic success', async () => {
  const state = baseState({
    memberships: [{ family_id: FAMILY_ID, user_id: OWNER_ID, role: 'owner' }],
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processNotifyFamilyActivity(client as never, OWNER_ID, MEMORY_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { sent: true });
  assertEquals(pushCalls.length, 0);
});

Deno.test('rejects non-POST methods', async () => {
  const response = await handleNotifyFamilyActivity(
    new Request('http://localhost/notify-family-activity', { method: 'GET' }),
  );

  assertEquals(response.status, 405);
});
