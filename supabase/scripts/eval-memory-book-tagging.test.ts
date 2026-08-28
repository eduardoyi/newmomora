import { assertEquals, assertExists } from 'jsr:@std/assert@1';

import {
  ageInMonthsAtDate,
  buildSystemPrompt,
  classifyChildOrAdult,
  CLI_USAGE,
  computeBirthdayMatch,
  daysToBirthday,
  formatMilestoneCatalogForPrompt,
  formatTopicVocabularyForPrompt,
  gateTopicsByDate,
  isTopicWithinDateWindow,
  nearbyHolidays,
  NEGATIVE_EXAMPLES,
  parseArgs,
  parseMilestoneCatalog,
  parseModelOutput,
  parseThemes,
  parseTopics,
  parseTopicVocabulary,
  selectImageCandidates,
  toJulianDayNumber,
} from './eval-memory-book-tagging.ts';

const NO_VOCAB_IDS = new Set<string>();

// --- parseArgs (owner hardening fix, 2026-08-27: never-silently-drop
// applies at the CLI level too -- matches the fix in
// eval-memory-book-outline.ts's parseArgs) ----------------------------------

Deno.test('parseArgs: a known flag combination parses cleanly, including a repeated --memory-id', () => {
  const options = parseArgs(['--limit', '20', '--memory-id', 'm1', '--memory-id', 'm2', '--mode', 'discovery', '--dry-run']);
  assertEquals(options.limit, 20);
  assertEquals(options.memoryIds, ['m1', 'm2']);
  assertEquals(options.mode, 'discovery');
  assertEquals(options.dryRun, true);
});

Deno.test('parseArgs: an unknown argument throws with the offending token and usage, instead of being silently dropped', () => {
  let error: Error | null = null;
  try {
    parseArgs(['--limit', '20', '--totally-not-a-flag']);
  } catch (e) {
    error = e as Error;
  }
  assertEquals(error !== null, true);
  assertEquals(error!.message.includes('--totally-not-a-flag'), true);
  assertEquals(error!.message.includes(CLI_USAGE), true);
});

// --- parseMilestoneCatalog ---------------------------------------------

const SAMPLE_CATALOG_MARKDOWN = `# Milestone Catalog — Draft v1

## Principles

1. **Explicit text only.** Some prose that happens to contain a \`|\` pipe
   character should never be mistaken for a table row.

## Body & movement

| id | Milestone | Band | Example explicit cues |
|---|---|---|---|
| first-smile | First smile | 0–4m | "first real smile" |
| rolls-over | Rolls over | 2–8m | "rolled over for the first time" |

## Talking & language

| id | Milestone | Band | Example explicit cues |
|---|---|---|---|
| first-word | First word | 7–20m | "her first word was…" |
`;

Deno.test('parseMilestoneCatalog extracts entries and skips header/separator rows', () => {
  const entries = parseMilestoneCatalog(SAMPLE_CATALOG_MARKDOWN);

  assertEquals(entries, [
    { id: 'first-smile', name: 'First smile', band: '0–4m' },
    { id: 'rolls-over', name: 'Rolls over', band: '2–8m' },
    { id: 'first-word', name: 'First word', band: '7–20m' },
  ]);
});

Deno.test('parseMilestoneCatalog ignores non-table prose even when it contains a pipe', () => {
  const entries = parseMilestoneCatalog('Some line with a | pipe but no table structure.\n');
  assertEquals(entries, []);
});

Deno.test('parseMilestoneCatalog against the real catalog file parses a non-trivial, well-formed set', async () => {
  const catalogUrl = new URL('../../docs/plans/milestone-catalog.md', import.meta.url);
  const markdown = await Deno.readTextFile(catalogUrl);
  const entries = parseMilestoneCatalog(markdown);

  // Robust to future catalog edits: assert shape + a known stable id rather
  // than an exact count (the doc's own "Notes for implementation" section
  // states 78 as of this writing, but that number is expected to drift).
  assertEquals(entries.length > 50, true);
  const ids = new Set(entries.map((e) => e.id));
  assertEquals(ids.has('first-steps'), true);
  assertEquals(ids.has('birthday'), true);
  for (const entry of entries) {
    assertExists(entry.id);
    assertExists(entry.name);
    assertExists(entry.band);
  }
});

Deno.test('formatMilestoneCatalogForPrompt renders "id — name (band)" lines', () => {
  const text = formatMilestoneCatalogForPrompt([
    { id: 'first-smile', name: 'First smile', band: '0–4m' },
    { id: 'first-word', name: 'First word', band: '7–20m' },
  ]);

  assertEquals(text, 'first-smile — First smile (0–4m)\nfirst-word — First word (7–20m)');
});

