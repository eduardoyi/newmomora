import { assertEquals, assertAlmostEquals } from 'jsr:@std/assert@1';
import {
  estimateCostUsd,
  parseLabels,
  recommend,
  summarizeArm,
  type ArmId,
  type CallResult,
} from './eval-artwork-medium.ts';

function result(armId: ArmId, overrides: Partial<CallResult> = {}): CallResult {
  return {
    armId,
    index: 1,
    expected: 'crayon',
    got: 'crayon',
    ok: true,
    error: false,
    depictsPlace: false,
    rawTripTopics: 0,
    usage: { promptTokens: 1000, completionTokens: 20 },
    ...overrides,
  };
}

Deno.test('parseLabels accepts string and object entries, normalizes mediums, and reports out-of-vocabulary entries', () => {
  const { labels, invalid } = parseLabels({
    'a.jpg': 'Crayons',
    'b.jpg': { medium: 'water color', depictsPlace: true },
    'c.jpg': 'oil on canvas',
    'd.jpg': { depictsPlace: true },
  });
  assertEquals(labels.get('a.jpg'), { medium: 'crayon', depictsPlace: false });
  assertEquals(labels.get('b.jpg'), { medium: 'watercolor', depictsPlace: true });
  assertEquals(invalid.sort(), ['c.jpg', 'd.jpg']);
  assertEquals(parseLabels(null).labels.size, 0);
  assertEquals(parseLabels([]).labels.size, 0);
});

Deno.test('estimateCostUsd uses gpt-4o-mini input/output rates and tolerates missing usage', () => {
  assertAlmostEquals(estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 0 }), 0.15, 1e-9);
  assertAlmostEquals(estimateCostUsd({ promptTokens: 0, completionTokens: 1_000_000 }), 0.6, 1e-9);
  assertEquals(estimateCostUsd(null), 0);
});

Deno.test('summarizeArm computes accuracy, errors, null parses, averages and place-leak counts per arm', () => {
  const results = [
    result('a'),
    result('a', { ok: false, got: 'pastel' }),
    result('a', { ok: false, got: null }),
    result('a', { ok: false, error: true, got: null, usage: null }),
    result('a', { depictsPlace: true, rawTripTopics: 1 }),
    result('b'),
  ];
  const summary = summarizeArm('a', results);
  assertEquals(summary.calls, 5);
  assertEquals(summary.correct, 2);
  assertEquals(summary.errors, 1);
  assertEquals(summary.nullParses, 1);
  assertAlmostEquals(summary.accuracyPct, 40, 1e-9);
  assertEquals(summary.avgPromptTokens, 1000);
  assertEquals(summary.placeCalls, 1);
  assertEquals(summary.placeCallsWithRawTripTopics, 1);
});

Deno.test("recommend keeps 'low' unless a challenger is at least 15 points better", () => {
  const base = { calls: 10, errors: 0, correct: 0, nullParses: 0, avgPromptTokens: 0, avgCompletionTokens: 0, totalCostUsd: 0, placeCalls: 0, placeCallsWithRawTripTopics: 0 };
  const a = { ...base, armId: 'a' as const, accuracyPct: 60, avgCostUsd: 0.0001 };
  const closeB = { ...base, armId: 'b' as const, accuracyPct: 70, avgCostUsd: 0.0003 };
  const winC = { ...base, armId: 'c' as const, accuracyPct: 80, avgCostUsd: 0.0004 };
  assertEquals(recommend([a, closeB]).startsWith('No arm is >= 15 pts better'), true);
  const winning = recommend([a, closeB, winC]);
  assertEquals(winning.startsWith('Arm c beats'), true);
  assertEquals(winning.includes('1280px'), true);
  assertEquals(recommend([a]).startsWith('Run arm a plus'), true);
});
