import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  extractClientIp,
  handleRedeemFamilyInvite,
  IP_ATTEMPT_LIMIT_PER_HOUR,
  normalizeInviteCode,
  processRedemption,
  USER_ATTEMPT_LIMIT_PER_HOUR,
} from './index.ts';

const REDEEMER_ID = '11111111-1111-4111-8111-111111111111';
const INVITER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';
const INVITE_ID = '44444444-4444-4444-8444-444444444444';

const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

interface FakeInvite {
  id: string;
  code: string;
  family_id: string;
  role: string;
  status: string;
  invited_by: string;
  expires_at: string;
  redeemed_by?: string | null;
  redeemed_at?: string | null;
}

interface FakeState {
  invites: FakeInvite[];
  families: Array<{ id: string; name: string; deleted_at: string | null }>;
  memberships: Array<{ family_id: string; user_id: string }>;
  profiles: Array<{ id: string; name?: string; expo_push_token?: string | null }>;
  attempts: Array<{ user_id: string; ip: string | null; attempted_at: string }>;
}

/**
 * Semantic fake of the service-role client: the atomic-claim UPDATE applies
 * its real conditions (status still pending, expiry in the future) against
 * in-memory rows, and rate-limit counts are computed from the attempts
 * array, so tests exercise the same decision points as production SQL.
 */
function createFakeServiceClient(state: FakeState) {
  return {
    from(table: string) {
      if (table === 'invite_redemption_attempts') {
        return {
          insert: (row: { user_id: string; ip: string | null }) =>
            Promise.resolve(
              (state.attempts.push({ ...row, attempted_at: new Date().toISOString() }),
              { error: null }),
            ),
          delete: () => ({
            lt: (_col: string, cutoff: string) => {
              state.attempts = state.attempts.filter((a) => a.attempted_at >= cutoff);
              return Promise.resolve({ error: null });
            },
          }),
          select: (_cols: string, _opts: { count: string; head: boolean }) => ({
            eq: (col: 'user_id' | 'ip', value: string) => ({
              gte: (_c: string, since: string) =>
                Promise.resolve({
                  count: state.attempts.filter(
                    (a) => a[col] === value && a.attempted_at >= since,
                  ).length,
                  error: null,
                }),
            }),
          }),
        };
      }

      if (table === 'family_invites') {
        return {
          select: () => ({
            eq: (_col: string, code: string) => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: state.invites.find((invite) => invite.code === code) ?? null,
                  error: null,
                }),
            }),
          }),
          update: (values: Partial<FakeInvite>) => ({
            eq: (_idCol: string, id: string) => ({
              eq: (_statusCol: string, requiredStatus: string) => ({
                gt: (_expiresCol: string, nowIso: string) => ({
                  select: () => ({
                    maybeSingle: () => {
                      const invite = state.invites.find((candidate) => candidate.id === id);
                      if (
                        invite &&
                        invite.status === requiredStatus &&
                        invite.expires_at > nowIso
                      ) {
                        Object.assign(invite, values);
                        return Promise.resolve({ data: { id }, error: null });
                      }
                      return Promise.resolve({ data: null, error: null });
                    },
                  }),
                }),
              }),
            }),
          }),
        };
      }

      if (table === 'families') {
        return {
          select: () => ({
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
            eq: (_famCol: string, familyId: string) => ({
              eq: (_userCol: string, userId: string) => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data:
                      state.memberships.find(
                        (m) => m.family_id === familyId && m.user_id === userId,
                      ) ?? null,
                    error: null,
                  }),
              }),
            }),
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
        code: 'sunny-tiger-lake',
        family_id: FAMILY_ID,
        role: 'viewer',
        status: 'pending',
        invited_by: INVITER_ID,
        expires_at: IN_A_WEEK,
      },
    ],
    families: [{ id: FAMILY_ID, name: "Rosa's family", deleted_at: null }],
    memberships: [{ family_id: FAMILY_ID, user_id: INVITER_ID }],
    profiles: [
      { id: REDEEMER_ID, name: 'Abuela Carmen' },
      { id: INVITER_ID, name: 'Rosa', expo_push_token: 'ExponentPushToken[rosa]' },
    ],
    attempts: [],
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