// --- toJulianDayNumber / dayOfWeek-derived math (indirect, via nearbyHolidays) ---

Deno.test('toJulianDayNumber is monotonic across a month/year boundary', () => {
  const dec31 = toJulianDayNumber('2025-12-31');
  const jan1 = toJulianDayNumber('2026-01-01');
  assertEquals(jan1 - dec31, 1);
});

// --- daysToBirthday ------------------------------------------------------

Deno.test('daysToBirthday returns 0 on the birthday itself', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-15'), 0);
});

Deno.test('daysToBirthday returns a positive count when the birthday is upcoming', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-10'), 5);
});

Deno.test('daysToBirthday returns a negative count when the birthday just passed', () => {
  assertEquals(daysToBirthday('2022-06-15', '2026-06-20'), -5);
});

Deno.test('daysToBirthday picks the nearer of last year vs next year across a year boundary', () => {
  // Born Jan 2 -- from Dec 30 the nearest anniversary is 3 days ahead
  // (next Jan 2), not 363 days back to last Jan 2.
  assertEquals(daysToBirthday('2020-01-02', '2025-12-30'), 3);
});

Deno.test('daysToBirthday clamps a Feb 29 birthday to Feb 28 in non-leap years', () => {
  // 2023 is not a leap year; the Feb 29 anniversary clamps to Feb 28.
  assertEquals(daysToBirthday('2020-02-29', '2023-02-28'), 0);
});

// --- ageInMonthsAtDate ----------------------------------------------------

Deno.test('ageInMonthsAtDate computes whole months elapsed', () => {
  assertEquals(ageInMonthsAtDate('2025-01-15', '2025-07-15'), 6);
  assertEquals(ageInMonthsAtDate('2025-01-15', '2025-07-10'), 5);
});

Deno.test('ageInMonthsAtDate returns null when referenceDate precedes dateOfBirth', () => {
  assertEquals(ageInMonthsAtDate('2025-06-01', '2025-01-01'), null);
});

// --- classifyChildOrAdult --------------------------------------------------

Deno.test('classifyChildOrAdult classifies by the <13 threshold and unknown DOB', () => {
  assertEquals(classifyChildOrAdult(0), 'child');
  assertEquals(classifyChildOrAdult(12), 'child');
  assertEquals(classifyChildOrAdult(13), 'adult');
  assertEquals(classifyChildOrAdult(40), 'adult');
  assertEquals(classifyChildOrAdult(null), 'unknown');
});

// --- computeBirthdayMatch --------------------------------------------------
// Returns { birthdayMatch, birthMatch } -- ageTurned >= 1 surfaces as
// birthdayMatch (with a signed daysOffset = memory_date - anniversary);
// ageTurned 0 (the anniversary IS the birth itself) surfaces separately as
// birthMatch (with daysFromBirth = memory_date - date_of_birth), since a
// newborn-week memory is "birth", not "0th birthday".

Deno.test('computeBirthdayMatch matches a tagged member within the default 7-day window, with a signed offset', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-18',
  );
  // Anniversary is 2026-06-15; memory_date (06-18) is 3 days AFTER it.
  assertEquals(result.birthdayMatch, { memberName: 'Enzo', ageTurned: 4, daysOffset: 3 });
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch reports a negative daysOffset when the memory precedes the anniversary', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-12',
  );
  assertEquals(result.birthdayMatch, { memberName: 'Enzo', ageTurned: 4, daysOffset: -3 });
});

Deno.test('computeBirthdayMatch returns nulls outside the window', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    '2026-06-30',
  );
  assertEquals(result.birthdayMatch, null);
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch ignores members with no date_of_birth', () => {
  const result = computeBirthdayMatch([{ id: 'a', name: 'Grandma', dateOfBirth: null }], '2026-06-15');
  assertEquals(result.birthdayMatch, null);
  assertEquals(result.birthMatch, null);
});

Deno.test('computeBirthdayMatch picks the closer of two matching members, tie-breaking on id', () => {
  const result = computeBirthdayMatch(
    [
      { id: 'b', name: 'Mara', dateOfBirth: '2024-06-12' }, // 3 days away
      { id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }, // 0 days away
    ],
    '2026-06-15',
  );
  assertEquals(result.birthdayMatch, { memberName: 'Enzo', ageTurned: 4, daysOffset: 0 });
});

Deno.test('computeBirthdayMatch reports the birth itself (ageTurned 0) as birthMatch, not birthdayMatch', () => {
  const result = computeBirthdayMatch(
    [{ id: 'a', name: 'Mara', dateOfBirth: '2026-06-15' }],
    '2026-06-18',
  );
  assertEquals(result.birthdayMatch, null);
  // Memory is 3 days after the actual date of birth.
  assertEquals(result.birthMatch, { memberName: 'Mara', daysFromBirth: 3 });
});

