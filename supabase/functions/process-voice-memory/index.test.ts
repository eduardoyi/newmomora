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
  // getAuthenticatedUser throws (500) when Supabase env vars are absent;
  // point it at a closed local port so the token lookup fails fast → 401.
  Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9');
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');

  try {
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
  } finally {
    Deno.env.delete('SUPABASE_URL');
    Deno.env.delete('SUPABASE_ANON_KEY');
  }
});
