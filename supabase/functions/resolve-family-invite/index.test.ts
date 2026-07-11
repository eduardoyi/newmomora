import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { handleResolveFamilyInvite, processResolution } from './index.ts';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const OUTSIDER_ID = '44444444-4444-4444-8444-444444444444';
const REDEEMER_ID = '55555555-5555-4555-8555-555555555555';
const FAMILY_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_FAMILY_ID = '77777777-7777-4777-8777-777777777777';
const INVITE_ID = '88888888-8888-4888-8888-888888888888';

interface FakeInvite {
  id: string;
  family_id: string;
  role: string;
  status: string;
  redeemed_by: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
}

interface FakeState {
  invites: FakeInvite[];
  families: Array<{ id: string; name: string; owner_id: string; deleted_at: string | null }>;
  memberships: Array<{ family_id: string; user_id: string; role: string }>;
  profiles: Array<{ id: string; expo_push_token?: string | null; active_family_id?: string | null }>;
  membershipInsertError?: { code: string; message: string } | null;
}

function createFakeServiceClient(state: FakeState) {
  return {
    from(table: string) {
      if (table === 'family_invites') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.invites.find((invite) => invite.id === id) ?? null,
                  error: null,
                }),
            }),
          }),
          update: (values: Partial<FakeInvite>) => ({
            eq: (_idCol: string, id: string) => ({
              eq: (_statusCol: string, requiredStatus: string) => {
                const invite = state.invites.find((candidate) => candidate.id === id);
                if (invite && invite.status === requiredStatus) {
                  Object.assign(invite, values);
                }
                return Promise.resolve({ error: null });
              },
            }),
          }),
        };
      }

      if (table === 'families') {
        return {
          select: (columns: string) => ({
            // getCallerFamilyRole path: .select(...).in('id', ids)
            in: (_col: string, ids: string[]) =>
              Promise.resolve({
                data: state.families.filter((family) => ids.includes(family.id)),
                error: null,
              }),
            // push path: .select('name').eq('id', ...).maybeSingle()
            eq: (_col: string, id: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.families.find((family) => family.id === id) ?? null,
                  error: null,
                }),
            }),
            _columns: columns,
          }),
        };
      }

      if (table === 'family_memberships') {
        return {
          select: () => ({
            // getCallerFamilyRole path: .eq('user_id', caller).in('family_id', ids)
            eq: (_col: string, userId: string) => ({
              in: (_famCol: string, familyIds: string[]) =>
                Promise.resolve({
                  data: state.memberships.filter(
                    (m) => m.user_id === userId && familyIds.includes(m.family_id),
                  ),
                  error: null,
                }),
            }),
          }),
          insert: (row: { family_id: string; user_id: string; role: string }) => {
            if (state.membershipInsertError) {
              return Promise.resolve({ error: state.membershipInsertError });
            }
            state.memberships.push(row);
            return Promise.resolve({ error: null });
          },
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
          }),
          update: (values: { active_family_id: string }) => ({
            eq: (_col: string, id: string) => {
              const profile = state.profiles.find((candidate) => candidate.id === id);
              if (profile) {
                profile.active_family_id = values.active_family_id;
              }
              return Promise.resolve({ error: null });
            },
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function baseState(overrides?: Partial<FakeState>): FakeState {
  return {
    invites: [
      {
        id: INVITE_ID,
        family_id: FAMILY_ID,
        role: 'viewer',
        status: 'redeemed',
        redeemed_by: REDEEMER_ID,
      },
    ],
    families: [
      { id: FAMILY_ID, name: "Rosa's family", owner_id: OWNER_ID, deleted_at: null },
      { id: OTHER_FAMILY_ID, name: 'Other family', owner_id: OUTSIDER_ID, deleted_at: null },
    ],
    memberships: [
      { family_id: FAMILY_ID, user_id: OWNER_ID, role: 'owner' },
      { family_id: FAMILY_ID, user_id: MANAGER_ID, role: 'manager' },
      { family_id: FAMILY_ID, user_id: VIEWER_ID, role: 'viewer' },
      // A manager elsewhere must NOT be able to resolve this family's invites.
      { family_id: OTHER_FAMILY_ID, user_id: OUTSIDER_ID, role: 'manager' },
    ],
    profiles: [
      { id: REDEEMER_ID, expo_push_token: 'ExponentPushToken[carmen]', active_family_id: null },
    ],
    ...overrides,
  };
}

function withMockedPush(run: () => Promise<void>): Promise<unknown[]> {
  const originalFetch = globalThis.fetch;
  const pushCalls: unknown[] = [];

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

Deno.test('resolve-family-invite rejects unauthenticated requests', async () => {
  const response = await handleResolveFamilyInvite(
    new Request('http://localhost/resolve-family-invite', {
      method: 'POST',
      body: JSON.stringify({ inviteId: INVITE_ID, action: 'approve' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('approve inserts the membership, sets active_family_id, marks approved, and pushes', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'approve');
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, status: 'approved' });

  // Membership inserted with the invite's role.
  const inserted = state.memberships.find((m) => m.user_id === REDEEMER_ID);
  assertEquals(inserted?.family_id, FAMILY_ID);
  assertEquals(inserted?.role, 'viewer');

  // active_family_id ALWAYS points at the new family after approval.
  assertEquals(state.profiles[0].active_family_id, FAMILY_ID);

  // Invite resolved.
  assertEquals(state.invites[0].status, 'approved');
  assertEquals(state.invites[0].resolved_by, OWNER_ID);
  assertEquals(typeof state.invites[0].resolved_at, 'string');

  // Redeemer got the "You're in!" push.
  assertEquals(pushCalls.length, 1);
  const push = pushCalls[0] as { to: string; body: string };
  assertEquals(push.to, 'ExponentPushToken[carmen]');
  assertStringIncludes(push.body, "You're in!");
  assertStringIncludes(push.body, "Rosa's family");
});

Deno.test('a manager (not just the owner) can approve', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  let response!: Response;
  await withMockedPush(async () => {
    response = await processResolution(client as never, MANAGER_ID, INVITE_ID, 'approve');
  });

  assertEquals(response.status, 200);
  assertEquals(state.invites[0].status, 'approved');
  await response.body?.cancel();
});

Deno.test('reject marks the invite rejected and does NOT insert a membership or touch active_family_id', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'reject');

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, status: 'rejected' });
  assertEquals(state.invites[0].status, 'rejected');
  assertEquals(state.invites[0].resolved_by, OWNER_ID);
  assertEquals(
    state.memberships.some((m) => m.user_id === REDEEMER_ID),
    false,
  );
  assertEquals(state.profiles[0].active_family_id, null);
});

for (const [label, callerId] of [
  ['a viewer of the family', VIEWER_ID],
  ['a manager of a DIFFERENT family', OUTSIDER_ID],
] as Array<[string, string]>) {
  Deno.test(`${label} cannot resolve the invite`, async () => {
    const state = baseState();
    const client = createFakeServiceClient(state);

    const response = await processResolution(client as never, callerId, INVITE_ID, 'approve');

    assertEquals(response.status, 403);
    const body = await response.json();
    assertEquals(body.code, 'forbidden');
    assertEquals(state.invites[0].status, 'redeemed');
    assertEquals(
      state.memberships.some((m) => m.user_id === REDEEMER_ID),
      false,
    );
  });
}

for (const status of ['pending', 'approved', 'rejected', 'revoked']) {
  Deno.test(`an invite with status '${status}' is not resolvable`, async () => {
    const state = baseState();
    state.invites[0].status = status;
    const client = createFakeServiceClient(state);

    const response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'approve');

    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.code, 'invalid_status');
  });
}