Deno.test('computeBirthdayMatch tracks birthdayMatch and birthMatch independently for different members', () => {
  const result = computeBirthdayMatch(
    [
      { id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }, // turns 4 -- a real birthday
      { id: 'b', name: 'Mara', dateOfBirth: '2026-06-16' }, // born the day before -- a birth, not a birthday
    ],
    '2026-06-15',
  );
  assertEquals(result.birthdayMatch, { memberName: 'Enzo', ageTurned: 4, daysOffset: 0 });
  assertEquals(result.birthMatch, { memberName: 'Mara', daysFromBirth: -1 });
});

// --- parseThemes -------------------------------------------------------------

Deno.test('parseThemes (strict mode) reads a plain string array and returns null confidences', () => {
  const result = parseThemes(['beach day', 'bath time'], 'strict');
  assertEquals(result, { themes: ['beach day', 'bath time'], themeConfidences: null });
});

Deno.test('parseThemes (strict mode) caps at 4 and drops non-strings/blanks', () => {
  const result = parseThemes(['a', '', '  b  ', 3, 'c', 'd', 'e'], 'strict');
  assertEquals(result, { themes: ['a', 'b', 'c', 'd'], themeConfidences: null });
});

Deno.test('parseThemes (discovery mode) reads {theme, confidence} objects', () => {
  const result = parseThemes(
    [
      { theme: 'beach day', confidence: 0.9 },
      { theme: 'bath time', confidence: 0.4 },
    ],
    'discovery',
  );
  assertEquals(result, { themes: ['beach day', 'bath time'], themeConfidences: [0.9, 0.4] });
});

Deno.test('parseThemes (discovery mode) tolerates a plain string item as confidence 0', () => {
  const result = parseThemes(['beach day', { theme: 'bath time', confidence: 0.7 }], 'discovery');
  assertEquals(result, { themes: ['beach day', 'bath time'], themeConfidences: [0, 0.7] });
});

Deno.test('parseThemes (discovery mode) caps at 4 and skips malformed entries', () => {
  const result = parseThemes(
    [
      { theme: 'a', confidence: 0.1 },
      { confidence: 0.2 }, // missing theme -- dropped
      { theme: 'b', confidence: 0.3 },
      { theme: 'c', confidence: 0.4 },
      { theme: 'd', confidence: 0.5 },
      { theme: 'e', confidence: 0.6 },
    ],
    'discovery',
  );
  assertEquals(result.themes, ['a', 'b', 'c', 'd']);
  assertEquals(result.themeConfidences, [0.1, 0.3, 0.4, 0.5]);
});

Deno.test('parseThemes returns empty output for a non-array value, respecting mode for confidences', () => {
  assertEquals(parseThemes(undefined, 'strict'), { themes: [], themeConfidences: null });
  assertEquals(parseThemes(undefined, 'discovery'), { themes: [], themeConfidences: [] });
});

// --- parseModelOutput ---------------------------------------------------------

const ALLOWED_EMOTIONS = new Set(['joy', 'tender', 'calm']);
const CATALOG_IDS = new Set(['first-steps', 'first-word']);

Deno.test('parseModelOutput (strict mode) parses plain-string themes and a valid milestone catalog_id', () => {
  const output = parseModelOutput(
    {
      themes: ['beach day'],
      labels: ['sand', 'sun'],
      description: 'A day at the beach.',
      emotion: 'joy',
      occasion: { type: 'birthday party', evidence: 'text', confidence: 0.8 },
      milestone: { claim: 'first steps', catalog_id: 'first-steps', detail: null },
    },
    ALLOWED_EMOTIONS,
    'strict',
    CATALOG_IDS,
    NO_VOCAB_IDS,
  );

  assertEquals(output.themes, ['beach day']);
  assertEquals(output.themeConfidences, null);
  assertEquals(output.emotion, 'joy');
  assertEquals(output.occasion, { type: 'birthday party', evidence: 'text', confidence: 0.8 });
  assertEquals(output.milestone, { claim: 'first steps', catalog_id: 'first-steps', detail: null, catalogIdRejected: null });
});

Deno.test('parseModelOutput (discovery mode) parses {theme, confidence} themes', () => {
  const output = parseModelOutput(
    { themes: [{ theme: 'beach day', confidence: 0.6 }], labels: ['sand'], description: 'x', emotion: 'calm' },
    ALLOWED_EMOTIONS,
    'discovery',
    CATALOG_IDS,
    NO_VOCAB_IDS,
  );

  assertEquals(output.themes, ['beach day']);
  assertEquals(output.themeConfidences, [0.6]);
});

