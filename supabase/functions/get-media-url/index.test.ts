import { assertEquals } from 'jsr:@std/assert@1';
import { handleGetMediaUrl } from './index.ts';

Deno.test('get-media-url rejects unauthenticated requests', async () => {
  const response = await handleGetMediaUrl(
    new Request('http://localhost/get-media-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['user-id/family/member/photo.webp'] }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('get-media-url rejects unsupported methods', async () => {
  const response = await handleGetMediaUrl(
    new Request('http://localhost/get-media-url', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});
