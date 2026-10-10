import { assertEquals } from 'jsr:@std/assert@1';
import {
  applyArtworkAnalysisMode,
  buildAnalysisInput,
  buildRelevantMilestoneCatalog,
  buildMemoryAnalysisSystemPrompt,
  computeMilestoneRows,
  gateMilestoneClaim,
  parseMemoryAnalysisModelOutput,
  parseMilestoneClaim,
  parseTopics,
  runMemoryAnalysis,
  selectImageCandidates,
  type MediaAssetForAnalysis,
} from './analyze-memory-core.ts';
import { TOPICS } from './memory-topics.ts';
import { MILESTONES } from './memory-milestones.ts';

// --- parseTopics -------------------------------------------------------------

Deno.test('parseTopics resolves bare-string ids against the approved vocabulary', () => {
  const result = parseTopics(['beach', 'grandparents']);
  assertEquals(result.topics, [
    { id: 'beach', detail: null },
    { id: 'grandparents', detail: null },
  ]);
  assertEquals(result.rejectedIds, []);
});

Deno.test('parseTopics normalizes id formatting before the vocabulary check', () => {
  const result = parseTopics(['Beach Day'.replace('Day', ''), 'Grandparents']);
  // "Beach " trims to "Beach" -> normalizes to "beach"; "Grandparents" -> "grandparents".
  assertEquals(result.topics.map((t) => t.id), ['beach', 'grandparents']);
});

Deno.test('parseTopics rejects an id outside the vocabulary and records it, never silently', () => {
  const result = parseTopics(['beach', 'not-a-real-topic']);
  assertEquals(result.topics, [{ id: 'beach', detail: null }]);
  assertEquals(result.rejectedIds, ['not-a-real-topic']);
});

Deno.test('parseTopics records a wrong-shape item as a rejected preview instead of dropping it', () => {
  const result = parseTopics([42, { nope: true }]);
  assertEquals(result.topics, []);
  assertEquals(result.rejectedIds, ['42', '{"nope":true}']);
});

Deno.test('parseTopics reads id from object shapes {id}/{topic}/{name}/{theme} and detail from {detail}/{note}', () => {
  const result = parseTopics([
    { id: 'ceremony', detail: 'Baptism' },
    { topic: 'other-holiday', note: 'Diwali' },
  ]);
  assertEquals(result.topics, [
    { id: 'ceremony', detail: 'Baptism' },
    { id: 'other-holiday', detail: 'Diwali' },
  ]);
});

Deno.test('parseTopics keeps a required-detail topic missing its detail, but records it', () => {
  const result = parseTopics(['ceremony']);
  assertEquals(result.topics, [{ id: 'ceremony', detail: null }]);
  assertEquals(result.missingDetailIds, ['ceremony']);
});

Deno.test('parseTopics never attaches a detail to a topic that does not require one', () => {
  const result = parseTopics([{ id: 'beach', detail: 'ignored' }]);
  assertEquals(result.topics, [{ id: 'beach', detail: null }]);
});

Deno.test('parseTopics caps at 3 topics', () => {
  const result = parseTopics(['beach', 'grandparents', 'mealtime', 'bath']);
  assertEquals(result.topics.length, 3);
  assertEquals(result.topics.map((t) => t.id), ['beach', 'grandparents', 'mealtime']);
});

Deno.test('parseTopics returns empty for a non-array value', () => {
  assertEquals(parseTopics(undefined), { topics: [], rejectedIds: [], missingDetailIds: [] });
});

// --- parseMilestoneClaim -------------------------------------------------------

Deno.test('parseMilestoneClaim validates catalog_id against the real catalog', () => {
  const result = parseMilestoneClaim({ claim: 'took her first steps', catalog_id: 'first-steps', detail: null });
  assertEquals(result, { claim: 'took her first steps', catalogId: 'first-steps', detail: null, evidence: null });
});

Deno.test('parseMilestoneClaim nulls an unrecognized catalog_id but keeps the claim', () => {
  const result = parseMilestoneClaim({ claim: 'turned three', catalog_id: 'not-a-real-id', detail: null });
  assertEquals(result, { claim: 'turned three', catalogId: null, detail: null, evidence: null });
});

