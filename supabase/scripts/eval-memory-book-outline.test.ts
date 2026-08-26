import { assertEquals } from 'jsr:@std/assert@1';

import {
  addDays,
  ageYearLabel,
  buildBackboneSegments,
  buildOutlineRequestBody,
  buildOutlineSystemPrompt,
  buildOutlineUserPrompt,
  buildReadingOrder,
  buildSpecialSegmentTitlesByMonth,
  buildTaggedMemberFeatures,
  computeMedianDate,
  computeMemoryEligibility,
  computePageEstimate,
  computeRequiredPacingGaps,
  computeScopeWindow,
  dissolveSmallThemedSpreads,
  dissolveThinBirthdaySpreads,
  emotionCandidatesToUnified,
  findAnchorSegmentIndex,
  flagSpecialBackboneSegments,
  formatMonthRangeLabel,
  fromJulianDayNumber,
  isQuoteSupportedByContent,
  isTimeAnchoredCandidate,
  normalizeForQuoteCheck,
  paceThemedSpreads,
  parseOutlineResponse,
  peoplePairCandidatesToUnified,
  planNonBackboneBudget,
  rankMemoryForThinning,
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
  type BackboneMemoryInput,
  type BudgetElement,
  type ChildCandidate,
  type FamilyMemberForTagging,
  type MemoryFeature,
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
  { id: 'id-1', familyId: 'fam-1', name: 'Enzo', dateOfBirth: '2020-01-01' },
  { id: 'id-2', familyId: 'fam-1', name: 'Mara', dateOfBirth: '2022-01-01' },
  { id: 'id-3', familyId: 'fam-2', name: 'Enzo', dateOfBirth: '2019-01-01' },
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
    ['child-id', { id: 'child-id', name: 'Enzo Ray', dateOfBirth: '2021-01-01' }],
    ['grandma-id', { id: 'grandma-id', name: 'Nonna Rosa', dateOfBirth: '1955-01-01' }],
  ]);
  const result = buildTaggedMemberFeatures(['child-id', 'grandma-id'], membersById, '2023-06-01');
  assertEquals(result, [
    { firstName: 'Enzo', personType: 'child' },
    { firstName: 'Nonna', personType: 'adult' },
  ]);
});

Deno.test('buildTaggedMemberFeatures: unresolvable member ids are skipped, not thrown', () => {
  const result = buildTaggedMemberFeatures(['ghost-id'], new Map(), '2023-06-01');
  assertEquals(result, []);
});