Deno.test('parseModelOutput rejects a milestone catalog_id not present in the catalog, preserving it in catalogIdRejected', () => {
  const output = parseModelOutput(
    {
      themes: [],
      labels: [],
      description: 'x',
      emotion: 'joy',
      milestone: { claim: 'said her first word', catalog_id: 'not-a-real-id', detail: null },
    },
    ALLOWED_EMOTIONS,
    'strict',
    CATALOG_IDS,
    NO_VOCAB_IDS,
  );

  assertEquals(output.milestone, {
    claim: 'said her first word',
    catalog_id: null,
    detail: null,
    catalogIdRejected: 'not-a-real-id',
  });
});

Deno.test('parseModelOutput leaves catalogIdRejected null when the model gives no catalog_id at all', () => {
  const output = parseModelOutput(
    { themes: [], labels: [], description: 'x', emotion: 'joy', milestone: { claim: 'turned three', catalog_id: null, detail: null } },
    ALLOWED_EMOTIONS,
    'strict',
    CATALOG_IDS,
    NO_VOCAB_IDS,
  );

  assertEquals(output.milestone, { claim: 'turned three', catalog_id: null, detail: null, catalogIdRejected: null });
});

Deno.test('parseModelOutput normalizes emotion but does not reject one outside the allowed set', () => {
  const output = parseModelOutput(
    { themes: [], labels: [], description: 'x', emotion: 'furious' },
    ALLOWED_EMOTIONS,
    'strict',
    CATALOG_IDS,
    NO_VOCAB_IDS,
  );

  assertEquals(output.emotion, 'furious');
});

// --- nearbyHolidays --------------------------------------------------------

Deno.test('nearbyHolidays finds Christmas within the default 10-day window', () => {
  const holidays = nearbyHolidays('2025-12-20');
  const names = holidays.map((h) => h.name);
  assertEquals(names.includes('Christmas'), true);
});

Deno.test('nearbyHolidays finds nothing far from any fixed holiday or Thanksgiving', () => {
  const holidays = nearbyHolidays('2026-08-15');
  assertEquals(holidays, []);
});

Deno.test('nearbyHolidays wraps across the year boundary (New Year near New Year\'s Eve)', () => {
  const holidays = nearbyHolidays('2026-01-03');
  const names = holidays.map((h) => h.name);
  assertEquals(names.includes("New Year's Day"), true);
});

Deno.test('nearbyHolidays computes the 4th-Thursday-of-November rule for Thanksgiving (US)', () => {
  // 2025-11-27 is the 4th Thursday of November 2025 (verified against a
  // real calendar).
  const holidays = nearbyHolidays('2025-11-27');
  const thanksgiving = holidays.find((h) => h.name === 'Thanksgiving (US)');
  assertExists(thanksgiving);
  assertEquals(thanksgiving!.date, '2025-11-27');
  assertEquals(thanksgiving!.daysAway, 0);
});

// --- selectImageCandidates --------------------------------------------------

function mediaRow(overrides: Partial<{
  id: string;
  memory_id: string;
  object_key: string;
  content_type: string;
  duration_ms: number | null;
  position: number;
  preview_object_key: string | null;
}> = {}) {
  return {
    id: 'media-1',
    memory_id: 'memory-1',
    object_key: 'original.jpg',
    content_type: 'image/jpeg',
    duration_ms: null,
    position: 0,
    preview_object_key: null,
    ...overrides,
  };
}

Deno.test('selectImageCandidates prefers preview_object_key when present', () => {
  const [candidate] = selectImageCandidates([mediaRow({ preview_object_key: 'preview.jpg' })]);
  assertEquals(candidate.source, 'preview');
  assertEquals(candidate.objectKey, 'preview.jpg');
  assertEquals(candidate.contentType, 'image/jpeg');
});

Deno.test('selectImageCandidates falls back to the original for jpeg/png/webp photos with no preview', () => {
  const [candidate] = selectImageCandidates([
    mediaRow({ content_type: 'image/png', object_key: 'original.png' }),
  ]);
  assertEquals(candidate.source, 'fallback_original');
  assertEquals(candidate.objectKey, 'original.png');
  assertEquals(candidate.contentType, 'image/png');
});

Deno.test('selectImageCandidates skips a HEIC original with no preview', () => {
  const [candidate] = selectImageCandidates([
    mediaRow({ content_type: 'image/heic', object_key: 'original.heic' }),
  ]);
  assertEquals(candidate.source, 'skipped_heic_no_preview');
  assertEquals(candidate.objectKey, null);
});

