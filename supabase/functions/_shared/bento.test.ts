import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { sendTransactionalEmail, sendTransactionalEmailWithOutcome } from './bento.ts';

const BENTO_ENV_KEYS = [
  'BENTO_SITE_UUID',
  'BENTO_PUBLISHABLE_KEY',
  'BENTO_SECRET_KEY',
  'BENTO_FROM_EMAIL',
] as const;

function withEnv(
  values: Partial<Record<(typeof BENTO_ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map(BENTO_ENV_KEYS.map((key) => [key, Deno.env.get(key)]));

  for (const key of BENTO_ENV_KEYS) {
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
  BENTO_SITE_UUID: 'site-123',
  BENTO_PUBLISHABLE_KEY: 'pub-abc',
  BENTO_SECRET_KEY: 'secret-xyz',
  BENTO_FROM_EMAIL: 'hello@usemomora.com',
} as const;

function withMockedFetch(
  responder: (url: string, init?: RequestInit) => Response,
  run: () => Promise<void>,
): Promise<Array<{ url: string; init?: RequestInit }>> {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    const urlString = url.toString();
    calls.push({ url: urlString, init });
    return Promise.resolve(responder(urlString, init));
  };

  return run()
    .then(() => calls)
    .finally(() => {
      globalThis.fetch = originalFetch;
    });
}

for (const missingKey of BENTO_ENV_KEYS) {
  Deno.test(`sendTransactionalEmail no-ops (never throws) when ${missingKey} is missing`, async () => {
    const partialEnv = { ...FULL_ENV };
    delete (partialEnv as Record<string, string | undefined>)[missingKey];

    let result: boolean | undefined;
    let calls: Array<{ url: string; init?: RequestInit }> = [];

    await withEnv(partialEnv, async () => {
      calls = await withMockedFetch(
        () => new Response(JSON.stringify({ results: 1 }), { status: 200 }),
        async () => {
          result = await sendTransactionalEmail({
            to: 'carmen@example.com',
            subject: 'Hi',
            htmlBody: '<p>Hi</p>',
          });
        },
      );
    });

    assertEquals(result, false);
    assertEquals(calls.length, 0);
  });
}

Deno.test('sendTransactionalEmail posts the Bento batch contract with site_uuid in the query', async () => {
  let calls: Array<{ url: string; init?: RequestInit }> = [];
  let result: boolean | undefined;

  await withEnv(FULL_ENV, async () => {
    calls = await withMockedFetch(
      () => new Response(JSON.stringify({ results: 1 }), { status: 200 }),
      async () => {
        result = await sendTransactionalEmail({
          to: 'carmen@example.com',
          subject: "You're in!",
          htmlBody: '<p>Welcome</p>',
        });
      },
    );
  });

  assertEquals(result, true);
  assertEquals(calls.length, 1);

  const call = calls[0];
  assertStringIncludes(call.url, 'https://app.bentonow.com/api/v1/batch/emails?site_uuid=site-123');

  const headers = call.init?.headers as Record<string, string>;
  assertEquals(headers.Authorization, `Basic ${btoa('pub-abc:secret-xyz')}`);
  assertEquals(headers['Content-Type'], 'application/json');
  assertEquals(call.init?.signal instanceof AbortSignal, true);

  const body = JSON.parse(call.init?.body as string);
  assertEquals(body, {
    emails: [
      {
        to: 'carmen@example.com',
        from: 'hello@usemomora.com',
        subject: "You're in!",
        html_body: '<p>Welcome</p>',
        transactional: true,
      },
    ],
  });
});

Deno.test('sendTransactionalEmail reports a definite provider rejection for a 4xx response', async () => {
  let result: boolean | undefined;

  await withEnv(FULL_ENV, async () => {
    await withMockedFetch(
      () => new Response('nope', { status: 422 }),
      async () => {
        result = await sendTransactionalEmail({
          to: 'carmen@example.com',
          subject: 'Hi',
          htmlBody: '<p>Hi</p>',
        });
      },
    );
  });

  assertEquals(result, false);

  let outcome: string | undefined;
  await withEnv(FULL_ENV, async () => {
    await withMockedFetch(
      () => new Response('', { status: 422 }),
      async () => {
        outcome = await sendTransactionalEmailWithOutcome({
          to: 'carmen@example.com', subject: 'Hi', htmlBody: '<p>Hi</p>',
        });
      },
    );
  });
  assertEquals(outcome, 'rejected');
});

Deno.test('sendTransactionalEmail reports an unknown outcome for network failure or ambiguous success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('network down'));

  let result: boolean | undefined;
  try {
    await withEnv(FULL_ENV, async () => {
      result = await sendTransactionalEmail({
        to: 'carmen@example.com',
        subject: 'Hi',
        htmlBody: '<p>Hi</p>',
      });
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(result, false);

  let malformedOutcome: string | undefined;
  await withEnv(FULL_ENV, async () => {
    await withMockedFetch(
      () => new Response(JSON.stringify({ results: 0 }), { status: 200 }),
      async () => {
        malformedOutcome = await sendTransactionalEmailWithOutcome({
          to: 'carmen@example.com', subject: 'Hi', htmlBody: '<p>Hi</p>',
        });
      },
    );
  });
  assertEquals(malformedOutcome, 'rejected');

  for (const results of [2, -1, 0.5]) {
    let unexpectedCountOutcome: string | undefined;
    await withEnv(FULL_ENV, async () => {
      await withMockedFetch(
        () => new Response(JSON.stringify({ results }), { status: 200 }),
        async () => {
          unexpectedCountOutcome = await sendTransactionalEmailWithOutcome({
            to: 'carmen@example.com', subject: 'Hi', htmlBody: '<p>Hi</p>',
          });
        },
      );
    });
    assertEquals(unexpectedCountOutcome, 'unknown');
  }

  let serverOutcome: string | undefined;
  await withEnv(FULL_ENV, async () => {
    await withMockedFetch(
      () => new Response('', { status: 503 }),
      async () => {
        serverOutcome = await sendTransactionalEmailWithOutcome({
          to: 'carmen@example.com', subject: 'Hi', htmlBody: '<p>Hi</p>',
        });
      },
    );
  });
  assertEquals(serverOutcome, 'unknown');
});
