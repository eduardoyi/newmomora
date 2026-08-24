import { assertEquals } from 'jsr:@std/assert@1';
import {
  estimateCostUsd,
  estimateDryRunCostUsd,
  parseArgs,
  shouldExitNonZero,
  summarizeCandidatesByFamily,
  summarizeCandidatesByType,
  type CandidateMemoryRow,
} from './backfill-memory-analysis.ts';

// --- parseArgs ---------------------------------------------------------------

Deno.test('parseArgs defaults to non-mutating dry run with default concurrency', () => {
  const options = parseArgs([]);
  assertEquals(options, { apply: false, limit: null, familyIds: [], memoryIds: [], concurrency: 3 });
});

Deno.test('parseArgs reads --apply', () => {
  assertEquals(parseArgs(['--apply']).apply, true);
});

Deno.test('parseArgs reads --limit as a positive number', () => {
  assertEquals(parseArgs(['--limit', '50']).limit, 50);
});

Deno.test('parseArgs ignores a malformed or non-positive --limit', () => {
  assertEquals(parseArgs(['--limit', 'abc']).limit, null);
  assertEquals(parseArgs(['--limit', '0']).limit, null);
  assertEquals(parseArgs(['--limit', '-5']).limit, null);
});

Deno.test('parseArgs collects repeatable --family-id flags in order', () => {
  const options = parseArgs(['--family-id', 'fam-1', '--family-id', 'fam-2']);
  assertEquals(options.familyIds, ['fam-1', 'fam-2']);
});

Deno.test('parseArgs collects repeatable --memory-id flags in order', () => {
  const options = parseArgs(['--memory-id', 'mem-1', '--memory-id', 'mem-2']);
  assertEquals(options.memoryIds, ['mem-1', 'mem-2']);
});

Deno.test('parseArgs reads --concurrency, ignoring a malformed value', () => {
  assertEquals(parseArgs(['--concurrency', '5']).concurrency, 5);
  assertEquals(parseArgs(['--concurrency', 'nope']).concurrency, 3);
});

Deno.test('parseArgs combines every flag in one invocation', () => {
  const options = parseArgs([
    '--apply',
    '--limit',
    '10',
    '--family-id',
    'fam-1',
    '--memory-id',
    'mem-1',
    '--concurrency',
    '2',
  ]);
  assertEquals(options, {
    apply: true,
    limit: 10,
    familyIds: ['fam-1'],
    memoryIds: ['mem-1'],
    concurrency: 2,
  });
});

Deno.test('parseArgs ignores unknown flags rather than throwing', () => {
  const options = parseArgs(['--not-a-real-flag', '--apply']);
  assertEquals(options.apply, true);
});

// --- estimateCostUsd / estimateDryRunCostUsd ----------------------------------

Deno.test('estimateCostUsd applies the gpt-4o-mini per-million-token rates', () => {
  // 1,000,000 prompt tokens @ $0.15/M + 1,000,000 completion tokens @ $0.60/M.
  assertEquals(estimateCostUsd(1_000_000, 1_000_000), 0.75);
  assertEquals(estimateCostUsd(0, 0), 0);
});

Deno.test('estimateCostUsd scales linearly with token count', () => {
  const double = estimateCostUsd(2000, 400);
  const single = estimateCostUsd(1000, 200);
  assertEquals(double, single * 2);
});

Deno.test('estimateDryRunCostUsd scales linearly with candidate count and stays a small positive number', () => {
  const forTen = estimateDryRunCostUsd(10);
  const forTwenty = estimateDryRunCostUsd(20);
  assertEquals(forTwenty, forTen * 2);
  assertEquals(forTen > 0, true);
  // Sanity bound: this must stay a per-memory fraction of a cent-scale
  // number, not something that looks like a whole-dollar-per-memory bug.
  assertEquals(forTen < 0.01, true);
});

// --- summarizeCandidatesByFamily / summarizeCandidatesByType -----------------

function candidate(overrides: Partial<CandidateMemoryRow> = {}): CandidateMemoryRow {
  return {
    id: 'memory-1',
    family_id: 'family-1',
    content: null,
    memory_type: 'text_only',
    memory_date: '2026-01-01',
    audio_transcript: null,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

Deno.test('summarizeCandidatesByFamily counts and sorts descending by count', () => {
  const rows = [
    candidate({ family_id: 'a' }),
    candidate({ family_id: 'b' }),
    candidate({ family_id: 'b' }),
    candidate({ family_id: 'b' }),
  ];
  assertEquals(summarizeCandidatesByFamily(rows), [
    { familyId: 'b', count: 3 },
    { familyId: 'a', count: 1 },
  ]);
});

Deno.test('summarizeCandidatesByFamily breaks ties alphabetically by family id', () => {
  const rows = [candidate({ family_id: 'zebra' }), candidate({ family_id: 'apple' })];
  assertEquals(summarizeCandidatesByFamily(rows), [
    { familyId: 'apple', count: 1 },
    { familyId: 'zebra', count: 1 },
  ]);
});

Deno.test('summarizeCandidatesByType counts and sorts descending by count', () => {
  const rows = [
    candidate({ memory_type: 'media' }),
    candidate({ memory_type: 'text_only' }),
    candidate({ memory_type: 'text_only' }),
  ];
  assertEquals(summarizeCandidatesByType(rows), [
    { memoryType: 'text_only', count: 2 },
    { memoryType: 'media', count: 1 },
  ]);
});

Deno.test('summarizeCandidatesByFamily/Type return an empty array for an empty input', () => {
  assertEquals(summarizeCandidatesByFamily([]), []);
  assertEquals(summarizeCandidatesByType([]), []);
});

// --- shouldExitNonZero ---------------------------------------------------------

Deno.test('shouldExitNonZero is false with zero attempts (empty candidate set is success)', () => {
  assertEquals(shouldExitNonZero(0, 0), false);
});

Deno.test('shouldExitNonZero is false at exactly 10% errors', () => {
  assertEquals(shouldExitNonZero(10, 1), false);
});

Deno.test('shouldExitNonZero is true just above 10% errors', () => {
  assertEquals(shouldExitNonZero(10, 2), true);
});

Deno.test('shouldExitNonZero is false with zero errors', () => {
  assertEquals(shouldExitNonZero(100, 0), false);
});

Deno.test('shouldExitNonZero is true when every attempt errored', () => {
  assertEquals(shouldExitNonZero(5, 5), true);
});
