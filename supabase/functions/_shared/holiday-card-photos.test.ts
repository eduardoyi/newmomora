import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  buildFrontJudgeRequestBody,
  buildFrontJudgeSystemPrompt,
  coreFamilyMemberIds,
  type FrontCandidate,
  type FrontPhotoInput,
  type FrontVerdict,
  frontPoolStart,
  frontPrintFit,
  FULL_BLEED_PX,
  parseFrontJudgeResponse,
  printClassForCard,
  rankFrontPicks,
  readChatUsage,
  selectFrontCandidates,
} from './holiday-card-photos.ts';

const TODAY = '2026-10-04';
const CORE = new Set(['dad', 'mom', 'kid1', 'kid2']);

function photo(over: Partial<FrontPhotoInput> & { memoryId: string }): FrontPhotoInput {
  return {
    mediaId: `media-${over.memoryId}`,
    date: '2026-06-01',
    taggedMemberIds: ['dad', 'kid1'],
    emotion: 'joy',
    topics: [],
    reported: false,
    dims: { width: 4032, height: 3024 },
    ...over,
  };
}

const OPTIONS = { today: TODAY, excludedMemoryIds: new Set<string>(), coreMemberIds: CORE };

Deno.test('full-bleed pixels follow Gelato 5R trim plus 4 mm bleed at 300 dpi', () => {
  assertEquals(FULL_BLEED_PX, { long: 2194, short: 1594 });
});

Deno.test('print class is evaluated against the card in the photo\'s own orientation', () => {
  // A 3024x4032 portrait photo is full-bleed on a portrait card...
  assertEquals(printClassForCard({ width: 3024, height: 4032 }, 'portrait'), 'full-bleed');
  // ...but a landscape crop of a portrait photo throws most of it away.
  assertEquals(printClassForCard({ width: 3024, height: 4032 }, 'landscape'), 'full-bleed');
  assertEquals(printClassForCard({ width: 1200, height: 1800 }, 'landscape'), 'low');
  assertEquals(printClassForCard({ width: 1200, height: 1800 }, 'portrait'), 'bordered');
  assertEquals(frontPrintFit({ width: 3024, height: 4032 }), {
    orientation: 'portrait',
    cardOrientation: 'portrait',
    printClass: 'full-bleed',
  });
  assertEquals(frontPrintFit({ width: 4032, height: 3024 }).cardOrientation, 'landscape');
});

Deno.test('print class thresholds: full-bleed, bordered, low', () => {
  assertEquals(frontPrintFit({ width: 2200, height: 1600 }).printClass, 'full-bleed');
  // 1500 px wide landscape = 68% of the card width.
  assertEquals(frontPrintFit({ width: 1500, height: 1100 }).printClass, 'bordered');
  assertEquals(frontPrintFit({ width: 1000, height: 750 }).printClass, 'low');
  // Portrait mirror of the same sizes.
  assertEquals(frontPrintFit({ width: 1600, height: 2200 }).printClass, 'full-bleed');
  assertEquals(frontPrintFit({ width: 1100, height: 1500 }).printClass, 'bordered');
  assertEquals(frontPrintFit({ width: 750, height: 1000 }).printClass, 'low');
});

Deno.test('square photos take whichever card orientation prints better', () => {
  const fit = frontPrintFit({ width: 2400, height: 2400 });
  assertEquals(fit.orientation, 'square');
  assertEquals(fit.printClass, 'full-bleed');
  assertEquals(fit.cardOrientation, 'landscape'); // tie goes to landscape
  assertEquals(frontPrintFit({ width: 1700, height: 1800 }).orientation, 'square');
});

Deno.test('photo pool window starts Dec 1 of the previous year', () => {
  assertEquals(frontPoolStart('2026-10-04'), '2025-12-01');
  const selection = selectFrontCandidates(
    [
      photo({ memoryId: 'a', date: '2025-11-30' }),
      photo({ memoryId: 'b', date: '2025-12-01' }),
      photo({ memoryId: 'c', date: '2026-10-05' }),
      photo({ memoryId: 'd', date: '2026-10-04' }),
    ],
    OPTIONS,
  );
  assertEquals(selection.candidates.map((c) => c.memoryId).sort(), ['b', 'd']);
  assertEquals(selection.dropped['outside-window'], 2);
});

