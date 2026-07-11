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
  const familyUpdates: Array<{ id: string; deleted_at: unknown }> = [];

  return {
    familyUpdates,
    client: {
      from(table: string) {
        if (table === 'families') {
          return {
            select: () => ({
              eq: () => ({
                is: async () => ({ data: options.ownedFamilies, error: null }),
              }),
            }),
            update: (values: { deleted_at: unknown }) => ({
              eq: async (_col: string, id: string) => {
                familyUpdates.push({ id, deleted_at: values.deleted_at });
                return { error: null };
              },
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

Deno.test('softDeleteOwnedFamiliesAndNotify soft-deletes every owned family and pushes only to other members with a token', async () => {
  const { client, familyUpdates } = fakeServiceClient({
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
    await softDeleteOwnedFamiliesAndNotify(client as never, OWNER_ID);
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Both owned families get soft-deleted.
  assertEquals(familyUpdates.length, 2);
  assertEquals(familyUpdates.every((update) => typeof update.deleted_at === 'string'), true);

  // Only the member WITH a push token gets notified; the tokenless member
  // and family B (no other members) are silently skipped.
  assertEquals(pushCalls.length, 1);
  assertEquals((pushCalls[0] as { to: string }).to, 'ExponentPushToken[abc]');
});

Deno.test('softDeleteOwnedFamiliesAndNotify is a no-op when the caller owns no families', async () => {
  const { client, familyUpdates } = fakeServiceClient({
    ownedFamilies: [],
    memberships: {},
    profiles: [],
  });

  await softDeleteOwnedFamiliesAndNotify(client as never, OWNER_ID);

  assertEquals(familyUpdates.length, 0);
});
