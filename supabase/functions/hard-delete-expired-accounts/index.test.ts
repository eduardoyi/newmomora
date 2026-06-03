import { assertEquals } from 'jsr:@std/assert@1';
import { handleHardDeleteExpiredAccounts } from './index.ts';

Deno.test('hard-delete-expired-accounts rejects missing cron secret', async () => {
  const response = await handleHardDeleteExpiredAccounts(
    new Request('http://localhost/hard-delete-expired-accounts', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