Deno.test('selection drops untagged-enough, sensitive, reported, low-mood, unreadable and low-print photos', () => {
  const selection = selectFrontCandidates(
    [
      photo({ memoryId: 'ok' }),
      photo({ memoryId: 'solo', taggedMemberIds: ['dad'] }),
      photo({ memoryId: 'sensitive' }),
      photo({ memoryId: 'reported', reported: true }),
      photo({ memoryId: 'sad', emotion: 'sad' }),
      photo({ memoryId: 'worried', emotion: 'worry' }),
      photo({ memoryId: 'weary', emotion: 'Weary' }),
      photo({ memoryId: 'nosize', dims: null }),
      photo({ memoryId: 'tiny', dims: { width: 900, height: 600 } }),
    ],
    { ...OPTIONS, excludedMemoryIds: new Set(['sensitive']) },
  );
  assertEquals(selection.candidates.map((c) => c.memoryId), ['ok']);
  assertEquals(selection.dropped, {
    'too-few-tagged': 1,
    'share-sensitive': 1,
    reported: 1,
    'low-mood': 3,
    'unreadable-size': 1,
    'low-print': 1,
  });
  assertEquals(selection.eligible, 1);
});

Deno.test('whole core family and full-bleed outrank partial and bordered photos', () => {
  const selection = selectFrontCandidates(
    [
      photo({ memoryId: 'pair', taggedMemberIds: ['dad', 'mom'] }),
      photo({ memoryId: 'whole-bordered', taggedMemberIds: ['dad', 'mom', 'kid1', 'kid2'], dims: { width: 1500, height: 1100 } }),
      photo({ memoryId: 'whole', taggedMemberIds: ['dad', 'mom', 'kid1', 'kid2'] }),
    ],
    OPTIONS,
  );
  assertEquals(selection.candidates.map((c) => c.memoryId), ['whole', 'whole-bordered', 'pair']);
  const whole = selection.candidates[0];
  assert(whole.wholeCore);
  assertEquals(whole.coreCovered.sort(), ['dad', 'kid1', 'kid2', 'mom']);
  assertEquals(whole.printClass, 'full-bleed');
});

Deno.test('holiday topics boost the pre-score; selection is deterministic', () => {
  const photos = [
    photo({ memoryId: 'plain' }),
    photo({ memoryId: 'xmas', topics: ['christmas'], date: '2025-12-25' }),
    photo({ memoryId: 'halloween', topics: ['halloween'] }),
  ];
  const first = selectFrontCandidates(photos, OPTIONS);
  const second = selectFrontCandidates([...photos].reverse(), OPTIONS);
  assertEquals(first.candidates, second.candidates);
  assertEquals(first.candidates[0].memoryId, 'xmas');
  assert(first.candidates[0].holiday);
  assertEquals(first.candidates.find((c) => c.memoryId === 'halloween')?.holiday, false);
});

Deno.test('cap, at most 3 photos per memory, and spread across dates', () => {
  const photos: FrontPhotoInput[] = [];
  // One memory with 5 photos, all whole core family.
  for (let i = 0; i < 5; i += 1) {
    photos.push(photo({ memoryId: 'burst', mediaId: `burst-${i}`, taggedMemberIds: ['dad', 'mom', 'kid1', 'kid2'], date: '2026-05-01' }));
  }
  // Four memories on one date, then single memories on other dates.
  for (let i = 0; i < 4; i += 1) photos.push(photo({ memoryId: `same-day-${i}`, taggedMemberIds: ['dad', 'mom', 'kid1'], date: '2026-05-02' }));
  for (let i = 0; i < 4; i += 1) photos.push(photo({ memoryId: `later-${i}`, date: `2026-06-0${i + 1}` }));

  const capped = selectFrontCandidates(photos, { ...OPTIONS, maxCandidates: 6 });
  assertEquals(capped.candidates.length, 6);
  assertEquals(capped.candidates.filter((c) => c.memoryId === 'burst').length, 2); // per-date soft cap, first pass
  const perDate = new Map<string, number>();
  for (const c of capped.candidates) perDate.set(c.date, (perDate.get(c.date) ?? 0) + 1);
  assert([...perDate.values()].every((n) => n <= 2));

  const all = selectFrontCandidates(photos, { ...OPTIONS, maxCandidates: 30 });
  assertEquals(all.candidates.filter((c) => c.memoryId === 'burst').length, 3); // memory cap
  assertEquals(all.candidates.length, 11);
});

