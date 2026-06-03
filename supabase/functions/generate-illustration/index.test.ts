import { assertEquals } from 'jsr:@std/assert@1';
import { handleGenerateIllustration } from './index.ts';

Deno.test('generate-illustration rejects unauthenticated requests', async () => {
  const response = await handleGenerateIllustration(
    new Request('http://localhost/generate-illustration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: '22222222-2222-4222-8222-222222222222' }),
    }),
  );

  assertEquals(response.status, 401);
});
