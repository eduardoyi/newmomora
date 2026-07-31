import { assertEquals } from 'jsr:@std/assert@1';
import { getAuthenticatedNonAnonymousUser, getAuthenticatedUser } from './auth.ts';

const AUTH_ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const;

function withEnv(
  values: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map(AUTH_ENV_KEYS.map((key) => [key, Deno.env.get(key)]));

  for (const key of AUTH_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      Deno.env.delete(key);
    } else {
      Deno.env.set(key, value);
    }
  }

  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  });
}

const FULL_ENV = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'test-anon-key',
} as const;

/**
 * Mocks the GoTrue `/auth/v1/user` response the real `getAuthenticatedUser`
 * calls via supabase-js's `auth.getUser()`. This is the realistic proxy for
 * "an anonymous JWT" in a unit test: the shared helper never decodes a JWT
 * itself, it entirely defers user resolution (including `is_anonymous`) to
 * this GoTrue response.
 */
function withMockedGoTrueUser(
  responder: () => Response,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = () => Promise.resolve(responder());

  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

function goTrueUserResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ANONYMOUS_USER_BODY = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  is_anonymous: true,
};

const PERMANENT_USER_BODY = {
  id: '22222222-2222-4222-8222-222222222222',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'parent@example.com',
  is_anonymous: false,
};

const REQUEST_HEADERS = { Authorization: 'Bearer test-jwt' };

Deno.test('getAuthenticatedUser returns null with no Authorization header (no network call)', async () => {
  const result = await getAuthenticatedUser(new Request('http://localhost/fn'));
  assertEquals(result, null);
});

Deno.test('getAuthenticatedUser returns null with a non-Bearer Authorization header', async () => {
  const result = await getAuthenticatedUser(
    new Request('http://localhost/fn', { headers: { Authorization: 'Basic xyz' } }),
  );
  assertEquals(result, null);
});

Deno.test('getAuthenticatedUser returns the raw user for an anonymous session (permissive by design)', async () => {
  let result: Awaited<ReturnType<typeof getAuthenticatedUser>> | undefined;
  await withEnv(FULL_ENV, () =>
    withMockedGoTrueUser(
      () => goTrueUserResponse(ANONYMOUS_USER_BODY),
      async () => {
        result = await getAuthenticatedUser(
          new Request('http://localhost/fn', { headers: REQUEST_HEADERS }),
        );
      },
    ));
  assertEquals(result?.id, ANONYMOUS_USER_BODY.id);
  assertEquals(result?.is_anonymous, true);
});

Deno.test('getAuthenticatedUser returns the user for a permanent session', async () => {
  let result: Awaited<ReturnType<typeof getAuthenticatedUser>> | undefined;
  await withEnv(FULL_ENV, () =>
    withMockedGoTrueUser(
      () => goTrueUserResponse(PERMANENT_USER_BODY),
      async () => {
        result = await getAuthenticatedUser(
          new Request('http://localhost/fn', { headers: REQUEST_HEADERS }),
        );
      },
    ));
  assertEquals(result?.id, PERMANENT_USER_BODY.id);
  assertEquals(result?.is_anonymous, false);
});

Deno.test('getAuthenticatedUser returns null when GoTrue rejects the token', async () => {
  let result: Awaited<ReturnType<typeof getAuthenticatedUser>> | undefined;
  await withEnv(FULL_ENV, () =>
    withMockedGoTrueUser(
      () => goTrueUserResponse({ error: 'invalid_token', error_description: 'bad jwt' }, 401),
      async () => {
        result = await getAuthenticatedUser(
          new Request('http://localhost/fn', { headers: REQUEST_HEADERS }),
        );
      },
    ));
  assertEquals(result, null);
});

// --- The WP-SEC anonymous-lockdown chokepoint ------------------------------

Deno.test('getAuthenticatedNonAnonymousUser rejects an anonymous session -- THE proof every other Edge Function relies on', async () => {
  let result: Awaited<ReturnType<typeof getAuthenticatedNonAnonymousUser>> | undefined;
  await withEnv(FULL_ENV, () =>
    withMockedGoTrueUser(
      () => goTrueUserResponse(ANONYMOUS_USER_BODY),
      async () => {
        result = await getAuthenticatedNonAnonymousUser(
          new Request('http://localhost/fn', { headers: REQUEST_HEADERS }),
        );
      },
    ));
  assertEquals(result, null);
});

Deno.test('getAuthenticatedNonAnonymousUser returns the user for a permanent session (no regression)', async () => {
  let result: Awaited<ReturnType<typeof getAuthenticatedNonAnonymousUser>> | undefined;
  await withEnv(FULL_ENV, () =>
    withMockedGoTrueUser(
      () => goTrueUserResponse(PERMANENT_USER_BODY),
      async () => {
        result = await getAuthenticatedNonAnonymousUser(
          new Request('http://localhost/fn', { headers: REQUEST_HEADERS }),
        );
      },
    ));
  assertEquals(result?.id, PERMANENT_USER_BODY.id);
});

Deno.test('getAuthenticatedNonAnonymousUser returns null with no Authorization header, same as getAuthenticatedUser', async () => {
  const result = await getAuthenticatedNonAnonymousUser(new Request('http://localhost/fn'));
  assertEquals(result, null);
});