Deno.test('parseMilestoneClaim returns null for a missing/blank claim', () => {
  assertEquals(parseMilestoneClaim({ catalog_id: 'first-steps' }), null);
  assertEquals(parseMilestoneClaim(null), null);
  assertEquals(parseMilestoneClaim({ claim: '   ' }), null);
});

// --- parseMemoryAnalysisModelOutput --------------------------------------------

Deno.test('parseMemoryAnalysisModelOutput assembles every axis from one raw JSON object', () => {
  const output = parseMemoryAnalysisModelOutput({
    topics: ['beach'],
    labels: ['sand', 'sun', 'towel'],
    description: 'A day at the beach.',
    emotion: 'joy',
    milestone: { claim: 'first steps', catalog_id: 'first-steps', detail: null, evidence: 'took her first steps' },
  });

  assertEquals(output.topics, [{ id: 'beach', detail: null }]);
  assertEquals(output.labels, ['sand', 'sun', 'towel']);
  assertEquals(output.description, 'A day at the beach.');
  assertEquals(output.emotion, 'joy');
  assertEquals(output.milestoneClaim, {
    claim: 'first steps',
    catalogId: 'first-steps',
    detail: null,
    evidence: 'took her first steps',
  });
});

Deno.test('parseMemoryAnalysisModelOutput normalizes an unknown emotion to the tender fallback', () => {
  const output = parseMemoryAnalysisModelOutput({ emotion: 'not-a-real-emotion' });
  assertEquals(output.emotion, 'tender');
});

Deno.test('parseMemoryAnalysisModelOutput parses `medium` tolerantly (case, plural, synonym) and nulls the unknown', () => {
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 'Crayons' }).artworkMedium, 'crayon');
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 'water color' }).artworkMedium, 'watercolor');
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 'felt tip' }).artworkMedium, 'marker');
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 'oil pastel' }).artworkMedium, 'pastel');
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 'finger paint on canvas' }).artworkMedium, null);
  assertEquals(parseMemoryAnalysisModelOutput({ medium: 7 }).artworkMedium, null);
  assertEquals(parseMemoryAnalysisModelOutput({}).artworkMedium, null);
});

Deno.test('parseMemoryAnalysisModelOutput handles a completely malformed raw payload', () => {
  const output = parseMemoryAnalysisModelOutput('not an object');
  assertEquals(output.artworkMedium, null);
  assertEquals(output.topics, []);
  assertEquals(output.labels, []);
  assertEquals(output.description, '');
  assertEquals(output.milestoneClaim, null);
});

// --- buildAnalysisInput ---------------------------------------------------------

Deno.test('buildAnalysisInput: text_only strips URLs and sends no images', () => {
  const result = buildAnalysisInput('text_only', 'Check https://example.com/x out', null, []);
  assertEquals(result.text, 'Check out');
  assertEquals(result.imageCandidates, []);
});

Deno.test('buildAnalysisInput: text_illustration with empty content has no text', () => {
  const result = buildAnalysisInput('text_illustration', '   ', null, []);
  assertEquals(result.text, null);
});

Deno.test('buildAnalysisInput: audio proceeds on description only', () => {
  const result = buildAnalysisInput('audio', 'Lila singing Twinkle Twinkle in the bath', null, []);
  assertEquals(result.text, 'Lila singing Twinkle Twinkle in the bath');
});

Deno.test('buildAnalysisInput: audio proceeds on transcript only', () => {
  const result = buildAnalysisInput('audio', null, 'twinkle twinkle little star', []);
  assertEquals(result.text, 'twinkle twinkle little star');
});

Deno.test('buildAnalysisInput: audio joins content and transcript, no images', () => {
  const result = buildAnalysisInput('audio', 'Lila singing', 'twinkle twinkle little star', []);
  assertEquals(result.text, 'Lila singing twinkle twinkle little star');
  assertEquals(result.imageCandidates, []);
});

Deno.test('buildAnalysisInput: audio with both empty has no text', () => {
  const result = buildAnalysisInput('audio', null, null, []);
  assertEquals(result.text, null);
});