Deno.test('unknown invite id returns 404', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processResolution(
    client as never,
    OWNER_ID,
    '99999999-9999-4999-8999-999999999999',
    'approve',
  );

  assertEquals(response.status, 404);
  await response.body?.cancel();
});

Deno.test('the 50-member-cap trigger error surfaces as a clean family_full error', async () => {
  const state = baseState({
    membershipInsertError: { code: 'P0001', message: 'Maximum 50 members per family' },
  });
  const client = createFakeServiceClient(state);

  const response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'approve');

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.code, 'family_full');
  // Invite stays redeemed -- nothing was resolved.
  assertEquals(state.invites[0].status, 'redeemed');
});

Deno.test('a duplicate-membership (23505) insert is idempotent: approval still completes', async () => {
  const state = baseState({
    membershipInsertError: { code: '23505', message: 'duplicate key value' },
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  await withMockedPush(async () => {
    response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'approve');
  });

  assertEquals(response.status, 200);
  assertEquals(state.invites[0].status, 'approved');
  assertEquals(state.profiles[0].active_family_id, FAMILY_ID);
  await response.body?.cancel();
});

Deno.test('approve fails cleanly when the redeemer account no longer exists', async () => {
  const state = baseState();
  state.invites[0].redeemed_by = null;
  const client = createFakeServiceClient(state);

  const response = await processResolution(client as never, OWNER_ID, INVITE_ID, 'approve');

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.code, 'invalid_status');
});