Deno.test('core family = own children + parents', () => {
  const ids = coreFamilyMemberIds(
    [
      { id: 'dad', dateOfBirth: '1985-01-01', relationship: 'parent' },
      { id: 'mom', dateOfBirth: null, relationship: 'parent' },
      { id: 'kid', dateOfBirth: '2022-03-01', relationship: null },
      { id: 'teen', dateOfBirth: '2008-03-01', relationship: null },
      { id: 'nana', dateOfBirth: '1955-03-01', relationship: 'grandparent' },
      { id: 'cousin', dateOfBirth: '2021-03-01', relationship: 'cousin' },
    ],
    TODAY,
  );
  assertEquals([...ids].sort(), ['dad', 'kid', 'mom']);
});

Deno.test('judge request: high-detail images labeled by index, json_object, no ids or names', () => {
  const body = buildFrontJudgeRequestBody('some-model', [
    { id: 'secret-media-id-1', image: { base64: 'AAAA', contentType: 'image/jpeg' }, orientation: 'portrait', expectedPeople: 4 },
    { id: 'secret-media-id-2', image: { url: 'https://example.test/x.jpg' }, orientation: 'landscape', expectedPeople: 2 },
  ]) as { model: string; response_format: unknown; messages: { role: string; content: unknown }[] };
  assertEquals(body.model, 'some-model');
  assertEquals(body.response_format, { type: 'json_object' });
  const text = JSON.stringify(body);
  assert(!text.includes('secret-media-id'));
  assertStringIncludes(text, 'Index 0 (portrait photo; expected people: 4)');
  assertStringIncludes(text, 'data:image/jpeg;base64,AAAA');
  assertStringIncludes(text, 'https://example.test/x.jpg');
  const user = body.messages[1].content as { type: string; image_url?: { detail: string } }[];
  const images = user.filter((part) => part.type === 'image_url');
  assertEquals(images.length, 2);
  assert(images.every((part) => part.image_url?.detail === 'high'));
});

Deno.test('judge system prompt forbids identifying people', () => {
  const prompt = buildFrontJudgeSystemPrompt();
  assertStringIncludes(prompt, 'never identify or name anyone');
  assertStringIncludes(prompt, '5:7');
});

const GOOD_ENTRY = {
  index: 0,
  people_visible: 4,
  all_faces_visible: true,
  eyes_open_mostly: true,
  looking_at_camera: 'most',
  light: 'good',
  sharp: true,
  setting: 'Living Room',
  unsafe: false,
  screenshot_or_document: false,
  crop_risk: false,
  card_score: 8.4,
  why: 'Everyone together, warm light, calm background.',
};

Deno.test('parseFrontJudgeResponse validates every field and maps indices to ids', () => {
  const verdicts = parseFrontJudgeResponse(JSON.stringify({ photos: [GOOD_ENTRY, { ...GOOD_ENTRY, index: 1, card_score: 14, people_visible: 3.6 }] }), ['m0', 'm1']);
  assertEquals(verdicts.get('m0'), {
    peopleVisible: 4,
    allFacesVisible: true,
    eyesOpenMostly: true,
    lookingAtCamera: 'most',
    light: 'good',
    sharp: true,
    setting: 'living room',
    unsafe: false,
    screenshotOrDocument: false,
    cropRisk: false,
    cardScore: 8.4,
    why: 'Everyone together, warm light, calm background.',
  });
  assertEquals(verdicts.get('m1')?.cardScore, 10); // clamped
  assertEquals(verdicts.get('m1')?.peopleVisible, 4); // rounded
});

Deno.test('parseFrontJudgeResponse drops malformed, duplicate and unknown entries and never throws', () => {
  const raw = JSON.stringify({
    photos: [
      GOOD_ENTRY,
      { ...GOOD_ENTRY, index: 0, card_score: 1 }, // duplicate index
      { ...GOOD_ENTRY, index: 7 }, // unknown index
      { ...GOOD_ENTRY, index: 1, sharp: 'yes' }, // bad type
      { ...GOOD_ENTRY, index: 2, light: 'dim' }, // bad enum
      { ...GOOD_ENTRY, index: 3, looking_at_camera: 'all' }, // bad enum
      { ...GOOD_ENTRY, index: 4, card_score: 'high' }, // bad number
      { ...GOOD_ENTRY, index: 5, why: '   ' }, // empty why
      { ...GOOD_ENTRY, index: -1 },
      null,
      'string',
    ],
  });
  const verdicts = parseFrontJudgeResponse(raw, ['a', 'b', 'c', 'd', 'e', 'f']);
  assertEquals([...verdicts.keys()], ['a']);
  assertEquals(verdicts.get('a')?.cardScore, 8.4); // the first entry wins
  assertEquals(parseFrontJudgeResponse('not json', ['a']).size, 0);
  assertEquals(parseFrontJudgeResponse('{"photos":"nope"}', ['a']).size, 0);
  assertEquals(parseFrontJudgeResponse(null, ['a']).size, 0);
  assertEquals(parseFrontJudgeResponse({ photos: [GOOD_ENTRY] }, ['a']).size, 1); // already-parsed objects work
});

