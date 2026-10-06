import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import {
  buildRollbackFile,
  chunkArray,
  decideRow,
  memoryTextForGate,
  parseArgs,
  parseRollbackFile,
  summarize,
  type CandidateMilestoneRow,
  type MemoryTextSource,
} from './milestone-honesty-backfill.ts';

const ID = '11111111-2222-3333-4444-555555555555';

function row(milestoneId: string, overrides: Partial<CandidateMilestoneRow> = {}): CandidateMilestoneRow {
  return { id: ID, memory_id: 'm', family_id: 'f', milestone_id: milestoneId, status: 'candidate', ...overrides };
}

function memory(content: string | null, extra: Partial<MemoryTextSource> = {}): MemoryTextSource {
  return { memory_type: 'text_only', content, audio_transcript: null, ...extra };
}

Deno.test('parseArgs defaults to a non-mutating dry run', () => {
  assertEquals(parseArgs([]), { apply: false, rollbackFile: null, familyIds: [], batchSize: 200 });
});

Deno.test('parseArgs reads --apply, --rollback, repeatable --family-id, --batch-size', () => {
  assertEquals(parseArgs(['--apply', '--rollback', 'a.json', '--family-id', 'x', '--family-id', 'y', '--batch-size', '50']), {
    apply: true,
    rollbackFile: 'a.json',
    familyIds: ['x', 'y'],
    batchSize: 50,
  });
  assertEquals(parseArgs(['--batch-size', '0']).batchSize, 200);
});

Deno.test('decideRow dismisses the owner over-tag cases', () => {
  assertEquals(decideRow(row('first-haircut'), memory('Tomás en la barbería, corte de pelo')), {
    action: 'dismiss',
    reason: 'no_explicit_language',
  });
  assertEquals(decideRow(row('first-question'), memory('Tomás me preguntó por qué el cielo es azul')).action, 'dismiss');
  assertEquals(decideRow(row('balance-bike'), memory('Tomás en su bici de equilibrio')).action, 'dismiss');
});

Deno.test('decideRow keeps explicit memories', () => {
  assertEquals(decideRow(row('first-haircut'), memory('Hoy le cortaron el pelo por primera vez')), { action: 'keep' });
  assertEquals(decideRow(row('first-steps'), memory('Dio sus primeros pasos!')), { action: 'keep' });
  assertEquals(
    decideRow(row('bike-no-training-wheels'), memory('She learned to ride her bike without training wheels')),
    { action: 'keep' },
  );
});

Deno.test('decideRow dismisses a non-birthday row whose memory has no text (photo-only)', () => {
  assertEquals(decideRow(row('first-beach'), memory(null)).action, 'dismiss');
  assertEquals(decideRow(row('first-beach'), memory('   ')).action, 'dismiss');
});

Deno.test('decideRow never text-gates birthday (deterministic DOB path), unknown ids, or missing memories', () => {
  assertEquals(decideRow(row('birthday'), memory(null)), { action: 'exempt', why: 'birthday' });
  assertEquals(decideRow(row('some-future-id'), memory('x')), { action: 'exempt', why: 'unknown_milestone' });
  assertEquals(decideRow(row('first-beach'), undefined), { action: 'exempt', why: 'memory_missing' });
});

Deno.test('memoryTextForGate mirrors the analyzer input (audio joins content + transcript; URLs stripped)', () => {
  assertEquals(memoryTextForGate(memory('see https://x.io/a first steps')), 'see first steps');
  assertEquals(
    memoryTextForGate({ memory_type: 'audio', content: 'Mia', audio_transcript: 'dijo mamá' }),
    'Mia dijo mamá',
  );
  assertEquals(memoryTextForGate({ memory_type: 'media', content: null, audio_transcript: null }), null);
});

Deno.test('summarize counts totals, per-milestone and per-reason without any memory text', () => {
  const summary = summarize([
    { milestoneId: 'first-haircut', decision: { action: 'dismiss', reason: 'no_explicit_language' } },
    { milestoneId: 'first-haircut', decision: { action: 'keep' } },
    { milestoneId: 'first-steps', decision: { action: 'dismiss', reason: 'subject_not_mentioned' } },
    { milestoneId: 'birthday', decision: { action: 'exempt', why: 'birthday' } },
  ]);
  assertEquals(summary.total, 4);
  assertEquals(summary.kept, 1);
  assertEquals(summary.wouldDismiss, 2);
  assertEquals(summary.exempt, 1);
  assertEquals(summary.byMilestone[0], { milestoneId: 'first-haircut', total: 2, kept: 1, wouldDismiss: 1, exempt: 0 });
  assertEquals(summary.byReason, [
    { reason: 'no_explicit_language', count: 1 },
    { reason: 'subject_not_mentioned', count: 1 },
  ]);
});

Deno.test('chunkArray splits into batches', () => {
  assertEquals(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(chunkArray([], 3), []);
});

Deno.test('rollback file round-trips and only carries ids, milestone ids, reason, previous status', () => {
  const file = buildRollbackFile('run1', '2026-10-01T00:00:00.000Z', [{ row: row('first-haircut'), reason: 'no_explicit_language' }]);
  assertEquals(file.rows, [{ id: ID, milestoneId: 'first-haircut', previousStatus: 'candidate', reason: 'no_explicit_language' }]);
  assertEquals(parseRollbackFile(JSON.parse(JSON.stringify(file))), file);
});

Deno.test('parseRollbackFile rejects malformed files and non-candidate previous statuses', () => {
  assertThrows(() => parseRollbackFile(null));
  assertThrows(() => parseRollbackFile({ version: 2, runId: 'x', rows: [] }));
  assertThrows(() => parseRollbackFile({ version: 1, runId: 'x', rows: [{ id: 'not-a-uuid', previousStatus: 'candidate' }] }));
  assertThrows(() => parseRollbackFile({ version: 1, runId: 'x', rows: [{ id: ID, previousStatus: 'confirmed' }] }));
});