Deno.test('buildAnalysisInput: audio with URL-only content strips to no text', () => {
  const result = buildAnalysisInput('audio', 'https://example.com/clip', null, []);
  assertEquals(result.text, null);
});

Deno.test('buildAnalysisInput: media selects up to 4 usable image candidates by position', () => {
  const media: MediaAssetForAnalysis[] = Array.from({ length: 6 }, (_, i) => ({
    objectKey: `orig-${i}.jpg`,
    contentType: 'image/jpeg',
    position: i,
    previewObjectKey: `preview-${i}.jpg`,
  }));
  const result = buildAnalysisInput('media', 'A caption', null, media);
  assertEquals(result.text, 'A caption');
  assertEquals(result.imageCandidates.length, 4);
  assertEquals(result.imageCandidates[0].objectKey, 'preview-0.jpg');
});

Deno.test('buildAnalysisInput: media with only a HEIC original and no preview has no usable images', () => {
  const media: MediaAssetForAnalysis[] = [
    { objectKey: 'a.heic', contentType: 'image/heic', position: 0, previewObjectKey: null },
  ];
  const result = buildAnalysisInput('media', null, null, media);
  assertEquals(result.imageCandidates, []);
});

// --- selectImageCandidates -------------------------------------------------------

function mediaRow(overrides: Partial<MediaAssetForAnalysis> = {}): MediaAssetForAnalysis {
  return { objectKey: 'original.jpg', contentType: 'image/jpeg', position: 0, previewObjectKey: null, ...overrides };
}

Deno.test('selectImageCandidates prefers preview_object_key when present', () => {
  const [candidate] = selectImageCandidates([mediaRow({ previewObjectKey: 'preview.jpg' })]);
  assertEquals(candidate, { source: 'preview', objectKey: 'preview.jpg', contentType: 'image/jpeg' });
});

Deno.test('selectImageCandidates falls back to the original for jpeg/png/webp photos with no preview', () => {
  const [candidate] = selectImageCandidates([mediaRow({ contentType: 'image/png', objectKey: 'original.png' })]);
  assertEquals(candidate, { source: 'fallback_original', objectKey: 'original.png', contentType: 'image/png' });
});

Deno.test('selectImageCandidates skips a HEIC original with no preview', () => {
  const [candidate] = selectImageCandidates([mediaRow({ contentType: 'image/heic', objectKey: 'original.heic' })]);
  assertEquals(candidate, { source: 'skipped_heic_no_preview', objectKey: null, contentType: null });
});

Deno.test('selectImageCandidates skips a video with no poster', () => {
  const [candidate] = selectImageCandidates([mediaRow({ contentType: 'video/mp4', objectKey: 'clip.mp4' })]);
  assertEquals(candidate, { source: 'skipped_video_no_poster', objectKey: null, contentType: null });
});

Deno.test('selectImageCandidates treats a video WITH a poster as usable (closes the video-emotion gap)', () => {
  const [candidate] = selectImageCandidates([
    mediaRow({ contentType: 'video/mp4', objectKey: 'clip.mp4', previewObjectKey: 'poster.jpg' }),
  ]);
  assertEquals(candidate, { source: 'preview', objectKey: 'poster.jpg', contentType: 'image/jpeg' });
});

// --- buildRelevantMilestoneCatalog -----------------------------------------------

Deno.test('buildRelevantMilestoneCatalog falls back to any-band-only entries with no tagged members', () => {
  const catalog = buildRelevantMilestoneCatalog([]);
  assertEquals(catalog.every((entry) => entry.ageBandMonths.min === null), true);
  assertEquals(catalog.some((entry) => entry.id === 'birthday'), true);
});

Deno.test('buildRelevantMilestoneCatalog unions in-band entries across tagged members', () => {
  const catalog = buildRelevantMilestoneCatalog([{ ageMonths: 12 }, { ageMonths: 60 }]);
  const ids = catalog.map((entry) => entry.id);
  assertEquals(ids.includes('first-steps'), true); // in-band for the 12-month-old
  assertEquals(ids.includes('bike-training-wheels'), true); // in-band for the 5-year-old (60mo)
  assertEquals(ids.includes('birthday'), true); // any-band, always included
});