Deno.test('selectImageCandidates skips a video with no poster', () => {
  const [candidate] = selectImageCandidates([
    mediaRow({ content_type: 'video/mp4', object_key: 'clip.mp4' }),
  ]);
  assertEquals(candidate.source, 'skipped_video_no_poster');
  assertEquals(candidate.objectKey, null);
});

Deno.test('selectImageCandidates treats a video WITH a poster as usable (preview always wins)', () => {
  const [candidate] = selectImageCandidates([
    mediaRow({ content_type: 'video/mp4', object_key: 'clip.mp4', preview_object_key: 'poster.jpg' }),
  ]);
  assertEquals(candidate.source, 'preview');
  assertEquals(candidate.objectKey, 'poster.jpg');
});

// --- parseTopicVocabulary (V1c controlled mode) -----------------------------

const SAMPLE_VOCAB_MARKDOWN = `# Topic Vocabulary — v2.1

## Concepts owned by other axes (unchanged from v1)

| Axis | What the model kept wanting (source archive) | Where it lives |
|---|---|---|
| **Emotion** | cuddle time, tender moments (116 tokens) | \`emotion\` column |

### Places & outings

| id | Page title | Covers | Source archive | Top raw themes (source) |
|---|---|---|---|---|
| \`beach\` | A day at the beach | Beach, sand, sea, seaside. | 8 | beach day (7) |
| \`lake-river\` ✦ | By the water | Lakes, rivers, creeks, docks, fishing, boating, paddling. | — | — |

✦ = added in v2 for generality.
`;

Deno.test('parseTopicVocabulary extracts id/pageTitle/covers, stripping backticks and the ✦ marker', () => {
  const entries = parseTopicVocabulary(SAMPLE_VOCAB_MARKDOWN);

  assertEquals(entries, [
    { id: 'beach', pageTitle: 'A day at the beach', covers: 'Beach, sand, sea, seaside.' },
    {
      id: 'lake-river',
      pageTitle: 'By the water',
      covers: 'Lakes, rivers, creeks, docks, fishing, boating, paddling.',
    },
  ]);
});

Deno.test('parseTopicVocabulary ignores the "Concepts owned by other axes" table (no backticked id column)', () => {
  const entries = parseTopicVocabulary(SAMPLE_VOCAB_MARKDOWN);
  assertEquals(entries.some((e) => e.id.includes('Emotion')), false);
});

Deno.test('parseTopicVocabulary against the real doc parses exactly 61 entries with known ids present', async () => {
  const vocabUrl = new URL('../../docs/plans/topic-vocabulary.md', import.meta.url);
  const markdown = await Deno.readTextFile(vocabUrl);
  const entries = parseTopicVocabulary(markdown);

  assertEquals(entries.length, 61);
  const ids = new Set(entries.map((e) => e.id));
  assertEquals(ids.has('beach'), true);
  assertEquals(ids.has('other-holiday'), true);
  assertEquals(ids.has('mothers-fathers-day'), true);
  assertEquals(ids.has('lunar-new-year'), true);
  for (const entry of entries) {
    assertExists(entry.id);
    assertExists(entry.pageTitle);
    assertExists(entry.covers);
  }
});

Deno.test('formatTopicVocabularyForPrompt renders "id — page title: covers" lines', () => {
  const text = formatTopicVocabularyForPrompt([
    { id: 'beach', pageTitle: 'A day at the beach', covers: 'Beach, sand, sea, seaside.' },
  ]);
  assertEquals(text, 'beach — A day at the beach: Beach, sand, sea, seaside.');
});

Deno.test('NEGATIVE_EXAMPLES is a non-empty, deduplicated list of the doc\'s dropped catch-alls', () => {
  assertEquals(NEGATIVE_EXAMPLES.length > 0, true);
  assertEquals(new Set(NEGATIVE_EXAMPLES).size, NEGATIVE_EXAMPLES.length);
  assertEquals(NEGATIVE_EXAMPLES.includes('playtime'), true);
  assertEquals(NEGATIVE_EXAMPLES.includes('cozy moments'), true);
});

// --- parseTopics (V1c controlled mode) --------------------------------------

const VOCAB_IDS = new Set(['beach', 'bath', 'other-holiday', 'ceremony']);

Deno.test('parseTopics keeps valid ids with no required detail forced to null', () => {
  const result = parseTopics([{ id: 'beach', detail: null }], VOCAB_IDS);
  assertEquals(result, { topics: [{ id: 'beach', detail: null }], topicsRejected: [], topicsMissingDetail: [] });
});

Deno.test('parseTopics forces detail to null for a topic that does not require one, even if the model sent one', () => {
  const result = parseTopics([{ id: 'beach', detail: 'Waikiki' }], VOCAB_IDS);
  assertEquals(result.topics, [{ id: 'beach', detail: null }]);
});

