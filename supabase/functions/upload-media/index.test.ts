import { assertEquals } from 'jsr:@std/assert@1';
import { handleUploadMedia, maxBytesForContentType } from './index.ts';

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

// Audio memories "keep the sound" (docs/features/audio-memories.md, P1.3): a
// 2-minute AAC clip is ~1.9 MB, so 5 MB is a generous but real ceiling --
// distinct from the 100 MB video/generic cap and the 20 MB image cap.
Deno.test('maxBytesForContentType applies the 5 MB audio cap to all three allow-listed audio MIME types', () => {
  const FIVE_MB = 5 * 1024 * 1024;
  assertEquals(maxBytesForContentType('audio/mp4'), FIVE_MB);
  assertEquals(maxBytesForContentType('audio/m4a'), FIVE_MB);
  assertEquals(maxBytesForContentType('audio/x-m4a'), FIVE_MB);
});

Deno.test('maxBytesForContentType keeps the image and generic/video caps distinct from the audio cap', () => {
  assertEquals(maxBytesForContentType('image/jpeg'), 20 * 1024 * 1024);
  assertEquals(maxBytesForContentType('video/mp4'), 100 * 1024 * 1024);
});