Deno.test('parseFrontJudgeResponse caps why at 15 words', () => {
  const why = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
  const verdict = parseFrontJudgeResponse({ photos: [{ ...GOOD_ENTRY, why }] }, ['a']).get('a');
  assertEquals(verdict?.why.split(' ').length, 15);
});

Deno.test('readChatUsage reads token counts or returns null', () => {
  assertEquals(readChatUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }), { promptTokens: 100, completionTokens: 20 });
  assertEquals(readChatUsage({ prompt_tokens: '100' }), null);
  assertEquals(readChatUsage(undefined), null);
});

function candidate(over: Partial<FrontCandidate> & { mediaId: string }): FrontCandidate {
  return {
    memoryId: `mem-${over.mediaId}`,
    date: '2026-06-01',
    taggedMemberIds: ['dad', 'kid1'],
    coreCovered: ['dad', 'kid1'],
    wholeCore: false,
    orientation: 'landscape',
    cardOrientation: 'landscape',
    width: 4032,
    height: 3024,
    printClass: 'full-bleed',
    holiday: false,
    preScore: 0,
    ...over,
  };
}

function verdict(over: Partial<FrontVerdict> = {}): FrontVerdict {
  return {
    peopleVisible: 2,
    allFacesVisible: false,
    eyesOpenMostly: false,
    lookingAtCamera: 'none',
    light: 'ok',
    sharp: true,
    setting: 'park',
    unsafe: false,
    screenshotOrDocument: false,
    cropRisk: false,
    cardScore: 7,
    why: 'fine',
    ...over,
  };
}

Deno.test('ranking applies hard filters and reports near-misses with reasons', () => {
  const candidates = [
    candidate({ mediaId: 'good' }),
    candidate({ mediaId: 'unsafe' }),
    candidate({ mediaId: 'shot' }),
    candidate({ mediaId: 'blurry' }),
    candidate({ mediaId: 'dark' }),
    candidate({ mediaId: 'blurry-weak' }),
    candidate({ mediaId: 'unjudged' }),
  ];
  const verdicts = new Map<string, FrontVerdict>([
    ['good', verdict({ cardScore: 8 })],
    ['unsafe', verdict({ unsafe: true, cardScore: 9 })],
    ['shot', verdict({ screenshotOrDocument: true, cardScore: 7 })],
    ['blurry', verdict({ sharp: false, cardScore: 8 })],
    ['dark', verdict({ light: 'poor', cardScore: 6 })],
    ['blurry-weak', verdict({ sharp: false, cardScore: 3 })],
  ]);
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY });
  assertEquals(ranking.picks.map((p) => p.candidate.mediaId), ['good']);
  assertEquals(ranking.unjudged, 1);
  assertEquals(
    ranking.nearMisses.map((n) => [n.candidate.mediaId, n.reason]),
    [['blurry', 'not-sharp'], ['shot', 'screenshot-or-document'], ['dark', 'poor-light']],
  );
  // Unsafe never becomes a near-miss; weak hard-drops are only counted.
  assertEquals(ranking.dropped, { unsafe: 1, 'not-sharp': 1 });
});

Deno.test('ranking: bonuses for whole core family, faces, full-bleed, holiday, recency; crop risk costs', () => {
  const candidates = [
    candidate({ mediaId: 'plain', printClass: 'bordered' }),
    candidate({ mediaId: 'whole', wholeCore: true, coreCovered: ['dad', 'mom', 'kid1', 'kid2'], printClass: 'bordered' }),
    candidate({ mediaId: 'xmas', holiday: true, printClass: 'bordered' }),
    candidate({ mediaId: 'risky', wholeCore: true, printClass: 'bordered' }),
    candidate({ mediaId: 'recent', date: '2026-10-04', printClass: 'bordered' }),
  ];
  const verdicts = new Map<string, FrontVerdict>(candidates.map((c) => [c.mediaId, verdict({ cardScore: 7 })]));
  verdicts.set('risky', verdict({ cardScore: 7, cropRisk: true }));
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY });
  // 7 + 2 + .3 | 7 + 1 + .3 | 7 + 2 - 1.5 + .3 | 7 + .5 | 7 + .3
  assertEquals(ranking.picks.map((p) => p.candidate.mediaId), ['whole', 'xmas', 'risky', 'recent', 'plain']);
  assert(ranking.picks.find((p) => p.candidate.mediaId === 'risky')?.notes.includes('crop risk (-1.5)'));
});

