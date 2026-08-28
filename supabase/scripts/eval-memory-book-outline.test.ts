import { assertEquals } from 'jsr:@std/assert@1';

import {
  addDays,
  ageYearLabel,
  buildBackboneSegments,
  buildOutlineRequestBody,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  admitThemedSpreads,
  buildReadingOrder,
  computeThemedSpreadBudget,
  enforceThemedSpreadSpacing,
  reassignDissolvedSpreadMembers,
  SPREAD_BUDGET_PAGES_PER_SPREAD,
  SPREAD_SPILL_BOUND,
  buildSpecialSegmentTitlesByMonth,
  buildTaggedMemberFeatures,
  classifyOrientation,
  computeAgeYearBirthdayMonths,
  computeFirstPhotoOrientation,
  computeMedianDate,
  computeMemoryEligibility,
  computePlacedPanoramaGuaranteeCount,
  computeRequiredPacingGaps,
  computeScopeWindow,
  resolveOutlineLanguage,
  BCP47_PATTERN,
  FALLBACK_LANGUAGE,
  dissolveSmallThemedSpreads,
  dissolveThinBirthdaySpreads,
  emotionCandidatesToUnified,
  findAnchorSegmentIndex,
  flagSpecialBackboneSegments,
  formatMonthRangeLabel,
  formatOrientationMarker,
  fromJulianDayNumber,
  isQuoteSupportedByContent,
  isTimeAnchoredCandidate,
  loadMilestonesForMemories,
  normalizeForQuoteCheck,
  CLI_USAGE,
  paceThemedSpreads,
  parseArgs,
  parseOutlineResponse,
  peoplePairCandidatesToUnified,
  planNonBackboneBudget,
  remapInsertIndex,
  resolveBookScope,
  resolveChild,
  resolveSinglePlacement,
  scopeWindowLastInclusiveDay,
  selectBackboneMemories,
  selectEmotionCandidates,
  selectPeoplePairCandidates,
  selectThemedCandidates,
  selectTopicCandidatesWithSparseFallback,
  suppressSurvivingBirthdaySpecialTitles,
  topicCandidatesToUnified,
  verifyQuoteTitles,
  buildSyntheticAsset,
  buildSyntheticManifest,
  buildSyntheticMemory,
  buildSyntheticOutline,
  buildSyntheticPortrait,
  estimatePagesViaFitter,
  type BackboneMemoryInput,
  type ChildCandidate,
  type FamilyMemberForTagging,
  type MediaRow,
  type MemoryFeature,
  type OracleElementInput,
  type ReadingOrderThemedSpreadInput,
  type PacingCandidate,
  type PlacementCandidate,
} from './eval-memory-book-outline.ts';
import { toJulianDayNumber } from '../functions/_shared/date-context.ts';

// --- resolveBookScope ----------------------------------------------------

Deno.test('resolveBookScope requires exactly one scope', () => {
  let threw = false;
  try {
    resolveBookScope({ ageYear: null, calendarYear: null, from: null, to: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('resolveBookScope rejects more than one scope', () => {
  let threw = false;
  try {
    resolveBookScope({ ageYear: 1, calendarYear: 2024, from: null, to: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('resolveBookScope accepts age-year', () => {
  const scope = resolveBookScope({ ageYear: 2, calendarYear: null, from: null, to: null });
  assertEquals(scope, { type: 'age-year', ageYear: 2 });
});

Deno.test('resolveBookScope rejects age-year < 1', () => {
  let threw = false;
  try {
    resolveBookScope({ ageYear: 0, calendarYear: null, from: null, to: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('resolveBookScope accepts calendar-year', () => {
  const scope = resolveBookScope({ ageYear: null, calendarYear: 2023, from: null, to: null });
  assertEquals(scope, { type: 'calendar-year', year: 2023 });
});

Deno.test('resolveBookScope accepts custom range', () => {
  const scope = resolveBookScope({ ageYear: null, calendarYear: null, from: '2023-01-01', to: '2023-06-30' });
  assertEquals(scope, { type: 'custom-range', from: '2023-01-01', to: '2023-06-30' });
});

Deno.test('resolveBookScope rejects from > to', () => {
  let threw = false;
  try {
    resolveBookScope({ ageYear: null, calendarYear: null, from: '2023-06-30', to: '2023-01-01' });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('resolveBookScope rejects a lone --from', () => {
  let threw = false;
  try {
    resolveBookScope({ ageYear: null, calendarYear: null, from: '2023-01-01', to: null });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- parseArgs (owner hardening fix, 2026-08-27: never-silently-drop
// applies at the CLI level too -- an unrecognized token used to fall
// through to a no-op default case, so a malformed invocation could proceed
// with a silently-partial or entirely-unparsed set of options) -------------

Deno.test('parseArgs: a known flag combination parses cleanly, including a repeated --exclude-memory-id', () => {
  const options = parseArgs([
    '--child', 'Enzo',
    '--age-year', '1',
    '--exclude-memory-id', 'm1',
    '--exclude-memory-id', 'm2',
    '--dry-run',
  ]);
  assertEquals(options.child, 'Enzo');
  assertEquals(options.ageYear, 1);
  assertEquals(options.excludeMemoryIds, ['m1', 'm2']);
  assertEquals(options.dryRun, true);
});

Deno.test('parseArgs: an unknown argument throws with the offending token and usage, instead of being silently dropped', () => {
  let error: Error | null = null;
  try {
    parseArgs(['--child', 'Enzo', '--totally-not-a-flag']);
  } catch (e) {
    error = e as Error;
  }
  assertEquals(error !== null, true);
  assertEquals(error!.message.includes('--totally-not-a-flag'), true);
  assertEquals(error!.message.includes(CLI_USAGE), true);
});

Deno.test('parseArgs: the reported incident -- a mangled multi-flag string arriving as one unrecognized token -- is rejected, not silently ignored', () => {
  let error: Error | null = null;
  try {
    parseArgs(['--child', 'Enzo', '--exclude-memory-id m1 --exclude-memory-id m2 --exclude-memory-id m3']);
  } catch (e) {
    error = e as Error;
  }
  assertEquals(error !== null, true);
  assertEquals(error!.message.includes('--exclude-memory-id m1'), true);
});

// --- Julian day round trip + addDays -------------------------------------

Deno.test('fromJulianDayNumber inverts toJulianDayNumber', () => {
  for (const date of ['2024-01-01', '2024-02-29', '2023-12-31', '2000-01-01', '2027-07-04']) {
    const jdn = toJulianDayNumber(date);
    const { year, month, day } = fromJulianDayNumber(jdn);
    const rebuilt = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    assertEquals(rebuilt, date);
  }
});

Deno.test('addDays crosses month and year boundaries', () => {
  assertEquals(addDays('2023-12-31', 1), '2024-01-01');
  assertEquals(addDays('2024-02-28', 1), '2024-02-29'); // leap year
  assertEquals(addDays('2023-02-28', 1), '2023-03-01'); // non-leap year
  assertEquals(addDays('2024-01-01', -1), '2023-12-31');
});

// --- computeScopeWindow (all three scope types) --------------------------

Deno.test('computeScopeWindow: age-year 1 is birth -> 1st birthday', () => {
  const window = computeScopeWindow({ type: 'age-year', ageYear: 1 }, '2022-05-10');
  assertEquals(window.start, '2022-05-10');
  assertEquals(window.endExclusive, '2023-05-10');
  assertEquals(window.label, 'Year One');
});

Deno.test('computeScopeWindow: age-year 3 window', () => {
  const window = computeScopeWindow({ type: 'age-year', ageYear: 3 }, '2020-01-15');
  assertEquals(window.start, '2022-01-15');
  assertEquals(window.endExclusive, '2023-01-15');
});

Deno.test('computeScopeWindow: age-year throws without a DOB', () => {
  let threw = false;
  try {
    computeScopeWindow({ type: 'age-year', ageYear: 1 }, null);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('computeScopeWindow: calendar-year is Jan 1 -> next Jan 1 exclusive', () => {
  const window = computeScopeWindow({ type: 'calendar-year', year: 2024 }, null);
  assertEquals(window.start, '2024-01-01');
  assertEquals(window.endExclusive, '2025-01-01');
  assertEquals(scopeWindowLastInclusiveDay(window), '2024-12-31');
});

Deno.test('computeScopeWindow: custom range is inclusive on both ends', () => {
  const window = computeScopeWindow({ type: 'custom-range', from: '2023-06-01', to: '2023-06-30' }, null);
  assertEquals(window.start, '2023-06-01');
  assertEquals(window.endExclusive, '2023-07-01');
  assertEquals(scopeWindowLastInclusiveDay(window), '2023-06-30');
});

Deno.test('ageYearLabel spells out ordinals', () => {
  assertEquals(ageYearLabel(1), 'Year One');
  assertEquals(ageYearLabel(4), 'Year Four');
  assertEquals(ageYearLabel(25), 'Year 25');
});

// --- resolveChild ----------------------------------------------------------

const MEMBERS: ChildCandidate[] = [
  { id: 'id-1', familyId: 'fam-1', name: 'Enzo', dateOfBirth: '2020-01-01', nicknames: [] },
  { id: 'id-2', familyId: 'fam-1', name: 'Mara', dateOfBirth: '2022-01-01', nicknames: [] },
  { id: 'id-3', familyId: 'fam-2', name: 'Enzo', dateOfBirth: '2019-01-01', nicknames: [] },
];

Deno.test('resolveChild matches by id', () => {
  assertEquals(resolveChild(MEMBERS, 'id-2').name, 'Mara');
});

Deno.test('resolveChild matches by exact unique name', () => {
  assertEquals(resolveChild(MEMBERS, 'Mara').id, 'id-2');
});

Deno.test('resolveChild throws on ambiguous name', () => {
  let threw = false;
  try {
    resolveChild(MEMBERS, 'Enzo');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('resolveChild throws on no match', () => {
  let threw = false;
  try {
    resolveChild(MEMBERS, 'Nobody');
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- computeMemoryEligibility ----------------------------------------------

Deno.test('computeMemoryEligibility: tagged to child is eligible', () => {
  const result = computeMemoryEligibility(['child-1', 'sibling-1'], 'child-1');
  assertEquals(result, { eligible: true, taggedToChild: true, untaggedInWindow: false });
});

Deno.test('computeMemoryEligibility: untagged is eligible', () => {
  const result = computeMemoryEligibility([], 'child-1');
  assertEquals(result, { eligible: true, taggedToChild: false, untaggedInWindow: true });
});

Deno.test('computeMemoryEligibility: sibling-only tagged is NOT eligible', () => {
  const result = computeMemoryEligibility(['sibling-1'], 'child-1');
  assertEquals(result, { eligible: false, taggedToChild: false, untaggedInWindow: false });
});

// --- loadMilestonesForMemories (owner round-4 decision, 2026-08-27: a
// 'dismissed' memory_milestones row is the owner correcting a factually-
// wrong match -- product-correct path, the future confirmation UI does
// exactly this -- so it must never surface downstream. Firsts, per-memory
// milestone context, and birthday detection all read the SAME query's
// output, so filtering it here covers all three at once.) --------------

/** A minimal fake of the supabase-js query-builder chain that records every
 * method call, so the `.neq('status', 'dismissed')` filter is verifiable
 * without a live database -- this script has no DB-mocking infrastructure
 * elsewhere, so this stays intentionally tiny (just enough surface for
 * `loadMilestonesForMemories`'s own chain) rather than a general client. */
function fakeMilestonesSupabase(calls: string[]) {
  const chain = {
    select(columns: string) {
      calls.push(`select:${columns}`);
      return chain;
    },
    neq(column: string, value: string) {
      calls.push(`neq:${column}:${value}`);
      return chain;
    },
    in(column: string, values: string[]) {
      calls.push(`in:${column}:${values.join(',')}`);
      return chain;
    },
    order(column: string) {
      calls.push(`order:${column}`);
      return chain;
    },
    range(from: number, to: number) {
      calls.push(`range:${from}:${to}`);
      return Promise.resolve({ data: [], error: null });
    },
  };
  return {
    from(table: string) {
      calls.push(`from:${table}`);
      return chain;
    },
  } as unknown as Parameters<typeof loadMilestonesForMemories>[0];
}

Deno.test('loadMilestonesForMemories: filters out dismissed rows at the query level', async () => {
  const calls: string[] = [];
  await loadMilestonesForMemories(fakeMilestonesSupabase(calls), ['m1', 'm2']);
  assertEquals(calls.includes('from:memory_milestones'), true);
  assertEquals(calls.includes('neq:status:dismissed'), true);
  // The filter must be applied to the SAME query Firsts/milestone-context/
  // birthday detection all read -- not a second, separately-filtered call.
  assertEquals(calls.filter((c) => c.startsWith('from:')).length, 1);
});

Deno.test('loadMilestonesForMemories: an empty memoryIds list never queries the database', async () => {
  const calls: string[] = [];
  await loadMilestonesForMemories(fakeMilestonesSupabase(calls), []);
  assertEquals(calls, []);
});

// --- buildBackboneSegments (segmentation + merging) -------------------------

function backboneInput(id: string, date: string, printable = true): BackboneMemoryInput {
  return { id, date, printable };
}

Deno.test('buildBackboneSegments: a month with >=3 printable memories is its own segment', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-05'),
    backboneInput('b', '2023-01-10'),
    backboneInput('c', '2023-01-20'),
  ]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].label, 'January 2023');
  assertEquals(segments[0].memoryIds, ['a', 'b', 'c']);
});

Deno.test('buildBackboneSegments: merges adjacent sparse months forward', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-05'), // 1 printable in Jan
    backboneInput('b', '2023-02-10'), // 1 printable in Feb -> still < 3, keep merging
    backboneInput('c', '2023-03-01'), // 1 printable in Mar -> total 3, flush
    backboneInput('d', '2023-03-15'),
  ]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].monthKeys, ['2023-01', '2023-02', '2023-03']);
  assertEquals(segments[0].memoryIds, ['a', 'b', 'c', 'd']);
  assertEquals(segments[0].label, 'January–March 2023');
});

Deno.test('buildBackboneSegments: trailing sparse months fold into the previous segment', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-01'),
    backboneInput('b', '2023-01-02'),
    backboneInput('c', '2023-01-03'), // Jan reaches 3 -> flush
    backboneInput('d', '2023-02-01'), // Feb has only 1 -> never reaches 3, folds into Jan segment
  ]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].monthKeys, ['2023-01', '2023-02']);
  assertEquals(segments[0].memoryIds, ['a', 'b', 'c', 'd']);
});

Deno.test('buildBackboneSegments: non-printable memories do not count toward the threshold but still ride along', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-01', true),
    backboneInput('b', '2023-01-02', false),
    backboneInput('c', '2023-01-03', false),
    backboneInput('d', '2023-02-01', true),
    backboneInput('e', '2023-02-02', true),
  ]);
  // Jan has only 1 printable -> merges into Feb, which brings the total to 3.
  assertEquals(segments.length, 1);
  assertEquals(segments[0].memoryIds, ['a', 'b', 'c', 'd', 'e']);
});

Deno.test('buildBackboneSegments: crosses a year boundary in its label', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-12-01'),
    backboneInput('b', '2024-01-01'),
    backboneInput('c', '2024-01-15'),
  ]);
  assertEquals(segments.length, 1);
  assertEquals(formatMonthRangeLabel(segments[0].monthKeys), 'December 2023 – January 2024');
});

Deno.test('buildBackboneSegments: empty input produces no segments', () => {
  assertEquals(buildBackboneSegments([]), []);
});

// --- flagSpecialBackboneSegments + buildSpecialSegmentTitlesByMonth (plan
// round-2 decision, 2026-08-25: special titles for birth/birthday months) --

Deno.test('flagSpecialBackboneSegments: flags the birth month, taking priority over a birthday month', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2022-05-10'),
    backboneInput('b', '2022-05-12'),
    backboneInput('c', '2022-05-20'),
  ]);
  // The same month is (implausibly) both the birth month and a birthday
  // month -- birth wins.
  const flags = flagSpecialBackboneSegments(segments, '2022-05', new Map([['2022-05', 1]]));
  assertEquals(flags.length, 1);
  assertEquals(flags[0], { segmentId: segments[0].id, month: '2022-05', kind: 'birth' });
});

Deno.test('flagSpecialBackboneSegments: flags a birthday month with its age turned', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-05-10'),
    backboneInput('b', '2023-05-12'),
    backboneInput('c', '2023-05-20'),
  ]);
  const flags = flagSpecialBackboneSegments(segments, '2022-05', new Map([['2023-05', 1]]));
  assertEquals(flags, [{ segmentId: segments[0].id, month: '2023-05', kind: 'birthday', ageTurned: 1 }]);
});

Deno.test('flagSpecialBackboneSegments: an unremarkable segment is not flagged', () => {
  const segments = buildBackboneSegments([backboneInput('a', '2023-07-01'), backboneInput('b', '2023-07-02'), backboneInput('c', '2023-07-03')]);
  assertEquals(flagSpecialBackboneSegments(segments, '2022-05', new Map([['2023-05', 1]])), []);
});

Deno.test('flagSpecialBackboneSegments: null birth month never flags anything as birth', () => {
  const segments = buildBackboneSegments([backboneInput('a', '2023-05-10'), backboneInput('b', '2023-05-12'), backboneInput('c', '2023-05-20')]);
  assertEquals(flagSpecialBackboneSegments(segments, null, new Map()), []);
});

// --- round-18 segment-merge case: a sparse year merges the opening and
// closing-run-up months into ONE backbone segment -- both flags must
// survive, each keyed to its own month, instead of the old `break`-after-
// first-birthday-month silently dropping the second one -----------------

Deno.test('flagSpecialBackboneSegments: a segment merging TWO distinct flagged months carries BOTH flags, each keyed to its own month', () => {
  // 2023-01 has 1 printable memory, 2023-02 has 2 -- buildBackboneSegments
  // merges them forward into ONE segment once the running count reaches 3.
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-15'),
    backboneInput('b', '2023-02-05'),
    backboneInput('c', '2023-02-20'),
  ]);
  assertEquals(segments.length, 1);
  assertEquals(segments[0].monthKeys, ['2023-01', '2023-02']);

  const flags = flagSpecialBackboneSegments(
    segments,
    null,
    new Map([
      ['2023-01', 1],
      ['2023-02', 2],
    ]),
  );
  assertEquals(flags.length, 2);
  assertEquals(flags.every((f) => f.segmentId === segments[0].id), true);
  assertEquals(flags, [
    { segmentId: segments[0].id, month: '2023-01', kind: 'birthday', ageTurned: 1 },
    { segmentId: segments[0].id, month: '2023-02', kind: 'birthday', ageTurned: 2 },
  ]);
});

Deno.test('flagSpecialBackboneSegments: a segment merging the birth month with a DIFFERENT month\'s birthday carries both -- birth priority is per-month, not whole-segment', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-15'),
    backboneInput('b', '2023-02-05'),
    backboneInput('c', '2023-02-20'),
  ]);
  assertEquals(segments.length, 1);

  const flags = flagSpecialBackboneSegments(segments, '2023-01', new Map([['2023-02', 1]]));
  assertEquals(flags, [
    { segmentId: segments[0].id, month: '2023-01', kind: 'birth' },
    { segmentId: segments[0].id, month: '2023-02', kind: 'birthday', ageTurned: 1 },
  ]);
});

// --- computeAgeYearBirthdayMonths (round-18 fix -- see its doc comment for
// the two bugs this replaces: the closing run-up month's birthday memory is
// dated ON the window's excluded endExclusive boundary and can never be
// loaded, and the opening month's flag used to depend on a real
// birthday-milestone memory happening to exist there) ----------------------

Deno.test('computeAgeYearBirthdayMonths: Year One (ageYear 1) -- opening (age 0) is omitted, only the closing run-up month (age 1) is flagged', () => {
  const scope = { type: 'age-year' as const, ageYear: 1 };
  const window = computeScopeWindow(scope, '2023-05-10');
  const months = computeAgeYearBirthdayMonths(scope, window);
  assertEquals([...months.entries()], [['2024-05', 1]]);
});

Deno.test('computeAgeYearBirthdayMonths: Year Two (ageYear 2) -- BOTH the opening (age 1) and closing run-up (age 2) months are flagged', () => {
  const scope = { type: 'age-year' as const, ageYear: 2 };
  const window = computeScopeWindow(scope, '2023-05-10');
  const months = computeAgeYearBirthdayMonths(scope, window);
  assertEquals(months.get('2024-05'), 1); // opening month = birthday N-1 = turns 1
  assertEquals(months.get('2025-05'), 2); // closing run-up month = birthday N = turns 2
  assertEquals(months.size, 2);
});

Deno.test('computeAgeYearBirthdayMonths: calendar-year and custom-range scopes return an empty map -- interior birthdays keep the OLD data-dependent behavior', () => {
  const window = computeScopeWindow({ type: 'calendar-year', year: 2023 }, null);
  assertEquals(computeAgeYearBirthdayMonths({ type: 'calendar-year', year: 2023 }, window).size, 0);

  const rangeWindow = computeScopeWindow({ type: 'custom-range', from: '2023-01-01', to: '2023-12-31' }, null);
  assertEquals(
    computeAgeYearBirthdayMonths({ type: 'custom-range', from: '2023-01-01', to: '2023-12-31' }, rangeWindow).size,
    0,
  );
});

Deno.test('computeAgeYearBirthdayMonths: end-to-end -- the real Enzo year-two incident (no specials at all) now flags both boundary months, and the closing month survives even though no memory is dated exactly on the boundary day', () => {
  const scope = { type: 'age-year' as const, ageYear: 2 };
  const window = computeScopeWindow(scope, '2023-05-10');
  const months = computeAgeYearBirthdayMonths(scope, window);

  // A sparse year-two archive: a few memories near the opening month, a few
  // near the closing month, NONE dated on the actual (excluded) boundary day.
  const segments = buildBackboneSegments([
    backboneInput('a', '2024-05-12'), // opening month (2024-05), a couple days after the birthday
    backboneInput('b', '2024-05-20'),
    backboneInput('c', '2025-05-01'), // closing run-up month (2025-05), still before the boundary day (05-10)
    backboneInput('d', '2025-05-05'),
  ]);
  const flags = flagSpecialBackboneSegments(segments, null, months);
  assertEquals(
    flags.some((f) => f.kind === 'birthday' && f.ageTurned === 1),
    true,
  );
  assertEquals(
    flags.some((f) => f.kind === 'birthday' && f.ageTurned === 2),
    true,
  );
});

// --- resolveOutlineLanguage (round-18 LANGUAGE resolution: the code-level
// safety net around the model's own chain -- steps 2/3 only, step 1
// "predominant caption language" is the model's job alone) ----------------

Deno.test('resolveOutlineLanguage: a valid model language wins over the configured one', () => {
  assertEquals(resolveOutlineLanguage('es', 'en-US'), 'es');
});

Deno.test('resolveOutlineLanguage: falls back to the configured language when the model omitted its own', () => {
  assertEquals(resolveOutlineLanguage(null, 'es-MX'), 'es-MX');
});

Deno.test('resolveOutlineLanguage: falls back to English when neither is available', () => {
  assertEquals(resolveOutlineLanguage(null, null), FALLBACK_LANGUAGE);
  assertEquals(resolveOutlineLanguage(null, null), 'en');
});

Deno.test('resolveOutlineLanguage: a garbled configured language is treated as unusable, same as absent', () => {
  assertEquals(resolveOutlineLanguage(null, 'not a language code!!'), 'en');
});

Deno.test('BCP47_PATTERN: accepts real-world codes, rejects garbage', () => {
  for (const code of ['en', 'es', 'es-MX', 'pt-BR', 'zh-Hans-CN']) {
    assertEquals(BCP47_PATTERN.test(code), true, code);
  }
  for (const code of ['', 'not a code', 'es_MX', '123']) {
    assertEquals(BCP47_PATTERN.test(code), false, code);
  }
});

Deno.test('buildSpecialSegmentTitlesByMonth: bridges the AI title from the original segment id to its month', () => {
  const flags = [{ segmentId: 'orig-2023-05', month: '2023-05', kind: 'birthday' as const, ageTurned: 1 }];
  const byMonth = buildSpecialSegmentTitlesByMonth(flags, { 'orig-2023-05': 'The month you turned one' });
  assertEquals(byMonth.get('2023-05'), 'The month you turned one');
});

Deno.test('buildSpecialSegmentTitlesByMonth: ignores a title for a segment id that was not actually flagged', () => {
  const flags = [{ segmentId: 'orig-2023-05', month: '2023-05', kind: 'birthday' as const, ageTurned: 1 }];
  const byMonth = buildSpecialSegmentTitlesByMonth(flags, { 'some-other-segment': 'Should not appear' });
  assertEquals(byMonth.size, 0);
});

Deno.test('buildSpecialSegmentTitlesByMonth: skips a blank AI title', () => {
  const flags = [{ segmentId: 'orig-2023-05', month: '2023-05', kind: 'birth' as const }];
  const byMonth = buildSpecialSegmentTitlesByMonth(flags, { 'orig-2023-05': '   ' });
  assertEquals(byMonth.size, 0);
});

// --- suppressSurvivingBirthdaySpecialTitles (owner round-3 note, 2026-08-25:
// birthday-beat precedence -- a surviving spread wins, its month reverts to
// plain; birth-month titles are never affected) ----------------------------

Deno.test('suppressSurvivingBirthdaySpecialTitles: drops a birthday flag whose spread survived (>=3 memories)', () => {
  const flags = [{ segmentId: 'seg-2023-05', month: '2023-05', kind: 'birthday' as const, ageTurned: 2 }];
  const result = suppressSurvivingBirthdaySpecialTitles(flags, new Set([2]));
  assertEquals(result, []);
});

Deno.test('suppressSurvivingBirthdaySpecialTitles: keeps a birthday flag whose spread dissolved (not in the surviving set)', () => {
  const flags = [{ segmentId: 'seg-2023-05', month: '2023-05', kind: 'birthday' as const, ageTurned: 2 }];
  const result = suppressSurvivingBirthdaySpecialTitles(flags, new Set());
  assertEquals(result, flags);
});

Deno.test('suppressSurvivingBirthdaySpecialTitles: never suppresses a birth-month flag, regardless of surviving ages', () => {
  const flags = [{ segmentId: 'seg-birth', month: '2022-05', kind: 'birth' as const }];
  const result = suppressSurvivingBirthdaySpecialTitles(flags, new Set([1, 2, 3]));
  assertEquals(result, flags);
});

Deno.test('suppressSurvivingBirthdaySpecialTitles: mixed flags -- only the surviving birthday one is dropped', () => {
  const flags = [
    { segmentId: 'seg-birth', month: '2022-05', kind: 'birth' as const },
    { segmentId: 'seg-bday-1', month: '2023-05', kind: 'birthday' as const, ageTurned: 1 },
    { segmentId: 'seg-bday-2', month: '2024-05', kind: 'birthday' as const, ageTurned: 2 },
  ];
  const result = suppressSurvivingBirthdaySpecialTitles(flags, new Set([2]));
  assertEquals(result.map((f) => f.segmentId), ['seg-birth', 'seg-bday-1']);
});

Deno.test('buildReadingOrder: a special segment title renders with the plain month label as its subtitle', () => {
  const finalBackboneSegments = buildBackboneSegments([
    backboneInput('a', '2023-05-10'),
    backboneInput('b', '2023-05-12'),
    backboneInput('c', '2023-05-20'),
  ]);
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments,
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [],
    backboneRationale: {},
    specialSegmentTitles: { [finalBackboneSegments[0].id]: 'The month you turned one' },
  });
  const segmentSection = sections.find((s) => s.id === `backbone:${finalBackboneSegments[0].id}`)!;
  assertEquals(segmentSection.title, 'The month you turned one');
  assertEquals(segmentSection.subtitle, finalBackboneSegments[0].label);
});

