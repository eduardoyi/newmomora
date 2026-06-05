import { assertEquals } from 'jsr:@std/assert@1';
import { handleUploadMedia } from './index.ts';

Deno.test('upload-media rejects unauthenticated requests', async () => {
  const response = await handleUploadMedia(
    new Request('http://localhost/upload-media', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'x-object-key': '11111111-1111-4111-8111-111111111111/memories/22222222-2222-4222-8222-222222222222/media/33333333-3333-4333-8333-333333333333.jpg',
      },
      body: new Uint8Array([1, 2, 3]),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('upload-media rejects unsupported methods', async () => {
  const response = await handleUploadMedia(
    new Request('http://localhost/upload-media', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});