Deno.test('parseTopics keeps a required-detail topic\'s detail when present', () => {
  const result = parseTopics([{ id: 'other-holiday', detail: 'Passover' }], VOCAB_IDS);
  assertEquals(result.topics, [{ id: 'other-holiday', detail: 'Passover' }]);
  assertEquals(result.topicsMissingDetail, []);
});

Deno.test('parseTopics keeps a required-detail topic missing its detail, recording it in topicsMissingDetail', () => {
  const result = parseTopics([{ id: 'ceremony', detail: null }], VOCAB_IDS);
  assertEquals(result.topics, [{ id: 'ceremony', detail: null }]);
  assertEquals(result.topicsMissingDetail, ['ceremony']);
});

Deno.test('parseTopics drops an id not in the vocabulary, recording it in topicsRejected', () => {
  const result = parseTopics([{ id: 'not-a-real-topic', detail: null }], VOCAB_IDS);
  assertEquals(result.topics, []);
  assertEquals(result.topicsRejected, ['not-a-real-topic']);
});

Deno.test('parseTopics caps at 3 valid topics', () => {
  const result = parseTopics(
    [{ id: 'beach' }, { id: 'bath' }, { id: 'other-holiday', detail: 'Diwali' }, { id: 'ceremony', detail: 'Baptism' }],
    VOCAB_IDS,
  );
  assertEquals(result.topics.length, 3);
  assertEquals(result.topics.map((t) => t.id), ['beach', 'bath', 'other-holiday']);
});

Deno.test('parseTopics returns empty output for a non-array value', () => {
  assertEquals(parseTopics(undefined, VOCAB_IDS), { topics: [], topicsRejected: [], topicsMissingDetail: [] });
});

// --- parseTopics tolerance (root-caused a live-run collapse: 726 processed,
// only 13 tagged, topicsRejected/topicsMissingDetail both empty -- the
// model wasn't answering with the exact requested {"id", "detail"} shape,
// and the old parseTopics silently `continue`d on anything else.) ---------

Deno.test('parseTopics accepts a bare string item as the id, with a null detail', () => {
  const result = parseTopics(['beach'], VOCAB_IDS);
  assertEquals(result, { topics: [{ id: 'beach', detail: null }], topicsRejected: [], topicsMissingDetail: [] });
});

Deno.test('parseTopics reads the id from `topic`/`name`/`theme` when `id` is absent', () => {
  assertEquals(parseTopics([{ topic: 'beach' }], VOCAB_IDS).topics, [{ id: 'beach', detail: null }]);
  assertEquals(parseTopics([{ name: 'bath' }], VOCAB_IDS).topics, [{ id: 'bath', detail: null }]);
  assertEquals(parseTopics([{ theme: 'beach' }], VOCAB_IDS).topics, [{ id: 'beach', detail: null }]);
});

Deno.test('parseTopics prefers `id` over `topic`/`name`/`theme` when more than one is present', () => {
  const result = parseTopics([{ id: 'beach', topic: 'bath' }], VOCAB_IDS);
  assertEquals(result.topics, [{ id: 'beach', detail: null }]);
});

Deno.test('parseTopics reads detail from `note` when `detail` is absent', () => {
  const result = parseTopics([{ id: 'ceremony', note: 'Baptism' }], VOCAB_IDS);
  assertEquals(result.topics, [{ id: 'ceremony', detail: 'Baptism' }]);
  assertEquals(result.topicsMissingDetail, []);
});

Deno.test('parseTopics normalizes ids (trim, lowercase, spaces/underscores -> hyphens) before the vocabulary check', () => {
  assertEquals(parseTopics(['Beach'], VOCAB_IDS).topics, [{ id: 'beach', detail: null }]);
  assertEquals(parseTopics([{ topic: 'other_holiday' }], VOCAB_IDS).topics, [{ id: 'other-holiday', detail: null }]);
  assertEquals(parseTopics([{ id: '  Other Holiday  ' }], VOCAB_IDS).topics, [{ id: 'other-holiday', detail: null }]);
});

Deno.test('parseTopics rejects a normalized id not in the vocabulary, recording the normalized form', () => {
  const result = parseTopics(['Not A Real Topic'], VOCAB_IDS);
  assertEquals(result.topics, []);
  assertEquals(result.topicsRejected, ['not-a-real-topic']);
});

Deno.test('parseTopics records an unresolvable item (no id in any recognized shape) as a JSON preview in topicsRejected, never silently dropping it', () => {
  const result = parseTopics([{ confidence: 0.9 }, null, 42], VOCAB_IDS);
  assertEquals(result.topics, []);
  assertEquals(result.topicsRejected, ['{"confidence":0.9}', 'null', '42']);
});