Deno.test('buildReadingOrder: a backbone segment with no special title renders its plain label, no subtitle', () => {
  const finalBackboneSegments = buildBackboneSegments([backboneInput('a', '2023-07-01'), backboneInput('b', '2023-07-02'), backboneInput('c', '2023-07-03')]);
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments,
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [],
    backboneRationale: {},
  });
  const segmentSection = sections.find((s) => s.id === `backbone:${finalBackboneSegments[0].id}`)!;
  assertEquals(segmentSection.title, finalBackboneSegments[0].label);
  assertEquals(segmentSection.subtitle, undefined);
});

// --- buildTaggedMemberFeatures (plan round-2 decision, 2026-08-25:
// relationship words may ONLY come from tagged-member evidence) -----------

Deno.test('buildTaggedMemberFeatures: resolves name and child/adult classification at the memory date', () => {
  const membersById = new Map<string, FamilyMemberForTagging>([
    ['child-id', { id: 'child-id', name: 'Enzo Ray', dateOfBirth: '2021-01-01', nicknames: [] }],
    ['grandma-id', { id: 'grandma-id', name: 'Nonna Rosa', dateOfBirth: '1955-01-01', nicknames: [] }],
  ]);
  const result = buildTaggedMemberFeatures(['child-id', 'grandma-id'], membersById, '2023-06-01');
  assertEquals(result, [
    { firstName: 'Enzo', personType: 'child', nicknames: [] },
    { firstName: 'Nonna', personType: 'adult', nicknames: [] },
  ]);
});

Deno.test('buildTaggedMemberFeatures: unresolvable member ids are skipped, not thrown', () => {
  const result = buildTaggedMemberFeatures(['ghost-id'], new Map(), '2023-06-01');
  assertEquals(result, []);
});

Deno.test('buildTaggedMemberFeatures: unknown date of birth yields personType unknown', () => {
  const membersById = new Map<string, FamilyMemberForTagging>([
    ['id-1', { id: 'id-1', name: 'Mystery Guest', dateOfBirth: null, nicknames: [] }],
  ]);
  const result = buildTaggedMemberFeatures(['id-1'], membersById, '2023-06-01');
  assertEquals(result, [{ firstName: 'Mystery', personType: 'unknown', nicknames: [] }]);
});

// --- Round-16 (owner correction): nicknames come from the family_members
// PROFILE column, never text-mined -- this is the "roster plumbing" pure
// part: a loaded member row's `nicknames` flows through
// `buildTaggedMemberFeatures` into the per-memory prompt input untouched. --

Deno.test('buildTaggedMemberFeatures: a profile nickname flows through untouched into the tagged-member feature', () => {
  const membersById = new Map<string, FamilyMemberForTagging>([
    ['grandma-id', { id: 'grandma-id', name: 'Rosa', dateOfBirth: '1955-01-01', nicknames: ['nonna', 'nona'] }],
  ]);
  const result = buildTaggedMemberFeatures(['grandma-id'], membersById, '2023-06-01');
  assertEquals(result, [{ firstName: 'Rosa', personType: 'adult', nicknames: ['nonna', 'nona'] }]);
});

Deno.test('buildTaggedMemberFeatures: a member with no profile nicknames gets an empty array, never invented', () => {
  const membersById = new Map<string, FamilyMemberForTagging>([
    ['id-1', { id: 'id-1', name: 'Eduardo', dateOfBirth: '1990-01-01', nicknames: [] }],
  ]);
  const result = buildTaggedMemberFeatures(['id-1'], membersById, '2023-06-01');
  assertEquals(result[0].nicknames, []);
});

// --- selectThemedCandidates (candidate thresholding) -------------------------

Deno.test('selectThemedCandidates: only topics with >= minCount eligible memories qualify', () => {
  const memberships = [
    { memoryId: 'm1', topics: ['beach'] },
    { memoryId: 'm2', topics: ['beach'] },
    { memoryId: 'm3', topics: ['beach'] },
    { memoryId: 'm4', topics: ['beach', 'grandparents'] },
    { memoryId: 'm5', topics: ['grandparents'] },
  ];
  const titles = new Map([
    ['beach', 'A day at the beach'],
    ['grandparents', 'With the grandparents'],
  ]);
  const candidates = selectThemedCandidates(memberships, titles, 4);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].topicId, 'beach');
  assertEquals(candidates[0].memoryIds, ['m1', 'm2', 'm3', 'm4']);
  assertEquals(candidates[0].pageTitle, 'A day at the beach');
});

Deno.test('selectThemedCandidates: ranks by count desc, then topic id asc', () => {
  const memberships = [
    { memoryId: 'm1', topics: ['a', 'b'] },
    { memoryId: 'm2', topics: ['a', 'b'] },
    { memoryId: 'm3', topics: ['a', 'b'] },
    { memoryId: 'm4', topics: ['a'] },
  ];
  const candidates = selectThemedCandidates(memberships, new Map(), 3);
  assertEquals(candidates.map((c) => c.topicId), ['a', 'b']);
});

// --- selectTopicCandidatesWithSparseFallback (sparse Year One threshold) ---

Deno.test('selectTopicCandidatesWithSparseFallback: uses the primary >=4 threshold when it already yields >=3 candidates', () => {
  const memberships = [
    { memoryId: 'm1', topics: ['a'] },
    { memoryId: 'm2', topics: ['a'] },
    { memoryId: 'm3', topics: ['a'] },
    { memoryId: 'm4', topics: ['a'] },
    { memoryId: 'm5', topics: ['b'] },
    { memoryId: 'm6', topics: ['b'] },
    { memoryId: 'm7', topics: ['b'] },
    { memoryId: 'm8', topics: ['b'] },
    { memoryId: 'm9', topics: ['c'] },
    { memoryId: 'm10', topics: ['c'] },
    { memoryId: 'm11', topics: ['c'] },
    { memoryId: 'm12', topics: ['c'] },
  ];
  const candidates = selectTopicCandidatesWithSparseFallback(memberships, new Map());
  assertEquals(candidates.map((c) => c.topicId).sort(), ['a', 'b', 'c']);
});

Deno.test('selectTopicCandidatesWithSparseFallback: drops to >=3 when the primary pass finds fewer than 3 candidates (sparse Year One)', () => {
  const memberships = [
    // Only "a" clears >=4; "b" has exactly 3 (would qualify at the sparse threshold).
    { memoryId: 'm1', topics: ['a'] },
    { memoryId: 'm2', topics: ['a'] },
    { memoryId: 'm3', topics: ['a'] },
    { memoryId: 'm4', topics: ['a'] },
    { memoryId: 'm5', topics: ['b'] },
    { memoryId: 'm6', topics: ['b'] },
    { memoryId: 'm7', topics: ['b'] },
  ];
  const candidates = selectTopicCandidatesWithSparseFallback(memberships, new Map());
  assertEquals(candidates.map((c) => c.topicId).sort(), ['a', 'b']);
});

