import { assertEquals } from 'jsr:@std/assert@1';
import { handleSendDailyReminder } from './index.ts';

Deno.test('send-daily-reminder rejects missing cron secret', async () => {
  const response = await handleSendDailyReminder(
    new Request('http://localhost/send-daily-reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: '11111111-1111-4111-8111-111111111111' }),
    }),
  );

  assertEquals(response.status, 401);
});
