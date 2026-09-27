import { assertEquals } from 'jsr:@std/assert@1';
import {
  addDays,
  ageYearScopes,
  birthdayFilmScope,
  birthdayPool,
  evaluateBirthdayFilm,
  evaluateColdOpen,
  evaluateFamilyFilm,
  evaluateFirsts,
  evaluateMontage,
  evaluateStarring,
  evaluateWorld,
  type FilmMemoryInput,
  hasQuotedSpeech,
  isFilmChild,
  isSoundCandidate,
  monthScope,
  evaluateMonthlyFilm,
  visualKind,
} from './year-film-eligibility.ts';
import type { PortraitVersionCandidate } from './portrait-versions.ts';

const CHILD = 'child-1';
const SIB = 'child-2';
const GRAN = 'gran';
const SCOPE = { start: '2024-03-04', endExclusive: '2025-03-04' };
const KIDS = [{ id: CHILD, dateOfBirth: '2022-01-01' }, { id: SIB, dateOfBirth: '2024-01-01' }];

function memory(overrides: Partial<FilmMemoryInput> & { id: string }): FilmMemoryInput {
  return {
    date: '2024-06-01',
    type: 'media',
    text: null,
    emotion: 'joy',
    topics: [],
    taggedMemberIds: [CHILD],
    illustrationReady: false,
    media: [{ kind: 'image', durationMs: null, hasPreview: true }],
    reported: false,
    ...overrides,
  };
}

function portrait(id: string, referenceDate: string | null): PortraitVersionCandidate {
  return {
    id,
    family_member_id: CHILD,
    reference_date: referenceDate,
    profile_picture_key: `${id}.jpg`,
    illustrated_profile_key: `${id}-ill.png`,
    illustrated_profile_status: 'ready',
    created_at: '2024-01-01T00:00:00Z',
  };
}

Deno.test('ageYearScopes: exclusive ends, completeness, Feb 29 clamp', () => {
  const scopes = ageYearScopes('2023-03-04', '2025-03-04');
  assertEquals(scopes.map((s) => [s.ageYear, s.start, s.endExclusive, s.complete]), [
    [1, '2023-03-04', '2024-03-04', true],
    [2, '2024-03-04', '2025-03-04', true],
    [3, '2025-03-04', '2026-03-04', false],
  ]);
  const leap = ageYearScopes('2024-02-29', '2025-03-01');
  assertEquals(leap[0].endExclusive, '2025-02-28');
});

Deno.test('isFilmChild: children under 13 with a DOB only', () => {
  assertEquals(isFilmChild({ id: 'a', dateOfBirth: '2022-01-01' }, '2026-09-26'), true);
  assertEquals(isFilmChild({ id: 'b', dateOfBirth: '1985-01-01' }, '2026-09-26'), false);
  assertEquals(isFilmChild({ id: 'c', dateOfBirth: null }, '2026-09-26'), false);
});

Deno.test('visualKind prefers illustration, then video clip, then photo; audio never', () => {
  assertEquals(visualKind(memory({ id: '1', illustrationReady: true })), 'illustration');
  assertEquals(visualKind(memory({ id: '2' })), 'photo');
  assertEquals(
    visualKind(memory({ id: '3', media: [{ kind: 'video', durationMs: 5000, hasPreview: true }] })),
    'video',
  );
  // Legacy rows have no duration: still a clip (F2 probes the file).
  assertEquals(
    visualKind(memory({ id: '4', media: [{ kind: 'video', durationMs: null, hasPreview: false }] })),
    'video',
  );
  // Too short to cut in as a clip, and no photo alongside.
  assertEquals(
    visualKind(memory({ id: '4b', media: [{ kind: 'video', durationMs: 1500, hasPreview: true }] })),
    null,
  );
  assertEquals(
    visualKind(memory({ id: '5', type: 'audio', media: [{ kind: 'audio', durationMs: 4000, hasPreview: false }] })),
    null,
  );
});

Deno.test('isSoundCandidate requires an audio memory of at least 2s', () => {
  const audio = (ms: number | null) =>
    memory({ id: 'a', type: 'audio', media: [{ kind: 'audio', durationMs: ms, hasPreview: false }] });
  assertEquals(isSoundCandidate(audio(2000)), true);
  assertEquals(isSoundCandidate(audio(1999)), false);
  assertEquals(isSoundCandidate(audio(null)), false);
});