// --- selectPeoplePairCandidates (Looking Back's pair recipe) ----------------

Deno.test('selectPeoplePairCandidates: only members co-tagged with the child in >=4 memories qualify', () => {
  const memberships = [
    { memoryId: 'm1', coTaggedMemberIds: ['sibling'] },
    { memoryId: 'm2', coTaggedMemberIds: ['sibling'] },
    { memoryId: 'm3', coTaggedMemberIds: ['sibling'] },
    { memoryId: 'm4', coTaggedMemberIds: ['sibling'] },
    { memoryId: 'm5', coTaggedMemberIds: ['grandma'] },
    { memoryId: 'm6', coTaggedMemberIds: ['grandma'] },
  ];
  const names = new Map([['sibling', 'Mara'], ['grandma', 'Abuela']]);
  const candidates = selectPeoplePairCandidates(memberships, names);
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0].memberId, 'sibling');
  assertEquals(candidates[0].memberName, 'Mara');
  assertEquals(candidates[0].memoryIds, ['m1', 'm2', 'm3', 'm4']);
});

Deno.test('selectPeoplePairCandidates: caps at the top 3 by co-tag count', () => {
  const memberships: Array<{ memoryId: string; coTaggedMemberIds: string[] }> = [];
  const counts = { a: 8, b: 7, c: 6, d: 5 };
  for (const [memberId, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      memberships.push({ memoryId: `${memberId}-${i}`, coTaggedMemberIds: [memberId] });
    }
  }
  const candidates = selectPeoplePairCandidates(memberships, new Map());
  assertEquals(candidates.length, 3);
  assertEquals(candidates.map((c) => c.memberId), ['a', 'b', 'c']); // highest co-tag counts win the cap
});

Deno.test('selectPeoplePairCandidates: falls back to the raw member id when no name is provided', () => {
  const memberships = [
    { memoryId: 'm1', coTaggedMemberIds: ['id-x'] },
    { memoryId: 'm2', coTaggedMemberIds: ['id-x'] },
    { memoryId: 'm3', coTaggedMemberIds: ['id-x'] },
    { memoryId: 'm4', coTaggedMemberIds: ['id-x'] },
  ];
  const candidates = selectPeoplePairCandidates(memberships, new Map());
  assertEquals(candidates[0].memberName, 'id-x');
});

// --- selectEmotionCandidates (Looking Back's emotion recipe) ----------------

Deno.test('selectEmotionCandidates: funny and tender qualify at >=4, mischief folds into funny', () => {
  const memories = [
    { memoryId: 'm1', emotion: 'funny' },
    { memoryId: 'm2', emotion: 'funny' },
    { memoryId: 'm3', emotion: 'mischief' },
    { memoryId: 'm4', emotion: 'mischief' },
    { memoryId: 'm5', emotion: 'tender' },
    { memoryId: 'm6', emotion: 'tender' },
    { memoryId: 'm7', emotion: 'tender' },
    { memoryId: 'm8', emotion: 'tender' },
    { memoryId: 'm9', emotion: 'joy' }, // not a target emotion -- ignored
  ];
  const candidates = selectEmotionCandidates(memories);
  const funny = candidates.find((c) => c.emotion === 'funny')!;
  const tender = candidates.find((c) => c.emotion === 'tender')!;
  assertEquals(funny.memoryIds.sort(), ['m1', 'm2', 'm3', 'm4']);
  assertEquals(tender.memoryIds, ['m5', 'm6', 'm7', 'm8']);
});

Deno.test('selectEmotionCandidates: below-threshold emotions are excluded', () => {
  const memories = [
    { memoryId: 'm1', emotion: 'funny' },
    { memoryId: 'm2', emotion: 'funny' },
    { memoryId: 'm3', emotion: null },
  ];
  assertEquals(selectEmotionCandidates(memories), []);
});

// --- Unified candidate model (all three generators feed the same AI call) --

Deno.test('topicCandidatesToUnified / peoplePairCandidatesToUnified / emotionCandidatesToUnified: distinct id namespaces', () => {
  assertEquals(
    topicCandidatesToUnified([{ topicId: 'beach', pageTitle: 'A day at the beach', memoryIds: ['m1'] }]),
    [{ id: 'topic:beach', kind: 'topic', defaultTitle: 'A day at the beach', memoryIds: ['m1'] }],
  );
  assertEquals(
    peoplePairCandidatesToUnified([{ memberId: 'mara-id', memberName: 'Mara', memoryIds: ['m1'] }]),
    [{ id: 'people:mara-id', kind: 'people-pair', defaultTitle: 'With Mara', memoryIds: ['m1'] }],
  );
  assertEquals(
    emotionCandidatesToUnified([{ emotion: 'funny', memoryIds: ['m1'] }]),
    [{ id: 'emotion:funny', kind: 'emotion', defaultTitle: 'The funny ones', memoryIds: ['m1'] }],
  );
  assertEquals(
    emotionCandidatesToUnified([{ emotion: 'tender', memoryIds: ['m1'] }])[0].defaultTitle,
    'The tender ones',
  );
});

// --- computeMedianDate + findAnchorSegmentIndex (pacing's chronological
// soft preference) ----------------------------------------------------------

Deno.test('computeMedianDate: lower median of an odd-length list', () => {
  assertEquals(computeMedianDate(['2023-03-01', '2023-01-01', '2023-02-01']), '2023-02-01');
});

Deno.test('computeMedianDate: lower median of an even-length list', () => {
  assertEquals(computeMedianDate(['2023-01-01', '2023-02-01', '2023-03-01', '2023-04-01']), '2023-02-01');
});

