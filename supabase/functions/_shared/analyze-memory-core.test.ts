import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildAnalysisInput,
  buildRelevantMilestoneCatalog,
  computeMilestoneRows,
  parseMemoryAnalysisModelOutput,
  parseMilestoneClaim,
  parseTopics,
  runMemoryAnalysis,
  selectImageCandidates,
  type MediaAssetForAnalysis,
} from './analyze-memory-core.ts';

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
  assertEquals(result, { claim: 'took her first steps', catalogId: 'first-steps', detail: null });
});

Deno.test('parseMilestoneClaim nulls an unrecognized catalog_id but keeps the claim', () => {
  const result = parseMilestoneClaim({ claim: 'turned three', catalog_id: 'not-a-real-id', detail: null });
  assertEquals(result, { claim: 'turned three', catalogId: null, detail: null });
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
    milestone: { claim: 'first steps', catalog_id: 'first-steps', detail: null },
  });

  assertEquals(output.topics, [{ id: 'beach', detail: null }]);
  assertEquals(output.labels, ['sand', 'sun', 'towel']);
  assertEquals(output.description, 'A day at the beach.');
  assertEquals(output.emotion, 'joy');
  assertEquals(output.milestoneClaim, { claim: 'first steps', catalogId: 'first-steps', detail: null });
});

Deno.test('parseMemoryAnalysisModelOutput normalizes an unknown emotion to the tender fallback', () => {
  const output = parseMemoryAnalysisModelOutput({ emotion: 'not-a-real-emotion' });
  assertEquals(output.emotion, 'tender');
});

Deno.test('parseMemoryAnalysisModelOutput handles a completely malformed raw payload', () => {
  const output = parseMemoryAnalysisModelOutput('not an object');
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
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null },
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
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null },
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
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null },
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
    milestoneClaim: { claim: 'first steps', catalogId: 'first-steps', detail: null },
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
    milestoneClaim: { claim: 'did something', catalogId: null, detail: null },
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
    taggedMembersForBirthday: [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
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
    taggedMembersForBirthday: [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-07-01',
  });
  assertEquals(rows, []);
});

Deno.test('computeMilestoneRows: deterministic birthday fires from explicit text alone (no birthday topic)', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    milestoneClaim: { claim: 'turned four today', catalogId: 'birthday', detail: null },
    topics: [],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
    memoryDate: '2026-06-15',
  });
  assertEquals(rows, [{ milestoneId: 'birthday', detail: '4', outOfBand: false, familyMemberId: 'a' }]);
});

Deno.test('computeMilestoneRows: deterministic birthday overrides a claim-based birthday row with the authoritative age turned', () => {
  const rows = computeMilestoneRows({
    textPresent: true,
    // Model paraphrase claims "turned three" but the DOB join says 4 --
    // the deterministic value wins.
    milestoneClaim: { claim: 'turned three', catalogId: 'birthday', detail: 'wrong age from model' },
    topics: [],
    taggedMembersWithAge: [],
    taggedMembersForBirthday: [{ id: 'a', name: 'Enzo', dateOfBirth: '2022-06-15' }],
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
    taggedMembersForBirthday: [{ id: 'a', name: 'Mara', dateOfBirth: '2026-06-15' }],
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
      memory: { id: 'm1', content: null, memoryType: 'text_only', memoryDate: '2026-06-15', audioTranscript: null },
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
                milestone: { claim: 'first steps', catalog_id: 'first-steps', detail: null },
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
      },
      taggedMembers: [{ id: 'a', name: 'Enzo', dateOfBirth: '2025-06-15' }], // 12 months old
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
      memory: { id: 'm2', content: 'A quiet afternoon.', memoryType: 'text_only', memoryDate: '2026-06-15', audioTranscript: null },
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
