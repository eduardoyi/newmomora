import { assertEquals } from 'jsr:@std/assert@1';
import { handleDeleteUserAccount } from './index.ts';

Deno.test('delete-user-account rejects unauthenticated requests', async () => {
  const response = await handleDeleteUserAccount(
    new Request('http://localhost/delete-user-account', {
      method: 'POST',
    }),
  );

  assertEquals(response.status, 401);
});