Deno.test('computeMedianDate: throws on an empty list', () => {
  let threw = false;
  try {
    computeMedianDate([]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('findAnchorSegmentIndex: finds the last segment whose last month is <= the anchor', () => {
  const segments = buildBackboneSegments([
    backboneInput('a', '2023-01-05'),
    backboneInput('b', '2023-01-10'),
    backboneInput('c', '2023-01-15'),
    backboneInput('d', '2023-06-05'),
    backboneInput('e', '2023-06-10'),
    backboneInput('f', '2023-06-15'),
  ]);
  assertEquals(segments.length, 2);
  assertEquals(findAnchorSegmentIndex('2023-03', segments), 0); // between Jan and Jun -> last one that fits is Jan
  assertEquals(findAnchorSegmentIndex('2023-06', segments), 1);
  assertEquals(findAnchorSegmentIndex('2022-12', segments), -1); // before everything
});

// --- Pacing (plan 2026-08-24: no 3+ consecutive unbroken backbone segments
// while a spread is available to interleave) --------------------------------

Deno.test('computeRequiredPacingGaps: no gaps needed for <=2 segments', () => {
  assertEquals(computeRequiredPacingGaps(0), []);
  assertEquals(computeRequiredPacingGaps(1), []);
  assertEquals(computeRequiredPacingGaps(2), []);
});

Deno.test('computeRequiredPacingGaps: one required gap for 3 or 4 segments', () => {
  assertEquals(computeRequiredPacingGaps(3), [1]);
  assertEquals(computeRequiredPacingGaps(4), [1]);
});

Deno.test('computeRequiredPacingGaps: scales for larger segment counts', () => {
  assertEquals(computeRequiredPacingGaps(7), [1, 3, 5]);
});

function pacingCandidate(id: string, idealGapIndex: number): PacingCandidate {
  return { id, idealGapIndex };
}

Deno.test('paceThemedSpreads: already-paced input is left unchanged', () => {
  // 4 segments -> requiredGaps = [1]. A spread already sits at gap 1.
  const candidates = [pacingCandidate('s1', 1), pacingCandidate('s2', -1)];
  const result = paceThemedSpreads(4, candidates);
  assertEquals(result.get('s1'), 1);
  assertEquals(result.get('s2'), -1); // untouched -- nothing needed fixing
});

Deno.test('paceThemedSpreads: relocates a free spread to break up a long run', () => {
  // 7 segments -> requiredGaps = [1, 3, 5]. Two spreads sit at the same
  // non-required edge position (-1); one should move to help cover a gap.
  const candidates = [pacingCandidate('s1', -1), pacingCandidate('s2', -1)];
  const result = paceThemedSpreads(7, candidates);
  const positions = [...result.values()].sort((a, b) => a - b);
  // At least one of the two required-gap-adjacent moves should have happened
  // -- with only 2 spreads and 3 required gaps, full coverage isn't possible
  // (scarcity), but every available spread should have been put to use.
  assertEquals(positions.some((p) => p === 1 || p === 3 || p === 5), true);
});

Deno.test('paceThemedSpreads: spread scarcity -- zero candidates is a no-op', () => {
  const result = paceThemedSpreads(7, []);
  assertEquals(result.size, 0);
});

Deno.test('paceThemedSpreads: scarcity -- fewer free spreads than required gaps leaves some unfilled without crashing', () => {
  // 7 segments -> requiredGaps = [1, 3, 5] (3 needed). Only 1 spread exists.
  const candidates = [pacingCandidate('only', -1)];
  const result = paceThemedSpreads(7, candidates);
  assertEquals(result.get('only'), 1); // closest required gap to -1 is 1
  // Only one gap could possibly be covered -- no crash, no fabricated spreads.
  assertEquals(result.size, 1);
});

Deno.test('paceThemedSpreads: prefers the candidate whose ideal gap is closest to the target', () => {
  // 4 segments -> requiredGaps = [1]. Two free candidates at -1 and 3;
  // -1 is closer to 1 (distance 2) than 3 is (distance 2) -- tie breaks on id.
  const near = pacingCandidate('near', 2); // distance 1 from gap 1
  const far = pacingCandidate('far', -1); // distance 2 from gap 1
  const result = paceThemedSpreads(4, [near, far]);
  assertEquals(result.get('near'), 1); // the closer one moves to cover the gap
  assertEquals(result.get('far'), -1); // stays put, wasn't needed
});

Deno.test('paceThemedSpreads: surplus spreads at a satisfied required gap can be relocated to help elsewhere', () => {
  // 7 segments -> requiredGaps = [1, 3, 5]. Two spreads both sit at gap 1
  // (satisfied, redundantly); one of them is free to help cover gap 3.
  const candidates = [pacingCandidate('a', 1), pacingCandidate('b', 1)];
  const result = paceThemedSpreads(7, candidates);
  const positions = [result.get('a'), result.get('b')].sort();
  assertEquals(positions, [1, 3]);
});

// --- isTimeAnchoredCandidate + pacing exemption (plan round-2 decision,
// 2026-08-25: newborn-days and date-gated seasonal topics never relocate) ---

Deno.test('isTimeAnchoredCandidate: newborn-days and date-gated seasonal topics are anchored', () => {
  assertEquals(isTimeAnchoredCandidate('topic:newborn-days'), true);
  assertEquals(isTimeAnchoredCandidate('topic:christmas'), true);
  assertEquals(isTimeAnchoredCandidate('topic:halloween'), true);
  assertEquals(isTimeAnchoredCandidate('topic:thanksgiving'), true);
  assertEquals(isTimeAnchoredCandidate('topic:easter'), true);
  assertEquals(isTimeAnchoredCandidate('topic:valentines'), true);
  assertEquals(isTimeAnchoredCandidate('topic:new-year'), true);
  assertEquals(isTimeAnchoredCandidate('topic:lunar-new-year'), true);
  assertEquals(isTimeAnchoredCandidate('topic:hanukkah'), true);
  assertEquals(isTimeAnchoredCandidate('topic:eid'), true);
  assertEquals(isTimeAnchoredCandidate('topic:diwali'), true);
  assertEquals(isTimeAnchoredCandidate('topic:dia-de-muertos'), true);
  assertEquals(isTimeAnchoredCandidate('topic:mothers-fathers-day'), true);
});

Deno.test('isTimeAnchoredCandidate: a non-seasonal topic, people-pair, or emotion candidate is NOT anchored', () => {
  assertEquals(isTimeAnchoredCandidate('topic:beach'), false);
  assertEquals(isTimeAnchoredCandidate('people:some-member-id'), false);
  assertEquals(isTimeAnchoredCandidate('emotion:funny'), false);
});

Deno.test('paceThemedSpreads: an anchored spread is never relocated, even under scarcity', () => {
  // 7 segments -> requiredGaps = [1, 3, 5]. The only spread that could
  // possibly cover gap 1 is anchored (newborn-days) -- it must stay put at
  // its own ideal gap rather than being dragged into pacing duty.
  const anchored: PacingCandidate = { id: 'spread:topic:newborn-days', idealGapIndex: -1, anchored: true };
  const result = paceThemedSpreads(7, [anchored]);
  assertEquals(result.get('spread:topic:newborn-days'), -1); // untouched
});

Deno.test('paceThemedSpreads: an anchored spread still counts toward gap coverage if it happens to sit on one', () => {
  const anchored: PacingCandidate = { id: 'anchored', idealGapIndex: 1, anchored: true };
  const free: PacingCandidate = { id: 'free', idealGapIndex: -1 };
  // 4 segments -> requiredGaps = [1]. The anchored spread already covers
  // gap 1, so the free spread should NOT be moved off its own ideal spot.
  const result = paceThemedSpreads(4, [anchored, free]);
  assertEquals(result.get('anchored'), 1);
  assertEquals(result.get('free'), -1);
});

// --- resolveSinglePlacement (scarcity) -------------------------------------

Deno.test('resolveSinglePlacement: a memory with one candidate stays there', () => {
  const candidates: PlacementCandidate[] = [{ memoryId: 'm1', spreadId: 'backbone:jan' }];
  const result = resolveSinglePlacement(candidates);
  assertEquals(result.placementByMemory.get('m1'), 'backbone:jan');
  assertEquals(result.reassignments, []);
});

Deno.test('resolveSinglePlacement: conflicting memory goes to the scarcer spread', () => {
  // "beach" has 3 members total (scarce); "backbone:jan" has 5 (plentiful).
  const candidates: PlacementCandidate[] = [
    { memoryId: 'm1', spreadId: 'themed:beach' },
    { memoryId: 'm2', spreadId: 'themed:beach' },
    { memoryId: 'm3', spreadId: 'themed:beach' },
    { memoryId: 'm3', spreadId: 'backbone:jan' },
    { memoryId: 'a', spreadId: 'backbone:jan' },
    { memoryId: 'b', spreadId: 'backbone:jan' },
    { memoryId: 'c', spreadId: 'backbone:jan' },
    { memoryId: 'd', spreadId: 'backbone:jan' },
  ];
  const result = resolveSinglePlacement(candidates);
  assertEquals(result.placementByMemory.get('m3'), 'themed:beach');
  assertEquals(result.reassignments.length, 1);
  assertEquals(result.reassignments[0], { memoryId: 'm3', droppedFrom: ['backbone:jan'], keptIn: 'themed:beach' });
});

Deno.test('resolveSinglePlacement: ties break alphabetically on spread id', () => {
  const candidates: PlacementCandidate[] = [
    { memoryId: 'm1', spreadId: 'themed:zoo' },
    { memoryId: 'm1', spreadId: 'themed:apple' },
  ];
  const result = resolveSinglePlacement(candidates);
  assertEquals(result.placementByMemory.get('m1'), 'themed:apple');
});

// --- dissolveSmallThemedSpreads -------------------------------------------

Deno.test('dissolveSmallThemedSpreads: dissolves a themed spread below minSize and moves members to backbone', () => {
  const placement = new Map([
    ['m1', 'themed:beach'],
    ['m2', 'themed:beach'],
    ['m3', 'backbone:jan'],
  ]);
  const defaults = new Map([
    ['m1', 'backbone:jan'],
    ['m2', 'backbone:feb'],
  ]);
  const result = dissolveSmallThemedSpreads(placement, new Set(['themed:beach']), defaults, 3);
  assertEquals(result.dissolvedSpreadIds, ['themed:beach']);
  assertEquals(result.placementByMemory.get('m1'), 'backbone:jan');
  assertEquals(result.placementByMemory.get('m2'), 'backbone:feb');
  assertEquals(result.movedToBackbone.length, 2);
});

Deno.test('dissolveSmallThemedSpreads: a spread at or above minSize survives', () => {
  const placement = new Map([
    ['m1', 'themed:beach'],
    ['m2', 'themed:beach'],
    ['m3', 'themed:beach'],
  ]);
  const result = dissolveSmallThemedSpreads(placement, new Set(['themed:beach']), new Map(), 3);
  assertEquals(result.dissolvedSpreadIds, []);
  assertEquals(result.placementByMemory.get('m1'), 'themed:beach');
});

// --- dissolveThinBirthdaySpreads (owner round-3 note, 2026-08-25: birthday-
// beat merge rule -- a birthday spread with <3 memories duplicates the beat
// its birthday-month segment already carries) ------------------------------

Deno.test('dissolveThinBirthdaySpreads: a birthday spread under 3 memories dissolves into its birthday month, pinned', () => {
  const placement = new Map([
    ['m1', 'birthday-2'],
    ['m2', 'birthday-2'],
    ['m3', 'backbone:2023-06'],
  ]);
  const defaults = new Map([
    ['m1', 'backbone:2023-05'], // both birthday memories' own default backbone month
    ['m2', 'backbone:2023-05'],
  ]);
  const result = dissolveThinBirthdaySpreads(placement, new Set(['birthday-2']), defaults, 3);
  assertEquals(result.dissolvedAges, [2]);
  // Memories land in the right (their own default) backbone segment.
  assertEquals(result.placementByMemory.get('m1'), 'backbone:2023-05');
  assertEquals(result.placementByMemory.get('m2'), 'backbone:2023-05');
  // Pinned -- must survive backbone thinning.
  assertEquals(result.pinnedMemoryIds.has('m1'), true);
  assertEquals(result.pinnedMemoryIds.has('m2'), true);
  assertEquals(result.movedToBackbone.length, 2);
});

Deno.test('dissolveThinBirthdaySpreads: a birthday spread with >=3 memories survives untouched', () => {
  const placement = new Map([
    ['m1', 'birthday-1'],
    ['m2', 'birthday-1'],
    ['m3', 'birthday-1'],
  ]);
  const result = dissolveThinBirthdaySpreads(placement, new Set(['birthday-1']), new Map(), 3);
  assertEquals(result.dissolvedAges, []);
  assertEquals(result.placementByMemory.get('m1'), 'birthday-1');
  assertEquals(result.pinnedMemoryIds.size, 0);
});

Deno.test('dissolveThinBirthdaySpreads: an empty birthday spread (0 memories) is left alone, not dissolved', () => {
  const result = dissolveThinBirthdaySpreads(new Map(), new Set(['birthday-3']), new Map(), 3);
  assertEquals(result.dissolvedAges, []);
});

// --- computePlacedPanoramaGuaranteeCount (owner round-3 decision,
// 2026-08-27: "1 guaranteed + 1 per ~20 pages" -- round-14: reviewer-context
// count only, formula unchanged, now fed by the pre-cap holistic estimate) --

Deno.test('computePlacedPanoramaGuaranteeCount: 1 guaranteed below the first 20-page tier', () => {
  assertEquals(computePlacedPanoramaGuaranteeCount(0), 1);
  assertEquals(computePlacedPanoramaGuaranteeCount(19), 1);
});

Deno.test('computePlacedPanoramaGuaranteeCount: gains one more per full 20-page tier', () => {
  assertEquals(computePlacedPanoramaGuaranteeCount(20), 2);
  assertEquals(computePlacedPanoramaGuaranteeCount(45), 3);
});

Deno.test('computePlacedPanoramaGuaranteeCount: never negative even for a negative estimate', () => {
  assertEquals(computePlacedPanoramaGuaranteeCount(-100), 1);
});

// --- planNonBackboneBudget / selectBackboneMemories (round-14 owner
// decision: outline-side BUDGET THINNING REMOVED ENTIRELY, following an A/B
// test showing the round-13 shape-placeholder oracle over-thinned real
// books -- see the "Themed-spread and backbone selection" section comment
// in eval-memory-book-outline.ts. Both functions now unconditionally keep
// everyone they are given; these tests assert that NO-CUT invariant plus
// whatever structural rules survive -- there is no more page-cost, budget,
// score, or pin behavior to test, because none of it exists anymore.) -----

Deno.test('planNonBackboneBudget: keeps every themed spread with at least one member, regardless of how many or how large', () => {
  const plan = planNonBackboneBudget([
    { id: 'themed:beach', memoryCount: 5 },
    { id: 'themed:bath', memoryCount: 200 }, // absurdly large -- still kept, nothing here prices it
  ]);
  assertEquals(plan.keptThemedIds.sort(), ['themed:bath', 'themed:beach']);
  assertEquals(plan.droppedThemedIds, []);
});

Deno.test('planNonBackboneBudget: a zero-memoryCount element is excluded (nothing to keep), not "dropped"', () => {
  const plan = planNonBackboneBudget([{ id: 'themed:empty', memoryCount: 0 }, { id: 'themed:real', memoryCount: 1 }]);
  assertEquals(plan.keptThemedIds, ['themed:real']);
  assertEquals(plan.droppedThemedIds, []); // empty, never "dropped for budget" -- there is no budget
});

Deno.test('planNonBackboneBudget: an empty input list returns an empty (not undefined) plan', () => {
  const plan = planNonBackboneBudget([]);
  assertEquals(plan.keptThemedIds, []);
  assertEquals(plan.droppedThemedIds, []);
});

function backboneCandidate(id: string) {
  return { id };
}

Deno.test('selectBackboneMemories: keeps every candidate, regardless of how many', () => {
  const candidates = [backboneCandidate('a'), backboneCandidate('b'), backboneCandidate('c')];
  assertEquals(selectBackboneMemories(candidates).sort(), ['a', 'b', 'c']);
});

Deno.test('selectBackboneMemories: an empty input list returns an empty (not undefined) result', () => {
  assertEquals(selectBackboneMemories([]), []);
});

Deno.test('selectBackboneMemories: preserves input order (no re-sorting by score/date/id -- there is no score anymore)', () => {
  const candidates = [backboneCandidate('z'), backboneCandidate('a'), backboneCandidate('m')];
  assertEquals(selectBackboneMemories(candidates), ['z', 'a', 'm']);
});

// --- remapInsertIndex (themed spread position survives re-segmentation) ----

Deno.test('remapInsertIndex: -1 (before everything) maps straight through', () => {
  const original = buildBackboneSegments([backboneInput('a', '2023-01-01')]);
  const final = buildBackboneSegments([backboneInput('b', '2023-06-01')]);
  assertEquals(remapInsertIndex(-1, original, final), -1);
});

Deno.test('remapInsertIndex: an out-of-range original index also maps to -1', () => {
  const original = buildBackboneSegments([backboneInput('a', '2023-01-01')]);
  const final = buildBackboneSegments([backboneInput('b', '2023-06-01')]);
  assertEquals(remapInsertIndex(5, original, final), -1);
});

Deno.test('remapInsertIndex: anchors on the original segment date and finds the nearest surviving final segment', () => {
  // Original: [Jan-Mar 2023] (index 0), [Jun 2023] (index 1). Model anchored after index 0 (March).
  const original = buildBackboneSegments([
    backboneInput('a', '2023-01-05'),
    backboneInput('b', '2023-02-05'),
    backboneInput('c', '2023-03-05'),
    backboneInput('d', '2023-06-05'),
    backboneInput('e', '2023-06-10'),
    backboneInput('f', '2023-06-15'),
  ]);
  assertEquals(original.length, 2);

  // After budget thinning, only the June memories survived -- final has one segment.
  const final = buildBackboneSegments([
    backboneInput('d', '2023-06-05'),
    backboneInput('e', '2023-06-10'),
    backboneInput('f', '2023-06-15'),
  ]);
  assertEquals(final.length, 1);

  // March (index 0's anchor) is before June's only final segment -> "before everything".
  assertEquals(remapInsertIndex(0, original, final), -1);
});

Deno.test('remapInsertIndex: an anchor after all final segments lands after the last one', () => {
  const original = buildBackboneSegments([
    backboneInput('a', '2023-01-05'),
    backboneInput('b', '2023-01-10'),
    backboneInput('c', '2023-01-15'),
    backboneInput('d', '2023-12-05'),
    backboneInput('e', '2023-12-10'),
    backboneInput('f', '2023-12-15'),
  ]);
  const final = buildBackboneSegments([
    backboneInput('a', '2023-01-05'),
    backboneInput('b', '2023-01-10'),
    backboneInput('c', '2023-01-15'),
  ]);
  assertEquals(final.length, 1);
  // Anchor is December (original index 1), long after the only surviving (January) segment.
  assertEquals(remapInsertIndex(1, original, final), 0);
});

// --- enforceThemedSpreadSpacing (round-15 owner-approved rule: no two
// themed spreads adjacent, at most one per backbone gap -- previously only
// satisfied by page-budget scarcity; round-14 removed that thinning and
// exposed real stacking, e.g. Enzo's jul-oct quote-anchored spreads landing
// 4-in-a-row) -------------------------------------------------------------

function spacingSpread(id: string, anchorGap: number, memberCount = 1) {
  return { id, anchorGap, memberCount };
}

Deno.test('enforceThemedSpreadSpacing: a no-op when every spread already has its own distinct gap', () => {
  const spreads = [spacingSpread('a', 0), spacingSpread('b', 2), spacingSpread('c', 5)];
  const assignment = enforceThemedSpreadSpacing(spreads, 6);
  assertEquals(assignment.get('a'), 0);
  assertEquals(assignment.get('b'), 2);
  assertEquals(assignment.get('c'), 5);
});

Deno.test('enforceThemedSpreadSpacing: an oversubscribed gap is won by the highest member-count spread; the rest spill', () => {
  // Reconstructs the Enzo shape: 4 spreads all anchored to the same gap
  // (a shared jul-oct seasonal window), distinct member counts.
  const spreads = [
    spacingSpread('topic:eating-out', 3, 4),
    spacingSpread('topic:toys-building', 3, 6), // highest -- wins the anchor
    spacingSpread('people:tender', 3, 5),
    spacingSpread('topic:travel', 3, 4),
  ];
  const assignment = enforceThemedSpreadSpacing(spreads, 10);
  assertEquals(assignment.get('topic:toys-building'), 3); // winner keeps the anchor
  // Every OTHER occupant of gap 3 moved off it.
  const others = ['topic:eating-out', 'people:tender', 'topic:travel'].map((id) => assignment.get(id));
  assertEquals(others.every((gap) => gap !== 3), true);
  // No two spreads ever share a gap -- the whole point of the rule.
  const allGaps = [...assignment.values()];
  assertEquals(new Set(allGaps).size, allGaps.length);
});

Deno.test('enforceThemedSpreadSpacing: priority for a contested gap is member count desc, then id asc (no independent ranking signal exists in this outline)', () => {
  // Two spreads tied on member count -- id breaks the tie.
  const spreads = [spacingSpread('topic:zzz', 4, 3), spacingSpread('topic:aaa', 4, 3)];
  const assignment = enforceThemedSpreadSpacing(spreads, 10);
  assertEquals(assignment.get('topic:aaa'), 4); // lexically-earlier id wins the anchor
  assertEquals(assignment.get('topic:zzz') !== 4, true);
});

Deno.test('enforceThemedSpreadSpacing: an overflow spread spills to the NEAREST free gap from its own anchor', () => {
  // Gap 5 is contested; gap 4 is already free and closer than gap 7.
  const spreads = [spacingSpread('winner', 5, 10), spacingSpread('loser', 5, 1)];
  const assignment = enforceThemedSpreadSpacing(spreads, 10);
  assertEquals(assignment.get('winner'), 5);
  assertEquals(assignment.get('loser'), 4); // nearest free gap either side of 5
});

Deno.test('enforceThemedSpreadSpacing: a tied spill distance resolves to the EARLIER (lower) gap', () => {
  // Gap 5 contested by 3 spreads: the winner keeps 5; gap 4 and gap 6 are
  // both free and equidistant from 5 for the next spread in priority order
  // -- it must take gap 4 (earlier), leaving the LAST spread gap 6.
  const spreads = [
    spacingSpread('winner', 5, 10),
    spacingSpread('second', 5, 5),
    spacingSpread('third', 5, 1),
  ];
  const assignment = enforceThemedSpreadSpacing(spreads, 10);
  assertEquals(assignment.get('winner'), 5);
  assertEquals(assignment.get('second'), 4); // tie between gap 4 and gap 6 -> earlier
  assertEquals(assignment.get('third'), 6); // only gap left within the search
});

Deno.test('enforceThemedSpreadSpacing: a time-anchored spread can still spill when its own season is oversubscribed', () => {
  // The function has no "anchored" concept of its own -- an upstream
  // time-anchored spread is simply another spread with a fixed anchorGap;
  // if two of them collide, the lower-priority one still spills (the owner
  // decision: "nearest available gap" IS how a time-anchored exemption
  // stays satisfied under a collision, not a literal same-gap guarantee).
  const spreads = [spacingSpread('newborn-days', 2, 3), spacingSpread('halloween-anchor', 2, 8)];
  const assignment = enforceThemedSpreadSpacing(spreads, 10);
  assertEquals(assignment.get('halloween-anchor'), 2);
  assertEquals(assignment.get('newborn-days'), 1); // spilled to the nearest free gap
});

Deno.test('enforceThemedSpreadSpacing: out-of-range anchors clamp into [-1, lastValidIndex] before spacing runs', () => {
  const spreads = [spacingSpread('a', 99), spacingSpread('b', -50)];
  const assignment = enforceThemedSpreadSpacing(spreads, 3);
  assertEquals([...assignment.values()].every((g) => g >= -1 && g <= 3), true);
});

Deno.test('enforceThemedSpreadSpacing: pathological exhaustion (more spreads than gaps) never drops a spread or crashes', () => {
  // lastValidIndex 1 -> only 3 valid gaps (-1, 0, 1); 5 spreads all anchored
  // to gap 0.
  const spreads = Array.from({ length: 5 }, (_, i) => spacingSpread(`s${i}`, 0, 5 - i));
  const assignment = enforceThemedSpreadSpacing(spreads, 1);
  assertEquals(assignment.size, 5); // every spread still gets SOME assignment
});

// --- computeThemedSpreadBudget (round-16 rule (b): at most
// floor(min(preCapPageEstimate, pageCap) / SPREAD_BUDGET_PAGES_PER_SPREAD)
// themed spreads per book -- same shape as the renderer's own full-bleed
// pacing rule) ---------------------------------------------------------------

Deno.test('computeThemedSpreadBudget: a full 122-page book budgets 8 spreads (the owner\'s own example)', () => {
  assertEquals(SPREAD_BUDGET_PAGES_PER_SPREAD, 15);
  assertEquals(computeThemedSpreadBudget(122, 122), 8); // floor(122/15) = 8
});

Deno.test('computeThemedSpreadBudget: caps the input at pageCap first -- a book that would run longer than the cap earns no extra spreads for pages it will never print', () => {
  assertEquals(computeThemedSpreadBudget(300, 122), 8); // min(300,122)=122 -> floor(122/15)=8, NOT floor(300/15)=20
});

Deno.test('computeThemedSpreadBudget: a smaller book budgets proportionally fewer spreads', () => {
  assertEquals(computeThemedSpreadBudget(40, 122), 2); // floor(40/15) = 2
  assertEquals(computeThemedSpreadBudget(14, 122), 0); // floor(14/15) = 0 -- a tiny book earns none
});

Deno.test('computeThemedSpreadBudget: never negative even for a degenerate (negative or zero) estimate', () => {
  assertEquals(computeThemedSpreadBudget(-50, 122), 0);
  assertEquals(computeThemedSpreadBudget(0, 122), 0);
});

// --- admitThemedSpreads (round-16 owner-approved rules (a)+(b)+(c): a
// spill BOUND on top of round-15's unbounded spacing, a page BUDGET, and
// DISSOLVE (never drop) for anything that loses either contest -- fixes the
// round-15 regeneration's taste regression: 12 spreads saturating every
// gap, one spilling a jul-oct-dated spread next to Oct-Nov 2024/Dec 2024) --

function admissionSpread(id: string, anchorGap: number, memberCount = 1) {
  return { id, anchorGap, memberCount };
}

Deno.test('admitThemedSpreads: a no-op when every spread already has its own gap and fits the budget', () => {
  const spreads = [admissionSpread('a', 0), admissionSpread('b', 2), admissionSpread('c', 5)];
  const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, 10, 10);
  assertEquals(placedGapById.get('a'), 0);
  assertEquals(placedGapById.get('b'), 2);
  assertEquals(placedGapById.get('c'), 5);
  assertEquals(dissolvedIds, []);
});

Deno.test('admitThemedSpreads: rule (b) -- spreads beyond the budget dissolve outright, lowest priority first (member count desc, then id asc)', () => {
  const spreads = [
    admissionSpread('big', 0, 10),
    admissionSpread('mid', 1, 5),
    admissionSpread('small', 2, 1),
  ];
  const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, 10, 2); // budget of 2 -- only the top 2 survive
  assertEquals([...placedGapById.keys()].sort(), ['big', 'mid']);
  assertEquals(dissolvedIds, ['small']);
});

Deno.test('admitThemedSpreads: rule (a) -- a spread exactly at the spill bound distance is placeable', () => {
  // Processed in priority order (member count desc): "winner" claims gap 5;
  // "filler4"/"filler6" claim their OWN anchors (4 and 6) before the lowest-
  // priority "contender" (also anchored at 5) is ever considered -- by the
  // time it runs, gaps 4-6 are all taken, so it must spill exactly 2 away.
  const spreads = [
    admissionSpread('winner', 5, 10),
    admissionSpread('filler4', 4, 9),
    admissionSpread('filler6', 6, 8),
    admissionSpread('contender', 5, 1),
  ];
  const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, 10, 4); // budget 4 -- everyone fits
  assertEquals(placedGapById.get('winner'), 5);
  assertEquals(placedGapById.get('filler4'), 4);
  assertEquals(placedGapById.get('filler6'), 6);
  // Exactly SPREAD_SPILL_BOUND away from its own anchor (5), and the EARLIER
  // of the two equidistant options (3 vs 7) per the documented tie-break.
  assertEquals(placedGapById.get('contender'), 5 - SPREAD_SPILL_BOUND);
  assertEquals(dissolvedIds, []);
});

Deno.test('admitThemedSpreads: rule (a) boundary -- one gap beyond the spill bound is unplaceable and DISSOLVES, never drops silently', () => {
  // Every gap within 2 of anchor 5 (3,4,5,6,7) is already taken -- the
  // contender has nowhere to land within its bound and must dissolve.
  const spreads = [
    admissionSpread('g3', 3, 10),
    admissionSpread('g4', 4, 10),
    admissionSpread('g5', 5, 10),
    admissionSpread('g6', 6, 10),
    admissionSpread('g7', 7, 10),
    admissionSpread('contender', 5, 1), // lowest priority -- loses every gap in [3,7]
  ];
  const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, 10, 6); // budget 6 -- everyone fits the BUDGET, only the BOUND is being tested
  assertEquals(dissolvedIds, ['contender']);
  assertEquals(placedGapById.has('contender'), false);
  // Everyone else still placed, none doubled up.
  const allGaps = [...placedGapById.values()];
  assertEquals(new Set(allGaps).size, allGaps.length);
});