// --- computeMilestoneRows ---------------------------------------------------------

Deno.test('computeMilestoneRows: no text means no claim-based milestone even if the model claims one', () => {
  const rows = computeMilestoneRows({
    textPresent: false,
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [{ id: 'a', ageMonths: 12 }],
    taggedMembersForBirthday: [],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, []);
});

Deno.test('computeMilestoneRows: an in-band single tagged member resolves family_member_id, out_of_band false', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [{ id: 'a', ageMonths: 12 }],
    taggedMembersForBirthday: [],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, [{ milestoneId: 'first-steps', detail: null, outOfBand: false, familyMemberId: 'a' }]);
});

Deno.test('computeMilestoneRows: an out-of-band claim is kept, flagged, with no family_member_id', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [{ id: 'a', ageMonths: 60 }], // 5 years old -- well outside first-steps' band
    taggedMembersForBirthday: [],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, [{ milestoneId: 'first-steps', detail: null, outOfBand: true, familyMemberId: null }]);
});

Deno.test('computeMilestoneRows: two members both in-band leaves family_member_id null (ambiguous)', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [{ id: 'a', ageMonths: 12 }, { id: 'b', ageMonths: 10 }],
    taggedMembersForBirthday: [],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows[0].familyMemberId, null);
  assertEquals(rows[0].outOfBand, false);
});

Deno.test('computeMilestoneRows: an unresolved catalog_id produces no row', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'did something', catalogId: null, detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, []);
});

Deno.test('computeMilestoneRows: deterministic birthday fires when topics include birthday and the DOB window matches', () => {
  const rows = computeMilestoneRows({
    textPresent: false,
    milestoneClaim: null,
    topics: [{ id: 'birthday', detail: null }],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Tomás', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-06-16',
  });
  assertEquals(rows, [{ milestoneId: 'birthday', detail: '4', outOfBand: false, familyMemberId: 'a' }]);
});

Deno.test('computeMilestoneRows: deterministic birthday does NOT fire outside the +/-7 day window even with the birthday topic', () => {
  const rows = computeMilestoneRows({
    textPresent: false,
    milestoneClaim: null,
    topics: [{ id: 'birthday', detail: null }],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Tomás', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-07-01',
  });
  assertEquals(rows, []);
});

Deno.test('computeMilestoneRows: deterministic birthday fires from explicit text alone (no birthday topic)', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'turned four today', catalogId: 'birthday', detail: null, evidence: null },
    topics: [],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Tomás', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, [{ milestoneId: 'birthday', detail: '4', outOfBand: false, familyMemberId: 'a' }]);
});

Deno.test('computeMilestoneRows: deterministic birthday overrides a claim-based birthday row with the authoritative age turned', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    // Model paraphrase claims "turned three" but the DOB join says 4 --
    // the deterministic value wins.
    milestoneClaim: { claim: 'turned three', catalogId: 'birthday', detail: 'wrong age from model', evidence: null },
    topics: [],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Tomás', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0], { milestoneId: 'birthday', detail: '4', outOfBand: false, familyMemberId: 'a' });
});

Deno.test('computeMilestoneRows: a newborn-week memory (ageTurned 0) never produces a birthday row', () => {
  const rows = computeMilestoneRows({
    textPresent: false,
    milestoneClaim: null,
    topics: [{ id: 'birthday', detail: null }],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Lucía', dateOfBirth: '2026-06-15' }],
    memoryDate: '2026-06-16',
  });
  assertEquals(rows, []);
});

// --- runMemoryAnalysis (orchestrator, mocked OpenAI, text-only so no R2 dependency) --