Deno.test('parseTopics truncates a long unresolvable item preview to ~60 chars', () => {
  const longItem = { note: 'x'.repeat(200) };
  const result = parseTopics([longItem], VOCAB_IDS);
  assertEquals(result.topicsRejected.length, 1);
  assertEquals(result.topicsRejected[0].endsWith('…'), true);
  assertEquals(result.topicsRejected[0].length, 61); // 60 chars + the ellipsis marker
});

Deno.test('parseTopics still caps at 3 when items are a mix of tolerant shapes', () => {
  const result = parseTopics(['beach', { topic: 'bath' }, { name: 'other-holiday', detail: 'Diwali' }, 'ceremony'], VOCAB_IDS);
  assertEquals(result.topics.length, 3);
  assertEquals(result.topics.map((t) => t.id), ['beach', 'bath', 'other-holiday']);
});

// --- isTopicWithinDateWindow / gateTopicsByDate (V1c date gating) ----------

Deno.test('isTopicWithinDateWindow: christmas is in-window mid-December', () => {
  assertEquals(isTopicWithinDateWindow('christmas', '2025-12-20'), true);
});

Deno.test('isTopicWithinDateWindow: christmas is out-of-window in July', () => {
  assertEquals(isTopicWithinDateWindow('christmas', '2025-07-04'), false);
});

Deno.test('isTopicWithinDateWindow: christmas window wraps the year boundary (Dec 15 -> Jan 6)', () => {
  assertEquals(isTopicWithinDateWindow('christmas', '2025-12-31'), true);
  assertEquals(isTopicWithinDateWindow('christmas', '2026-01-06'), true);
  assertEquals(isTopicWithinDateWindow('christmas', '2026-01-07'), false);
  assertEquals(isTopicWithinDateWindow('christmas', '2025-12-14'), false);
});

Deno.test('isTopicWithinDateWindow: new-year window wraps the year boundary (Dec 26 -> Jan 7)', () => {
  assertEquals(isTopicWithinDateWindow('new-year', '2025-12-26'), true);
  assertEquals(isTopicWithinDateWindow('new-year', '2026-01-07'), true);
  assertEquals(isTopicWithinDateWindow('new-year', '2026-01-08'), false);
  assertEquals(isTopicWithinDateWindow('new-year', '2025-12-25'), false);
});

Deno.test('isTopicWithinDateWindow: halloween window does not wrap and rejects out-of-window dates', () => {
  assertEquals(isTopicWithinDateWindow('halloween', '2025-10-31'), true);
  assertEquals(isTopicWithinDateWindow('halloween', '2025-10-20'), false);
  assertEquals(isTopicWithinDateWindow('halloween', '2025-11-04'), false);
});

Deno.test('isTopicWithinDateWindow: thanksgiving (computed 4th-Thursday-of-November) is in-window at ±7 days', () => {
  // 2025-11-27 is the 4th Thursday of November 2025.
  assertEquals(isTopicWithinDateWindow('thanksgiving', '2025-11-27'), true);
  assertEquals(isTopicWithinDateWindow('thanksgiving', '2025-12-04'), true); // +7d
  assertEquals(isTopicWithinDateWindow('thanksgiving', '2025-12-05'), false); // +8d
});

Deno.test('isTopicWithinDateWindow: mothers-fathers-day matches either Mother\'s Day or Father\'s Day', () => {
  // Mother's Day 2026 = 2nd Sunday of May = 2026-05-10.
  assertEquals(isTopicWithinDateWindow('mothers-fathers-day', '2026-05-10'), true);
  // Father's Day 2026 = 3rd Sunday of June = 2026-06-21.
  assertEquals(isTopicWithinDateWindow('mothers-fathers-day', '2026-06-21'), true);
  assertEquals(isTopicWithinDateWindow('mothers-fathers-day', '2026-08-01'), false);
});

Deno.test('isTopicWithinDateWindow: a movable holiday (easter) matches its per-year table entry within ±10 days', () => {
  // Easter 2025 = 2025-04-20 (per-year table).
  assertEquals(isTopicWithinDateWindow('easter', '2025-04-20'), true);
  assertEquals(isTopicWithinDateWindow('easter', '2025-04-30'), true); // +10d
  assertEquals(isTopicWithinDateWindow('easter', '2025-05-01'), false); // +11d
});

Deno.test('isTopicWithinDateWindow: a movable holiday outside the 2022-2027 table fails closed', () => {
  assertEquals(isTopicWithinDateWindow('easter', '2030-04-20'), false);
});

