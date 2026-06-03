import { assertEquals } from 'jsr:@std/assert@1';
import { handleScheduleDailyReminders } from './index.ts';

Deno.test('schedule-daily-reminders rejects missing cron secret', async () => {
  const response = await handleScheduleDailyReminders(
    new Request('http://localhost/schedule-daily-reminders', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