Deno.test('runMemoryAnalysis: neither text nor images returns {skipped:true} with no OpenAI call', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  };

  try {
    const result = await runMemoryAnalysis({
      memory: { id: 'm1', content: null, memoryType: 'text_only', memoryDate: '2026-06-15', audioTranscript: null, mediaVariant: null },
      taggedMembers: [],
      media: [],
    });
    assertEquals(result, { skipped: true });
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('runMemoryAnalysis: a text-only memory produces a full analysis with date-gated topics and milestones', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                topics: ['beach', 'halloween'], // halloween is out of season for a June memory -- gated out below
                labels: ['sand', 'sun'],
                description: 'A beach day.',
                emotion: 'joy',
                milestone: {
                  claim: 'first steps',
                  catalog_id: 'first-steps',
                  detail: null,
                  evidence: 'She took her first steps on the beach today',
                },
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const result = await runMemoryAnalysis({
      memory: {
        id: 'm1',
        content: 'She took her first steps on the beach today!',
        memoryType: 'text_only',
        memoryDate: '2026-06-15',
        audioTranscript: null,
        mediaVariant: null,
      },
      taggedMembers: [{ id: 'a', name: 'Tomás', dateOfBirth: '2025-06-15' }], // 12 months old
      media: [],
    });

    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.emotion, 'joy');
    assertEquals(result.topics, [{ id: 'beach', detail: null }]); // halloween date-gated out
    assertEquals(result.labels, ['sand', 'sun']);
    assertEquals(result.description, 'A beach day.');
    assertEquals(result.milestones, [
      { milestoneId: 'first-steps', detail: null, outOfBand: false, familyMemberId: 'a' },
    ]);
    // The mocked response carries no top-level `usage` key -- chatJsonWithVisionMulti
    // reports that as null rather than guessing at zero counts.
    assertEquals(result.usage, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('runMemoryAnalysis: forwards real token usage from the provider response (backfill script cost reporting)', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                topics: [],
                labels: [],
                description: 'x',
                emotion: 'calm',
                milestone: null,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 812, completion_tokens: 97 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const result = await runMemoryAnalysis({
      memory: { id: 'm2', content: 'A quiet afternoon.', memoryType: 'text_only', memoryDate: '2026-06-15', audioTranscript: null, mediaVariant: null },
      taggedMembers: [],
      media: [],
    });

    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.usage, { promptTokens: 812, completionTokens: 97 });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

// --- explicit-evidence gate (owner rule 2026-10-01) -----------------------------------

function claim(catalogId: string, evidence: string | null) {
  return { claim: 'x', catalogId, detail: null, evidence };
}

Deno.test('parseMilestoneClaim reads the verbatim evidence quote (and aliases), trimmed', () => {
  assertEquals(
    parseMilestoneClaim({ claim: 'c', catalog_id: 'first-steps', evidence: '  dio sus primeros pasos ' })?.evidence,
    'dio sus primeros pasos',
  );
  assertEquals(parseMilestoneClaim({ claim: 'c', catalog_id: 'first-steps', quote: 'primeros pasos' })?.evidence, 'primeros pasos');
  assertEquals(parseMilestoneClaim({ claim: 'c', catalog_id: 'first-steps' })?.evidence, null);
});

Deno.test('gateMilestoneClaim drops the owner over-tag cases (haircut, question, balance bike)', () => {
  const cases: Array<[string, string, string]> = [
    ['first-haircut', 'Tomás en la barbería con su corte de pelo nuevo', 'Tomás en la barbería con su corte de pelo nuevo'],
    ['first-question', 'Tomás me preguntó por qué el cielo es azul', 'Tomás me preguntó por qué el cielo es azul'],
    ['balance-bike', 'Tomás riding his balance bike at the park', 'Tomás riding his balance bike at the park'],
  ];
  for (const [id, text, quote] of cases) {
    const gated = gateMilestoneClaim(claim(id, quote), text);
    assertEquals(gated.claim, null, id);
    assertEquals(gated.rejected, 'no_explicit_language', id);
  }
});

Deno.test('gateMilestoneClaim keeps genuinely explicit claims', () => {
  const cases: Array<[string, string, string]> = [
    ['first-haircut', 'Hoy le cortaron el pelo por primera vez. Quedó guapísimo.', 'hoy le cortaron el pelo por primera vez'],
    ['first-steps', 'Mira: dio sus primeros pasos!', 'dio sus primeros pasos'],
    [
      'bike-no-training-wheels',
      'Today Mia learned to ride her bike without training wheels. So proud.',
      'learned to ride her bike without training wheels',
    ],
    ['first-haircut', 'Su primeiro corte de cabelo, que fofo', 'Su primeiro corte de cabelo'],
  ];
  for (const [id, text, quote] of cases) {
    const gated = gateMilestoneClaim(claim(id, quote), text);
    assertEquals(gated.rejected, null, id);
    assertEquals(gated.claim?.catalogId, id);
  }
});

Deno.test('gateMilestoneClaim drops a quote that is not verbatim in the memory text', () => {
  const gated = gateMilestoneClaim(
    claim('first-haircut', 'se cortó el pelo por primera vez'),
    'Fuimos a la peluquería y Tomás se portó muy bien.',
  );
  assertEquals(gated.claim, null);
  assertEquals(gated.rejected, 'quote_not_in_text');
});

Deno.test('gateMilestoneClaim tolerates case, accents, whitespace and punctuation differences in the quote', () => {
  const gated = gateMilestoneClaim(
    claim('first-haircut', '  HOY le cortaron el PELO por primera vez…  '),
    'Hoy le cortaron   el pelo, por primera vez!',
  );
  assertEquals(gated.rejected, null);
});

Deno.test('gateMilestoneClaim drops a claim with no evidence quote at all', () => {
  const gated = gateMilestoneClaim(claim('first-steps', null), 'Dio sus primeros pasos');
  assertEquals(gated.claim, null);
  assertEquals(gated.rejected, 'no_evidence');
});

Deno.test('gateMilestoneClaim: first-time wording about something else does not carry a different milestone', () => {
  const gated = gateMilestoneClaim(
    claim('first-haircut', 'primera vez que come mango'),
    'Primera vez que come mango. Luego fuimos al parque.',
  );
  assertEquals(gated.rejected, 'subject_not_mentioned');
});

Deno.test('gateMilestoneClaim passes a claim with no catalog id through untouched', () => {
  const unresolved = { claim: 'x', catalogId: null, detail: null, evidence: null };
  assertEquals(gateMilestoneClaim(unresolved, 'anything').claim, unresolved);
});

Deno.test('buildMemoryAnalysisSystemPrompt demands a verbatim evidence quote and tags per-entry requirements', () => {
  const prompt = buildMemoryAnalysisSystemPrompt({
    topics: TOPICS,
    milestoneCatalog: MILESTONES.filter((m) => ['first-haircut', 'rolls-over', 'birthday'].includes(m.id)),
  });
  assertEquals(prompt.includes('"evidence": string'), true);
  assertEquals(prompt.includes('character for character'), true);
  assertEquals(prompt.includes('first-haircut — First haircut (3m–4y) [needs explicit first-time wording]'), true);
  assertEquals(prompt.includes('rolls-over — Rolls over (2–8m) [needs explicit first-time or achievement wording]'), true);
  assertEquals(prompt.includes('[needs the event itself stated]'), true);
});

Deno.test('runMemoryAnalysis: a model milestone claim that fails the evidence gate produces no milestone row', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const originalLog = console.log;
  const logged: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                topics: [],
                labels: [],
                description: 'A haircut.',
                emotion: 'joy',
                milestone: {
                  claim: 'first haircut',
                  catalog_id: 'first-haircut',
                  detail: null,
                  evidence: 'Tomás en la barbería con su corte de pelo',
                },
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const result = await runMemoryAnalysis({
      memory: {
        id: 'm3',
        content: 'Tomás en la barbería con su corte de pelo nuevo',
        memoryType: 'text_only',
        memoryDate: '2026-06-15',
        audioTranscript: null,
        mediaVariant: null,
      },
      taggedMembers: [{ id: 'a', name: 'Tomás', dateOfBirth: '2024-06-15' }],
      media: [],
    });
    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.milestones, []);
    // PII rule: the drop log carries ids and a reason code only.
    assertEquals(logged.length, 1);
    assertEquals(logged[0], ['analyze-memory milestone dropped', 'm3', 'first-haircut', 'no_explicit_language']);
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

// --- artwork mode (docs/plans/artwork-scanning.md 1.5) ---------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.test('buildMemoryAnalysisSystemPrompt: the non-artwork prompt is byte-identical to the pre-artwork prompt', async () => {
  // Hash of the prompt as it was before the artwork addendum existed, built
  // with empty topic/milestone inputs so the pin covers only the fixed
  // instruction text (not the evolving vocabulary). If you change the shared
  // instructions on purpose, update this hash in the same change.
  const baseline = buildMemoryAnalysisSystemPrompt({ topics: [], milestoneCatalog: [] });
  assertEquals(baseline.length, 4443);
  assertEquals(await sha256Hex(baseline), '9a714f92f5ae51c04aaad6b03f4d938786907d8fb25f3fb279b4f25fa95b9e72');
  assertEquals(buildMemoryAnalysisSystemPrompt({ topics: [], milestoneCatalog: [], isArtwork: false }), baseline);
  assertEquals(baseline.includes('ARTWORK'), false);
  assertEquals(baseline.includes('medium'), false);
});

