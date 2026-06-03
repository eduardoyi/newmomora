import { assertEquals } from 'jsr:@std/assert@1';
import { handleCancelAccountDeletion } from './index.ts';

Deno.test('cancel-account-deletion rejects unauthenticated requests', async () => {
  const response = await handleCancelAccountDeletion(
    new Request('http://localhost/cancel-account-deletion', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