Deno.test('normalizeInviteCode lowercases, trims, and collapses whitespace/dashes', () => {
  assertEquals(normalizeInviteCode('  Sunny  Tiger--Lake '), 'sunny-tiger-lake');
  assertEquals(normalizeInviteCode('SUNNY-TIGER-LAKE'), 'sunny-tiger-lake');
  assertEquals(normalizeInviteCode('sunny tiger lake'), 'sunny-tiger-lake');
  assertEquals(normalizeInviteCode('-sunny-tiger-lake-'), 'sunny-tiger-lake');
  assertEquals(normalizeInviteCode('   '), '');
});

Deno.test('extractClientIp takes only the LAST x-forwarded-for hop (platform-appended)', () => {
  const spoofed = new Request('http://localhost/redeem-family-invite', {
    headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9' },
  });
  assertEquals(extractClientIp(spoofed), '203.0.113.9');

  const single = new Request('http://localhost/redeem-family-invite', {
    headers: { 'x-forwarded-for': '203.0.113.9' },
  });
  assertEquals(extractClientIp(single), '203.0.113.9');

  const missing = new Request('http://localhost/redeem-family-invite');
  assertEquals(extractClientIp(missing), null);
});

Deno.test('redeem-family-invite rejects unauthenticated requests', async () => {
  const response = await handleRedeemFamilyInvite(
    new Request('http://localhost/redeem-family-invite', {
      method: 'POST',
      body: JSON.stringify({ code: 'sunny-tiger-lake' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('happy path: claims the invite, pushes to the inviter, returns familyName + role', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processRedemption(
      client as never,
      REDEEMER_ID,
      '  SUNNY  tiger--LAKE ',
      '203.0.113.9',
    );
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { familyName: "Rosa's family", role: 'viewer' });

  // Invite is atomically claimed.
  assertEquals(state.invites[0].status, 'redeemed');
  assertEquals(state.invites[0].redeemed_by, REDEEMER_ID);
  assertEquals(typeof state.invites[0].redeemed_at, 'string');

  // Attempt logged with the IP.
  assertEquals(state.attempts.length, 1);
  assertEquals(state.attempts[0].user_id, REDEEMER_ID);
  assertEquals(state.attempts[0].ip, '203.0.113.9');

  // Inviter push carries the redeemer + family names.
  assertEquals(pushCalls.length, 1);
  const push = pushCalls[0] as { to: string; body: string };
  assertEquals(push.to, 'ExponentPushToken[rosa]');
  assertStringIncludes(push.body, 'Abuela Carmen wants to join');
  assertStringIncludes(push.body, "Rosa's family");
});

Deno.test('a push failure does not fail the redemption', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('expo down'));

  try {
    const response = await processRedemption(
      client as never,
      REDEEMER_ID,
      'sunny-tiger-lake',
      null,
    );
    assertEquals(response.status, 200);
    assertEquals(state.invites[0].status, 'redeemed');
    await response.body?.cancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

for (const [label, mutate] of [
  ['expired', (state: FakeState) => (state.invites[0].expires_at = YESTERDAY)],
  ['revoked', (state: FakeState) => (state.invites[0].status = 'revoked')],
  ['already redeemed', (state: FakeState) => (state.invites[0].status = 'redeemed')],
  [
    'family soft-deleted',
    (state: FakeState) => (state.families[0].deleted_at = new Date().toISOString()),
  ],
  ['unknown code', (state: FakeState) => (state.invites[0].code = 'other-word-code')],
] as Array<[string, (state: FakeState) => void]>) {
  Deno.test(`${label} code returns the same generic invalid_code error`, async () => {
    const state = baseState();
    mutate(state);
    const client = createFakeServiceClient(state);

    const response = await processRedemption(
      client as never,
      REDEEMER_ID,
      'sunny-tiger-lake',
      null,
    );

    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.code, 'invalid_code');
    assertEquals(body.error, 'That invite code is invalid or has expired.');
    // The attempt is still logged even though the code failed.
    assertEquals(state.attempts.length, 1);
  });
}

Deno.test('rejects a caller who is already a member of the invite family', async () => {
  const state = baseState();
  state.memberships.push({ family_id: FAMILY_ID, user_id: REDEEMER_ID });
  const client = createFakeServiceClient(state);

  const response = await processRedemption(
    client as never,
    REDEEMER_ID,
    'sunny-tiger-lake',
    null,
  );

  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.code, 'already_member');
  // The invite stays claimable by someone else.
  assertEquals(state.invites[0].status, 'pending');
});

Deno.test('per-user rate limit: the 11th attempt within an hour is rejected before any code check', async () => {
  const now = Date.now();
  const state = baseState({
    attempts: Array.from({ length: USER_ATTEMPT_LIMIT_PER_HOUR }, (_, i) => ({
      user_id: REDEEMER_ID,
      ip: null,
      attempted_at: new Date(now - (i + 1) * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const response = await processRedemption(
    client as never,
    REDEEMER_ID,
    'sunny-tiger-lake', // a VALID code -- the limit must trip regardless
    null,
  );

  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.code, 'rate_limited');
  // Valid code was never claimed.
  assertEquals(state.invites[0].status, 'pending');
  // The rejected attempt itself was still logged (11 total now).
  assertEquals(state.attempts.length, USER_ATTEMPT_LIMIT_PER_HOUR + 1);
});

Deno.test('attempts older than an hour do not count against the per-user limit', async () => {
  const now = Date.now();
  const state = baseState({
    attempts: Array.from({ length: USER_ATTEMPT_LIMIT_PER_HOUR }, (_, i) => ({
      user_id: REDEEMER_ID,
      ip: null,
      attempted_at: new Date(now - (2 + i) * 60 * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  await withMockedPush(async () => {
    response = await processRedemption(client as never, REDEEMER_ID, 'sunny-tiger-lake', null);
  });

  assertEquals(response.status, 200);
  await response.body?.cancel();
});

Deno.test('per-IP rate limit: shared IP over the limit is rejected even for a fresh user', async () => {
  const now = Date.now();
  const state = baseState({
    attempts: Array.from({ length: IP_ATTEMPT_LIMIT_PER_HOUR }, (_, i) => ({
      user_id: `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ip: '203.0.113.9',
      attempted_at: new Date(now - (i + 1) * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const response = await processRedemption(
    client as never,
    REDEEMER_ID, // fresh user, zero prior attempts of their own
    'sunny-tiger-lake',
    '203.0.113.9',
  );

  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.code, 'rate_limited');
});

Deno.test('a spoofed x-forwarded-for PREFIX does not evade the IP limit -- only the last hop counts', async () => {
  const now = Date.now();
  // The attacker's real IP (the platform-appended last hop) is saturated;
  // they prepend a fresh-looking IP to try to dodge the limit.
  const state = baseState({
    attempts: Array.from({ length: IP_ATTEMPT_LIMIT_PER_HOUR }, (_, i) => ({
      user_id: `99999999-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ip: '203.0.113.9',
      attempted_at: new Date(now - (i + 1) * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const request = new Request('http://localhost/redeem-family-invite', {
    method: 'POST',
    headers: { 'x-forwarded-for': '10.0.0.42, 203.0.113.9' },
  });
  const ip = extractClientIp(request);
  assertEquals(ip, '203.0.113.9'); // NOT the spoofed 10.0.0.42 prefix

  const response = await processRedemption(client as never, REDEEMER_ID, 'sunny-tiger-lake', ip);

  assertEquals(response.status, 429);
  await response.body?.cancel();
});

Deno.test('missing IP skips the per-IP limit but still enforces the per-user limit', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  let response!: Response;
  await withMockedPush(async () => {
    response = await processRedemption(client as never, REDEEMER_ID, 'sunny-tiger-lake', null);
  });

  assertEquals(response.status, 200);
  assertEquals(state.attempts[0].ip, null);
  await response.body?.cancel();
});

Deno.test('two redemptions of the same code: only the first wins the atomic claim', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);
  const otherUser = '55555555-5555-4555-8555-555555555555';

  let first!: Response;
  await withMockedPush(async () => {
    first = await processRedemption(client as never, REDEEMER_ID, 'sunny-tiger-lake', null);
  });
  const second = await processRedemption(client as never, otherUser, 'sunny-tiger-lake', null);

  assertEquals(first.status, 200);
  assertEquals(second.status, 400);
  const secondBody = await second.json();
  assertEquals(secondBody.code, 'invalid_code');
  assertEquals(state.invites[0].redeemed_by, REDEEMER_ID);
  await first.body?.cancel();
});

Deno.test('opportunistically prunes attempt rows older than 24h', async () => {
  const state = baseState({
    attempts: [
      {
        user_id: REDEEMER_ID,
        ip: null,
        attempted_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      },
    ],
  });
  const client = createFakeServiceClient(state);

  let response!: Response;
  await withMockedPush(async () => {
    response = await processRedemption(client as never, REDEEMER_ID, 'sunny-tiger-lake', null);
  });

  assertEquals(response.status, 200);
  // The 25h-old row is gone; only the fresh attempt remains.
  assertEquals(state.attempts.length, 1);
  assertEquals(state.attempts[0].ip, null);
  await response.body?.cancel();
});