Deno.test('buildMemoryAnalysisSystemPrompt: artwork appends the medium field and the depicted-is-not-an-event rule', () => {
  const baseline = buildMemoryAnalysisSystemPrompt({ topics: TOPICS, milestoneCatalog: [] });
  const artwork = buildMemoryAnalysisSystemPrompt({ topics: TOPICS, milestoneCatalog: [], isArtwork: true });
  assertEquals(artwork.startsWith(baseline), true);
  const addendum = artwork.slice(baseline.length);
  assertEquals(addendum.includes("scans of a child's artwork"), true);
  assertEquals(addendum.includes('not where the family was or what it did'), true);
  assertEquals(
    addendum.includes(
      '[crayon, marker, colored pencil, pencil, watercolor, paint, chalk, pastel, collage, mixed media]',
    ),
    true,
  );
  assertEquals(addendum.includes('`mixed media` when pieces differ or materials combine'), true);
});

Deno.test('applyArtworkAnalysisMode forces topics to arts-crafts, lowercases + prefixes labels, prefixes the description', () => {
  const output = applyArtworkAnalysisMode({
    topics: [
      { id: 'beach', detail: null },
      { id: 'travel', detail: null },
      { id: 'arts-crafts', detail: 'sunny day' },
    ],
    labels: ['Disney Castle', 'Paris', 'Sun', 'sun'],
    description: 'a castle with a flag',
    artworkMedium: 'crayon',
  });
  assertEquals(output.topics, [{ id: 'arts-crafts', detail: 'sunny day' }]);
  assertEquals(output.labels, ['artwork', 'crayon', 'disney castle', 'paris', 'sun']);
  assertEquals(output.description, "a child's crayon drawing of a castle with a flag");
});

