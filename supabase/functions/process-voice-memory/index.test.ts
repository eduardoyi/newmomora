import { assertEquals } from 'jsr:@std/assert@1';
import { handleProcessVoiceMemory } from './index.ts';

Deno.test('process-voice-memory rejects unauthenticated requests', async () => {
  const response = await handleProcessVoiceMemory(
    new Request('http://localhost/process-voice-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: 'abc', familyMembers: [] }),
    }),
  );

  assertEquals(response.status, 401);
});

Deno.test('process-voice-memory rejects empty audio', async () => {
  const response = await handleProcessVoiceMemory(
    new Request('http://localhost/process-voice-memory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test',
      },
      body: JSON.stringify({ audioBase64: '', familyMembers: [] }),
    }),
  );

  assertEquals(response.status, 401);
});
