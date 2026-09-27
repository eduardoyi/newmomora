import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { PortraitVersionCandidate } from './portrait-versions.ts';
import {
  buildBirthdayScript,
  buildMonthlyScript,
  birthdayCelebration,
  checkKey,
  distinctiveThemes,
  type FilmMemorySource,
  type FilmPerson,
  type FilmScene,
  type FilmScript,
  firstNamedChild,
  type FrameChecks,
  isCertainFirst,
  shareSensitiveIds,
} from './year-film-script.ts';
import type { FrameCheck } from './year-film-vision.ts';
import { birthdayFilmScope } from './year-film-eligibility.ts';

const ENZO = 'enzo';
const MARA = 'mara';
const GRAN = 'gran';
const SCOPE = { start: '2025-10-23', endExclusive: '2026-10-23' };

function portrait(id: string, memberId: string, referenceDate: string | null): PortraitVersionCandidate {
  return {
    id,
    family_member_id: memberId,
    reference_date: referenceDate,
    profile_picture_key: `${id}.jpg`,
    illustrated_profile_key: `${id}-ill.png`,
    illustrated_profile_status: 'ready',
    created_at: '2024-01-01T00:00:00Z',
  };
}

function person(id: string, dob: string | null, createdAt: string, portraits: PortraitVersionCandidate[] = []): FilmPerson {
  return { id, name: `${id[0].toUpperCase()}${id.slice(1)} Lastname`, dateOfBirth: dob, createdAt, portraits };
}

const enzo = person(ENZO, '2022-10-23', '2024-01-02', [portrait('p-old', ENZO, '2025-06-01'), portrait('p-new', ENZO, '2026-07-01')]);
const mara = person(MARA, '2024-11-08', '2024-11-10', [portrait('pm', MARA, '2026-03-01')]);
const gran = person(GRAN, '1955-01-01', '2024-01-01', [portrait('pg', GRAN, null)]);

let counter = 0;
function memory(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  counter += 1;
  const id = overrides.id ?? `m${String(counter).padStart(3, '0')}`;
  return {
    id,
    date: '2026-01-15',
    type: 'media',
    text: null,
    emotion: 'joy',
    topics: [],
    taggedMemberIds: [ENZO],
    illustrationReady: false,
    illustrationKey: null,
    media: [{ kind: 'image', durationMs: null, hasPreview: true }],
    assets: [{ kind: 'image', key: `${id}.jpg`, previewKey: `${id}-p.jpg`, durationMs: null, aspectRatio: 0.75 }],
    reported: false,
    ...overrides,
  };
}

function video(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  const id = overrides.id ?? `v${++counter}`;
  return memory({
    id,
    media: [{ kind: 'video', durationMs: 9000, hasPreview: true }],
    assets: [{ kind: 'video', key: `${id}.mp4`, previewKey: `${id}-poster.jpg`, durationMs: 9000, aspectRatio: 0.56 }],
    ...overrides,
  });
}

function drawing(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  const id = overrides.id ?? `d${++counter}`;
  return memory({
    id,
    type: 'text_illustration',
    text: 'A long caption about something lovely that happened today',
    illustrationReady: true,
    illustrationKey: `${id}.png`,
    media: [],
    assets: [],
    ...overrides,
  });
}

function scene<T extends FilmScene['type']>(script: FilmScript, type: T): Extract<FilmScene, { type: T }> | undefined {
  return script.scenes.find((s) => s.type === type) as Extract<FilmScene, { type: T }> | undefined;
}

function scenes<T extends FilmScene['type']>(script: FilmScript, type: T): Extract<FilmScene, { type: T }>[] {
  return script.scenes.filter((s) => s.type === type) as Extract<FilmScene, { type: T }>[];
}

const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];

/** A year with every media kind in every month; drawings are the most
 * captioned, so the old kind-agnostic scoring would have favored them. */