Deno.test('ranking: a better card score can beat the bonuses; full-bleed adds a point', () => {
  const candidates = [
    candidate({ mediaId: 'ten', printClass: 'bordered' }),
    candidate({ mediaId: 'whole-eight', wholeCore: true, printClass: 'full-bleed' }),
  ];
  const verdicts = new Map<string, FrontVerdict>([
    ['ten', verdict({ cardScore: 10 })],
    ['whole-eight', verdict({ cardScore: 8, allFacesVisible: true })],
  ]);
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY });
  // 8 + 2 (whole core) + 1 (faces) + 1 (full-bleed) = 12 vs 10.
  assertEquals(ranking.picks[0].candidate.mediaId, 'whole-eight');
  assert(ranking.picks[0].notes.includes('whole core family tagged and visible (+2)'));
  assert(ranking.picks[0].notes.includes('full-bleed print (+1)'));
});

Deno.test('ranking keeps at most 2 photos per memory; the rest are near-misses', () => {
  const candidates = [1, 2, 3].map((i) => candidate({ mediaId: `burst-${i}`, memoryId: 'same-moment' }));
  const verdicts = new Map<string, FrontVerdict>(candidates.map((c, i) => [c.mediaId, verdict({ cardScore: 9 - i })]));
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY });
  assertEquals(ranking.picks.length, 2);
  assertEquals(ranking.nearMisses.map((n) => [n.candidate.mediaId, n.reason]), [['burst-3', 'same-moment-as-a-higher-pick']]);
});

Deno.test('ranking: tags only count when the photo shows the family; one person and crowds cost', () => {
  const candidates = [
    candidate({ mediaId: 'family', wholeCore: true, printClass: 'bordered' }),
    candidate({ mediaId: 'solo-from-family-memory', wholeCore: true, printClass: 'bordered' }),
    candidate({ mediaId: 'crowd', wholeCore: true, printClass: 'bordered' }),
    candidate({ mediaId: 'two-kids', printClass: 'bordered' }),
  ];
  const verdicts = new Map<string, FrontVerdict>([
    ['family', verdict({ peopleVisible: 4 })],
    ['solo-from-family-memory', verdict({ peopleVisible: 1 })],
    ['crowd', verdict({ peopleVisible: 15 })],
    ['two-kids', verdict({ peopleVisible: 2 })],
  ]);
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY, expectedPeople: 4 });
  // 7 + 2 | 7 + 2 - 2 | 7 | 7 - 3 (no tag bonus: fewer people than the family)
  assertEquals(ranking.picks.map((p) => p.candidate.mediaId), ['family', 'crowd', 'two-kids', 'solo-from-family-memory']);
  assert(ranking.picks.find((p) => p.candidate.mediaId === 'solo-from-family-memory')?.notes.includes('only one person in this photo (-3)'));
});

Deno.test('ranking: a photo tagged with someone outside the core family drops below core-only photos', () => {
  const candidates = [
    candidate({ mediaId: 'kids-and-uncle', taggedMemberIds: ['kid1', 'kid2', 'uncle'], coreCovered: ['kid1', 'kid2'], printClass: 'bordered' }),
    candidate({ mediaId: 'kids', taggedMemberIds: ['kid1', 'kid2'], coreCovered: ['kid1', 'kid2'], printClass: 'bordered' }),
  ];
  const verdicts = new Map<string, FrontVerdict>([
    ['kids-and-uncle', verdict({ peopleVisible: 3, cardScore: 9 })],
    ['kids', verdict({ peopleVisible: 2, cardScore: 7 })],
  ]);
  const ranking = rankFrontPicks(candidates, verdicts, { today: TODAY, expectedPeople: 4 });
  assertEquals(ranking.picks.map((p) => p.candidate.mediaId), ['kids', 'kids-and-uncle']);
  assert(ranking.picks[1].notes.includes('someone outside the core family is tagged (-4)'));
});