Deno.test('applyArtworkAnalysisMode without a medium falls back to the plain artwork prefixes and caps labels', () => {
  const output = applyArtworkAnalysisMode({
    topics: [{ id: 'camping', detail: null }],
    labels: Array.from({ length: 10 }, (_, index) => `Label${index}`),
    description: '',
    artworkMedium: null,
  });
  assertEquals(output.topics, [{ id: 'arts-crafts', detail: null }]);
  assertEquals(output.labels.length, 10);
  assertEquals(output.labels.slice(0, 2), ['artwork', 'label0']);
  assertEquals(output.description, "a child's artwork drawing");
});

function mockAnalysisFetch(modelOutput: Record<string, unknown>, captured: { body: string }) {
  return async (_input: unknown, init?: RequestInit) => {
    captured.body = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelOutput) } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

Deno.test('runMemoryAnalysis: an artwork media memory gets the artwork prompt, forced topics, lowercased labels and the medium', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const captured = { body: '' };
  globalThis.fetch = mockAnalysisFetch(
    {
      topics: ['travel', 'beach'],
      labels: ['Disney Castle', 'Paris'],
      description: 'a castle by the sea',
      emotion: 'joy',
      medium: 'Crayons',
      milestone: null,
    },
    captured,
  ) as typeof fetch;

  try {
    const result = await runMemoryAnalysis({
      memory: {
        id: 'art1',
        content: 'Her castle',
        memoryType: 'media',
        memoryDate: '2026-06-15',
        audioTranscript: null,
        mediaVariant: 'artwork',
      },
      taggedMembers: [],
      media: [],
    });

    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.topics, [{ id: 'arts-crafts', detail: null }]);
    assertEquals(result.topicDetails, {});
    assertEquals(result.labels, ['artwork', 'crayon', 'disney castle', 'paris']);
    assertEquals(result.description, "a child's crayon drawing of a castle by the sea");
    assertEquals(result.artworkMedium, 'crayon');
    assertEquals(result.emotion, 'joy');
    assertEquals(captured.body.includes('scans of a child'), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('runMemoryAnalysis: an artwork memory with an unparseable medium returns artworkMedium null and the plain artwork prefix', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = mockAnalysisFetch(
    { topics: [], labels: ['House'], description: 'a house', emotion: 'calm', medium: 'oil on canvas', milestone: null },
    { body: '' },
  ) as typeof fetch;

  try {
    const result = await runMemoryAnalysis({
      memory: { id: 'art2', content: 'House', memoryType: 'media', memoryDate: '2026-06-15', audioTranscript: null, mediaVariant: 'artwork' },
      taggedMembers: [],
      media: [],
    });
    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.artworkMedium, null);
    assertEquals(result.labels, ['artwork', 'house']);
    assertEquals(result.description, "a child's artwork drawing of a house");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('runMemoryAnalysis: artwork mode leaves caption-stated milestones alone', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  globalThis.fetch = mockAnalysisFetch(
    {
      topics: [],
      labels: [],
      description: 'a stick figure',
      emotion: 'joy',
      medium: 'marker',
      milestone: {
        claim: 'first steps',
        catalog_id: 'first-steps',
        detail: null,
        evidence: 'took her first steps',
      },
    },
    { body: '' },
  ) as typeof fetch;

  try {
    const result = await runMemoryAnalysis({
      memory: {
        id: 'art3',
        content: 'She took her first steps and then drew this',
        memoryType: 'media',
        memoryDate: '2026-06-15',
        audioTranscript: null,
        mediaVariant: 'artwork',
      },
      taggedMembers: [{ id: 'a', name: 'Tomás', dateOfBirth: '2025-06-15' }],
      media: [],
    });
    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.milestones.map((milestone) => milestone.milestoneId), ['first-steps']);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('runMemoryAnalysis: a regular media memory ignores a hallucinated medium and keeps the standard prompt and topics', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const captured = { body: '' };
  globalThis.fetch = mockAnalysisFetch(
    { topics: ['beach'], labels: ['Sand'], description: 'A beach.', emotion: 'joy', medium: 'crayon', milestone: null },
    captured,
  ) as typeof fetch;

  try {
    const result = await runMemoryAnalysis({
      memory: { id: 'm9', content: 'Beach day', memoryType: 'media', memoryDate: '2026-06-15', audioTranscript: null, mediaVariant: null },
      taggedMembers: [],
      media: [],
    });
    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.artworkMedium, null);
    assertEquals(result.topics, [{ id: 'beach', detail: null }]);
    assertEquals(result.labels, ['Sand']);
    assertEquals(result.description, 'A beach.');
    assertEquals(captured.body.includes('scans of a child'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});

Deno.test('runMemoryAnalysis: media_variant artwork on a non-media type does not enter artwork mode', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = Deno.env.get('OPENAI_API_KEY');
  Deno.env.set('OPENAI_API_KEY', 'test-key');
  const captured = { body: '' };
  globalThis.fetch = mockAnalysisFetch(
    { topics: ['beach'], labels: ['Sand'], description: 'A beach.', emotion: 'joy', medium: 'crayon', milestone: null },
    captured,
  ) as typeof fetch;

  try {
    const result = await runMemoryAnalysis({
      memory: { id: 'm10', content: 'Beach day', memoryType: 'text_only', memoryDate: '2026-06-15', audioTranscript: null, mediaVariant: 'artwork' },
      taggedMembers: [],
      media: [],
    });
    if (result.skipped) throw new Error('expected a completed analysis');
    assertEquals(result.artworkMedium, null);
    assertEquals(result.topics, [{ id: 'beach', detail: null }]);
    assertEquals(captured.body.includes('scans of a child'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) Deno.env.delete('OPENAI_API_KEY');
    else Deno.env.set('OPENAI_API_KEY', originalKey);
  }
});