Deno.test('admitThemedSpreads: reconstructs the real Enzo shape -- 12 candidate spreads over a 9-segment backbone, budget 8, every survivor within the spill bound of its own anchor', () => {
  // Mirrors the round-16 bug report: most candidates anchor to the shared
  // jul-oct window (segments 6-8), a few scattered earlier.
  const spreads = [
    admissionSpread('bikes-scooters', 0, 4),
    admissionSpread('funny', 1, 6),
    admissionSpread('people-a', 2, 6),
    admissionSpread('treats', 3, 5),
    admissionSpread('eating-out', 6, 4),
    admissionSpread('toys-building', 6, 5),
    admissionSpread('tender', 7, 6),
    admissionSpread('people-b', 7, 6),
    admissionSpread('people-c', 7, 6),
    admissionSpread('travel', 7, 3), // lowest member count in the jul-oct cluster
    admissionSpread('days-out', 8, 5),
    admissionSpread('extra-thin', 8, 2), // lowest priority overall -- expected to dissolve for budget
  ];
  const lastValidIndex = 8; // 9 backbone segments
  const budget = computeThemedSpreadBudget(122, 122); // 8, the owner's own example
  const { placedGapById, dissolvedIds } = admitThemedSpreads(spreads, lastValidIndex, budget);

  // At most `budget` survive -- the jul-oct cluster is dense enough that
  // ONE budget-admitted spread ("days-out") also fails to find a free gap
  // within its own spill bound and dissolves too, landing below budget.
  // This is expected: the budget cut and the spill bound are two
  // INDEPENDENT ways to lose, not a guarantee of exactly `budget` survivors.
  assertEquals(placedGapById.size <= budget, true);
  assertEquals(placedGapById.size + dissolvedIds.length, spreads.length); // nobody vanishes -- every id is accounted for
  // Every survivor is within SPREAD_SPILL_BOUND of its OWN anchor.
  const anchorById = new Map(spreads.map((s) => [s.id, s.anchorGap]));
  for (const [id, gap] of placedGapById) {
    assertEquals(Math.abs(gap - anchorById.get(id)!) <= SPREAD_SPILL_BOUND, true);
  }
  // No two survivors share a gap.
  const allGaps = [...placedGapById.values()];
  assertEquals(new Set(allGaps).size, allGaps.length);
  // The lowest-priority spread in the whole set dissolves for budget, and
  // the jul-oct cluster is dense enough that at least one more dissolves
  // purely from being unplaceable within its own bound.
  assertEquals(dissolvedIds.includes('extra-thin'), true);
  assertEquals(dissolvedIds.length > spreads.length - budget, true);
});

// --- reassignDissolvedSpreadMembers (round-16 rule (c), "dissolve, never
// drop": a dissolved spread's memories return to their OWN natural
// chronological backbone home, as if never grouped) -------------------------

Deno.test('reassignDissolvedSpreadMembers: routes a dissolved spread\'s members to their own default backbone segment', () => {
  const placement = new Map([
    ['m1', 'spread:travel'],
    ['m2', 'spread:travel'],
    ['m3', 'backbone:2025-08'],
  ]);
  const dissolved = new Map([['spread:travel', ['m1', 'm2']]]);
  const defaultBackbone = new Map([
    ['m1', 'backbone:2025-08'],
    ['m2', 'backbone:2025-09'],
  ]);
  const result = reassignDissolvedSpreadMembers(placement, dissolved, defaultBackbone);
  assertEquals(result.get('m1'), 'backbone:2025-08');
  assertEquals(result.get('m2'), 'backbone:2025-09');
  assertEquals(result.get('m3'), 'backbone:2025-08'); // untouched -- was never in a dissolved spread
});

Deno.test('reassignDissolvedSpreadMembers: ZERO memories are ever lost -- the key set is identical before and after', () => {
  const placement = new Map([
    ['m1', 'spread:travel'],
    ['m2', 'spread:tender'],
    ['m3', 'backbone:2025-08'],
    ['m4', 'firsts'],
  ]);
  const dissolved = new Map([
    ['spread:travel', ['m1']],
    ['spread:tender', ['m2']],
  ]);
  const defaultBackbone = new Map([
    ['m1', 'backbone:2025-08'],
    ['m2', 'backbone:2025-09'],
  ]);
  const result = reassignDissolvedSpreadMembers(placement, dissolved, defaultBackbone);
  assertEquals(new Set(result.keys()), new Set(placement.keys())); // same union of memory ids
  assertEquals(result.size, placement.size);
});

Deno.test('reassignDissolvedSpreadMembers: a memory with no default-backbone entry is left at its current placement rather than vanishing', () => {
  const placement = new Map([['m1', 'spread:travel']]);
  const dissolved = new Map([['spread:travel', ['m1']]]);
  const result = reassignDissolvedSpreadMembers(placement, dissolved, new Map()); // no default entry for m1
  assertEquals(result.get('m1'), 'spread:travel'); // stays put, never lost
});

// --- buildReadingOrder (the assembly-bug regression: a surviving themed,
// Firsts, and birthday spread must all appear in the rendered order; plan
// 2026-08-24: Firsts now closes the book, right before Closing) -----------

Deno.test('buildReadingOrder: a surviving themed spread, Firsts spread, and birthday spread all appear at their insert positions', () => {
  const finalBackboneSegments = buildBackboneSegments([
    backboneInput('jan1', '2023-01-05'),
    backboneInput('jan2', '2023-01-10'),
    backboneInput('jan3', '2023-01-15'),
    backboneInput('jun1', '2023-06-05'),
    backboneInput('jun2', '2023-06-10'),
    backboneInput('jun3', '2023-06-15'),
  ]);
  assertEquals(finalBackboneSegments.length, 2); // Jan segment (index 0), Jun segment (index 1)

  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments,
    firsts: { present: true, title: 'Big and small wins', memoryIds: ['first-steps-memory', 'first-word-memory'] },
    birthdaySpreads: [{ ageTurned: 2, memoryIds: ['bday-1', 'bday-2', 'bday-3'] }],
    themedSpreads: [
      {
        candidateId: 'topic:bikes-scooters',
        candidateKind: 'topic',
        title: 'On wheels',
        titleMode: 'descriptive',
        titleSourceMemoryId: null,
        memoryIds: ['bike-1', 'bike-2', 'bike-3'],
        insertAfterFinalSegmentIndex: 0, // right after the Jan segment
        rationale: { 'bike-1': 'first scooter ride' },
        kicker: 'lo que más te gustó hacer',
      },
    ],
    backboneRationale: {},
    highlightedMemoryIds: new Set(['jan1']),
  });

  const byId = new Map(sections.map((s) => [s.id, s]));

  // Every section that should exist actually appears.
  assertEquals(byId.has('firsts'), true);
  assertEquals(byId.get('firsts')!.memoryIds, ['first-steps-memory', 'first-word-memory']);
  assertEquals(byId.get('firsts')!.title, 'Big and small wins');

  assertEquals(byId.has('birthday-2'), true);
  assertEquals(byId.get('birthday-2')!.memoryIds, ['bday-1', 'bday-2', 'bday-3']);

  assertEquals(byId.has('topic:bikes-scooters'), true);
  assertEquals(byId.get('topic:bikes-scooters')!.memoryIds, ['bike-1', 'bike-2', 'bike-3']);
  assertEquals(byId.get('topic:bikes-scooters')!.rationale, { 'bike-1': 'first scooter ride' });
  assertEquals(byId.get('topic:bikes-scooters')!.spreadType, 'topic');
  assertEquals(byId.get('topic:bikes-scooters')!.kicker, 'lo que más te gustó hacer');

  // Highlight persistence (design handoff decision, 2026-08-27): a
  // highlighted memory inside the Jan segment shows up on that segment's
  // `highlights`, scoped to just that segment's own members.
  assertEquals(byId.get(`backbone:${finalBackboneSegments[0].id}`)!.highlights, ['jan1']);
  assertEquals(byId.get(`backbone:${finalBackboneSegments[1].id}`)!.highlights, []);

  // Position: the birthday spread stays chronological (before the backbone
  // body); the themed spread sits right after the Jan backbone segment and
  // before the Jun one; Firsts now closes the book, right before Closing.
  const order = sections.map((s) => s.id);
  const birthdayIdx = order.indexOf('birthday-2');
  const janIdx = order.indexOf(`backbone:${finalBackboneSegments[0].id}`);
  const themedIdx = order.indexOf('topic:bikes-scooters');
  const junIdx = order.indexOf(`backbone:${finalBackboneSegments[1].id}`);
  const firstsIdx = order.indexOf('firsts');
  const closingIdx = order.indexOf('closing');

  assertEquals(birthdayIdx < janIdx, true);
  assertEquals(janIdx < themedIdx, true);
  assertEquals(themedIdx < junIdx, true);
  assertEquals(junIdx < firstsIdx, true);
  assertEquals(firstsIdx < closingIdx, true);
  assertEquals(closingIdx, sections.length - 1);
});

Deno.test('buildReadingOrder: Firsts falls back to FIRSTS_DEFAULT_TITLE when the model supplied no title', () => {
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments: [],
    firsts: { present: true, title: null, memoryIds: ['m1'] },
    birthdaySpreads: [],
    themedSpreads: [],
    backboneRationale: {},
  });
  const firsts = sections.find((s) => s.id === 'firsts')!;
  assertEquals(firsts.title, 'Big and small victories this year');
});

Deno.test('buildReadingOrder: the firsts section carries warmNames, filtered to its own surviving memoryIds', () => {
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments: [],
    firsts: {
      present: true,
      title: 'Grandes y pequeñas victorias',
      memoryIds: ['m1'], // m2 lost its placement contest / didn't survive budget
      warmNames: [
        { memoryId: 'm1', milestoneId: 'first-steps', warmName: 'Diste tus primeros pasos.' },
        { memoryId: 'm2', milestoneId: 'first-haircut', warmName: 'Tuviste tu primer corte de pelo.' },
      ],
    },
    birthdaySpreads: [],
    themedSpreads: [],
    backboneRationale: {},
  });
  const firsts = sections.find((s) => s.id === 'firsts')!;
  assertEquals(firsts.firstsWarmNames, [{ memoryId: 'm1', milestoneId: 'first-steps', warmName: 'Diste tus primeros pasos.' }]);
});

Deno.test('buildReadingOrder: an out-of-range insert index clamps to the last final segment instead of vanishing', () => {
  const finalBackboneSegments = buildBackboneSegments([backboneInput('a', '2023-01-01')]);
  const sections = buildReadingOrder({
    childName: 'Mara',
    finalBackboneSegments,
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [
      {
        candidateId: 'topic:beach',
        candidateKind: 'topic',
        title: 'Beach',
        titleMode: 'descriptive',
        titleSourceMemoryId: null,
        memoryIds: ['x'],
        insertAfterFinalSegmentIndex: 99,
        rationale: {},
        kicker: null,
      },
    ],
    backboneRationale: {},
  });
  assertEquals(sections.some((s) => s.id === 'topic:beach'), true);
});

function readingOrderThemedSpread(
  candidateId: string,
  insertAfterFinalSegmentIndex: number,
  memoryIds: string[],
): ReadingOrderThemedSpreadInput {
  return {
    candidateId,
    candidateKind: 'topic',
    title: candidateId,
    titleMode: 'descriptive',
    titleSourceMemoryId: null,
    memoryIds,
    insertAfterFinalSegmentIndex,
    rationale: {},
    kicker: null,
  };
}

Deno.test('buildReadingOrder: round-15 -- four spreads anchored to the same backbone gap (the real Enzo shape) never end up adjacent, and no gap holds more than one', () => {
  const finalBackboneSegments = buildBackboneSegments([
    backboneInput('aug1', '2025-08-05'),
    backboneInput('aug2', '2025-08-10'),
    backboneInput('aug3', '2025-08-15'),
    backboneInput('sep1', '2025-09-05'),
    backboneInput('sep2', '2025-09-10'),
    backboneInput('sep3', '2025-09-15'),
    backboneInput('oct1', '2025-10-05'),
    backboneInput('oct2', '2025-10-10'),
    backboneInput('oct3', '2025-10-15'),
  ]);
  assertEquals(finalBackboneSegments.length, 3); // Aug, Sep, Oct

  // All four candidates anchor to the SAME gap (index 0 -- right after Aug),
  // exactly the "stacked 4-in-a-row" bug report: eating-out, toys-building,
  // tender, and travel all draw from the shared jul-oct window.
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments,
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [
      readingOrderThemedSpread('topic:eating-out', 0, ['m1', 'm2', 'm3', 'm4']),
      readingOrderThemedSpread('topic:toys-building', 0, ['m5', 'm6', 'm7', 'm8', 'm9', 'm10']),
      readingOrderThemedSpread('emotion:tender', 0, ['m11', 'm12', 'm13', 'm14', 'm15']),
      readingOrderThemedSpread('topic:travel', 0, ['m16', 'm17', 'm18', 'm19']),
    ],
    backboneRationale: {},
  });

  const kinds = sections.map((s) => s.kind);
  // Invariant (1): no two themed sections are ever adjacent in the reading order.
  for (let i = 0; i < kinds.length - 1; i++) {
    assertEquals(kinds[i] === 'themed' && kinds[i + 1] === 'themed', false);
  }
  // Invariant (2): at most one themed spread between any two consecutive
  // backbone elements -- i.e. every maximal run of 'themed' sections has length 1.
  let runLength = 0;
  for (const kind of kinds) {
    runLength = kind === 'themed' ? runLength + 1 : 0;
    assertEquals(runLength <= 1, true);
  }
  // All four spreads still appear -- nobody was dropped, only relocated.
  const themedIds = sections.filter((s) => s.kind === 'themed').map((s) => s.id);
  assertEquals(themedIds.sort(), ['emotion:tender', 'topic:eating-out', 'topic:toys-building', 'topic:travel'].sort());
});

Deno.test('buildReadingOrder: already-spaced themed spreads are a no-op -- round-15 changes nothing when there was no conflict', () => {
  const finalBackboneSegments = buildBackboneSegments([
    backboneInput('jan1', '2023-01-05'),
    backboneInput('jan2', '2023-01-10'),
    backboneInput('jan3', '2023-01-15'),
    backboneInput('feb1', '2023-02-05'),
    backboneInput('feb2', '2023-02-10'),
    backboneInput('feb3', '2023-02-15'),
  ]);
  const sections = buildReadingOrder({
    childName: 'Mara',
    finalBackboneSegments,
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [
      readingOrderThemedSpread('topic:a', -1, ['m1']),
      readingOrderThemedSpread('topic:b', 0, ['m2']),
    ],
    backboneRationale: {},
  });
  const order = sections.map((s) => s.id);
  assertEquals(order.indexOf('topic:a') < order.indexOf(`backbone:${finalBackboneSegments[0].id}`), true);
  assertEquals(
    order.indexOf('topic:b') > order.indexOf(`backbone:${finalBackboneSegments[0].id}`) &&
      order.indexOf('topic:b') < order.indexOf(`backbone:${finalBackboneSegments[1].id}`),
    true,
  );
});

Deno.test('buildReadingOrder: cover/title/through-the-years/closing always appear even with an empty book', () => {
  const sections = buildReadingOrder({
    childName: 'Enzo',
    finalBackboneSegments: [],
    firsts: null,
    birthdaySpreads: [],
    themedSpreads: [],
    backboneRationale: {},
  });
  assertEquals(sections.map((s) => s.id), ['cover', 'title', 'through-the-years', 'closing']);
});

// --- Photo orientation (owner root-cause fix, 2026-08-27: panorama
// candidates must be `wide` -- the AI had no way to judge orientation
// because aspect_ratio was never surfaced at all) ----------------------------

function mediaRow(overrides: Partial<MediaRow> = {}): MediaRow {
  return {
    id: 'media1',
    memory_id: 'm1',
    object_key: 'obj1',
    content_type: 'image/jpeg',
    position: 0,
    preview_object_key: null,
    aspect_ratio: null,
    ...overrides,
  };
}

Deno.test('classifyOrientation: clearly wide/tall/square', () => {
  assertEquals(classifyOrientation(1.5), 'wide');
  assertEquals(classifyOrientation(0.5), 'tall');
  assertEquals(classifyOrientation(1.0), 'square');
});

