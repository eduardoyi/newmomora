import { assertEquals } from 'jsr:@std/assert@1';
import { handleAnalyzeMemory } from './index.ts';

// `analyze-memory` is a thin re-export of analyze-emotion's handler
// (see index.ts's header comment) -- this smoke test just pins that the
// wiring works end to end for the wrapper's own module path, rather than
// re-testing analyze-emotion's full behavior (covered by
// ../analyze-emotion/index.test.ts).
Deno.test('analyze-memory rejects unauthenticated requests', async () => {
  const response = await handleAnalyzeMemory(
    new Request('http://localhost/analyze-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryId: '22222222-2222-4222-8222-222222222222' }),
    }),
  );

  assertEquals(response.status, 401);
});
