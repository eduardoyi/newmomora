import { assertEquals } from 'jsr:@std/assert@1';

import { createJwtSkewRetryFetch } from './supabase-admin.ts';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function scriptedFetch(responses: Response[]) {
  const calls: Array<{ input: unknown; init: unknown }> = [];
  const fetchImpl = ((input: unknown, init: unknown) => {
    calls.push({ input, init });
    return Promise.resolve(responses[calls.length - 1]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const skewRejection = () => jsonResponse(401, { code: 'PGRST303', message: 'JWT issued at future', details: null, hint: null });

Deno.test('resends once after a PGRST303 "JWT issued at future" rejection', async () => {
  const { fetchImpl, calls } = scriptedFetch([skewRejection(), jsonResponse(200, [{ id: 1 }])]);
  const sleeps: number[] = [];
  const retryFetch = createJwtSkewRetryFetch(fetchImpl, (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  });

  const response = await retryFetch('https://x.supabase.co/rest/v1/rpc/claim', { method: 'POST', body: '{"p_limit":50}' });

  assertEquals(response.status, 200);
  assertEquals(calls.length, 2);
  assertEquals(calls[1], calls[0]);
  assertEquals(sleeps, [1_000]);
});

Deno.test('returns the second rejection instead of looping', async () => {
  const { fetchImpl, calls } = scriptedFetch([skewRejection(), skewRejection()]);
  const retryFetch = createJwtSkewRetryFetch(fetchImpl, () => Promise.resolve());

  const response = await retryFetch('https://x.supabase.co/rest/v1/rpc/claim', { method: 'POST' });

  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, 'PGRST303');
  assertEquals(calls.length, 2);
});

Deno.test('does not retry other auth failures or non-JSON 401s', async () => {
  for (const rejection of [
    jsonResponse(401, { code: 'PGRST301', message: 'JWT expired' }),
    jsonResponse(401, { code: 'PGRST303', message: 'JWT expired' }),
    new Response('Unauthorized', { status: 401 }),
  ]) {
    const { fetchImpl, calls } = scriptedFetch([rejection]);
    const retryFetch = createJwtSkewRetryFetch(fetchImpl, () => Promise.resolve());

    const response = await retryFetch('https://x.supabase.co/rest/v1/table', {});

    assertEquals(response.status, 401);
    assertEquals(calls.length, 1);
  }
});

Deno.test('passes successful and non-auth error responses through untouched', async () => {
  const { fetchImpl, calls } = scriptedFetch([jsonResponse(500, { code: '57014', message: 'canceling statement' })]);
  const retryFetch = createJwtSkewRetryFetch(fetchImpl, () => Promise.resolve());

  const response = await retryFetch('https://x.supabase.co/rest/v1/table', {});

  assertEquals(response.status, 500);
  assertEquals((await response.json()).code, '57014');
  assertEquals(calls.length, 1);
});