Deno.test('classifyOrientation: boundary values fall to square (strict inequalities)', () => {
  assertEquals(classifyOrientation(1.15), 'square');
  assertEquals(classifyOrientation(0.87), 'square');
});

Deno.test('computeFirstPhotoOrientation: no media at all returns null', () => {
  assertEquals(computeFirstPhotoOrientation([]), null);
});

Deno.test('computeFirstPhotoOrientation: media with only videos returns null', () => {
  const media = [mediaRow({ id: 'v1', content_type: 'video/mp4', position: 0, aspect_ratio: 1.7 })];
  assertEquals(computeFirstPhotoOrientation(media), null);
});

Deno.test('computeFirstPhotoOrientation: first photo lacking aspect_ratio returns null -- never falls back to a later photo', () => {
  const media = [
    mediaRow({ id: 'p1', position: 0, aspect_ratio: null }),
    mediaRow({ id: 'p2', position: 1, aspect_ratio: 1.7 }),
  ];
  assertEquals(computeFirstPhotoOrientation(media), null);
});

Deno.test('computeFirstPhotoOrientation: returns the first photo\'s orientation and ratio', () => {
  const media = [mediaRow({ id: 'p1', position: 0, aspect_ratio: 1.7 })];
  assertEquals(computeFirstPhotoOrientation(media), { orientation: 'wide', ratio: 1.7 });
});

Deno.test('computeFirstPhotoOrientation: sorts by position first, regardless of input array order', () => {
  const media = [
    mediaRow({ id: 'p2', position: 1, aspect_ratio: 1.7 }),
    mediaRow({ id: 'p1', position: 0, aspect_ratio: 0.5 }),
  ];
  assertEquals(computeFirstPhotoOrientation(media), { orientation: 'tall', ratio: 0.5 });
});

Deno.test('formatOrientationMarker: null info formats as null', () => {
  assertEquals(formatOrientationMarker(null), null);
});

Deno.test('formatOrientationMarker: wide at or above the callout threshold spells out the ratio', () => {
  assertEquals(formatOrientationMarker({ orientation: 'wide', ratio: 1.7 }), 'wide 1.7:1');
});

Deno.test('formatOrientationMarker: wide below the callout threshold has no ratio callout', () => {
  assertEquals(formatOrientationMarker({ orientation: 'wide', ratio: 1.2 }), 'wide');
});

Deno.test('formatOrientationMarker: tall and square format plainly', () => {
  assertEquals(formatOrientationMarker({ orientation: 'tall', ratio: 0.5 }), 'tall');
  assertEquals(formatOrientationMarker({ orientation: 'square', ratio: 1.0 }), 'square');
});

// --- buildOutlineSystemPrompt (prompt-string assertions -- items 1 and 4 of
// the round-2 brief are prompt rules, not code-enforced logic) ------------

Deno.test('buildOutlineSystemPrompt: relationship words may only come from tagged-member evidence', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('RELATIONSHIP WORDS'), true);
  assertEquals(prompt.includes('TAGGED PEOPLE'), true);
  assertEquals(prompt.includes('NEVER infer a relationship from what people look like in a photo'), true);
  // The real failure this rule exists to prevent.
  assertEquals(prompt.includes('Entre tias, tios y primos'), true);
  assertEquals(prompt.includes('Look who came to see you'), true);
});

Deno.test('buildOutlineSystemPrompt: round-16 (owner correction) -- prefers a member\'s own profile nickname over their first name in generated copy, with the real examples and article guidance', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('PEOPLE-PAIR SPREAD TITLES AND NAMES IN COPY'), true);
  assertEquals(prompt.includes('PREFER their own profile nickname'), true);
  assertEquals(prompt.includes('"nn:" field'), true);
  assertEquals(prompt.includes('natural article handling'), true);
  assertEquals(prompt.includes('"Con la nonna"'), true);
  assertEquals(prompt.includes('"Con papi"'), true);
  assertEquals(prompt.includes('"Tus momentos con Billy"'), true);
  // Never invent one -- fall back only when the profile has none.
  assertEquals(prompt.includes('never invent a nickname that is not listed'), true);
  // The profile itself is the evidence -- no separate text-mining requirement.
  assertEquals(prompt.includes('it needs no separate confirmation'), true);
});

Deno.test('buildOutlineSystemPrompt: explains the quote/descriptive title modes with the real examples', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('title_mode'), true);
  assertEquals(prompt.includes('"quote"'), true);
  assertEquals(prompt.includes('"descriptive"'), true);
  assertEquals(prompt.includes('Ay Dios mío'), true);
  assertEquals(prompt.includes('Papi, con amor, por favor'), true);
  assertEquals(prompt.includes('title_source_memory_id'), true);
});

Deno.test('buildOutlineSystemPrompt: the title-fits-all rule and its real BAD example survive the quote-mode amendment', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('MUST BE TRUE OF EVERY MEMORY IN THE SPREAD'), true);
  assertEquals(prompt.includes('¡Nos vamos en avión!'), true);
  assertEquals(prompt.includes('A quote does not exempt a title from this rule'), true);
});

Deno.test('buildOutlineSystemPrompt: instructs special segment_titles only for flagged segments', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('segment_titles'), true);
  assertEquals(prompt.includes('welcome to the world'), true);
  assertEquals(prompt.includes('the month you turned N'), true);
});

// Design handoff decision (2026-08-27): kicker + hero candidates.

Deno.test('buildOutlineSystemPrompt: explains the kicker with its real examples, themed spreads only', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('KICKER'), true);
  assertEquals(prompt.includes('kicker'), true);
  assertEquals(prompt.includes('lo que nos hiciste reír'), true);
  assertEquals(prompt.includes('lo que más te gustó hacer'), true);
  assertEquals(prompt.includes('<=6 words'), true);
});

Deno.test('buildOutlineSystemPrompt: asks for up to 5 hero_candidates', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('HERO CANDIDATES'), true);
  assertEquals(prompt.includes('hero_candidates'), true);
  assertEquals(prompt.includes('up to 5'), true);
});

Deno.test('buildOutlineSystemPrompt: hero candidates are orientation-aware -- wide/square preferred, tall not forbidden (owner root-cause fix, 2026-08-27)', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('prefer `wide` or `square` for a full-bleed page'), true);
  assertEquals(prompt.includes('a `tall` photo makes a poor full-page bleed'), true);
  assertEquals(prompt.includes('not forbidden'), true);
});

Deno.test('buildOutlineSystemPrompt: panorama nomination is uncapped and best-first, never "up to 3"', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('PANORAMA CANDIDATES'), true);
  assertEquals(prompt.includes('panorama_candidates'), true);
  assertEquals(prompt.includes('no cap'), true);
  assertEquals(prompt.includes('BEST-FIRST'), true);
  assertEquals(prompt.includes('up to 3'), false); // superseded by the uncapped amendment
});

Deno.test('buildOutlineSystemPrompt: panorama candidates must be wide -- 2:1 double-page span, tall/square forbidden, empty list is valid (owner root-cause fix, 2026-08-27)', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('TWO PAGES at roughly 2:1'), true);
  assertEquals(prompt.includes('a `tall` or `square` photo can NEVER work here'), true);
  assertEquals(prompt.includes('MUST show `wide`'), true);
  assertEquals(prompt.includes('returning an EMPTY list is the correct, expected answer'), true);
  assertEquals(prompt.includes('never nominate a tall or square photo just to avoid an empty list'), true);
});

Deno.test('buildOutlineSystemPrompt: nominates panoramas generously -- aim 5-10, over-nomination is free (owner round-4 decision, 2026-08-27: nomination was the bottleneck, not resolution)', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('NOMINATE GENEROUSLY'), true);
  assertEquals(prompt.includes('Aim for 5-10 candidates'), true);
  assertEquals(prompt.includes('over-nomination costs nothing'), true);
  assertEquals(prompt.includes('under-nomination kills a panoramic spread outright'), true);
  // Validation rules (wide-only / 2:1 / empty-list-valid) survive the amendment unchanged.
  assertEquals(prompt.includes('MUST show `wide`'), true);
  assertEquals(prompt.includes('returning an EMPTY list is the correct, expected answer'), true);
});

Deno.test('buildOutlineSystemPrompt: asks for a dedication and back cover line, and never mentions spine/closing as AI fields', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('dedication'), true);
  assertEquals(prompt.includes('back_cover_line'), true);
  assertEquals(prompt.includes('spine'), false);
});

Deno.test('buildOutlineSystemPrompt: dedication must NOT open with a salutation -- the page furniture prints it (owner round-3 decision, 2026-08-27)', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('do NOT open with a salutation'), true);
  assertEquals(prompt.includes('Para <name>'), true);
  // The stale example duplicating the furniture's own greeting must be gone.
  assertEquals(prompt.includes('Para Enzo'), false);
});

Deno.test('buildOutlineSystemPrompt: editorial_note is documented as INTERNAL ONLY, never printed', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('editorial_note'), true);
  assertEquals(prompt.includes('INTERNAL ONLY'), true);
  assertEquals(prompt.includes('never printed in the book'), true);
});

Deno.test('buildOutlineSystemPrompt: explains FIRSTS WARM NAMES with the real examples', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('FIRSTS WARM NAMES'), true);
  assertEquals(prompt.includes('warm_name'), true);
  assertEquals(prompt.includes('Aprendiste a montar bicicleta sin pedales'), true);
  assertEquals(prompt.includes('Tuviste tu primer corte de pelo'), true);
  assertEquals(prompt.includes('firsts_milestones'), true);
});

// --- round-18 LANGUAGE resolution ------------------------------------------

Deno.test('buildOutlineSystemPrompt: explains the LANGUAGE resolution chain and requires a language field', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('LANGUAGE:'), true);
  assertEquals(prompt.includes('predominant language'), true);
  assertEquals(prompt.includes('CONFIGURED LANGUAGE'), true);
  assertEquals(prompt.includes('LANGUAGE EVIDENCE ONLY'), true);
  assertEquals(prompt.includes('REQUIRED'), true);
  assertEquals(prompt.includes('`language` field'), true);
});

Deno.test('buildOutlineSystemPrompt: the JSON shape requires a top-level "language" field', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('"language": "<REQUIRED'), true);
});

// --- round-18 PROTAGONIST RULE (spread membership is caption-gated: a
// caption-less tagged photo is always admissible; an explicit narrative
// caption centering someone else keeps the memory in the backbone) --------

Deno.test('buildOutlineSystemPrompt: the protagonist rule admits caption-less tagged memories unconditionally', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('PROTAGONIST RULE'), true);
  assertEquals(prompt.includes('ALWAYS admissible'), true);
});

Deno.test('buildOutlineSystemPrompt: the protagonist rule excludes only a captioned memory that centers someone else, with the real burger-dinner example', () => {
  const prompt = buildOutlineSystemPrompt();
  assertEquals(prompt.includes('centers someone else'), true);
  assertEquals(prompt.includes('burger-dinner'), true);
  assertEquals(prompt.includes('stays in the chronological backbone') || prompt.includes('stays in the backbone'), true);
});

Deno.test('buildOutlineSystemPrompt: the protagonist rule explicitly covers all three candidate kinds, including emotion spreads', () => {
  const prompt = buildOutlineSystemPrompt();
  const ruleStart = prompt.indexOf('PROTAGONIST RULE');
  assertEquals(ruleStart >= 0, true);
  const ruleLine = prompt.slice(ruleStart, prompt.indexOf('\n', ruleStart) + 400);
  assertEquals(ruleLine.includes('topic'), true);
  assertEquals(ruleLine.includes('people-pair'), true);
  assertEquals(ruleLine.includes('emotion'), true);
});

// --- buildOutlineUserPrompt (tagged-people metadata + flagged segments) ----

function fixtureFeature(overrides: Partial<MemoryFeature> = {}): MemoryFeature {
  return {
    id: 'm1',
    date: '2023-06-01',
    topics: [],
    topicDetails: {},
    emotion: null,
    hasText: false,
    excerpt: null,
    textLength: 0,
    photoCount: 0,
    videoCount: 0,
    previewKey: null,
    engagementCount: 0,
    milestones: [],
    birthdayAgeTurned: null,
    taggedToChild: true,
    taggedMembers: [],
    photoOrientation: null,
    ...overrides,
  };
}

Deno.test('buildOutlineUserPrompt: includes each memory\'s tagged people with child/adult markers', () => {
  const features = new Map([
    ['m1', fixtureFeature({ taggedMembers: [{ firstName: 'Enzo', personType: 'child', nicknames: [] }, { firstName: 'Nonna', personType: 'adult', nicknames: [] }] })],
  ]);
  const prompt = buildOutlineUserPrompt(
    {
      childName: 'Enzo',
      scopeLabel: 'Year One',
      windowStart: '2023-01-01',
      windowLastDay: '2023-12-31',
      backboneSegments: [],
      firstsCount: 0,
      birthdaySpreads: [],
      throughTheYearsCount: 0,
      specialSegments: [],
      configuredLanguage: null,
      languageEvidenceCaptions: [],
    },
    [],
    features,
  );
  assertEquals(prompt.includes('Enzo(child)'), true);
  assertEquals(prompt.includes('Nonna(adult)'), true);
});

Deno.test('buildOutlineUserPrompt: round-16 (owner correction) -- a profile nickname is surfaced as an "nn:" suffix on the tagged-person entry, never for a person with no profile nickname', () => {
  const features = new Map([
    [
      'm1',
      fixtureFeature({
        taggedMembers: [
          { firstName: 'Rosa', personType: 'adult', nicknames: ['nonna', 'nona'] },
          { firstName: 'Enzo', personType: 'child', nicknames: [] },
        ],
      }),
    ],
  ]);
  const prompt = buildOutlineUserPrompt(
    {
      childName: 'Enzo',
      scopeLabel: 'Year One',
      windowStart: '2023-01-01',
      windowLastDay: '2023-12-31',
      backboneSegments: [],
      firstsCount: 0,
      birthdaySpreads: [],
      throughTheYearsCount: 0,
      specialSegments: [],
      configuredLanguage: null,
      languageEvidenceCaptions: [],
    },
    [],
    features,
  );
  assertEquals(prompt.includes('Rosa(adult;nn:nonna/nona)'), true);
  assertEquals(prompt.includes('Enzo(child)'), true); // no nicknames -- no "nn:" suffix, never invented
});

Deno.test('buildOutlineUserPrompt: per-memory row includes the orientation marker when present, omits the suffix when absent (owner root-cause fix, 2026-08-27)', () => {
  const features = new Map([
    ['m1', fixtureFeature({ id: 'm1', photoCount: 1, videoCount: 0, photoOrientation: { orientation: 'wide', ratio: 1.7 } })],
    ['m2', fixtureFeature({ id: 'm2', photoCount: 1, videoCount: 0, photoOrientation: null })],
  ]);
  const prompt = buildOutlineUserPrompt(
    {
      childName: 'Enzo',
      scopeLabel: 'Year One',
      windowStart: '2023-01-01',
      windowLastDay: '2023-12-31',
      backboneSegments: [],
      firstsCount: 0,
      birthdaySpreads: [],
      throughTheYearsCount: 0,
      specialSegments: [],
      configuredLanguage: null,
      languageEvidenceCaptions: [],
    },
    [],
    features,
  );
  assertEquals(prompt.includes('p1/v0/wide 1.7:1'), true);
  assertEquals(prompt.includes('p1/v0 |'), true); // m2: no orientation marker suffix at all
});

Deno.test('buildOutlineUserPrompt: flags a special segment for the model with its kind', () => {
  const segments = buildBackboneSegments([backboneInput('a', '2022-05-10'), backboneInput('b', '2022-05-12'), backboneInput('c', '2022-05-20')]);
  const prompt = buildOutlineUserPrompt(
    {
      childName: 'Enzo',
      scopeLabel: 'Year One',
      windowStart: '2022-05-01',
      windowLastDay: '2022-05-31',
      backboneSegments: segments,
      firstsCount: 0,
      birthdaySpreads: [],
      throughTheYearsCount: 0,
      specialSegments: [{ segmentId: segments[0].id, month: '2022-05', kind: 'birth' }],
      configuredLanguage: null,
      languageEvidenceCaptions: [],
    },
    [],
    new Map(),
  );
  assertEquals(prompt.includes('FLAGGED: birth month'), true);
});

Deno.test('buildOutlineUserPrompt: a single genuine milestone still gets its own FIRSTS MILESTONES block (owner round-4 decision, 2026-08-27: a live regen had the owner dismiss a wrong match, leaving exactly ONE real milestone -- the OLD >=2 gate withheld the milestone_id slug entirely, and the model guessed the bare NAME instead, producing an unknown_firsts_milestone violation for a perfectly real milestone; a single genuine victory now earns the section)', () => {
  const features = new Map([
    ['m1', fixtureFeature({
      id: 'm1',
      milestones: [{ milestoneId: 'balance-bike', name: 'Rides scooter / balance bike', detail: null, outOfBand: false }],
    })],
  ]);
  const promptSkeleton = {
    childName: 'Enzo',
    scopeLabel: 'Year One',
    windowStart: '2023-01-01',
    windowLastDay: '2023-12-31',
    backboneSegments: [],
    birthdaySpreads: [],
    throughTheYearsCount: 0,
    specialSegments: [],
    configuredLanguage: null,
    languageEvidenceCaptions: [],
  };

  const zero = buildOutlineUserPrompt({ ...promptSkeleton, firstsCount: 0 }, [], new Map());
  assertEquals(zero.includes('FIRSTS MILESTONES'), false);
  assertEquals(zero.includes('this spread CLOSES the book'), false);

  const oneMileStone = buildOutlineUserPrompt({ ...promptSkeleton, firstsCount: 1 }, [], features);
  assertEquals(oneMileStone.includes('Firsts (non-birthday explicit milestones) in scope: 1 -- this spread CLOSES the book'), true);
  assertEquals(oneMileStone.includes('FIRSTS MILESTONES'), true);
  assertEquals(oneMileStone.includes('memory_id="m1" milestone_id="balance-bike"'), true);
});

