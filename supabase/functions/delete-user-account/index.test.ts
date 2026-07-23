import { assertEquals } from 'jsr:@std/assert@1';
import { handleDeleteUserAccount, softDeleteOwnedFamiliesAndNotify } from './index.ts';

Deno.test('delete-user-account rejects unauthenticated requests', async () => {
  const response = await handleDeleteUserAccount(
    new Request('http://localhost/delete-user-account', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const FAMILY_A = '22222222-2222-4222-8222-222222222222';
const FAMILY_B = '33333333-3333-4333-8333-333333333333';
const MEMBER_WITH_TOKEN = '44444444-4444-4444-8444-444444444444';
const MEMBER_WITHOUT_TOKEN = '55555555-5555-4555-8555-555555555555';

function fakeServiceClient(options: {
  ownedFamilies: Array<{ id: string }>;
  memberships: Record<string, Array<{ user_id: string }>>;
  profiles: Array<{ id: string; expo_push_token: string | null }>;
}) {
  const familyLookups: Array<{ ownerId: string; operationToken: string }> = [];

  return {
    familyLookups,
    client: {
      from(table: string) {
        if (table === 'families') {
          return {
            select: () => ({
              eq: (_column: string, ownerId: string) => ({
                eq: async (_tokenColumn: string, operationToken: string) => {
                  familyLookups.push({ ownerId, operationToken });
                  return { data: options.ownedFamilies, error: null };
                },
              }),
            }),
          };
        }

        if (table === 'family_memberships') {
          return {
            select: () => ({
              eq: (_col: string, familyId: string) => ({
                neq: async () => ({
                  data: options.memberships[familyId] ?? [],
                  error: null,
                }),
              }),
            }),
          };
        }

        if (table === 'user_profiles') {
          return {
            select: () => ({
              in: async (_col: string, ids: string[]) => ({
                data: options.profiles.filter((p) => ids.includes(p.id)),
                error: null,
              }),
            }),
          };
        }

        throw new Error(`Unexpected table ${table}`);
      },
    },
  };
}

Deno.test('softDeleteOwnedFamiliesAndNotify notifies only families marked by the exact schedule token', async () => {
  const { client, familyLookups } = fakeServiceClient({
    ownedFamilies: [{ id: FAMILY_A }, { id: FAMILY_B }],
    memberships: {
      [FAMILY_A]: [{ user_id: MEMBER_WITH_TOKEN }, { user_id: MEMBER_WITHOUT_TOKEN }],
      [FAMILY_B]: [],
    },
    profiles: [
      { id: MEMBER_WITH_TOKEN, expo_push_token: 'ExponentPushToken[abc]' },
      { id: MEMBER_WITHOUT_TOKEN, expo_push_token: null },
    ],
  });

  const originalFetch = globalThis.fetch;
  const pushCalls: unknown[] = [];

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    pushCalls.push(JSON.parse(init?.body as string));
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };

  try {
    await softDeleteOwnedFamiliesAndNotify(client as never, OWNER_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(familyLookups, [{
    ownerId: OWNER_ID,
    operationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }]);

  // Only the member WITH a push token gets notified; the tokenless member
  // and family B (no other members) are silently skipped.
  assertEquals(pushCalls.length, 1);
  assertEquals((pushCalls[0] as { to: string }).to, 'ExponentPushToken[abc]');
});

Deno.test('softDeleteOwnedFamiliesAndNotify is a no-op when the schedule owns no active family rows', async () => {
  const { client, familyLookups } = fakeServiceClient({
    ownedFamilies: [],
    memberships: {},
    profiles: [],
  });

  await softDeleteOwnedFamiliesAndNotify(client as never, OWNER_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

  assertEquals(familyLookups.length, 1);
});