function yearOfMemories(): FilmMemorySource[] {
  const out: FilmMemorySource[] = [];
  MONTHS.forEach((month, i) => {
    out.push(memory({ date: `${month}-05`, topics: ['park-playground'], taggedMemberIds: [ENZO, GRAN] }));
    out.push(memory({ date: `${month}-12`, emotion: i % 2 ? 'funny' : 'wonder', topics: ['beach'] }));
    out.push(video({ date: `${month}-20`, text: 'Enzo cantando en el carro, muy feliz con su hermana', taggedMemberIds: [ENZO, MARA] }));
    out.push(drawing({ date: `${month}-08` }));
    out.push(drawing({ date: `${month}-16` }));
    out.push(drawing({ date: `${month}-24` }));
  });
  return out;
}

function birthday(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildBirthdayScript>[0]> = {}) {
  return buildBirthdayScript({
    child: enzo,
    ageYear: 4,
    scope: SCOPE,
    memories,
    members: [gran, enzo, mara],
    ownChildIds: [ENZO, MARA],
    milestones: [],
    quotes: [],
    language: 'en',
    ...extra,
  });
}

function check(overrides: Partial<FrameCheck>): FrameCheck {
  return {
    mainSubject: ENZO,
    childrenVisible: [ENZO],
    faceVisible: true,
    expression: 'neutral',
    quality: 'good',
    unsafe: false,
    screenCapture: false,
    ...overrides,
  };
}

Deno.test('shareSensitiveIds: topics, milestones and es/en text, without false positives', () => {
  const ms = [
    memory({ id: 'bath', topics: ['bath'] }),
    memory({ id: 'potty-ms' }),
    memory({ id: 'es', text: 'Enzo hizo pipí en la poceta' }),
    memory({ id: 'en', text: 'First time on the potty!' }),
    memory({ id: 'ok1', text: 'We had a pipeline of peeking peekaboo games' }),
    memory({ id: 'ok2', text: 'Pipa and Pepe came over' }),
  ];
  const ids = shareSensitiveIds(ms, [{ memoryId: 'potty-ms', familyMemberId: ENZO, milestoneId: 'potty-trained', status: 'candidate' }]);
  assertEquals([...ids].sort(), ['bath', 'en', 'es', 'potty-ms']);
});

Deno.test('birthday: cold open pairs each portrait illustration with its source photo', () => {
  const open = scene(birthday(yearOfMemories()), 'cold_open')!;
  assertEquals(open.title, "Enzo's Year Four");
  assertEquals([open.from?.key, open.from?.pairKey], ['p-old-ill.png', 'p-old.jpg']);
  assertEquals([open.to.key, open.to.pairKey], ['p-new-ill.png', 'p-new.jpg']);
});

Deno.test('birthday: focus beats alternate with bursts that never repeat a memory', () => {
  const script = birthday(yearOfMemories());
  assertEquals(scenes(script, 'burst').map((b) => b.role).filter((r) => r !== 'emotion'), ['first_half', 'second_half', 'finale']);
  const types = script.scenes.map((s) => s.type);
  assertEquals(types[0], 'cold_open');
  assertEquals(types.at(-1), 'end_card');
  const ids = scenes(script, 'burst').flatMap((b) => b.frames.map((f) => f.memoryId));
  assertEquals(new Set(ids).size, ids.length);
  const [first, second] = scenes(script, 'burst');
  assert(first.frames.every((f) => f.date! < '2026-04-23'));
  assert(second.frames.every((f) => f.date! >= '2026-04-23'));
});

Deno.test('bursts keep drawings near the target mix even when drawings dominate the pool', () => {
  // Plenty of every kind: drawings are the most captioned, yet capped by the mix.
  const extra = MONTHS.flatMap((month) => [
    memory({ date: `${month}-03` }),
    memory({ date: `${month}-14` }),
    video({ date: `${month}-26` }),
    video({ date: `${month}-27` }),
  ]);
  const script = birthday([...yearOfMemories(), ...extra]);
  const frames = scenes(script, 'burst').flatMap((b) => b.frames);
  const drawings = frames.filter((f) => f.kind === 'illustration').length;
  assert(drawings / frames.length <= 0.25, `drawings ${drawings}/${frames.length}`);
  assert(frames.some((f) => f.kind === 'video') && frames.some((f) => f.kind === 'photo'));
});

