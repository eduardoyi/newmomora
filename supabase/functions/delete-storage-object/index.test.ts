import { assertEquals } from 'jsr:@std/assert@1';
import { handleDeleteStorageObject } from './index.ts';

Deno.test('delete-storage-object rejects unauthenticated requests', async () => {
  const response = await handleDeleteStorageObject(
    new Request('http://localhost/delete-storage-object', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectKey: '11111111-1111-4111-8111-111111111111/memories/33333333-3333-4333-8333-333333333333/media.mp4',
      }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('delete-storage-object rejects unsupported methods', async () => {
  const response = await handleDeleteStorageObject(
    new Request('http://localhost/delete-storage-object', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});
