import { assertEquals } from 'jsr:@std/assert@1';
import { postSignedToYearFilmWorker } from './year-film-worker-dispatch.ts';

const SECRET = 'test-secret-not-real';

function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = Deno.env.get(key);
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('postSignedToYearFilmWorker signs `${timestamp}.${nonce}.${body}` and posts to endpoint + path', async () => {
  const realFetch = globalThis.fetch;
  const seen: { url: string; headers: Headers; body: string }[] = [];
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return Promise.resolve(new Response('{}', { status: 202 }));
  }) as typeof fetch;
  try {
    const ok = await withEnv(
      { CLOUDFLARE_YEAR_FILM_WORKFLOW_URL: 'https://worker.example.test/', CLOUDFLARE_YEAR_FILM_WORKFLOW_SECRET: SECRET },
      () => postSignedToYearFilmWorker('/holiday-cards/generate', { cardId: 'c1', attemptId: 'a1' }),
    );
    assertEquals(ok, true);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].url, 'https://worker.example.test/holiday-cards/generate');
    assertEquals(seen[0].body, JSON.stringify({ cardId: 'c1', attemptId: 'a1' }));
    const timestamp = seen[0].headers.get('x-dispatch-timestamp')!;
    const nonce = seen[0].headers.get('x-dispatch-nonce')!;
    assertEquals(seen[0].headers.get('x-dispatch-signature'), await hmacHex(SECRET, `${timestamp}.${nonce}.${seen[0].body}`));
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test('postSignedToYearFilmWorker returns false without env or on a non-2xx answer', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    return Promise.resolve(new Response('no', { status: 502 }));
  }) as typeof fetch;
  try {
    assertEquals(
      await withEnv({ CLOUDFLARE_YEAR_FILM_WORKFLOW_URL: undefined, CLOUDFLARE_YEAR_FILM_WORKFLOW_SECRET: undefined }, () =>
        postSignedToYearFilmWorker('/dispatch', { filmId: 'f', attemptId: 'a' })),
      false,
    );
    assertEquals(calls, 0);
    assertEquals(
      await withEnv({ CLOUDFLARE_YEAR_FILM_WORKFLOW_URL: 'https://worker.example.test', CLOUDFLARE_YEAR_FILM_WORKFLOW_SECRET: SECRET }, () =>
        postSignedToYearFilmWorker('/dispatch', { filmId: 'f', attemptId: 'a' })),
      false,
    );
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