Deno.test('bursts use several photos from one carousel memory', () => {
  const carousel = memory({
    id: 'carousel',
    date: '2026-01-02',
    media: [1, 2, 3, 4].map(() => ({ kind: 'image' as const, durationMs: null, hasPreview: true })),
    assets: [1, 2, 3, 4].map((n) => ({ kind: 'image' as const, key: `c${n}.jpg`, previewKey: null, durationMs: null, aspectRatio: 1 })),
  });
  const frames = scenes(birthday([carousel, ...yearOfMemories()]), 'burst').flatMap((b) => b.frames);
  const fromCarousel = frames.filter((f) => f.memoryId === 'carousel').length;
  assert(fromCarousel >= 2 && fromCarousel <= 3, `carousel frames ${fromCarousel}`);
});

Deno.test('birthday: without vision, then/now and voice clips need solo tags', () => {
  const script = birthday(yearOfMemories());
  assertEquals(script.verification, 'tags');
  const close = scene(script, 'close')!;
  assertEquals(close.source, 'then_now');
  assert(close.frames[0].date! < close.frames[1].date!);
  // The only videos are tagged with both kids → no voice fallback.
  assertEquals(scene(script, 'sound'), undefined);
  const solo = video({ id: 'solo-clip', date: '2026-05-20', taggedMemberIds: [ENZO] });
  const sound = scene(birthday([...yearOfMemories(), solo]), 'sound')!;
  assertEquals([sound.source, sound.needsVoiceCheck, sound.frame.memoryId], ['video', true, 'solo-clip']);
});

Deno.test('birthday: with vision, only frames verified to show the child back a claim', () => {
  const memories = yearOfMemories();
  const checks: FrameChecks = new Map();
  // Every photo/clip is a group shot except one early and one late photo.
  for (const m of memories) {
    for (const a of m.assets) checks.set(a.previewKey ?? a.key, check({ mainSubject: 'group' }));
  }
  const early = memories.find((m) => m.date === '2025-11-12')!;
  const late = memories.find((m) => m.date === '2026-10-12')!;
  checks.set(early.assets[0].previewKey!, check({ expression: 'big_smile' }));
  checks.set(late.assets[0].previewKey!, check({ expression: 'laughing' }));
  const script = birthday(memories, { checks });
  assertEquals(script.verification, 'vision');
  const close = scene(script, 'close')!;
  assertEquals(close.frames.map((f) => f.memoryId), [early.id, late.id]);
  assert(close.frames[1].why.includes('vision: Enzo · laughing'));
});

Deno.test('birthday: an upset face never closes the film; smiles win then/now', () => {
  const memories = yearOfMemories();
  const checks: FrameChecks = new Map();
  for (const m of memories) for (const a of m.assets) checks.set(a.previewKey ?? a.key, check({ mainSubject: 'group' }));
  const latest = memories.find((m) => m.date === '2026-10-12')!; // newest solo photo
  const earlier = memories.find((m) => m.date === '2026-09-12')!;
  checks.set(latest.assets[0].previewKey!, check({ expression: 'upset' }));
  checks.set(earlier.assets[0].previewKey!, check({ expression: 'smiling' }));
  const close = scene(birthday(memories, { checks }), 'close');
  assert(close?.frames.at(-1)?.memoryId !== latest.id, 'closed on an upset face');
});