// --- round-18 LANGUAGE CONTEXT block ---------------------------------------

function languageSkeleton(overrides: { configuredLanguage: string | null; languageEvidenceCaptions: string[] }) {
  return {
    childName: 'Enzo',
    scopeLabel: 'Year One',
    windowStart: '2023-01-01',
    windowLastDay: '2023-12-31',
    backboneSegments: [],
    firstsCount: 0,
    birthdaySpreads: [],
    throughTheYearsCount: 0,
    specialSegments: [],
    ...overrides,
  };
}

Deno.test('buildOutlineUserPrompt: shows "(not set)" for a null configured language and omits the evidence block when empty', () => {
  const prompt = buildOutlineUserPrompt(
    languageSkeleton({ configuredLanguage: null, languageEvidenceCaptions: [] }),
    [],
    new Map(),
  );
  assertEquals(prompt.includes('CONFIGURED LANGUAGE: (not set)'), true);
  assertEquals(prompt.includes('LANGUAGE EVIDENCE ONLY'), false);
});

Deno.test('buildOutlineUserPrompt: shows the configured language value when set', () => {
  const prompt = buildOutlineUserPrompt(
    languageSkeleton({ configuredLanguage: 'es-MX', languageEvidenceCaptions: [] }),
    [],
    new Map(),
  );
  assertEquals(prompt.includes('CONFIGURED LANGUAGE: es-MX'), true);
});

Deno.test('buildOutlineUserPrompt: renders the LANGUAGE EVIDENCE ONLY block, marked not-selectable/not-quotable, when captions are supplied', () => {
  const prompt = buildOutlineUserPrompt(
    languageSkeleton({ configuredLanguage: null, languageEvidenceCaptions: ['Hoy fuimos al parque', 'Le encantó el columpio'] }),
    [],
    new Map(),
  );
  assertEquals(prompt.includes('LANGUAGE EVIDENCE ONLY'), true);
  assertEquals(prompt.includes('not selectable'), true);
  assertEquals(prompt.includes('never quotable'), true);
  assertEquals(prompt.includes('Hoy fuimos al parque'), true);
  assertEquals(prompt.includes('Le encantó el columpio'), true);
});

// --- Quote-title verification (owner amendment, round-2, 2026-08-25: "never
// silently accept an unverifiable quote") ----------------------------------

Deno.test('normalizeForQuoteCheck: case/accent/punctuation-insensitive', () => {
  assertEquals(normalizeForQuoteCheck('¡Ay, Dios MÍO!'), normalizeForQuoteCheck('ay dios mio'));
});

Deno.test('isQuoteSupportedByContent: true when the (normalized) title appears in the content', () => {
  assertEquals(isQuoteSupportedByContent('Ay Dios mío', 'Hoy dijo "¡Ay Dios mío!" al ver el pastel.'), true);
});

Deno.test('isQuoteSupportedByContent: false for a fabricated quote not present in the content', () => {
  assertEquals(isQuoteSupportedByContent('Ay Dios mío', 'A completely unrelated sentence about the park.'), false);
});

Deno.test('isQuoteSupportedByContent: false for null content or an empty title', () => {
  assertEquals(isQuoteSupportedByContent('Ay Dios mío', null), false);
  assertEquals(isQuoteSupportedByContent('   ', 'Ay Dios mío, que grande estas'), false);
});

Deno.test('verifyQuoteTitles: descriptive-mode spreads are never checked', () => {
  const violations = verifyQuoteTitles(
    [{ candidateId: 'topic:beach', title: 'A day at the beach', titleMode: 'descriptive', titleSourceMemoryId: null }],
    new Map(),
  );
  assertEquals(violations, []);
});

Deno.test('verifyQuoteTitles: a verified quote produces no violation', () => {
  const violations = verifyQuoteTitles(
    [{ candidateId: 'emotion:funny', title: 'Ay Dios mío', titleMode: 'quote', titleSourceMemoryId: 'm1' }],
    new Map([['m1', 'Dijo "ay Dios mío" y se rió.']]),
  );
  assertEquals(violations, []);
});

Deno.test('verifyQuoteTitles: an unverifiable quote is flagged, not silently accepted', () => {
  const violations = verifyQuoteTitles(
    [{ candidateId: 'emotion:funny', title: 'A completely fabricated quote', titleMode: 'quote', titleSourceMemoryId: 'm1' }],
    new Map([['m1', 'Went to the park and had ice cream.']]),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0].kind, 'unverifiable_quote_title');
});

Deno.test('verifyQuoteTitles: a quote with no source content at all is flagged', () => {
  const violations = verifyQuoteTitles(
    [{ candidateId: 'emotion:funny', title: 'Ay Dios mío', titleMode: 'quote', titleSourceMemoryId: null }],
    new Map(),
  );
  assertEquals(violations.length, 1);
});

// --- parseOutlineResponse: title_mode / title_source_memory_id (owner
// amendment, round-2, 2026-08-25) ------------------------------------------

// --- round-18: parseOutlineResponse's "language" field --------------------

Deno.test('parseOutlineResponse: a valid model language is used verbatim, no violation', () => {
  const { response, violations } = parseOutlineResponse(
    { language: 'es' },
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.language, 'es');
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: a garbled model language falls back through the chain and records invalid_language', () => {
  const { response, violations } = parseOutlineResponse(
    { language: 'not a real code!!' },
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    'es-MX',
  );
  assertEquals(response.language, 'es-MX'); // falls back to the configured language
  assertEquals(violations.some((v) => v.kind === 'invalid_language' && v.detail === 'not a real code!!'), true);
});

Deno.test('parseOutlineResponse: an absent model language falls back to the configured language silently, no violation (matches this file\'s convention for other optional AI fields)', () => {
  const { response, violations } = parseOutlineResponse(
    {},
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    'fr',
  );
  assertEquals(response.language, 'fr');
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: an absent model language AND no configured language falls back to English', () => {
  const { response, violations } = parseOutlineResponse(
    {},
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.language, 'en');
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: a valid quote spread keeps title_mode and its source memory id', () => {
  const { response, violations } = parseOutlineResponse(
    {
      spreads: [
        {
          candidate_id: 'emotion:funny',
          title: 'Ay Dios mío',
          title_mode: 'quote',
          title_source_memory_id: 'm1',
          memory_ids: ['m1', 'm2', 'm3'],
        },
      ],
    },
    new Set(['emotion:funny']),
    new Set(),
    new Set(['m1', 'm2', 'm3']),
    new Map([['emotion:funny', new Set(['m1', 'm2', 'm3'])]]),
    new Map([['emotion:funny', 'The funny ones']]),
    new Map(),
  );
  assertEquals(violations, []);
  assertEquals(response.spreads[0].titleMode, 'quote');
  assertEquals(response.spreads[0].titleSourceMemoryId, 'm1');
});