Deno.test('hasQuotedSpeech matches paired quotes in several styles', () => {
  assertEquals(hasQuotedSpeech('She said "the moon is following us" in the car'), true);
  assertEquals(hasQuotedSpeech('Dijo «ay Dios mío» y se rió'), true);
  assertEquals(hasQuotedSpeech('He said “más agua” twice'), true);
  assertEquals(hasQuotedSpeech('No quotes here, just a note'), false);
  assertEquals(hasQuotedSpeech(null), false);
});

Deno.test('birthdayPool: scope, reports, and untagged policy', () => {
  const memories = [
    memory({ id: 'tagged' }),
    memory({ id: 'untagged', taggedMemberIds: [] }),
    memory({ id: 'sibling', taggedMemberIds: [SIB] }),
    memory({ id: 'reported', reported: true }),
    memory({ id: 'before', date: '2024-03-03' }),
    memory({ id: 'birthday', date: '2025-03-04' }),
  ];
  assertEquals(birthdayPool(memories, CHILD, SCOPE, 'exclude').map((m) => m.id), ['tagged']);
  assertEquals(birthdayPool(memories, CHILD, SCOPE, 'include').map((m) => m.id), ['tagged', 'untagged']);
});

Deno.test('evaluateColdOpen: match cut only with two distinct portraits', () => {
  assertEquals(evaluateColdOpen([], SCOPE).mode, 'none');
  assertEquals(evaluateColdOpen([portrait('p1', '2024-01-01')], SCOPE).mode, 'single_portrait');
  assertEquals(
    evaluateColdOpen([portrait('p1', '2024-01-01'), portrait('p2', '2025-01-01')], SCOPE).mode,
    'match_cut',
  );
});

Deno.test('evaluateMontage: excludes worry/sad, dedupes same day, counts quarters', () => {
  const pool = [
    memory({ id: '1', date: '2024-03-10' }),
    memory({ id: '2', date: '2024-03-10' }),
    memory({ id: '3', date: '2024-07-01', emotion: 'sad' }),
    memory({ id: '4', date: '2024-12-01', illustrationReady: true }),
    memory({ id: '5', date: '2024-12-02', type: 'text_only', media: [] }),
  ];
  const result = evaluateMontage(pool, SCOPE);
  assertEquals(result.visuals, 4);
  assertEquals(result.byKind, { illustration: 1, photo: 3, video: 0 });
  assertEquals(result.usableFrames, 2);
  assertEquals(result.quartersCovered, 2);
});

Deno.test('evaluateStarring counts people sharing ≥2 memories with the child, no ranking', () => {
  const pool = [
    memory({ id: '1', taggedMemberIds: [CHILD, GRAN] }),
    memory({ id: '2', taggedMemberIds: [CHILD, GRAN, SIB] }),
    memory({ id: '3', taggedMemberIds: [GRAN] }),
  ];
  assertEquals(evaluateStarring(pool, CHILD), { include: true, people: 1 });
});

Deno.test('evaluateWorld needs 3 topics each on 2 memories', () => {
  const pool = ['a', 'a', 'b', 'b', 'c', 'c', 'd'].map((topic, i) => memory({ id: `${i}`, topics: [topic] }));
  const result = evaluateWorld(pool);
  assertEquals(result.include, true);
  assertEquals(result.qualifyingTopics, 3);
  assertEquals(evaluateWorld(pool.slice(0, 4)).include, false);
});

Deno.test('evaluateFirsts ignores dismissed, other children, and out-of-pool memories', () => {
  const pool = [memory({ id: 'm1' }), memory({ id: 'm2' })];
  const result = evaluateFirsts(
    pool,
    [
      { memoryId: 'm1', familyMemberId: CHILD, milestoneId: 'first-steps', status: 'confirmed' },
      { memoryId: 'm2', familyMemberId: CHILD, milestoneId: 'first-word', status: 'dismissed' },
      { memoryId: 'm2', familyMemberId: SIB, milestoneId: 'first-tooth', status: 'candidate' },
      { memoryId: 'elsewhere', familyMemberId: CHILD, milestoneId: 'first-swim', status: 'candidate' },
    ],
    CHILD,
  );
  assertEquals(result, { include: true, total: 1, shown: 1 });
});