Deno.test('birthday: sensitive memories never appear, and potty/birthday are not firsts', () => {
  const potty = drawing({ id: 'potty', date: '2026-02-02', emotion: 'pride', text: 'Enzo hizo pipí solito' });
  const steps = memory({ id: 'bike', date: '2026-08-20', text: 'Estrenando bicicletas sin rueditas' });
  const script = birthday([...yearOfMemories(), potty, steps], {
    milestones: [
      { memoryId: 'potty', familyMemberId: ENZO, milestoneId: 'potty-trained', status: 'confirmed' },
      { memoryId: 'bike', familyMemberId: ENZO, milestoneId: 'bike-no-training-wheels', status: 'candidate' },
      { memoryId: 'bike', familyMemberId: ENZO, milestoneId: 'birthday', status: 'candidate' },
    ],
    quotes: [{ memoryId: 'potty', quote: 'hice pipí solito', speakerId: ENZO }],
  });
  assert(!JSON.stringify(script.scenes).includes('"potty"'), 'potty memory leaked into a scene');
  // "Estrenando" (using for the first time) is an explicit first; birthday never is.
  assertEquals(scene(script, 'firsts')!.items.map((f) => f.label), ['Rides bike without training wheels']);
  assertEquals(scene(script, 'line'), undefined);
});

Deno.test('isCertainFirst: confirmed, or explicit "first" in the text within the age band', () => {
  const row = { memoryId: 'm', familyMemberId: ENZO, milestoneId: 'first-haircut', status: 'candidate' };
  assert(!isCertainFirst(row, 'Corte de pelo en la barbería'));
  assert(isCertainFirst(row, 'Primer corte de pelo en la barbería'));
  assert(isCertainFirst(row, 'Hoy Enzo estrenó su bici'));
  assert(isCertainFirst(row, "Leo's first haircut!"));
  assert(!isCertainFirst({ ...row, outOfBand: true }, 'Primer corte de pelo'));
  assert(isCertainFirst({ ...row, status: 'confirmed', outOfBand: true }, null));
  assert(!isCertainFirst({ ...row, status: 'dismissed' }, 'Primer corte de pelo'));
  assert(!isCertainFirst(row, 'Mi primo vino a jugar')); // "primo" is not "primer"
});

Deno.test('birthday: the close shows the real birthday party when there is one', () => {
  const party = memory({ id: 'party', date: '2025-10-23', taggedMemberIds: [ENZO, GRAN] });
  const nextDay = memory({ id: 'cake', date: '2025-10-24', taggedMemberIds: [ENZO] });
  const unrelated = memory({ id: 'later', date: '2025-10-25', taggedMemberIds: [ENZO] });
  const script = birthday([...yearOfMemories(), party, nextDay, unrelated], {
    milestones: [{ memoryId: 'cake', familyMemberId: ENZO, milestoneId: 'birthday', status: 'candidate' }],
  });
  const close = scene(script, 'close')!;
  assertEquals([close.source, close.celebrationDate], ['celebration', '2025-10-23']);
  assertEquals(close.frames.map((f) => f.memoryId).sort(), ['cake', 'party']);
  assertEquals(birthdayCelebration([unrelated], [], enzo, SCOPE), null);
});

Deno.test('birthday: a funny-ones burst when there are enough funny moments', () => {
  const script = birthday(yearOfMemories()); // 6 funny photos in the year
  const moods = scenes(script, 'burst').find((b) => b.role === 'emotion');
  assertEquals(moods?.titles, ['The funny ones']);
  assert(moods!.frames.every((f) => f.emotion === 'funny'));
});

Deno.test('films stay within the 50s cap however rich the year', () => {
  const rich = MONTHS.flatMap((month) =>
    Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0 ? video({ date: `${month}-${String(i + 1).padStart(2, '0')}` }) : memory({ date: `${month}-${String(i + 1).padStart(2, '0')}` })
    )
  );
  const script = birthday([...yearOfMemories(), ...rich]);
  assert(script.estimatedSeconds <= 50, `${script.estimatedSeconds}s`);
  assert(script.stats.frames > 40, `${script.stats.frames} frames`);
});