Deno.test('parseOutlineResponse: quote mode with a source id outside the spread\'s own memory_ids downgrades to descriptive + records a violation', () => {
  const { response, violations } = parseOutlineResponse(
    {
      spreads: [
        {
          candidate_id: 'emotion:funny',
          title: 'Ay Dios mío',
          title_mode: 'quote',
          title_source_memory_id: 'not-in-this-spread',
          memory_ids: ['m1', 'm2', 'm3'],
        },
      ],
    },
    new Set(['emotion:funny']),
    new Set(),
    new Set(['m1', 'm2', 'm3', 'not-in-this-spread']),
    new Map([['emotion:funny', new Set(['m1', 'm2', 'm3'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(response.spreads[0].titleMode, 'descriptive');
  assertEquals(response.spreads[0].titleSourceMemoryId, null);
  assertEquals(violations.some((v) => v.kind === 'quote_missing_source'), true);
});

Deno.test('parseOutlineResponse: quote mode with no title_source_memory_id at all downgrades to descriptive', () => {
  const { response, violations } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'emotion:funny', title: 'Ay Dios mío', title_mode: 'quote', memory_ids: ['m1'] }] },
    new Set(['emotion:funny']),
    new Set(),
    new Set(['m1']),
    new Map([['emotion:funny', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(response.spreads[0].titleMode, 'descriptive');
  assertEquals(violations.some((v) => v.kind === 'quote_missing_source'), true);
});

Deno.test('parseOutlineResponse: missing title_mode defaults to descriptive with no violation', () => {
  const { response, violations } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'topic:beach', title: 'A day at the beach', memory_ids: ['m1'] }] },
    new Set(['topic:beach']),
    new Set(),
    new Set(['m1']),
    new Map([['topic:beach', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(response.spreads[0].titleMode, 'descriptive');
  assertEquals(response.spreads[0].titleSourceMemoryId, null);
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: a garbled title_mode value is recorded as a violation and falls back to descriptive', () => {
  const { response, violations } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'topic:beach', title: 'A day at the beach', title_mode: 'verbatim', memory_ids: ['m1'] }] },
    new Set(['topic:beach']),
    new Set(),
    new Set(['m1']),
    new Map([['topic:beach', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(response.spreads[0].titleMode, 'descriptive');
  assertEquals(violations.some((v) => v.kind === 'invalid_title_mode'), true);
});

Deno.test('parseOutlineResponse: parses segment_titles for a valid segment id and drops an unknown one', () => {
  const { response, violations } = parseOutlineResponse(
    { spreads: [], segment_titles: { 'seg-1': 'Welcome to the world', 'unknown-seg': 'Should be dropped' } },
    new Set(),
    new Set(['seg-1']),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.segmentTitles, { 'seg-1': 'Welcome to the world' });
  assertEquals(violations.some((v) => v.kind === 'unknown_segment_id'), true);
});

// --- kicker (design handoff decision, 2026-08-27) --------------------------

Deno.test('parseOutlineResponse: parses a valid kicker and trims it', () => {
  const { response, violations } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'emotion:funny', title: 'Ay Dios mío', kicker: '  lo que nos hiciste reír  ', memory_ids: ['m1'] }] },
    new Set(['emotion:funny']),
    new Set(),
    new Set(['m1']),
    new Map([['emotion:funny', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(violations, []);
  assertEquals(response.spreads[0].kicker, 'lo que nos hiciste reír');
});

Deno.test('parseOutlineResponse: an omitted or blank kicker is null, not a violation', () => {
  const { response: withoutKicker } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'topic:beach', title: 'A day at the beach', memory_ids: ['m1'] }] },
    new Set(['topic:beach']),
    new Set(),
    new Set(['m1']),
    new Map([['topic:beach', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(withoutKicker.spreads[0].kicker, null);

  const { response: blankKicker } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'topic:beach', title: 'A day at the beach', kicker: '   ', memory_ids: ['m1'] }] },
    new Set(['topic:beach']),
    new Set(),
    new Set(['m1']),
    new Map([['topic:beach', new Set(['m1'])]]),
    new Map(),
    new Map(),
  );
  assertEquals(blankKicker.spreads[0].kicker, null);
});

// --- backbone highlight segment-membership validation + heroCandidates
// (design handoff decision, 2026-08-27) -------------------------------------

Deno.test('parseOutlineResponse: a highlight id not a member of its claimed segment is dropped and recorded', () => {
  const { response, violations } = parseOutlineResponse(
    { backbone_highlights: [{ segment_id: 'seg-jan', memory_ids: ['m1', 'm2'] }] },
    new Set(),
    new Set(['seg-jan']),
    new Set(['m1', 'm2']),
    new Map(),
    new Map(),
    new Map([['seg-jan', new Set(['m1'])]]), // m2 is valid in-scope, but not IN this segment
  );
  assertEquals(response.backboneHighlights[0].memoryIds, ['m1']);
  assertEquals(violations.some((v) => v.kind === 'highlight_not_in_segment'), true);
});

Deno.test('parseOutlineResponse: hero_candidates validates existence and caps at 5', () => {
  const validIds = new Set(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  const { response, violations } = parseOutlineResponse(
    { hero_candidates: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'ghost'] },
    new Set(),
    new Set(),
    validIds,
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.heroCandidates, ['m1', 'm2', 'm3', 'm4', 'm5']);
  assertEquals(violations.some((v) => v.kind === 'unknown_hero_candidate'), true);
  assertEquals(violations.some((v) => v.kind === 'too_many_hero_candidates'), true);
});

Deno.test('parseOutlineResponse: hero_candidates deduplicates', () => {
  const { response, violations } = parseOutlineResponse(
    { hero_candidates: ['m1', 'm1'] },
    new Set(),
    new Set(),
    new Set(['m1']),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.heroCandidates, ['m1']);
  assertEquals(violations.some((v) => v.kind === 'duplicate_memory_id'), true);
});

Deno.test('parseOutlineResponse: missing hero_candidates is an empty array, no violation', () => {
  const { response, violations } = parseOutlineResponse({}, new Set(), new Set(), new Set(), new Map(), new Map(), new Map());
  assertEquals(response.heroCandidates, []);
  assertEquals(violations, []);
});

// --- panorama_candidates (owner decision 2026-08-27, amended twice same
// day: uncapped + best-first, then root-cause-fixed to require `wide`
// orientation specifically -- a tall/square photo can never span a 2:1
// double-page panorama) -----------------------------------------------------

Deno.test('parseOutlineResponse: panorama_candidates is uncapped -- no "too many" violation, order preserved', () => {
  const manyIds = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const validIds = new Set(manyIds);
  const { response, violations } = parseOutlineResponse(
    { panorama_candidates: manyIds },
    new Set(),
    new Set(),
    validIds,
    new Map(),
    new Map(),
    new Map(),
    validIds, // every id is wide-orientation for this test
  );
  assertEquals(response.panoramaCandidates, manyIds); // all 12 kept, best-first order preserved
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: panorama_candidates validates existence and wide orientation', () => {
  const validIds = new Set(['m1', 'm2', 'm3']);
  const wideOrientation = new Set(['m1', 'm2']); // m3 exists but is tall/square/unknown
  const { response, violations } = parseOutlineResponse(
    { panorama_candidates: ['m1', 'm2', 'm3', 'ghost'] },
    new Set(),
    new Set(),
    validIds,
    new Map(),
    new Map(),
    new Map(),
    wideOrientation,
  );
  assertEquals(response.panoramaCandidates, ['m1', 'm2']);
  assertEquals(violations.some((v) => v.kind === 'unknown_panorama_candidate' && v.detail === '"ghost"'), true);
  assertEquals(violations.some((v) => v.kind === 'panorama_candidate_not_wide' && v.detail === 'm3'), true);
});

Deno.test('parseOutlineResponse: panorama_candidates deduplicates, preserving first-seen order', () => {
  const validIds = new Set(['m1', 'm2']);
  const { response, violations } = parseOutlineResponse(
    { panorama_candidates: ['m1', 'm2', 'm1'] },
    new Set(),
    new Set(),
    validIds,
    new Map(),
    new Map(),
    new Map(),
    validIds,
  );
  assertEquals(response.panoramaCandidates, ['m1', 'm2']);
  assertEquals(violations.some((v) => v.kind === 'duplicate_memory_id'), true);
});

Deno.test('parseOutlineResponse: missing panorama_candidates is an empty array, no violation', () => {
  const { response, violations } = parseOutlineResponse({}, new Set(), new Set(), new Set(), new Map(), new Map(), new Map());
  assertEquals(response.panoramaCandidates, []);
  assertEquals(violations, []);
});

// --- dedication / back_cover_line (owner decision 2026-08-27) --------------

Deno.test('parseOutlineResponse: parses dedication and back_cover_line, trimmed', () => {
  const { response } = parseOutlineResponse(
    { dedication: '  Para Enzo...  ', back_cover_line: '  Un año de recuerdos.  ' },
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.dedication, 'Para Enzo...');
  assertEquals(response.backCoverLine, 'Un año de recuerdos.');
});

Deno.test('parseOutlineResponse: missing or blank dedication/back_cover_line are null', () => {
  const { response: missing } = parseOutlineResponse({}, new Set(), new Set(), new Set(), new Map(), new Map(), new Map());
  assertEquals(missing.dedication, null);
  assertEquals(missing.backCoverLine, null);

  const { response: blank } = parseOutlineResponse(
    { dedication: '   ', back_cover_line: '' },
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(blank.dedication, null);
  assertEquals(blank.backCoverLine, null);
});

// --- firsts_milestones / warm_name (owner round-3 decision, 2026-08-27:
// AI-drafted warm second-person milestone lines, never trusted without
// checking against a REAL (memory, milestone) pair) --------------------------

Deno.test('parseOutlineResponse: parses a valid firsts_milestones entry, trimmed', () => {
  const validMilestoneKeys = new Set(['m1::first-steps']);
  const { response, violations } = parseOutlineResponse(
    { firsts_milestones: [{ memory_id: 'm1', milestone_id: 'first-steps', warm_name: '  Diste tus primeros pasos.  ' }] },
    new Set(),
    new Set(),
    new Set(['m1']),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    validMilestoneKeys,
  );
  assertEquals(response.firstsWarmNames, [{ memoryId: 'm1', milestoneId: 'first-steps', warmName: 'Diste tus primeros pasos.' }]);
  assertEquals(violations, []);
});

Deno.test('parseOutlineResponse: a firsts_milestones entry for an unknown (memory, milestone) pair is dropped and recorded', () => {
  const validMilestoneKeys = new Set(['m1::first-steps']);
  const { response, violations } = parseOutlineResponse(
    { firsts_milestones: [{ memory_id: 'm1', milestone_id: 'first-haircut', warm_name: 'Tuviste tu primer corte de pelo.' }] },
    new Set(),
    new Set(),
    new Set(['m1']),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    validMilestoneKeys,
  );
  assertEquals(response.firstsWarmNames, []);
  assertEquals(violations.some((v) => v.kind === 'unknown_firsts_milestone' && v.detail === 'm1::first-haircut'), true);
});

Deno.test('parseOutlineResponse: a firsts_milestones entry with a missing/blank warm_name is dropped and recorded', () => {
  const validMilestoneKeys = new Set(['m1::first-steps']);
  const { response, violations } = parseOutlineResponse(
    { firsts_milestones: [{ memory_id: 'm1', milestone_id: 'first-steps', warm_name: '   ' }] },
    new Set(),
    new Set(),
    new Set(['m1']),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    validMilestoneKeys,
  );
  assertEquals(response.firstsWarmNames, []);
  assertEquals(violations.some((v) => v.kind === 'missing_firsts_warm_name'), true);
});

Deno.test('parseOutlineResponse: a duplicate firsts_milestones entry for the same pair is dropped and recorded', () => {
  const validMilestoneKeys = new Set(['m1::first-steps']);
  const { response, violations } = parseOutlineResponse(
    {
      firsts_milestones: [
        { memory_id: 'm1', milestone_id: 'first-steps', warm_name: 'Diste tus primeros pasos.' },
        { memory_id: 'm1', milestone_id: 'first-steps', warm_name: 'A second, unwanted draft.' },
      ],
    },
    new Set(),
    new Set(),
    new Set(['m1']),
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    validMilestoneKeys,
  );
  assertEquals(response.firstsWarmNames.length, 1);
  assertEquals(response.firstsWarmNames[0].warmName, 'Diste tus primeros pasos.');
  assertEquals(violations.some((v) => v.kind === 'duplicate_firsts_milestone'), true);
});

Deno.test('parseOutlineResponse: missing firsts_milestones is an empty array, no violation', () => {
  const { response, violations } = parseOutlineResponse({}, new Set(), new Set(), new Set(), new Map(), new Map(), new Map());
  assertEquals(response.firstsWarmNames, []);
  assertEquals(violations, []);
});

// --- parseOutlineResponse (integration-shaped: fabricated AI response) -----

Deno.test('parseOutlineResponse: drops unknown ids/candidates/segments and records violations, never trusting the model', () => {
  const validCandidateIds = new Set(['topic:beach']);
  const validSegmentIds = new Set(['2023-01']);
  const validMemoryIds = new Set(['m1', 'm2', 'm3']);
  // m3 is a valid in-scope memory id, but deliberately NOT a member of the
  // "topic:beach" candidate's member list.
  const candidateMembersById = new Map([['topic:beach', new Set(['m1', 'm2'])]]);
  const candidateDefaultTitleById = new Map([['topic:beach', 'A day at the beach']]);
  const segmentMembersById = new Map([['2023-01', new Set(['m1', 'm2', 'm3'])]]);

  const raw = {
    spreads: [
      {
        candidate_id: 'topic:beach',
        insert_after_segment_index: 0,
        title: 'Beach Days',
        // m1 duplicated, m2 valid, "ghost-id" doesn't exist in scope, m3 is
        // a valid memory id but not actually a member of the "topic:beach"
        // candidate (should be dropped + recorded, not trusted).
        memory_ids: ['m1', 'm1', 'm2', 'ghost-id', 'm3'],
        rationale: { m1: 'first beach day', m2: 'splashing' },
      },
      {
        candidate_id: 'topic:made-up-topic',
        memory_ids: ['m1'],
      },
      'not-an-object',
    ],
    backbone_highlights: [
      { segment_id: '2023-01', memory_ids: ['m1', 'unknown-memory'], rationale: { m1: 'sweet smile' } },
      { segment_id: 'unknown-segment', memory_ids: ['m1'] },
    ],
    firsts_title: 'Big and small wins',
    editorial_note: 'A gentle first year.',
  };

  const { response, violations } = parseOutlineResponse(
    raw,
    validCandidateIds,
    validSegmentIds,
    validMemoryIds,
    candidateMembersById,
    candidateDefaultTitleById,
    segmentMembersById,
  );

  assertEquals(response.spreads.length, 1);
  assertEquals(response.spreads[0].candidateId, 'topic:beach');
  assertEquals(response.spreads[0].candidateKind, 'topic');
  // m1 appears once despite being duplicated in the raw input.
  assertEquals(response.spreads[0].memoryIds, ['m1', 'm2']);
  assertEquals(response.spreads[0].rationale, { m1: 'first beach day', m2: 'splashing' });

  assertEquals(response.backboneHighlights.length, 1);
  assertEquals(response.backboneHighlights[0].segmentId, '2023-01');
  assertEquals(response.backboneHighlights[0].memoryIds, ['m1']);

  assertEquals(response.firstsTitle, 'Big and small wins');
  assertEquals(response.internalEditorialNote, 'A gentle first year.');

  const violationKinds = violations.map((v) => v.kind).sort();
  assertEquals(violationKinds.includes('unknown_candidate_id'), true);
  assertEquals(violationKinds.includes('unknown_memory_id'), true);
  assertEquals(violationKinds.includes('unknown_segment_id'), true);
  assertEquals(violationKinds.includes('memory_not_in_candidate'), true);
  assertEquals(violationKinds.includes('malformed_spread'), true);
  assertEquals(violationKinds.includes('duplicate_memory_id'), true);
});

Deno.test('parseOutlineResponse: rejects a candidate_id that is not one of the three known kind prefixes', () => {
  const { violations } = parseOutlineResponse(
    { spreads: [{ candidate_id: 'not-a-real-prefix', memory_ids: [] }] },
    new Set(['not-a-real-prefix']), // even if it were "valid" by id, the kind prefix check must still reject it
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(violations.some((v) => v.kind === 'unknown_candidate_id'), true);
});

// --- buildOutlineRequestBody (reasoning-model param compatibility) ---------

Deno.test('buildOutlineRequestBody: never sends temperature or a token-cap param', () => {
  const body = buildOutlineRequestBody('system', 'user', 'gpt-5.6-sol');
  assertEquals(Object.prototype.hasOwnProperty.call(body, 'temperature'), false);
  assertEquals(Object.prototype.hasOwnProperty.call(body, 'max_tokens'), false);
  assertEquals(Object.prototype.hasOwnProperty.call(body, 'max_completion_tokens'), false);
});

Deno.test('buildOutlineRequestBody: keeps model, messages, and json_object response_format', () => {
  const body = buildOutlineRequestBody('sys-prompt', 'user-prompt', 'gpt-5.6-sol') as {
    model: string;
    response_format: { type: string };
    messages: Array<{ role: string; content: string }>;
  };
  assertEquals(body.model, 'gpt-5.6-sol');
  assertEquals(body.response_format, { type: 'json_object' });
  assertEquals(body.messages, [
    { role: 'system', content: 'sys-prompt' },
    { role: 'user', content: 'user-prompt' },
  ]);
});

Deno.test('parseOutlineResponse: empty/malformed raw input produces an empty-but-valid response', () => {
  const { response, violations } = parseOutlineResponse(
    null,
    new Set(),
    new Set(),
    new Set(),
    new Map(),
    new Map(),
    new Map(),
  );
  assertEquals(response.spreads, []);
  assertEquals(response.backboneHighlights, []);
  assertEquals(response.firstsTitle, null);
  assertEquals(response.heroCandidates, []);
  assertEquals(response.internalEditorialNote, '');
  assertEquals(violations, []);
});

// --- Fitter-as-oracle (round-13): synthetic manifest/outline builders ----

Deno.test('buildSyntheticAsset: an ordinary (non-trusted) asset gets nominal dimensions well under every fitter trust threshold, with no originalWidth/Height', () => {
  const asset = buildSyntheticAsset(mediaRow({ aspect_ratio: 1.5 }), false);
  assertEquals(asset.aspectRatio, 1.5);
  assertEquals(asset.kind, 'photo');
  assertEquals(asset.originalWidth, null);
  assertEquals(asset.originalHeight, null);
  assertEquals(asset.width < 2500, true); // under BOTH the panorama (3500) and full-bleed (2500) trust thresholds
});

Deno.test('buildSyntheticAsset: a trusted (nominated) asset gets an explicit originalWidth/Height comfortably over every trust threshold', () => {
  const asset = buildSyntheticAsset(mediaRow({ aspect_ratio: 2.4 }), true);
  assertEquals((asset.originalWidth ?? 0) >= 3500, true);
  assertEquals((asset.originalHeight ?? 0) > 0, true);
});

Deno.test('buildSyntheticAsset: video content-type maps to the video-poster asset kind', () => {
  const asset = buildSyntheticAsset(mediaRow({ content_type: 'video/mp4', aspect_ratio: 1.7 }), false);
  assertEquals(asset.kind, 'video-poster');
});

Deno.test('buildSyntheticAsset: a null aspect_ratio falls back to an ordinary landscape ratio, never trusted-path-relevant', () => {
  const asset = buildSyntheticAsset(mediaRow({ aspect_ratio: null }), false);
  assertEquals(asset.aspectRatio, 1.5);
});

Deno.test('buildSyntheticMemory: a text memory becomes text_illustration, with a length-only placeholder string and a square (1.0) illustration', () => {
  const memory = buildSyntheticMemory(fixtureFeature({ hasText: true, textLength: 42 }), [], false);
  assertEquals(memory.type, 'text_illustration');
  assertEquals(memory.text?.length, 42);
  assertEquals(memory.illustration?.aspectRatio, 1);
});

Deno.test('buildSyntheticMemory: never carries the real memory content -- only a placeholder of the same length', () => {
  // textLength is the ONLY signal that ever reaches the synthetic memory --
  // there is no real `content` field passed into `buildSyntheticMemory` at
  // all, so this is a structural guarantee, not just a spot-check: assert
  // the placeholder is uniform filler, never anything resembling prose.
  const memory = buildSyntheticMemory(fixtureFeature({ hasText: true, textLength: 20 }), [], false);
  assertEquals(memory.text, 'x'.repeat(20));
});

Deno.test('buildSyntheticMemory: a photo-only memory (no text) becomes type photo, with no illustration', () => {
  const memory = buildSyntheticMemory(fixtureFeature({ hasText: false, photoCount: 1 }), [mediaRow()], false);
  assertEquals(memory.type, 'photo');
  assertEquals(memory.illustration, null);
  assertEquals(memory.assets.length, 1);
});

Deno.test('buildSyntheticMemory: a video-only memory becomes type video', () => {
  const memory = buildSyntheticMemory(
    fixtureFeature({ hasText: false, videoCount: 1 }),
    [mediaRow({ content_type: 'video/mp4' })],
    false,
  );
  assertEquals(memory.type, 'video');
});

Deno.test('buildSyntheticMemory: milestones and tagged members carry through in the fitter\'s own shape', () => {
  const memory = buildSyntheticMemory(
    fixtureFeature({
      milestones: [{ milestoneId: 'first-steps', name: 'First steps', detail: '', outOfBand: false }],
      taggedMembers: [{ firstName: 'Enzo', personType: 'child', nicknames: [] }],
      engagementCount: 3,
    }),
    [],
    false,
  );
  assertEquals(memory.milestones, [{ id: 'first-steps', name: 'First steps', detail: '' }]);
  assertEquals(memory.taggedMembers, [{ name: 'Enzo', isChild: true }]);
  assertEquals(memory.engagement, 3);
});

Deno.test('buildSyntheticManifest: builds one memory per feature id, trusting only ids in trustedWideIds', () => {
  const features = new Map([
    ['m1', fixtureFeature({ photoCount: 1 })],
    ['m2', fixtureFeature({ photoCount: 1 })],
  ]);
  const media = new Map([
    ['m1', [mediaRow({ aspect_ratio: 2.4 })]],
    ['m2', [mediaRow({ aspect_ratio: 2.4 })]],
  ]);
  const manifest = buildSyntheticManifest(features, media, { id: 'c1', name: 'Child', dateOfBirth: null }, new Set(['m1']));
  assertEquals(Object.keys(manifest.memories).sort(), ['m1', 'm2']);
  assertEquals(manifest.memories['m1'].assets[0].originalWidth !== null, true);
  assertEquals(manifest.memories['m2'].assets[0].originalWidth, null);
  assertEquals(manifest.child.id, 'c1');
});

Deno.test('buildSyntheticManifest: passes portraits through untouched (drives through-the-years page yield)', () => {
  const manifest = buildSyntheticManifest(
    new Map(),
    new Map(),
    { id: 'c1', name: 'Child', dateOfBirth: null },
    new Set(),
    [buildSyntheticPortrait('2024-01-01'), buildSyntheticPortrait('2024-06-01')],
  );
  assertEquals(manifest.portraits.length, 2);
});

Deno.test('buildSyntheticOutline: wraps elements with defaults, preserving panorama/hero candidate lists', () => {
  const elements: OracleElementInput[] = [{ id: 'backbone:x', kind: 'backbone', memoryIds: ['m1'] }];
  const outline = buildSyntheticOutline(elements, ['m1'], ['m2']);
  assertEquals(outline.elements.length, 1);
  assertEquals(outline.elements[0].kind, 'backbone');
  assertEquals(outline.elements[0].memoryIds, ['m1']);
  assertEquals(outline.elements[0].highlights, []);
  assertEquals(outline.panoramaCandidates, ['m1']);
  assertEquals(outline.heroCandidates, ['m2']);
});

Deno.test('estimatePagesViaFitter: an empty element list costs 0 pages', () => {
  const manifest = buildSyntheticManifest(new Map(), new Map(), { id: 'c1', name: 'Child', dateOfBirth: null }, new Set());
  assertEquals(estimatePagesViaFitter([], manifest), 0);
  assertEquals(estimatePagesViaFitter([{ id: 'x', kind: 'backbone', memoryIds: [] }], manifest), 0);
});

Deno.test('estimatePagesViaFitter: trusting a wide, panorama-nominated memory actually changes the fitter\'s page yield (the trust wiring is load-bearing, not decorative)', () => {
  const features = new Map([['m1', fixtureFeature({ photoCount: 1 })]]);
  const media = new Map([['m1', [mediaRow({ aspect_ratio: 2.4 })]]]);
  const trustedManifest = buildSyntheticManifest(features, media, { id: 'c1', name: 'Child', dateOfBirth: null }, new Set(['m1']));
  const untrustedManifest = buildSyntheticManifest(features, media, { id: 'c1', name: 'Child', dateOfBirth: null }, new Set());
  const elements: OracleElementInput[] = [{ id: 'x', kind: 'backbone', memoryIds: ['m1'] }];

  const trustedPages = estimatePagesViaFitter(elements, trustedManifest, ['m1'], []);
  const untrustedPages = estimatePagesViaFitter(elements, untrustedManifest, ['m1'], []);
  // A nominated-but-NOT-dimensionally-trusted memory fails closed -- treated
  // as an ordinary photo, exactly like a non-nominated one -- while the
  // trusted nominee gets the real (larger) panorama page cost.
  assertEquals(trustedPages > untrustedPages, true);
});

Deno.test('estimatePagesViaFitter: an untrusted (non-nominated) wide memory NEVER gets panorama treatment, even if aspect ratio alone would look wide enough', () => {
  const features = new Map([['m1', fixtureFeature({ photoCount: 1 })]]);
  const media = new Map([['m1', [mediaRow({ aspect_ratio: 2.4 })]]]);
  const manifest = buildSyntheticManifest(features, media, { id: 'c1', name: 'Child', dateOfBirth: null }, new Set());
  const elements: OracleElementInput[] = [{ id: 'x', kind: 'backbone', memoryIds: ['m1'] }];
  const asOrdinary = estimatePagesViaFitter(elements, manifest, [], []); // not even nominated
  const nominatedButUntrusted = estimatePagesViaFitter(elements, manifest, ['m1'], []); // nominated, but manifest never marked it trusted
  assertEquals(asOrdinary, nominatedButUntrusted); // fails closed identically either way
});

// Round-14: `estimateElementPagesViaFitter` (the shape-placeholder oracle)
// and the injectable `estimate` parameter on `planNonBackboneBudget`/
// `selectBackboneMemories` are DELETED -- neither function prices anything
// anymore, so there is nothing left to inject a price function into. See
// the "planNonBackboneBudget / selectBackboneMemories" no-cut tests above.