Deno.test('buildTaggedMemberFeatures: unknown date of birth yields personType unknown', () => {
  const membersById = new Map<string, FamilyMemberForTagging>([
    ['id-1', { id: 'id-1', name: 'Mystery Guest', dateOfBirth: null }],
  ]);
  const result = buildTaggedMemberFeatures(['id-1'], membersById, '2023-06-01');
  assertEquals(result, [{ firstName: 'Mystery', personType: 'unknown' }]);
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

// --- rankMemoryForThinning + computePageEstimate + enforcePageBudget --------

Deno.test('rankMemoryForThinning: milestone always ranks highest', () => {
  assertEquals(
    rankMemoryForThinning({ hasMilestone: true, hasText: false, hasVisual: false, hasEngagement: false }),
    4,
  );
});

Deno.test('rankMemoryForThinning: full ladder', () => {
  assertEquals(rankMemoryForThinning({ hasMilestone: false, hasText: true, hasVisual: true, hasEngagement: false }), 3);
  assertEquals(rankMemoryForThinning({ hasMilestone: false, hasText: false, hasVisual: true, hasEngagement: true }), 2);
  assertEquals(rankMemoryForThinning({ hasMilestone: false, hasText: false, hasVisual: true, hasEngagement: false }), 1);
  assertEquals(rankMemoryForThinning({ hasMilestone: false, hasText: true, hasVisual: false, hasEngagement: false }), 0);
});

// Plan round-2 decision (2026-08-25): a caption-less video ranks as a
// visual, same as a photo -- QR pages make video/audio first-class, so
// hasVisual = photoCount + videoCount > 0 is computed by the caller, not
// hasPhoto alone. rankMemoryForThinning itself just needs to rank a
// visual-only memory above a truly bare text-only one.
Deno.test('rankMemoryForThinning: a video-only memory (hasVisual, no text) outranks a text-only one', () => {
  const videoOnly = rankMemoryForThinning({ hasMilestone: false, hasText: false, hasVisual: true, hasEngagement: false });
  const textOnly = rankMemoryForThinning({ hasMilestone: false, hasText: true, hasVisual: false, hasEngagement: false });
  assertEquals(videoOnly, 1);
  assertEquals(textOnly, 0);
  assertEquals(videoOnly > textOnly, true);
});

Deno.test('computePageEstimate: fixed pages + themed/firsts/birthday (2 each) + backbone ceil(n/3)', () => {
  const elements: BudgetElement[] = [
    { id: 'themed:beach', kind: 'themed', memoryCount: 5 },
    { id: 'firsts', kind: 'firsts', memoryCount: 4 },
    { id: 'birthday-1', kind: 'birthday', memoryCount: 6 },
    { id: 'backbone:jan', kind: 'backbone', memoryCount: 7 }, // ceil(7/3) = 3
  ];
  // 4 fixed + 2 + 2 + 2 + 3 = 13
  assertEquals(computePageEstimate(elements), 13);
});

// --- planNonBackboneBudget (priority a+b: non-droppable, then themed) ------

Deno.test('planNonBackboneBudget: keeps every themed spread when (a)+(b) already fit the budget', () => {
  const plan = planNonBackboneBudget(4, 4 /* firsts+1 birthday */, [
    { id: 'themed:beach', memoryCount: 5 },
    { id: 'themed:bath', memoryCount: 6 },
  ], 20);
  assertEquals(plan.keptThemedIds.sort(), ['themed:bath', 'themed:beach']);
  assertEquals(plan.droppedThemedIds, []);
  assertEquals(plan.nonBackbonePages, 4 + 4 + 2 + 2);
  assertEquals(plan.backboneCapacityPages, 20 - plan.nonBackbonePages);
});

Deno.test('planNonBackboneBudget: never drops non-droppable pages, only themed, smallest-count-first', () => {
  // fixed(4) + nonDroppable(6: firsts + 2 birthdays) + 3 themed*2 = 16.
  // Budget 10 -> must drop themed spreads until fixed+nonDroppable+themed <= 10,
  // i.e. drop until only 0 themed spreads remain (4+6=10 alone already fills it).
  const plan = planNonBackboneBudget(4, 6, [
    { id: 'themed:a', memoryCount: 10 },
    { id: 'themed:b', memoryCount: 4 },
    { id: 'themed:c', memoryCount: 5 },
  ], 10);
  assertEquals(plan.keptThemedIds, []);
  assertEquals(plan.droppedThemedIds, ['themed:b', 'themed:c', 'themed:a']); // smallest-count-first
  assertEquals(plan.nonBackbonePages, 10);
  assertEquals(plan.backboneCapacityPages, 0);
});

Deno.test('planNonBackboneBudget: drops only as many themed spreads as needed', () => {
  // fixed(4) + nonDroppable(0) + 2 themed*2 = 8. Budget 6 -> drop exactly one (the smaller).
  const plan = planNonBackboneBudget(4, 0, [
    { id: 'themed:small', memoryCount: 4 },
    { id: 'themed:big', memoryCount: 9 },
  ], 6);
  assertEquals(plan.keptThemedIds, ['themed:big']);
  assertEquals(plan.droppedThemedIds, ['themed:small']);
  assertEquals(plan.nonBackbonePages, 6);
  assertEquals(plan.backboneCapacityPages, 0);
});

// --- selectBackboneMemories (priority c: backbone gets the leftover) -------

Deno.test('selectBackboneMemories: keeps the highest-ranked candidates that fit the capacity', () => {
  const candidates = [
    { id: 'text-only', date: '2023-01-01', rank: 0 as const },
    { id: 'photo-only', date: '2023-01-02', rank: 1 as const },
    { id: 'milestone', date: '2023-01-03', rank: 4 as const },
    { id: 'photo-text', date: '2023-01-04', rank: 3 as const },
  ];
  // capacityPages=1 -> capacity = 3 memories -> keep the 3 highest ranks.
  const kept = selectBackboneMemories(candidates, 1);
  assertEquals(kept.sort(), ['milestone', 'photo-only', 'photo-text']);
});

Deno.test('selectBackboneMemories: ties break by date then id', () => {
  const candidates = [
    { id: 'z', date: '2023-01-05', rank: 1 as const },
    { id: 'a', date: '2023-01-01', rank: 1 as const },
  ];
  const kept = selectBackboneMemories(candidates, 1); // capacity 3, but only 2 candidates -- both kept, order not asserted here
  assertEquals(kept.length, 2);
  // Capacity 0 pages -> 0 memories kept regardless of rank.
  assertEquals(selectBackboneMemories(candidates, 0), []);
});

Deno.test('selectBackboneMemories: zero capacity keeps nothing', () => {
  assertEquals(selectBackboneMemories([{ id: 'a', date: '2023-01-01', rank: 4 as const }], 0), []);
});

// Owner round-3 note (2026-08-25): pinned ids (a dissolved birthday spread's
// memories) bypass rank-based thinning entirely, but still count toward capacity.

Deno.test('selectBackboneMemories: a pinned low-rank memory survives even when capacity would otherwise cut it', () => {
  const candidates = [
    { id: 'pinned-text-only', date: '2023-05-01', rank: 0 as const },
    { id: 'high-rank-1', date: '2023-01-01', rank: 4 as const },
    { id: 'high-rank-2', date: '2023-01-02', rank: 4 as const },
    { id: 'high-rank-3', date: '2023-01-03', rank: 4 as const },
  ];
  // capacityPages=1 -> capacity=3. Without pinning, "pinned-text-only" (rank
  // 0) would be the first cut. With it pinned, it survives; the pin eats
  // one of the 3 slots, leaving room for only 2 of the 3 rank-4 candidates.
  const kept = selectBackboneMemories(candidates, 1, new Set(['pinned-text-only']));
  assertEquals(kept.includes('pinned-text-only'), true);
  assertEquals(kept.length, 3);
});

Deno.test('selectBackboneMemories: pinning more memories than capacity still keeps every pinned one', () => {
  const candidates = [
    { id: 'p1', date: '2023-05-01', rank: 0 as const },
    { id: 'p2', date: '2023-05-02', rank: 0 as const },
  ];
  const kept = selectBackboneMemories(candidates, 0, new Set(['p1', 'p2'])); // capacity 0
  assertEquals(kept.sort(), ['p1', 'p2']);
});

Deno.test('selectBackboneMemories: no pinnedIds argument behaves exactly as before', () => {
  const candidates = [{ id: 'a', date: '2023-01-01', rank: 4 as const }];
  assertEquals(selectBackboneMemories(candidates, 1), ['a']);
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
      },
    ],
    backboneRationale: {},
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
      },
    ],
    backboneRationale: {},
  });
  assertEquals(sections.some((s) => s.id === 'topic:beach'), true);
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
    photoCount: 0,
    videoCount: 0,
    previewKey: null,
    engagementCount: 0,
    milestones: [],
    birthdayAgeTurned: null,
    taggedToChild: true,
    taggedMembers: [],
    ...overrides,
  };
}

Deno.test('buildOutlineUserPrompt: includes each memory\'s tagged people with child/adult markers', () => {
  const features = new Map([
    ['m1', fixtureFeature({ taggedMembers: [{ firstName: 'Enzo', personType: 'child' }, { firstName: 'Nonna', personType: 'adult' }] })],
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
    },
    [],
    features,
  );
  assertEquals(prompt.includes('Enzo(child)'), true);
  assertEquals(prompt.includes('Nonna(adult)'), true);
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
    },
    [],
    new Map(),
  );
  assertEquals(prompt.includes('FLAGGED: birth month'), true);
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
  );
  assertEquals(response.segmentTitles, { 'seg-1': 'Welcome to the world' });
  assertEquals(violations.some((v) => v.kind === 'unknown_segment_id'), true);
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
  assertEquals(response.editorialNote, 'A gentle first year.');

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
  );
  assertEquals(response.spreads, []);
  assertEquals(response.backboneHighlights, []);
  assertEquals(response.firstsTitle, null);
  assertEquals(response.editorialNote, '');
  assertEquals(violations, []);
});