Deno.test('birthday: starring lists people by creation order, with photo/illustration pairs', () => {
  const starring = scene(birthday(yearOfMemories()), 'starring')!;
  assertEquals(starring.people.map((p) => p.name), ['Gran', 'Mara']);
  assertEquals(starring.people[0].portrait.pairKey, 'pg.jpg');
});

Deno.test('birthday: Spanish titles and catalog labels', () => {
  const steps = memory({ id: 'bike', date: '2026-08-20', text: 'Primera vez en bici sin rueditas' });
  const script = birthday([...yearOfMemories(), steps], {
    language: 'es',
    milestones: [{ memoryId: 'bike', familyMemberId: ENZO, milestoneId: 'bike-no-training-wheels', status: 'confirmed' }],
  });
  assertEquals(script.title, 'El cuarto año de Enzo');
  assertEquals(scene(script, 'close')!.line, '¡Feliz cumpleaños, Enzo!');
  assertEquals(scene(script, 'firsts')!.items[0].label, 'Bici sin rueditas');
  assertEquals(scenes(script, 'burst').find((b) => b.role === 'emotion')?.titles, ['Los momentos más graciosos']);
});

Deno.test('distinctiveThemes prefers what sets the scope apart, in the film language', () => {
  const routine = Array.from({ length: 40 }, (_, i) => memory({ id: `r${i}`, date: '2025-01-01', topics: ['mealtime'] }));
  const pool = [
    ...Array.from({ length: 4 }, (_, i) => memory({ id: `meal${i}`, topics: ['mealtime'] })),
    ...Array.from({ length: 3 }, (_, i) => memory({ id: `snow${i}`, topics: ['snow-play'] })),
  ];
  const themes = distinctiveThemes(pool, [...routine, ...pool], 3, 2, 'es');
  assertEquals([themes[0].topicId, themes[0].title], ['snow-play', 'Días de nieve']);
  assertEquals(distinctiveThemes([memory({ topics: ['bath'] }), memory({ topics: ['bath'] })], [], 3), []);
});

function august(): FilmMemorySource[] {
  return [
    video({ id: 'enzo-laugh', date: '2026-08-02', taggedMemberIds: [ENZO] }),
    video({ id: 'group', date: '2026-08-03', taggedMemberIds: [ENZO, MARA, GRAN] }),
    memory({ id: 'mara-smile', date: '2026-08-04', taggedMemberIds: [MARA] }),
    ...Array.from({ length: 10 }, (_, i) => memory({ date: `2026-08-1${i}`, emotion: 'calm', taggedMemberIds: [ENZO, MARA] })),
  ];
}

function monthly(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildMonthlyScript>[0]> = {}) {
  return buildMonthlyScript({
    yearMonth: '2026-08',
    memories,
    children: [mara, enzo, person('baby', '2027-01-01', '2026-12-01')],
    milestones: [],
    quotes: [],
    language: 'en',
    ...extra,
  });
}

Deno.test('monthly: awards come from vision-verified expressions, never from group frames', () => {
  const memories = august();
  const checks: FrameChecks = new Map();
  const key = (id: string) => checkKey({ ...memories.find((m) => m.id === id)!.assets[0], memoryId: id, date: null, kind: 'photo', emotion: null, why: '' });
  // The group clip "shows Enzo laughing" but he isn't the main subject.
  checks.set(key('group'), check({ mainSubject: 'group', expression: 'laughing' }));
  checks.set(key('enzo-laugh'), check({ expression: 'laughing' }));
  checks.set(key('mara-smile'), check({ mainSubject: MARA, childrenVisible: [MARA], expression: 'big_smile' }));
  const awards = scenes(monthly(memories, { checks }), 'award');
  assertEquals(awards.map((a) => [a.childName, a.award, a.evidence, a.frame.memoryId]), [
    ['Enzo', 'biggest laugh', 'laughing', 'enzo-laugh'],
    ['Mara', 'biggest smile', 'smiling', 'mara-smile'],
  ]);
  assertEquals(awards[0].intro, 'and the biggest laugh award goes to');
  assertEquals(awards[1].intro, "and don't forget about…");
});

