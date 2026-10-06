import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { buildQuotePrompt, parseQuoteResponse, selectQuotePool } from './year-film-quotes.ts';

const SUBJECTS = [{ id: 'tomas', name: 'Tomás' }, { id: 'lucia', name: 'Lucía' }];
const CONTENT = new Map<string, string | null>([
  ['m1', 'Tomás me dijo: "papi, el mundo es una burbuja" y se fue corriendo.'],
  ['m2', 'Lucía said “more bubbles please” at the park today.'],
]);

Deno.test('parseQuoteResponse accepts verbatim quotes and strips wrapping quote marks', () => {
  const raw = JSON.stringify({
    quotes: [
      { memory_id: 'm1', speaker: 'Tomás', quote: '"papi, el mundo es una burbuja"' },
      { memory_id: 'm2', speaker: 'lucía', quote: 'more bubbles please' },
    ],
  });
  const { accepted, rejected } = parseQuoteResponse(raw, SUBJECTS, CONTENT);
  assertEquals(accepted, [
    { memoryId: 'm1', quote: 'papi, el mundo es una burbuja', speakerId: 'tomas' },
    { memoryId: 'm2', quote: 'more bubbles please', speakerId: 'lucia' },
  ]);
  assertEquals(rejected, []);
});

Deno.test('parseQuoteResponse rejects paraphrases, strangers, long quotes, unknown memories and duplicates', () => {
  const raw = JSON.stringify({
    quotes: [
      { memory_id: 'm1', speaker: 'Tomás', quote: 'dad, the world is a bubble' }, // translated
      { memory_id: 'm1', speaker: 'Papi', quote: 'papi' },
      { memory_id: 'm2', speaker: 'Lucía', quote: 'more bubbles please at the park today and then we went home to eat dinner' },
      { memory_id: 'nope', speaker: 'Lucía', quote: 'hi' },
      { memory_id: 'm2', speaker: 'Lucía', quote: 'more bubbles please' },
      { memory_id: 'm2', speaker: 'Lucía', quote: 'More bubbles please' },
      { memory_id: 'm2' },
    ],
  });
  const { accepted, rejected } = parseQuoteResponse(raw, SUBJECTS, CONTENT);
  assertEquals(accepted.length, 1);
  assertEquals(rejected.map((r) => r.reason), [
    'not_verbatim',
    'unknown_speaker',
    'too_long',
    'unknown_memory',
    'duplicate',
    'bad_shape',
  ]);
});

Deno.test('parseQuoteResponse never throws on malformed output', () => {
  assertEquals(parseQuoteResponse('not json', SUBJECTS, CONTENT).rejected[0].reason, 'bad_shape');
  assertEquals(parseQuoteResponse('{"language":"es","quotes":[]}', SUBJECTS, CONTENT).language, 'es');
  assertEquals(parseQuoteResponse('{"quotes": 3}', SUBJECTS, CONTENT).rejected[0].reason, 'bad_shape');
});

Deno.test('selectQuotePool keeps subjects\' texted memories, explicit quotes first', () => {
  const pool = selectQuotePool(
    [
      { id: 'a', date: '2026-01-01', text: 'A long note with no quote marks at all', taggedMemberIds: ['tomas'] },
      { id: 'b', date: '2025-01-01', text: 'He said "agua por favor" twice today', taggedMemberIds: ['tomas'] },
      { id: 'c', date: '2026-02-01', text: 'short', taggedMemberIds: ['tomas'] },
      { id: 'd', date: '2026-03-01', text: 'A long note about the niece only', taggedMemberIds: ['elena'] },
    ],
    SUBJECTS,
  );
  assertEquals(pool.map((m) => m.id), ['b', 'a']);
});

Deno.test('buildQuotePrompt names the children and lists entries with ids', () => {
  const { system, user } = buildQuotePrompt(SUBJECTS, [
    { id: 'm1', date: '2026-01-01', text: CONTENT.get('m1')!, taggedMemberIds: ['tomas'] },
  ]);
  assertStringIncludes(system, 'Tomás, Lucía');
  assertStringIncludes(system, 'verbatim');
  assertStringIncludes(user, '[m1] 2026-01-01:');
});
