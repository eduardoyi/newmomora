import { assertEquals } from 'jsr:@std/assert@1';
import {
  CODE_PREVIEW_LIMIT_PER_HOUR,
  extractClientIp,
  handlePreviewFamilyInvite,
  normalizeInviteCode,
  processPreview,
} from './index.ts';

const INVITER_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';

const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

interface FakeInvite {
  code: string;
  family_id: string;
  status: string;
  expires_at: string;
  invited_by: string;
}

interface FakeState {
  invites: FakeInvite[];
  families: Array<{ id: string; name: string; deleted_at: string | null }>;
  profiles: Array<{ id: string; name?: string }>;
  attempts: Array<{ code: string; ip: string | null; attempted_at: string }>;
}

function createFakeServiceClient(state: FakeState) {
  return {
    from(table: string) {
      if (table === 'invite_preview_attempts') {
        return {
          insert: (row: { code: string; ip: string | null }) =>
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
            eq: (_col: 'code', value: string) => ({
              gte: (_c: string, since: string) =>
                Promise.resolve({
                  count: state.attempts.filter(
                    (a) => a.code === value && a.attempted_at >= since,
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
        code: 'sunny-tiger-lake',
        family_id: FAMILY_ID,
        status: 'pending',
        expires_at: IN_A_WEEK,
        invited_by: INVITER_ID,
      },
    ],
    families: [{ id: FAMILY_ID, name: "Rosa's family", deleted_at: null }],
    profiles: [{ id: INVITER_ID, name: 'Rosa' }],
    attempts: [],
    ...overrides,
  };
}

Deno.test('normalizeInviteCode lowercases, trims, and collapses whitespace/dashes', () => {
  assertEquals(normalizeInviteCode('  Sunny  Tiger--Lake '), 'sunny-tiger-lake');
  assertEquals(normalizeInviteCode('SUNNY-TIGER-LAKE'), 'sunny-tiger-lake');
});

Deno.test('extractClientIp takes only the LAST x-forwarded-for hop', () => {
  const spoofed = new Request('http://localhost/preview-family-invite', {
    headers: { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 203.0.113.9' },
  });
  assertEquals(extractClientIp(spoofed), '203.0.113.9');
});

Deno.test('preview-family-invite rejects unauthenticated requests', async () => {
  const response = await handlePreviewFamilyInvite(
    new Request('http://localhost/preview-family-invite', {
      method: 'POST',
      body: JSON.stringify({ code: 'sunny-tiger-lake' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('preview-family-invite rejects unsupported methods', async () => {
  const response = await handlePreviewFamilyInvite(
    new Request('http://localhost/preview-family-invite', { method: 'GET' }),
  );
  assertEquals(response.status, 405);
});

Deno.test('happy path: returns ONLY familyName + inviterName, never membership/email/role/family id', async () => {
  const state = baseState();
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, '  SUNNY  tiger--LAKE ', '203.0.113.9');

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { familyName: "Rosa's family", inviterName: 'Rosa' });
  assertEquals(Object.keys(body).sort(), ['familyName', 'inviterName']);

  // Attempt logged by normalized code, not raw input.
  assertEquals(state.attempts.length, 1);
  assertEquals(state.attempts[0].code, 'sunny-tiger-lake');
  assertEquals(state.attempts[0].ip, '203.0.113.9');
});

Deno.test('falls back to a generic inviter label when the inviter profile is gone', async () => {
  const state = baseState({ profiles: [] });
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, 'sunny-tiger-lake', null);

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { familyName: "Rosa's family", inviterName: 'A family member' });
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

    const response = await processPreview(client as never, 'sunny-tiger-lake', null);

    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.code, 'invalid_code');
    assertEquals(body.error, 'That invite code is invalid or has expired.');
    // The attempt is still logged even though the code failed.
    assertEquals(state.attempts.length, 1);
  });
}

Deno.test('rate limit: the (N+1)th preview of the SAME code within an hour is rejected', async () => {
  const now = Date.now();
  const state = baseState({
    attempts: Array.from({ length: CODE_PREVIEW_LIMIT_PER_HOUR }, (_, i) => ({
      code: 'sunny-tiger-lake',
      ip: null,
      attempted_at: new Date(now - (i + 1) * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, 'sunny-tiger-lake', null);

  assertEquals(response.status, 429);
  const body = await response.json();
  assertEquals(body.code, 'rate_limited');
  assertEquals(state.attempts.length, CODE_PREVIEW_LIMIT_PER_HOUR + 1);
});

Deno.test('rate limit is per-code, not per-caller: a DIFFERENT code is unaffected by another code being hammered', async () => {
  const now = Date.now();
  const state = baseState({
    invites: [
      {
        code: 'sunny-tiger-lake',
        family_id: FAMILY_ID,
        status: 'pending',
        expires_at: IN_A_WEEK,
        invited_by: INVITER_ID,
      },
      {
        code: 'quiet-otter-river',
        family_id: FAMILY_ID,
        status: 'pending',
        expires_at: IN_A_WEEK,
        invited_by: INVITER_ID,
      },
    ],
    attempts: Array.from({ length: CODE_PREVIEW_LIMIT_PER_HOUR + 5 }, (_, i) => ({
      code: 'sunny-tiger-lake',
      ip: null,
      attempted_at: new Date(now - (i + 1) * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, 'quiet-otter-river', null);

  assertEquals(response.status, 200);
});

Deno.test('attempts older than an hour do not count against the per-code limit', async () => {
  const now = Date.now();
  const state = baseState({
    attempts: Array.from({ length: CODE_PREVIEW_LIMIT_PER_HOUR }, (_, i) => ({
      code: 'sunny-tiger-lake',
      ip: null,
      attempted_at: new Date(now - (2 + i) * 60 * 60 * 1000).toISOString(),
    })),
  });
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, 'sunny-tiger-lake', null);

  assertEquals(response.status, 200);
});

Deno.test('opportunistically prunes attempt rows older than 24h', async () => {
  const state = baseState({
    attempts: [
      { code: 'sunny-tiger-lake', ip: null, attempted_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() },
    ],
  });
  const client = createFakeServiceClient(state);

  const response = await processPreview(client as never, 'sunny-tiger-lake', null);

  assertEquals(response.status, 200);
  assertEquals(state.attempts.length, 1);
});

// ── WP-SEC carve-out: an anonymous JWT must NOT be rejected here ──────────
//
// Unlike every other normal Edge Function (which now goes through
// getAuthenticatedNonAnonymousUser), this one calls getAuthenticatedUser
// directly. This end-to-end test exercises the REAL handler (not a fake
// dependency) against a mocked GoTrue response + mocked PostgREST calls, so
// a future accidental swap back to the strict helper would fail this test.

const AUTH_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

function withAuthEnv(run: () => Promise<void>): Promise<void> {
  const previous = new Map(AUTH_ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
  Deno.env.set('SUPABASE_URL', 'http://localhost:54321');
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

function restResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function routedFetchMock(url: string): Response {
  if (url.includes('/auth/v1/user')) {
    return restResponse({
      id: '11111111-1111-4111-8111-111111111111',
      aud: 'authenticated',
      role: 'authenticated',
      is_anonymous: true,
    });
  }
  if (url.includes('/rest/v1/invite_preview_attempts')) {
    // insert() and delete().lt() both resolve fine with an empty array/count.
    return restResponse([]);
  }
  if (url.includes('/rest/v1/family_invites')) {
    return restResponse({
      family_id: FAMILY_ID,
      status: 'pending',
      expires_at: IN_A_WEEK,
      invited_by: INVITER_ID,
    });
  }
  if (url.includes('/rest/v1/families')) {
    return restResponse({ name: "Rosa's family", deleted_at: null });
  }
  if (url.includes('/rest/v1/user_profiles')) {
    return restResponse({ name: 'Rosa' });
  }
  throw new Error(`Unexpected fetch to ${url}`);
}

Deno.test('WP-SEC carve-out: the real handler accepts an anonymous session end-to-end (never 401)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url: string | URL | Request) => Promise.resolve(routedFetchMock(url.toString()));

  try {
    await withAuthEnv(async () => {
      const response = await handlePreviewFamilyInvite(
        new Request('http://localhost/preview-family-invite', {
          method: 'POST',
          headers: { Authorization: 'Bearer anon-jwt', 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 'sunny-tiger-lake' }),
        }),
      );

      // The point of this test: NOT 401. (The rest client mock is
      // best-effort REST-shaped; count-based rate-limit parsing may or may
      // not resolve cleanly through the generic mock, but an anonymous
      // caller must never be turned away at the auth gate.)
      assertEquals(response.status !== 401, true);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