Deno.test('monthly: without vision only "star of the month" from solo frames; else a portrait', () => {
  const memories = august().filter((m) => m.id !== 'mara-smile');
  const awards = scenes(monthly(memories), 'award');
  assertEquals(awards.map((a) => [a.childName, a.award, a.evidence]), [
    ['Enzo', 'star of the month', 'subject'],
    ['Mara', 'star of the month', 'portrait'],
  ]);
  assertEquals(awards[0].frame.memoryId, 'enzo-laugh');
});

Deno.test('monthly: title, a fast finale burst, and Spanish contraction', () => {
  const script = monthly(august(), { language: 'es' });
  assertEquals(scene(script, 'title')!.title, 'agosto');
  const finale = scenes(script, 'burst').find((b) => b.role === 'finale')!;
  assert(finale.frames.length >= 8);
  const es = monthly(august(), {
    language: 'es',
    checks: new Map([[`enzo-laugh-poster.jpg`, check({ expression: 'laughing' })]]),
  });
  assertEquals(scenes(es, 'award')[0].intro, 'y el premio a la risa más grande es para');
});

Deno.test('firstNamedChild finds whose voice a clip is', () => {
  const kids = [{ id: ENZO, name: 'Enzo X' }, { id: MARA, name: 'Mara X' }];
  assertEquals(firstNamedChild('Enzo contándole un cuento a Mara', kids), ENZO);
  assertEquals(firstNamedChild('Mara cantando con Enzo', kids), MARA);
  assertEquals(firstNamedChild('Cantando en el carro', kids), null);
  assertEquals(firstNamedChild('Enzoberto', kids), null);
});

Deno.test('birthday: a sibling\'s voice is never the child\'s sound', () => {
  const siblingVoice = memory({
    id: 'story',
    type: 'audio',
    date: '2026-09-26',
    text: 'Enzo contándole un cuento a Mara',
    taggedMemberIds: [ENZO, MARA],
    media: [{ kind: 'audio', durationMs: 30000, hasPreview: false }],
    assets: [{ kind: 'audio', key: 'story.m4a', previewKey: null, durationMs: 30000, aspectRatio: null }],
  });
  const script = buildBirthdayScript({
    child: mara,
    ageYear: 2,
    scope: { start: '2025-11-08', endExclusive: '2026-11-08' },
    memories: [...yearOfMemories().map((m) => ({ ...m, taggedMemberIds: [...m.taggedMemberIds, MARA] })), siblingVoice],
    members: [gran, enzo, mara],
    ownChildIds: [ENZO, MARA],
    milestones: [],
    quotes: [],
    language: 'en',
  });
  assert(scene(script, 'sound')?.frame.memoryId !== 'story', 'used the sibling\'s voice');
});

Deno.test('birthday film window runs through the birthday, so this year\'s party closes it', () => {
  const scope = birthdayFilmScope('2022-10-23', 4);
  assertEquals(scope, { start: '2025-10-23', endExclusive: '2026-10-26' });
  const lastYear = memory({ id: 'party-3', date: '2025-10-23', taggedMemberIds: [ENZO] });
  const thisYear = memory({ id: 'party-4', date: '2026-10-23', taggedMemberIds: [ENZO] });
  const dayAfter = memory({ id: 'cake-4', date: '2026-10-25', taggedMemberIds: [ENZO] });
  const script = birthday([...yearOfMemories(), lastYear, thisYear, dayAfter], {
    scope,
    milestones: [{ memoryId: 'cake-4', familyMemberId: ENZO, milestoneId: 'birthday', status: 'candidate' }],
  });
  const close = scene(script, 'close')!;
  assertEquals([close.source, close.celebrationDate], ['celebration', '2026-10-23']);
  assertEquals(close.frames.map((f) => f.memoryId).sort(), ['cake-4', 'party-4']);
});
