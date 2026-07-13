import { assertEquals } from 'jsr:@std/assert@1';

import {
  handleNotifyMemoryEngagement,
  processNotifyMemoryEngagement,
  validateNotifyMemoryEngagementRequest,
} from './index.ts';

const CREATOR_ID = '11111111-1111-4111-8111-111111111111';
const VIEWER_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_ID = '33333333-3333-4333-8333-333333333333';
const FAMILY_ID = '44444444-4444-4444-8444-444444444444';
const MEMORY_ID = '55555555-5555-4555-8555-555555555555';
const COMMENT_ID = '66666666-6666-4666-8666-666666666666';

interface FakeState {
  memories: Array<Record<string, unknown>>;
  families: Array<Record<string, unknown>>;
  memberships: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
  likes: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  activityLog: Array<Record<string, unknown>>;
}

function baseState(): FakeState {
  return {
    memories: [{ id: MEMORY_ID, user_id: CREATOR_ID, family_id: FAMILY_ID }],
    families: [{ id: FAMILY_ID, owner_id: CREATOR_ID, deleted_at: null, name: 'Rosa family' }],
    memberships: [
      { family_id: FAMILY_ID, user_id: CREATOR_ID, role: 'owner' },
      { family_id: FAMILY_ID, user_id: VIEWER_ID, role: 'viewer' },
    ],
    profiles: [
      {
        id: CREATOR_ID,
        name: 'Rosa',
        expo_push_token: 'ExponentPushToken[rosa]',
        notify_engagement: true,
      },
      { id: VIEWER_ID, name: 'Vera', expo_push_token: null, notify_engagement: true },
    ],
    likes: [{ memory_id: MEMORY_ID, user_id: VIEWER_ID }],
    comments: [{ id: COMMENT_ID, memory_id: MEMORY_ID, user_id: VIEWER_ID }],
    activityLog: [],
  };
}

function createFakeClient(state: FakeState) {
  const rowsFor = (table: string): Array<Record<string, unknown>> => {
    if (table === 'memories') return state.memories;
    if (table === 'families') return state.families;
    if (table === 'family_memberships') return state.memberships;
    if (table === 'user_profiles') return state.profiles;
    if (table === 'memory_likes') return state.likes;
    if (table === 'memory_comments') return state.comments;
    if (table === 'family_activity_log') return state.activityLog;
    throw new Error(`Unexpected table ${table}`);
  };

  const query = (table: string, initial = rowsFor(table)) => {
    let rows = [...initial];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return builder;
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return builder;
      },
      gte: (column: string, value: string) => {
        rows = rows.filter((row) => String(row[column]) >= value);
        return builder;
      },
      lt: (column: string, value: string) => {
        if (table === 'family_activity_log') {
          state.activityLog = state.activityLog.filter((row) => String(row[column]) >= value);
        }
        return Promise.resolve({ data: null, error: null });
      },
      limit: (count: number) => Promise.resolve({ data: rows.slice(0, count), error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: { data: typeof rows; error: null }) => void) =>
        resolve({ data: rows, error: null }),
    };
    return builder;
  };

  return {
    from(table: string) {
      return {
        select: () => query(table),
        insert: (row: Record<string, unknown>) => {
          if (table !== 'family_activity_log') throw new Error(`Unexpected insert ${table}`);
          state.activityLog.push({ ...row, created_at: new Date().toISOString() });
          return Promise.resolve({ error: null });
        },
        delete: () => query(table),
      };
    },
  };
}

async function withPushCapture(run: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  globalThis.fetch = (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  };
  try {
    await run();
    return calls;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test('notify-memory-engagement rejects unauthenticated requests', async () => {
  const response = await handleNotifyMemoryEngagement(new Request('http://localhost', {
    method: 'POST',
    body: JSON.stringify({ memoryId: MEMORY_ID, kind: 'like' }),
  }));
  assertEquals(response.status, 401);
});

Deno.test('comment notification validation requires an engagement id', () => {
  assertEquals(
    validateNotifyMemoryEngagementRequest({ memoryId: MEMORY_ID, kind: 'comment' }),
    'engagementId is required for comments',
  );
  assertEquals(
    validateNotifyMemoryEngagementRequest({
      memoryId: MEMORY_ID,
      kind: 'comment',
      engagementId: COMMENT_ID,
    }),
    null,
  );
});

Deno.test('a viewer can send a generic like notification to the memory creator', async () => {
  const state = baseState();
  const client = createFakeClient(state);
  const calls = await withPushCapture(async () => {
    const response = await processNotifyMemoryEngagement(client as never, VIEWER_ID, {
      memoryId: MEMORY_ID,
      kind: 'like',
    });
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { sent: true });
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, 'Vera liked a memory');
  assertEquals(calls[0].data, { route: 'memory', familyId: FAMILY_ID, memoryId: MEMORY_ID });
});

Deno.test('the creator is never notified about their own engagement', async () => {
  const state = baseState();
  state.likes.push({ memory_id: MEMORY_ID, user_id: CREATOR_ID });
  const response = await processNotifyMemoryEngagement(
    createFakeClient(state) as never,
    CREATOR_ID,
    { memoryId: MEMORY_ID, kind: 'like' },
  );
  assertEquals(await response.json(), { sent: false, reason: 'self' });
});

Deno.test('the recipient engagement preference disables delivery', async () => {
  const state = baseState();
  state.profiles[0].notify_engagement = false;
  const response = await processNotifyMemoryEngagement(
    createFakeClient(state) as never,
    VIEWER_ID,
    { memoryId: MEMORY_ID, kind: 'like' },
  );
  assertEquals(await response.json(), { sent: false, reason: 'disabled' });
});

Deno.test('a comment must belong to the caller and target memory', async () => {
  const state = baseState();
  const outsiderResponse = await processNotifyMemoryEngagement(
    createFakeClient(state) as never,
    OUTSIDER_ID,
    { memoryId: MEMORY_ID, kind: 'comment', engagementId: COMMENT_ID },
  );
  assertEquals(outsiderResponse.status, 403);

  const wrongAuthorResponse = await processNotifyMemoryEngagement(
    createFakeClient(state) as never,
    CREATOR_ID,
    { memoryId: MEMORY_ID, kind: 'comment', engagementId: COMMENT_ID },
  );
  assertEquals(wrongAuthorResponse.status, 404);
});

Deno.test('repeat like notifications for the same actor and memory are debounced', async () => {
  const state = baseState();
  state.activityLog.push({
    family_id: FAMILY_ID,
    actor_id: VIEWER_ID,
    kind: `engagement_like:${MEMORY_ID}`,
    created_at: new Date().toISOString(),
  });
  const response = await processNotifyMemoryEngagement(
    createFakeClient(state) as never,
    VIEWER_ID,
    { memoryId: MEMORY_ID, kind: 'like' },
  );
  assertEquals(await response.json(), { sent: false, reason: 'debounced' });
});
