import { assertEquals } from 'jsr:@std/assert@1';
import { handleAnalyzeEmotion } from '../analyze-emotion/index.ts';
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

// The alias endpoint must be the very same handler: the artwork medium axis
// (media_variant select, artwork-mode analysis, the additive `artworkMedium`
// response field, the artwork_medium CAS write -- all in analyze-emotion and
// _shared/analyze-memory-core.ts) reaches `analyze-memory` callers only
// through this identity. If the wrapper ever gets its own handler, it must
// re-cover those behaviors.
Deno.test('analyze-memory is the same handler as analyze-emotion (artwork medium behavior is shared)', () => {
  assertEquals(handleAnalyzeMemory, handleAnalyzeEmotion);
});
