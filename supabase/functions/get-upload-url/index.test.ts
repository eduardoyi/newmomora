import { assertEquals } from 'jsr:@std/assert@1';
import { handleGetUploadUrl } from './index.ts';

Deno.test('get-upload-url rejects unauthenticated requests', async () => {
  const response = await handleGetUploadUrl(
    new Request('http://localhost/get-upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectKey: '11111111-1111-4111-8111-111111111111/family/22222222-2222-4222-8222-222222222222/photo.webp',
        contentType: 'image/jpeg',
      }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('get-upload-url rejects unsupported methods', async () => {
  const response = await handleGetUploadUrl(
    new Request('http://localhost/get-upload-url', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});
