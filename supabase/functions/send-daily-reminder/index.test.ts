import { assertEquals } from 'jsr:@std/assert@1';
import { handleSendDailyReminder, processSendDailyReminder } from './index.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';

interface FakeProfile {
  enable_daily_reminder: boolean;
  expo_push_token: string | null;
  deleted_at: string | null;
}

function createFakeServiceClient(profile: FakeProfile | null) {
  return {
    from(table: string) {
      if (table === 'user_profiles') {
        return {
          select: () => ({
            eq: (_col: string, _id: string) => ({
              maybeSingle: () => Promise.resolve({ data: profile, error: null }),
            }),
          }),
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function withMockedPush(
  run: () => Promise<void>,
): Promise<Array<{ to: string; title: string; body: string; data?: unknown }>> {
  const originalFetch = globalThis.fetch;
  const pushCalls: Array<{ to: string; title: string; body: string; data?: unknown }> = [];

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

Deno.test('send-daily-reminder rejects missing cron secret', async () => {
  const response = await handleSendDailyReminder(
    new Request('http://localhost/send-daily-reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('sends a push with a new-memory deep-link route', async () => {
  const client = createFakeServiceClient({
    enable_daily_reminder: true,
    expo_push_token: 'ExponentPushToken[abc]',
    deleted_at: null,
  });

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processSendDailyReminder(client as never, USER_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { success: true });

  assertEquals(pushCalls.length, 1);
  assertEquals(pushCalls[0].to, 'ExponentPushToken[abc]');
  assertEquals(pushCalls[0].data, { route: 'new-memory' });
});

Deno.test('skips without sending when the reminder is disabled', async () => {
  const client = createFakeServiceClient({
    enable_daily_reminder: false,
    expo_push_token: 'ExponentPushToken[abc]',
    deleted_at: null,
  });

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processSendDailyReminder(client as never, USER_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { success: true, skipped: true });
  assertEquals(pushCalls.length, 0);
});

Deno.test('skips without sending when there is no push token', async () => {
  const client = createFakeServiceClient({
    enable_daily_reminder: true,
    expo_push_token: null,
    deleted_at: null,
  });

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processSendDailyReminder(client as never, USER_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { success: true, skipped: true });
  assertEquals(pushCalls.length, 0);
});

Deno.test('skips a soft-deleted account', async () => {
  const client = createFakeServiceClient({
    enable_daily_reminder: true,
    expo_push_token: 'ExponentPushToken[abc]',
    deleted_at: new Date().toISOString(),
  });

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processSendDailyReminder(client as never, USER_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { success: true, skipped: true });
  assertEquals(pushCalls.length, 0);
});

Deno.test('skips when the profile is missing', async () => {
  const client = createFakeServiceClient(null);

  let response!: Response;
  const pushCalls = await withMockedPush(async () => {
    response = await processSendDailyReminder(client as never, USER_ID);
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, { success: true, skipped: true });
  assertEquals(pushCalls.length, 0);
});
