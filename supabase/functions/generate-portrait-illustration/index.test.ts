import { assertEquals } from 'jsr:@std/assert@1';
import { handleGeneratePortraitIllustration } from './index.ts';

Deno.test('generate-portrait-illustration rejects unauthenticated requests', async () => {
  const response = await handleGeneratePortraitIllustration(
    new Request('http://localhost/generate-portrait-illustration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ familyMemberId: '22222222-2222-4222-8222-222222222222' }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('generate-portrait-illustration rejects unsupported methods', async () => {
  const response = await handleGeneratePortraitIllustration(
    new Request('http://localhost/generate-portrait-illustration', {
      method: 'GET',
    }),
  );

  assertEquals(response.status, 405);
});