Deno.test('isTopicWithinDateWindow: a non-gated topic id is always considered in-window', () => {
  assertEquals(isTopicWithinDateWindow('beach', '2025-01-01'), true);
  assertEquals(isTopicWithinDateWindow('birthday', '2025-01-01'), true);
});

Deno.test('gateTopicsByDate keeps in-window and non-gated topics, removes out-of-window ones into dateGated', () => {
  const result = gateTopicsByDate(
    [
      { id: 'christmas', detail: null }, // in window
      { id: 'halloween', detail: null }, // out of window
      { id: 'beach', detail: null }, // not gated at all
    ],
    '2025-12-20',
  );
  assertEquals(result.topics, [{ id: 'christmas', detail: null }, { id: 'beach', detail: null }]);
  assertEquals(result.dateGated, ['halloween']);
});

Deno.test('gateTopicsByDate never gates other-holiday/national-holiday/ceremony regardless of date', () => {
  const result = gateTopicsByDate(
    [
      { id: 'other-holiday', detail: 'Nowruz' },
      { id: 'national-holiday', detail: 'July 4th' },
      { id: 'ceremony', detail: 'Baptism' },
    ],
    '2025-01-01',
  );
  assertEquals(result.topics.length, 3);
  assertEquals(result.dateGated, []);
});

Deno.test('gateTopicsByDate DOES gate mothers-fathers-day despite it requiring a detail', () => {
  const result = gateTopicsByDate([{ id: 'mothers-fathers-day', detail: "Mother's Day" }], '2025-01-01');
  assertEquals(result.topics, []);
  assertEquals(result.dateGated, ['mothers-fathers-day']);
});

// --- buildSystemPrompt (controlled-mode vocabulary placement) ---------------
// Regression coverage for the prompt-structure fix: a live 25-memory sample
// with the vocabulary appended at the END of the prompt (after the
// milestone catalog) came back with topics on only 1/25 memories, with the
// topicsRawUnparsed tripwire never firing (so the model was genuinely
// emitting `topics: []`, not producing something parseTopics choked on).
// The fix moves the vocabulary immediately after the topics instruction,
// before `labels`.

const SAMPLE_CATALOG = [{ id: 'first-steps', name: 'First steps', band: '8-19m' }];
const SAMPLE_VOCAB = [
  { id: 'beach', pageTitle: 'A day at the beach', covers: 'Beach, sand, sea, seaside.' },
  { id: 'grandparents', pageTitle: 'With the grandparents', covers: 'Time with grandparents.' },
];

Deno.test('buildSystemPrompt (controlled mode) inlines the topic vocabulary immediately after the topics instruction, before `labels`', () => {
  const prompt = buildSystemPrompt(['joy', 'calm'], SAMPLE_CATALOG, 'controlled', SAMPLE_VOCAB);

  // (a) contains a known vocabulary line fragment.
  assertEquals(prompt.includes('beach — '), true);

  // (b) the vocabulary appears before the `labels` bullet.
  const vocabIndex = prompt.indexOf('beach — ');
  const labelsIndex = prompt.indexOf('`labels`');
  assertExists(vocabIndex);
  assertExists(labelsIndex);
  assertEquals(vocabIndex >= 0 && labelsIndex >= 0 && vocabIndex < labelsIndex, true);

  // (c) the topics example string appears.
  assertEquals(prompt.includes('"topics": ["beach", "grandparents"]'), true);
});

Deno.test('buildSystemPrompt (controlled mode) still places the milestone catalog at the end, after the vocabulary', () => {
  const prompt = buildSystemPrompt(['joy', 'calm'], SAMPLE_CATALOG, 'controlled', SAMPLE_VOCAB);

  const vocabIndex = prompt.indexOf('beach — ');
  const catalogIndex = prompt.indexOf('first-steps — First steps');
  assertEquals(vocabIndex >= 0 && catalogIndex >= 0 && vocabIndex < catalogIndex, true);
});

Deno.test('buildSystemPrompt (discovery/strict modes) never mentions the topic vocabulary', () => {
  const strictPrompt = buildSystemPrompt(['joy', 'calm'], SAMPLE_CATALOG, 'strict', SAMPLE_VOCAB);
  const discoveryPrompt = buildSystemPrompt(['joy', 'calm'], SAMPLE_CATALOG, 'discovery', SAMPLE_VOCAB);

  assertEquals(strictPrompt.includes('TOPIC VOCABULARY'), false);
  assertEquals(discoveryPrompt.includes('TOPIC VOCABULARY'), false);
  assertEquals(strictPrompt.includes('beach — '), false);
  assertEquals(discoveryPrompt.includes('beach — '), false);
});