Deno.test('evaluateBirthdayFilm: year-scale thresholds need volume, visuals, and 3 quarters', () => {
  const build = (count: number, months: string[]) =>
    Array.from({ length: count }, (_, i) =>
      memory({ id: `m${i}`, date: `${months[i % months.length]}-${String((i % 27) + 1).padStart(2, '0')}` })
    );
  const run = (memories: FilmMemoryInput[]) =>
    evaluateBirthdayFilm({ memories, childId: CHILD, scope: SCOPE, untagged: 'exclude', milestones: [], portraits: [] });

  assertEquals(run(build(59, ['2024-04', '2024-07', '2024-10'])).eligible, false); // below 60
  assertEquals(run(build(60, ['2024-04', '2024-05'])).eligible, false); // one quarter only
  const ok = run(build(60, ['2024-04', '2024-07', '2024-10']));
  assertEquals(ok.eligible, true);
  assertEquals(ok.scenes.montage.frames, 14);
  assertEquals(ok.scenes.close, 'visuals');
});

Deno.test('sound scene falls back to video clips when no audio memory exists', () => {
  const result = evaluateBirthdayFilm({
    memories: [memory({ id: 'v', media: [{ kind: 'video', durationMs: 8000, hasPreview: true }] })],
    childId: CHILD,
    scope: SCOPE,
    untagged: 'exclude',
    milestones: [],
    portraits: [],
  });
  assertEquals(result.scenes.sound, { include: true, candidates: 0, longestMs: null, videoFallbacks: 1 });
});

Deno.test('evaluateFamilyFilm gives every listed child a chapter, even with zero memories', () => {
  const memories = [
    ...Array.from({ length: 16 }, (_, i) => memory({ id: `m${i}`, date: '2024-05-01' })),
    memory({ id: 'shared', taggedMemberIds: [CHILD, GRAN] }),
  ];
  const result = evaluateFamilyFilm({ memories, children: KIDS, scope: SCOPE });
  assertEquals(result.eligible, false); // year-scale bar is 60
  assertEquals(result.chapters.length, 2);
  assertEquals(result.chapters[1].portraitOnly, true);
  assertEquals(result.sharedMoments, 1);
  assertEquals(result.siblingGapRatio, 17);
});

Deno.test('monthScope handles December rollover', () => {
  assertEquals(monthScope('2026-08'), { start: '2026-08-01', endExclusive: '2026-09-01' });
  assertEquals(monthScope('2026-12'), { start: '2026-12-01', endExclusive: '2027-01-01' });
});

Deno.test('evaluateMonthlyFilm: low bar, themes, per-child award candidates', () => {
  const memories = [
    ...Array.from({ length: 6 }, (_, i) =>
      memory({ id: `a${i}`, date: `2026-08-0${i + 1}`, topics: ['park-playground'], emotion: 'funny' })
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      memory({ id: `b${i}`, date: `2026-08-1${i}`, taggedMemberIds: [SIB], topics: ['beach'], emotion: 'calm' })
    ),
    memory({ id: 'other-month', date: '2026-09-01' }),
  ];
  const result = evaluateMonthlyFilm({ memories, children: KIDS, yearMonth: '2026-08' });
  assertEquals(result.eligible, true);
  assertEquals(result.counts.moments, 10);
  assertEquals(result.themes, [{ id: 'park-playground', memories: 6 }, { id: 'beach', memories: 4 }]);
  assertEquals(result.chapters.map((c) => c.awardCandidates), [6, 0]);
  assertEquals(evaluateMonthlyFilm({ memories: memories.slice(0, 9), children: KIDS, yearMonth: '2026-08' }).eligible, false);
});

Deno.test('chapters only include children born before the scope ends', () => {
  const result = evaluateMonthlyFilm({ memories: [], children: KIDS, yearMonth: '2023-12' });
  assertEquals(result.chapters.map((c) => c.childId), [CHILD]);
  // Born mid-month still gets a chapter.
  assertEquals(evaluateMonthlyFilm({ memories: [], children: KIDS, yearMonth: '2024-01' }).chapters.length, 2);
});

Deno.test('addDays and birthdayFilmScope roll over months, years and leap days', () => {
  assertEquals(addDays('2026-12-30', 3), '2027-01-02');
  assertEquals(addDays('2024-02-28', 1), '2024-02-29');
  assertEquals(birthdayFilmScope('2024-02-29', 2), { start: '2025-02-28', endExclusive: '2026-03-03' });
});
