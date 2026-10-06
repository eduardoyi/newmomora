import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { PortraitVersionCandidate } from './portrait-versions.ts';
import {
  buildBirthdayScript,
  buildFamilyYearScript,
  buildHolidayScript,
  buildMonthlyScript,
  birthdayCelebration,
  checkKey,
  distinctiveThemes,
  familyDisplayName,
  type FilmMemorySource,
  type FilmPerson,
  type FilmScene,
  type FilmScript,
  firstNamedChild,
  type FrameChecks,
  isCertainFirst,
  rankMemories,
  SHARE_SENSITIVE_MILESTONES,
  shareSensitiveIds,
  unconfirmedFirsts,
} from './year-film-script.ts';
import type { FrameCheck } from './year-film-vision.ts';
import { birthdayFilmScope, familyYearScope } from './year-film-eligibility.ts';
import { HOLIDAY_FIRST_PHRASES, holidayFirstLabel, MILESTONE_NAMES_ES } from './year-film-i18n.ts';

const TOMAS = 'tomas';
const LUCIA = 'lucia';
const GRAN = 'gran';
const SCOPE = { start: '2025-10-17', endExclusive: '2026-10-17' };

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
  const first = id === TOMAS ? 'Tomás' : id === LUCIA ? 'Lucía' : `${id[0].toUpperCase()}${id.slice(1)}`;
  return { id, name: `${first} Lastname`, dateOfBirth: dob, createdAt, portraits };
}

const tomas = person(TOMAS, '2022-10-17', '2024-01-02', [portrait('p-old', TOMAS, '2025-06-01'), portrait('p-new', TOMAS, '2026-07-01')]);
const lucia = person(LUCIA, '2024-11-14', '2024-11-10', [portrait('pm', LUCIA, '2026-03-01')]);
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
    taggedMemberIds: [TOMAS],
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
    out.push(memory({ date: `${month}-05`, topics: ['park-playground'], taggedMemberIds: [TOMAS, GRAN] }));
    out.push(memory({ date: `${month}-12`, emotion: i % 2 ? 'funny' : 'wonder', topics: ['beach'] }));
    out.push(video({ date: `${month}-20`, text: 'Tomás cantando en el carro, muy feliz con su hermana', taggedMemberIds: [TOMAS, LUCIA] }));
    out.push(drawing({ date: `${month}-08` }));
    out.push(drawing({ date: `${month}-16` }));
    out.push(drawing({ date: `${month}-24` }));
  });
  return out;
}

function birthday(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildBirthdayScript>[0]> = {}) {
  return buildBirthdayScript({
    child: tomas,
    ageYear: 4,
    scope: SCOPE,
    memories,
    members: [gran, tomas, lucia],
    ownChildIds: [TOMAS, LUCIA],
    milestones: [],
    quotes: [],
    language: 'en',
    ...extra,
  });
}

function check(overrides: Partial<FrameCheck>): FrameCheck {
  return {
    mainSubject: TOMAS,
    childrenVisible: [TOMAS],
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
    memory({ id: 'es', text: 'Tomás hizo pipí en la poceta' }),
    memory({ id: 'en', text: 'First time on the potty!' }),
    memory({ id: 'ok1', text: 'We had a pipeline of peeking peekaboo games' }),
    memory({ id: 'ok2', text: 'Pipa and Pepe came over' }),
  ];
  const ids = shareSensitiveIds(ms, [{ memoryId: 'potty-ms', familyMemberId: TOMAS, milestoneId: 'potty-trained', status: 'candidate' }]);
  assertEquals([...ids].sort(), ['bath', 'en', 'es', 'potty-ms']);
});

Deno.test('birthday: cold open pairs each portrait illustration with its source photo', () => {
  const open = scene(birthday(yearOfMemories()), 'cold_open')!;
  assertEquals(open.title, 'Memories of your fourth year, Tomás');
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
  assert(first.frames.every((f) => f.date! < '2026-04-17'));
  assert(second.frames.every((f) => f.date! >= '2026-04-17'));
});

Deno.test('a half burst stays inside its half even when the journal gets dense later', () => {
  // A few memories early in the year, many in the second half (a journal started mid-year).
  const early = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'].flatMap((month) => [
    memory({ date: `${month}-05` }),
    video({ date: `${month}-15` }),
  ]);
  const late = ['2026-06', '2026-07', '2026-08', '2026-09'].flatMap((month) =>
    Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? video : memory)({ date: `${month}-${String(i + 1).padStart(2, '0')}` }))
  );
  const script = birthday([...early, ...late]);
  const [first, second, ...rest] = scenes(script, 'burst').filter((b) => b.role !== 'emotion');
  assertEquals(first.role, 'first_half');
  assert(first.frames.every((f) => f.date! < '2026-04-17'), first.frames.map((f) => f.date).join());
  assert(second.frames.every((f) => f.date! >= '2026-04-17'));
  assert(rest[0].frames.length > 0);
});

Deno.test('a half with almost nothing is folded into the finale, not shown as a near-empty burst', () => {
  const late = ['2026-06', '2026-07', '2026-08', '2026-09'].flatMap((month) =>
    Array.from({ length: 12 }, (_, i) => memory({ date: `${month}-${String(i + 1).padStart(2, '0')}` }))
  );
  const script = birthday([memory({ date: '2025-12-01' }), ...late]);
  assertEquals(scenes(script, 'burst').some((b) => b.role === 'first_half'), false);
  assert(script.dropped.some((d) => d.reason.startsWith('first_half')));
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
  const solo = video({ id: 'solo-clip', date: '2026-05-20', taggedMemberIds: [TOMAS] });
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
  assert(close.frames[1].why.includes('vision: Tomás · laughing'));
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
  const potty = drawing({ id: 'potty', date: '2026-02-02', emotion: 'pride', text: 'Tomás hizo pipí solito' });
  const steps = memory({ id: 'bike', date: '2026-08-20', text: 'Estrenando bicicletas sin rueditas' });
  const script = birthday([...yearOfMemories(), potty, steps], {
    milestones: [
      { memoryId: 'potty', familyMemberId: TOMAS, milestoneId: 'potty-trained', status: 'confirmed' },
      { memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'bike-no-training-wheels', status: 'candidate' },
      { memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'birthday', status: 'candidate' },
    ],
    quotes: [{ memoryId: 'potty', quote: 'hice pipí solito', speakerId: TOMAS }],
  });
  assert(!JSON.stringify(script.scenes).includes('"potty"'), 'potty memory leaked into a scene');
  // "Estrenando" (using for the first time) is an explicit first; birthday never is.
  assertEquals(scene(script, 'firsts')!.items.map((f) => f.label), ['Rides bike without training wheels']);
  assertEquals(scene(script, 'line'), undefined);
});

Deno.test('isCertainFirst: confirmed, or explicit "first" in the text within the age band', () => {
  const row = { memoryId: 'm', familyMemberId: TOMAS, milestoneId: 'first-haircut', status: 'candidate' };
  assert(!isCertainFirst(row, 'Corte de pelo en la barbería'));
  assert(isCertainFirst(row, 'Primer corte de pelo en la barbería'));
  assert(isCertainFirst(row, 'Hoy Tomás estrenó su bici'));
  assert(isCertainFirst(row, "Leo's first haircut!"));
  assert(!isCertainFirst({ ...row, outOfBand: true }, 'Primer corte de pelo'));
  assert(isCertainFirst({ ...row, status: 'confirmed', outOfBand: true }, null));
  assert(!isCertainFirst({ ...row, status: 'dismissed' }, 'Primer corte de pelo'));
  assert(!isCertainFirst(row, 'Mi primo vino a jugar')); // "primo" is not "primer"
});

Deno.test('birthday: the close shows the party of the birthday the film celebrates', () => {
  const scope = birthdayFilmScope('2022-10-17', 4); // 2025-10-17 → 2026-10-19
  const party = memory({ id: 'party', date: '2026-10-17', taggedMemberIds: [TOMAS, GRAN] });
  const nextDay = memory({ id: 'cake', date: '2026-10-18', taggedMemberIds: [TOMAS] });
  const unrelated = memory({ id: 'later', date: '2026-10-19', taggedMemberIds: [TOMAS] });
  const lastYear = memory({ id: 'third', date: '2025-10-17', taggedMemberIds: [TOMAS] });
  const script = birthday([...yearOfMemories(), lastYear, party, nextDay, unrelated], {
    scope,
    milestones: [{ memoryId: 'cake', familyMemberId: TOMAS, milestoneId: 'birthday', status: 'candidate' }],
  });
  const close = scene(script, 'close')!;
  assertEquals([close.source, close.celebrationDate], ['celebration', '2026-10-17']);
  assertEquals(close.frames.map((f) => f.memoryId).sort(), ['cake', 'party']);
  assertEquals(birthdayCelebration([unrelated], [], tomas, scope), null);
});

Deno.test("birthday: last year's party never closes this year's film", () => {
  // Only the birthday the window starts on is logged (this year's party hasn't happened yet).
  const scope = birthdayFilmScope('2022-10-17', 4);
  const lastYear = memory({ id: 'third', date: '2025-10-17', taggedMemberIds: [TOMAS] });
  const close = scene(birthday([...yearOfMemories(), lastYear], { scope }), 'close')!;
  // Falls back to then → now (the year's first photo may be that party, as "then"), never a party claim.
  assert(close.source !== 'celebration', close.source);
  assertEquals(close.celebrationDate, null);
});

Deno.test('birthday: a funny-ones burst when there are enough funny moments', () => {
  const script = birthday(yearOfMemories()); // 6 funny photos in the year
  const moods = scenes(script, 'burst').find((b) => b.role === 'emotion');
  assertEquals(moods?.titles, ['Your funniest moments']);
  assert(moods!.frames.every((f) => f.emotion === 'funny'));
});

Deno.test('films stay within the 60s cap however rich the year', () => {
  const rich = MONTHS.flatMap((month) =>
    Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0 ? video({ date: `${month}-${String(i + 1).padStart(2, '0')}` }) : memory({ date: `${month}-${String(i + 1).padStart(2, '0')}` })
    )
  );
  const script = birthday([...yearOfMemories(), ...rich]);
  assert(script.estimatedSeconds <= 60, `${script.estimatedSeconds}s`);
  assert(script.stats.frames > 40, `${script.stats.frames} frames`);
});

Deno.test('birthday: starring lists people by creation order, with photo/illustration pairs', () => {
  const starring = scene(birthday(yearOfMemories()), 'starring')!;
  assertEquals(starring.people.map((p) => p.name), ['Gran', 'Lucía']);
  assertEquals(starring.people[0].portrait.pairKey, 'pg.jpg');
});

Deno.test('birthday: each person brings up to 3 moments with the child, spread over the year', () => {
  const year = yearOfMemories();
  const starring = scene(birthday(year), 'starring')!;
  const byId = new Map(year.map((m) => [m.id, m]));
  for (const person of starring.people) {
    assert(person.moments.length > 0 && person.moments.length <= 3, `${person.name}: ${person.moments.length}`);
    for (const m of person.moments) assert(byId.get(m.memoryId!)!.taggedMemberIds.includes(person.memberId), m.memoryId!);
    assertEquals(new Set(person.moments.map((m) => m.date!.slice(0, 7))).size, person.moments.length); // spread, not one month
  }
});

Deno.test('birthday: reveals go to the most present people, not the oldest profiles; everyone joins the group shot', () => {
  // Eight early relatives with 2 shared memories each, and Dad (created last) in 20.
  const relatives = Array.from({ length: 8 }, (_, i) => person(`rel${i}`, '1960-01-01', `2023-0${i + 1}-01`, [portrait(`pr${i}`, `rel${i}`, null)]));
  const dad = person('dad', '1985-01-01', '2026-05-28', [portrait('pd', 'dad', null)]);
  const extra = [
    ...relatives.flatMap((r, i) => [0, 1].map((k) => memory({ date: `${MONTHS[i]}-1${k}`, taggedMemberIds: [TOMAS, r.id] }))),
    ...MONTHS.flatMap((month) => [3, 4].map((d) => memory({ date: `${month}-0${d}`, taggedMemberIds: [TOMAS, 'dad'] }))),
  ];
  const starring = scene(birthday([...yearOfMemories(), ...extra], { members: [...relatives, gran, tomas, lucia, dad] }), 'starring')!;
  const shown = starring.people.map((p) => p.memberId);
  assertEquals(shown.length, 6);
  assert(shown.includes('dad') && shown.includes(LUCIA) && shown.includes(GRAN), shown.join());
  assertEquals(shown.at(-1), 'dad'); // displayed in creation order, never by count
  assertEquals(starring.together!.length, 9);
});

Deno.test('birthday: people get their own moments before sharing one', () => {
  // Each month has a memory with Gran and Lucía together, plus one with each alone.
  const year = MONTHS.flatMap((month) => [
    memory({ date: `${month}-02`, taggedMemberIds: [TOMAS, GRAN, LUCIA] }),
    memory({ date: `${month}-09`, taggedMemberIds: [TOMAS, GRAN] }),
    memory({ date: `${month}-18`, taggedMemberIds: [TOMAS, LUCIA] }),
  ]);
  const [granCards, luciaCards] = scene(birthday([...yearOfMemories(), ...year]), 'starring')!.people.map((p) => p.moments.map((m) => m.memoryId));
  assertEquals(granCards.filter((id) => luciaCards.includes(id)), []);
});

Deno.test('birthday: Spanish titles and catalog labels', () => {
  const steps = memory({ id: 'bike', date: '2026-08-20', text: 'Primera vez en bici sin rueditas' });
  const script = birthday([...yearOfMemories(), steps], {
    language: 'es',
    milestones: [{ memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'bike-no-training-wheels', status: 'confirmed' }],
  });
  assertEquals(script.title, 'Recuerdos de tu cuarto año, Tomás');
  assertEquals(scene(script, 'firsts')!.kicker, 'Tus logros');
  assertEquals(scene(script, 'close')!.line, '¡Feliz cumpleaños, Tomás!');
  assertEquals(scene(script, 'firsts')!.items[0].label, 'Bici sin rueditas');
  assertEquals(scene(script, 'firsts')!.items[0].frame?.memoryId, 'bike'); // the milestone's own card
  assertEquals(scenes(script, 'burst').find((b) => b.role === 'emotion')?.titles, ['Tus momentos más graciosos']);
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

Deno.test('themes in a voice read as things loved, and skip topics that are not', () => {
  const pool = [
    ...Array.from({ length: 3 }, () => memory({ topics: ['bikes-scooters'] })),
    ...Array.from({ length: 3 }, () => memory({ topics: ['pretend-play'] })),
    ...Array.from({ length: 4 }, () => memory({ topics: ['doctor-dentist'] })),
  ];
  const titles = (voice: 'child' | 'family', language: 'es' | 'en') =>
    distinctiveThemes(pool, pool, 3, 2, language, voice).map((t) => t.title).sort();
  assertEquals(titles('child', 'es'), ['disfrazarte y jugar a imaginar', 'moverte sobre ruedas']);
  assertEquals(titles('family', 'es'), ['disfrazarnos y jugar a imaginar', 'movernos sobre ruedas']);
  assertEquals(titles('child', 'en'), ['dress-up and pretend play', 'riding on wheels']);
});

function august(): FilmMemorySource[] {
  return [
    video({ id: 'tomas-laugh', date: '2026-08-02', taggedMemberIds: [TOMAS] }),
    video({ id: 'group', date: '2026-08-03', taggedMemberIds: [TOMAS, LUCIA, GRAN] }),
    memory({ id: 'lucia-smile', date: '2026-08-04', taggedMemberIds: [LUCIA] }),
    ...Array.from({ length: 10 }, (_, i) => memory({ date: `2026-08-1${i}`, emotion: 'calm', taggedMemberIds: [TOMAS, LUCIA] })),
  ];
}

function monthly(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildMonthlyScript>[0]> = {}) {
  return buildMonthlyScript({
    yearMonth: '2026-08',
    memories,
    children: [lucia, tomas, person('baby', '2027-01-01', '2026-12-01')],
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
  // The group clip "shows Tomás laughing" but he isn't the main subject.
  checks.set(key('group'), check({ mainSubject: 'group', expression: 'laughing' }));
  checks.set(key('tomas-laugh'), check({ expression: 'laughing' }));
  checks.set(key('lucia-smile'), check({ mainSubject: LUCIA, childrenVisible: [LUCIA], expression: 'big_smile' }));
  const awards = scenes(monthly(memories, { checks }), 'award');
  assertEquals(awards.map((a) => [a.childName, a.award, a.evidence, a.frame.memoryId]), [
    ['Tomás', 'biggest laugh', 'laughing', 'tomas-laugh'],
    ['Lucía', 'biggest smile', 'smiling', 'lucia-smile'],
  ]);
  assertEquals(awards[0].intro, 'and the biggest laugh award goes to');
  assertEquals(awards[1].intro, 'and the biggest smile award goes to'); // each award announces itself
});

Deno.test('monthly: without vision only "star of the month" from solo frames; else a portrait', () => {
  const memories = august().filter((m) => m.id !== 'lucia-smile');
  const awards = scenes(monthly(memories), 'award');
  assertEquals(awards.map((a) => [a.childName, a.award, a.evidence]), [
    ['Tomás', 'star of the month', 'subject'],
    ['Lucía', 'star of the month', 'portrait'],
  ]);
  assertEquals(awards[0].frame.memoryId, 'tomas-laugh');
});

Deno.test('monthly: title, a fast finale burst, and Spanish contraction', () => {
  const script = monthly(august(), { language: 'es' });
  assertEquals(scene(script, 'title')!.title, 'agosto');
  const finale = scenes(script, 'burst').find((b) => b.role === 'finale')!;
  assert(finale.frames.length >= 8);
  const es = monthly(august(), {
    language: 'es',
    checks: new Map([[`tomas-laugh-poster.jpg`, check({ expression: 'laughing' })]]),
  });
  assertEquals(scenes(es, 'award')[0].intro, 'y el premio a la risa más grande es para');
});

Deno.test('firstNamedChild finds whose voice a clip is', () => {
  const kids = [{ id: TOMAS, name: 'Tomás X' }, { id: LUCIA, name: 'Lucía X' }];
  assertEquals(firstNamedChild('Tomás contándole un cuento a Lucía', kids), TOMAS);
  assertEquals(firstNamedChild('Lucía cantando con Tomás', kids), LUCIA);
  assertEquals(firstNamedChild('Cantando en el carro', kids), null);
  assertEquals(firstNamedChild('Tomásberto', kids), null);
});

Deno.test('birthday: a sibling\'s voice is never the child\'s sound', () => {
  const siblingVoice = memory({
    id: 'story',
    type: 'audio',
    date: '2026-09-26',
    text: 'Tomás contándole un cuento a Lucía',
    taggedMemberIds: [TOMAS, LUCIA],
    media: [{ kind: 'audio', durationMs: 30000, hasPreview: false }],
    assets: [{ kind: 'audio', key: 'story.m4a', previewKey: null, durationMs: 30000, aspectRatio: null }],
  });
  const script = buildBirthdayScript({
    child: lucia,
    ageYear: 2,
    scope: { start: '2025-11-14', endExclusive: '2026-11-14' },
    memories: [...yearOfMemories().map((m) => ({ ...m, taggedMemberIds: [...m.taggedMemberIds, LUCIA] })), siblingVoice],
    members: [gran, tomas, lucia],
    ownChildIds: [TOMAS, LUCIA],
    milestones: [],
    quotes: [],
    language: 'en',
  });
  assert(scene(script, 'sound')?.frame.memoryId !== 'story', 'used the sibling\'s voice');
});

Deno.test('birthday film window runs through the birthday, so this year\'s party closes it', () => {
  const scope = birthdayFilmScope('2022-10-17', 4);
  assertEquals(scope, { start: '2025-10-17', endExclusive: '2026-10-19' });
  const lastYear = memory({ id: 'party-3', date: '2025-10-17', taggedMemberIds: [TOMAS] });
  const thisYear = memory({ id: 'party-4', date: '2026-10-17', taggedMemberIds: [TOMAS] });
  const dayAfter = memory({ id: 'cake-4', date: '2026-10-18', taggedMemberIds: [TOMAS] });
  const script = birthday([...yearOfMemories(), lastYear, thisYear, dayAfter], {
    scope,
    milestones: [{ memoryId: 'cake-4', familyMemberId: TOMAS, milestoneId: 'birthday', status: 'candidate' }],
  });
  const close = scene(script, 'close')!;
  assertEquals([close.source, close.celebrationDate], ['celebration', '2026-10-17']);
  assertEquals(close.frames.map((f) => f.memoryId).sort(), ['cake-4', 'party-4']);
});

Deno.test('counters carry a backdrop mosaic; the film carries its timeline span', () => {
  const script = birthday(yearOfMemories());
  const counters = scene(script, 'counters')!;
  assertEquals(counters.kicker, 'Your year in');
  assert(counters.backdrop.length >= 24, `backdrop ${counters.backdrop.length}`);
  assertEquals(script.span, { from: '2025-10-17', to: '2026-10-17' });
  const august = buildMonthlyScript({ yearMonth: '2026-08', memories: yearOfMemories(), children: [tomas, lucia], milestones: [], quotes: [], language: 'es' });
  assertEquals(august.span, { from: '2026-08-01', to: '2026-08-31' });
  assertEquals(scene(august, 'title')!.kicker, 'Nuestro');
});

// ── Year-end family film ─────────────────────────────────────────────────

/** 2026 with Tomás everywhere and Lucía (born Nov 2024) in only a few memories. */
function familyYear(): FilmMemorySource[] {
  const out: FilmMemorySource[] = [];
  ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].forEach((month, i) => {
    out.push(memory({ date: `${month}-03`, topics: ['park-playground'], taggedMemberIds: [TOMAS] }));
    out.push(memory({ date: `${month}-09`, topics: ['beach'], taggedMemberIds: [TOMAS, GRAN, LUCIA] }));
    out.push(video({ date: `${month}-14`, taggedMemberIds: [TOMAS] }));
    out.push(drawing({ date: `${month}-20`, taggedMemberIds: [TOMAS] }));
    out.push(memory({ date: `${month}-25`, emotion: i % 2 ? 'funny' : 'joy', taggedMemberIds: [TOMAS] }));
    if (i % 4 === 0) out.push(memory({ date: `${month}-27`, taggedMemberIds: [LUCIA] }));
  });
  out.push(memory({ id: 'after-cutoff', date: '2026-12-28', taggedMemberIds: [TOMAS, LUCIA, GRAN] }));
  return out;
}

function family(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildFamilyYearScript>[0]> = {}) {
  return buildFamilyYearScript({
    year: 2026,
    memories,
    children: [tomas, lucia],
    members: [gran, tomas, lucia],
    milestones: [],
    quotes: [],
    language: 'es',
    ...extra,
  });
}

Deno.test('family year: Jan 1 → Dec 27, one chapter per child whatever the data', () => {
  assertEquals(familyYearScope(2026), { start: '2026-01-01', endExclusive: '2026-12-28' });
  const script = family(familyYear());
  assertEquals(script.kind, 'family_year');
  assertEquals(script.title, 'Nuestro 2026');
  const chapters = scenes(script, 'chapter');
  assertEquals(chapters.map((c) => c.name), ['Tomás', 'Lucía']); // oldest first, the thin one included
  assert(chapters.every((c) => c.portrait !== null));
  const all = script.scenes.flatMap((sc) => ('frames' in sc ? sc.frames : []) as { memoryId: string | null }[]);
  assert(!all.some((f) => f.memoryId === 'after-cutoff'), 'nothing after the Dec 27 cut-off');
  assertEquals(scenes(script, 'close')[0].line, '¡Por un 2027 juntos!');
  assertEquals(scenes(script, 'close')[0].source, 'family');
  const themes = scenes(script, 'burst').find((b) => b.role === 'second_half');
  assertEquals(themes?.titlesKicker, 'Lo que más nos gustó este año');
  assert(script.estimatedSeconds <= 60, `${script.estimatedSeconds}s`);
});

Deno.test('family year: firsts take turns across children and carry their name', () => {
  const memories = familyYear();
  const tomasFirsts = ['bike', 'scooter', 'swim'].map((id, i) => memory({ id, date: `2026-0${i + 2}-11`, taggedMemberIds: [TOMAS] }));
  const luciaFirst = memory({ id: 'steps', date: '2026-06-11', taggedMemberIds: [LUCIA] });
  const milestones = [
    { memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'bike-no-training-wheels', status: 'confirmed' as const },
    { memoryId: 'scooter', familyMemberId: TOMAS, milestoneId: 'rides-scooter', status: 'confirmed' as const },
    { memoryId: 'swim', familyMemberId: TOMAS, milestoneId: 'first-swim', status: 'confirmed' as const },
    { memoryId: 'steps', familyMemberId: LUCIA, milestoneId: 'first-steps', status: 'confirmed' as const },
  ];
  const firsts = scenes(family([...memories, ...tomasFirsts, luciaFirst], { milestones }), 'firsts')[0];
  assert(firsts.items.some((f) => f.childName === 'Lucía'), firsts.items.map((f) => f.childName).join());
  assert(firsts.items.length <= 4);
  assert(firsts.items.every((f) => f.childName === 'Tomás' || f.childName === 'Lucía'));
});

// ── Holiday card film ────────────────────────────────────────────────────

const EDU = 'edu';
const ADRI = 'adri';
const edu = { ...person(EDU, '1985-05-05', '2024-01-01', [portrait('pe', EDU, '2026-01-01')]), relationship: 'parent' };
const adri = { ...person(ADRI, '1987-03-14', '2024-01-02', [portrait('pa', ADRI, '2026-01-01')]), relationship: 'parent' };
const CORE = [TOMAS, LUCIA, EDU, ADRI];

function holiday(memories: FilmMemorySource[], extra: Partial<Parameters<typeof buildHolidayScript>[0]> = {}) {
  return buildHolidayScript({
    year: 2026,
    scope: { start: '2026-01-01', endExclusive: '2026-10-05' },
    familyName: 'Rivera Soto',
    memories,
    children: [tomas, lucia],
    members: [gran, tomas, lucia, edu, adri],
    milestones: [],
    quotes: [],
    language: 'es',
    ...extra,
  });
}

function closeIds(script: FilmScript): string[] {
  return scenes(script, 'close')[0].frames.map((f) => f.memoryId!);
}

Deno.test('holiday film: Jan 1 → the day it is made, ≤ 60 s, slower bursts, holiday theme and end card', () => {
  const script = holiday(familyYear());
  assertEquals(script.kind, 'family_holiday');
  assertEquals(script.theme, 'holiday');
  assertEquals(script.title, 'Nuestro 2026');
  assertEquals(scenes(script, 'title')[0].subtitle, 'Un año en familia');
  // The strip spans the whole card year (it is watched in December); the content stops on the creation day.
  assertEquals(script.span, { from: '2026-01-01', to: '2026-12-31' });
  assertEquals(script.scope, { start: '2026-01-01', endExclusive: '2026-10-05' });
  const all = script.scenes.flatMap((sc) => ('frames' in sc ? sc.frames : []) as { date: string | null }[]);
  assert(all.every((f) => (f.date ?? '') < '2026-10-05'), 'nothing after the day the card is made');
  assertEquals(scenes(script, 'chapter').map((c) => c.name), ['Tomás', 'Lucía']);
  assert(script.estimatedSeconds <= 60, `${script.estimatedSeconds}s`);
  assert(script.estimatedSeconds > 45, `a bit longer than before: ${script.estimatedSeconds}s`);
  // No counters, emotion or "together" bursts.
  for (const type of ['counters', 'award'] as const) assertEquals(scenes(script, type).length, 0, type);
  const bursts = scenes(script, 'burst');
  assertEquals(bursts.map((b) => b.role), ['first_half', 'second_half', 'finale']);
  assert(bursts.every((b) => b.holdFactor === 1.5), 'each frame holds 1.5× longer');
  // The estimate accounts for the slower hold.
  const year = family(familyYear());
  assert(scenes(year, 'burst').every((b) => b.holdFactor === undefined));
  const end = scenes(script, 'end_card')[0];
  assertEquals(end.greeting, 'Felices fiestas');
  assertEquals(end.from, 'de parte de la familia Rivera Soto');
  assertEquals(script.scenes.at(-1)?.type, 'end_card');
  const en = holiday(familyYear(), { language: 'en', familyName: 'The Rivera Soto Family' });
  assertEquals(scenes(en, 'end_card')[0].greeting, 'Happy holidays');
  assertEquals(scenes(en, 'end_card')[0].from, 'from the Rivera Soto family');
});

Deno.test('holiday film: the greeting choice feeds the end card, es + en, default holidays', () => {
  const greetings = (language: 'es' | 'en') =>
    (['christmas', 'holidays', 'new-year'] as const).map((greeting) => scenes(holiday(familyYear(), { language, greeting }), 'end_card')[0].greeting);
  assertEquals(greetings('es'), ['Feliz Navidad', 'Felices fiestas', 'Feliz Año Nuevo']);
  assertEquals(greetings('en'), ['Merry Christmas', 'Happy holidays', 'Happy New Year']);
  assertEquals(scenes(holiday(familyYear()), 'end_card')[0].greeting, 'Felices fiestas');
  // The sign-off does not depend on the greeting.
  assertEquals(scenes(holiday(familyYear(), { greeting: 'new-year' }), 'end_card')[0].from, 'de parte de la familia Rivera Soto');
});

Deno.test('holiday film: sensitive and worried/sad/weary memories never appear, holiday topics score up', () => {
  const memories = familyYear();
  memories.push(memory({ id: 'sad', date: '2026-03-04', emotion: 'sad', taggedMemberIds: CORE }));
  memories.push(memory({ id: 'tired', date: '2026-04-04', emotion: 'weary', taggedMemberIds: CORE }));
  memories.push(memory({ id: 'bath', date: '2026-05-04', topics: ['bath'], taggedMemberIds: CORE }));
  const script = holiday(memories);
  const ids = JSON.stringify(script.scenes);
  for (const id of ['sad', 'tired', 'bath']) assert(!ids.includes(`"${id}"`), id);
  assertEquals(script.stats.pool, familyYear().filter((m) => m.date < '2026-10-05').length);
  const ranked = rankMemories(
    [memory({ id: 'xmas', date: '2026-01-02', topics: ['christmas'] }), memory({ id: 'plain', date: '2026-01-03' })],
    { scope: { start: '2026-01-01', endExclusive: '2026-10-05' }, milestones: [], ownChildIds: [TOMAS, LUCIA], n: 1, holiday: true },
  );
  assertEquals(ranked[0].memory.id, 'xmas');
});

Deno.test('sound scene: every alternate keeps its OWN memory\'s caption, parallel to its frame (a fallback never shows the primary\'s)', () => {
  const audio = (id: string, date: string, text: string) => memory({
    id, type: 'audio', date, text, taggedMemberIds: [TOMAS],
    media: [{ kind: 'audio', durationMs: 20000, hasPreview: false }],
    assets: [{ kind: 'audio', key: `${id}.m4a`, previewKey: null, durationMs: 20000, aspectRatio: null }],
  });
  const script = holiday([...familyYear(), audio('a1', '2026-05-05', 'Tomás leyéndole un libro a Lucía'), audio('a2', '2026-06-06', 'Tomás cantando en el carro'), audio('a3', '2026-07-07', 'Cantando en el carro')]);
  const sound = scenes(script, 'sound')[0];
  assertEquals(sound.alternates.length, 2);
  const texts: Record<string, string> = { a1: 'Tomás leyéndole un libro a Lucía', a2: 'Tomás cantando en el carro', a3: 'Cantando en el carro' };
  assertEquals(sound.caption, texts[sound.frame.memoryId!]);
  assertEquals(sound.alternateCaptions, sound.alternates.map((f) => texts[f.memoryId!]));
  // The video-fallback variant (no audio memories) keeps them aligned too.
  const clips = ['c1', 'c2'].map((id, i) => video({ id, date: `2026-0${i + 4}-20`, text: `Clip ${id}`, taggedMemberIds: [TOMAS], media: [{ kind: 'video', durationMs: 9000, hasPreview: true }] }));
  const withClips = holiday([...familyYear(), ...clips], { checks: new Map(clips.map((c) => [c.assets[0].previewKey!, check({ underdressed: false })])) });
  const vs = scenes(withClips, 'sound')[0];
  if (vs) assertEquals(vs.alternateCaptions, vs.alternates.map((f) => `Clip ${f.memoryId}`));
});

Deno.test('holiday film: the sound is dropped before a chapter would be, to stay under 60 s', () => {
  const audio = memory({
    id: 'audio1',
    type: 'audio',
    date: '2026-05-05',
    taggedMemberIds: [TOMAS],
    media: [{ kind: 'audio', durationMs: 20000, hasPreview: false }],
    assets: [{ kind: 'audio', key: 'a.m4a', previewKey: null, durationMs: 20000, aspectRatio: null }],
  });
  const withSound = holiday([...familyYear(), audio]);
  assert(withSound.estimatedSeconds <= 60, `${withSound.estimatedSeconds}s`);
  assertEquals(scenes(withSound, 'sound').length, 1);
  const kidsOf = (n: number) => Array.from({ length: n }, (_, i) => person(`kid${i}`, `202${i % 6}-03-01`, `2024-01-0${i + 1}`, [portrait(`pk${i}`, `kid${i}`, '2026-03-01')]));
  const many = kidsOf(6);
  const crowded = holiday(
    [...familyYear(), audio, ...many.flatMap((k) => [memory({ date: '2026-06-06', taggedMemberIds: [k.id] }), memory({ date: '2026-07-07', taggedMemberIds: [k.id] })])],
    { children: many, members: [...many, edu, adri] },
  );
  assertEquals(scenes(crowded, 'chapter').length, 6); // never skip a child
  assertEquals(scenes(crowded, 'sound').length, 0);
  assert(crowded.dropped.some((d) => d.scene === 'sound' && d.reason.includes('60')));
});

/** A year of ordinary memories plus the close candidates under test. */
function withClose(extra: FilmMemorySource[]): FilmMemorySource[] {
  return [...familyYear(), ...extra];
}

const together = (id: string, date: string, tags: string[], extra: Partial<FilmMemorySource> = {}) =>
  memory({ id, date, taggedMemberIds: tags, assets: [{ id: `media-${id}`, kind: 'image', key: `${id}.jpg`, previewKey: `${id}-p.jpg`, durationMs: null, aspectRatio: 1.5 }], ...extra });

Deno.test('holiday film close: the whole core family and nobody else — never a photo without a parent or with an uncle', () => {
  const script = holiday(withClose([
    together('old-all', '2026-04-01', CORE),
    together('new-all', '2026-09-01', CORE),
    together('no-dad', '2026-09-20', [TOMAS, LUCIA, ADRI]), // newer, but Eduardo is missing
    together('uncle', '2026-09-25', [...CORE, GRAN]), // newer, but a non-core member is in it
    together('kids-only', '2026-09-28', [TOMAS, LUCIA]),
  ]));
  assertEquals(closeIds(script), ['new-all', 'old-all']);
  const close = scenes(script, 'close')[0];
  assertEquals(close.source, 'family');
  assert(close.frames[0].why.includes('all 4 core members, nobody else'));
  assert(!script.dropped.some((d) => d.scene === 'close'));
});

Deno.test('holiday film close: the card front\'s top picks go first, then vision-verified group frames', () => {
  const memories = withClose([together('a', '2026-09-01', CORE), together('b', '2026-06-01', CORE), together('c', '2026-03-01', CORE)]);
  // Newest first by default.
  assertEquals(closeIds(holiday(memories)), ['a', 'b']);
  // A top pick (by media id or object key) outranks recency.
  assertEquals(closeIds(holiday(memories, { preferredCloseMedia: ['media-c'] })), ['c', 'a']);
  assertEquals(closeIds(holiday(memories, { preferredCloseMedia: ['b.jpg'] }))[0], 'b');
  // Vision: a frame showing both children beats a newer one that doesn't; a blurry one drops out.
  const check = (children: string[], quality: 'good' | 'blurry' = 'good') => ({
    mainSubject: 'group', childrenVisible: children, faceVisible: true, expression: 'smiling' as const, quality, unsafe: false, screenCapture: false,
    underdressed: false, // the holiday film's checks come from the strict public prompt
  });
  const checks: FrameChecks = new Map([['a-p.jpg', check([TOMAS])], ['b-p.jpg', check([TOMAS, LUCIA])], ['c-p.jpg', check([TOMAS, LUCIA], 'blurry')]]);
  assertEquals(closeIds(holiday(memories, { checks })), ['b', 'a']);
});

Deno.test('holiday film close: a frame the strict check flagged never closes the film — everyone\'s portraits do', () => {
  const memories = withClose([together('a', '2026-09-01', CORE), together('b', '2026-06-01', CORE)]);
  const check = (underdressed: boolean) => ({
    mainSubject: 'group', childrenVisible: [TOMAS, LUCIA], faceVisible: true, expression: 'smiling' as const, quality: 'good' as const,
    unsafe: false, screenCapture: false, underdressed,
  });
  // One flagged (newest): the other carries the close, alone.
  const one: FrameChecks = new Map([['a-p.jpg', check(true)], ['b-p.jpg', check(false)]]);
  assertEquals(closeIds(holiday(memories, { checks: one })), ['b']);
  // Both flagged — or checked only by the NORMAL prompt (no `underdressed` answer): portraits, not a flagged photo.
  const both: FrameChecks = new Map([['a-p.jpg', check(true)], ['b-p.jpg', check(true)]]);
  assertEquals(scenes(holiday(memories, { checks: both }), 'close')[0].source, 'portraits');
  const normal = new Map([...one].map(([k, v]) => [k, { ...v, underdressed: undefined }])) as FrameChecks;
  assertEquals(scenes(holiday(memories, { checks: normal }), 'close')[0].source, 'portraits');
});

Deno.test('holiday film close: always a still — a front pick that is a clip falls back to the memory\'s photo', () => {
  const clipPick = memory({
    id: 'clip', date: '2026-09-10', taggedMemberIds: CORE,
    media: [{ kind: 'video', durationMs: 5000, hasPreview: true }, { kind: 'image', durationMs: null, hasPreview: true }],
    assets: [
      { id: 'media-clip', kind: 'video', key: 'clip.mp4', previewKey: 'clip-poster.jpg', durationMs: 5000, aspectRatio: 0.56 },
      { id: 'media-clip-photo', kind: 'image', key: 'clip.jpg', previewKey: 'clip-p.jpg', durationMs: null, aspectRatio: 1.5 },
    ],
  });
  const clipOnly = memory({
    id: 'clip-only', date: '2026-09-11', taggedMemberIds: CORE,
    media: [{ kind: 'video', durationMs: 5000, hasPreview: true }],
    assets: [{ id: 'media-clip-only', kind: 'video', key: 'clip-only.mp4', previewKey: 'clip-only-poster.jpg', durationMs: 5000, aspectRatio: 0.56 }],
  });
  const script = holiday(withClose([clipPick, clipOnly, together('plain', '2026-03-01', CORE)]), { preferredCloseMedia: ['media-clip'] });
  const close = scenes(script, 'close')[0];
  assert(close.frames.every((f) => f.kind !== 'video'), 'no clip in the close');
  assertEquals(close.frames.map((f) => f.memoryId), ['clip', 'plain']);
  assertEquals(close.frames[0].key, 'clip.jpg');
});

Deno.test('holiday film: public-audience text/topic screen (bath, undressed, diapers, nursing) is stricter than the year film\'s', () => {
  const tubs = [
    memory({ id: 'tub', text: 'Se bañó en la bañera con los patitos' }),
    memory({ id: 'en-bath', text: 'Bath time with the ducks' }),
    memory({ id: 'shower', text: 'Su primera ducha sola' }),
    memory({ id: 'undies', text: 'Running around in his underwear' }),
    memory({ id: 'nursing', text: 'Nursing Lucía before bed' }),
    memory({ id: 'care', topics: ['baby-care'] }),
  ];
  const fine = [
    memory({ id: 'beach', text: 'Se bañó en el mar, qué felicidad', topics: ['beach'] }), // swimming is the vision check's call
    memory({ id: 'swimsuit', text: 'Nadando con su bañador nuevo' }),
    memory({ id: 'shirtless', text: 'Tomás sin camiseta en la playa, shirtless all day' }), // beach shirtless is fine (the vision check decides)
    memory({ id: 'pool', text: 'Bathing suit shopping' }),
    memory({ id: 'park', text: 'Un día en el parque', topics: ['park-playground'] }),
  ];
  const all = [...tubs, ...fine];
  const normal = shareSensitiveIds(all, []);
  const strict = shareSensitiveIds(all, [], { publicAudience: true });
  for (const m of tubs) assert(strict.has(m.id), `public: ${m.id}`);
  for (const m of fine) assert(!strict.has(m.id), `public keeps ${m.id}`);
  // The year film's screen is unchanged (none of those were sensitive to it).
  for (const id of ['tub', 'en-bath', 'shower', 'undies', 'nursing', 'care']) assert(!normal.has(id), `normal: ${id}`);
  // And the holiday film's pool uses it.
  const script = holiday([...familyYear(), memory({ id: 'tub2', date: '2026-05-04', text: 'En la bañera', taggedMemberIds: CORE }), memory({ id: 'shirt2', date: '2026-05-05', text: 'Sin ropa', taggedMemberIds: CORE })]);
  const ids = JSON.stringify(script.scenes);
  assert(!ids.includes('"tub2"') && !ids.includes('"shirt2"'));
  assertEquals(script.stats.pool, familyYear().filter((m) => m.date < '2026-10-05').length);
  const yearFilm = family([...familyYear(), memory({ id: 'tub3', date: '2026-05-04', text: 'En la bañera', taggedMemberIds: CORE })]);
  assertEquals(yearFilm.stats.pool, family(familyYear()).stats.pool + 1); // the year film still includes it
});

Deno.test('holiday film: a chapter moment never rests on a frame the strict check flagged or the normal prompt checked', () => {
  const memories = familyYear();
  const strict = (underdressed: boolean | undefined) => check({ underdressed });
  const checksWith = (flag: (key: string) => boolean | undefined) => {
    const map: FrameChecks = new Map();
    for (const m of memories) for (const a of m.assets) map.set(a.previewKey ?? a.key, strict(flag(a.previewKey ?? a.key)));
    return map;
  };
  const moments = (c: FrameChecks) => scenes(holiday(memories, { checks: c }), 'chapter').flatMap((ch) => ch.frames.map((f) => f.memoryId!));
  const baseline = moments(checksWith(() => false));
  assert(baseline.length >= 2, `chapters have verified moments (${baseline.length})`);
  const target = memories.find((m) => m.id === baseline[0])!;
  const targetKey = target.assets[0].previewKey ?? target.assets[0].key;
  assert(!moments(checksWith((k) => k === targetKey)).includes(target.id), 'the flagged frame is not a chapter moment');
  // A verdict from the normal prompt (no answer to the strict question) backs no claim in a public film.
  assertEquals(moments(checksWith(() => undefined)), []);
});

Deno.test('holiday film: the firsts card says it the way a parent does; the year film keeps the catalog label', () => {
  const memories = withClose([
    memory({ id: 'steps', date: '2026-04-11', taggedMemberIds: [LUCIA] }),
    memory({ id: 'bike', date: '2026-06-11', taggedMemberIds: [TOMAS] }),
  ]);
  const milestones = [
    { memoryId: 'steps', familyMemberId: LUCIA, milestoneId: 'walking', status: 'confirmed' as const },
    { memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'bike-no-training-wheels', status: 'confirmed' as const },
  ];
  assertEquals(scenes(holiday(memories, { milestones }), 'firsts')[0].items.map((f) => f.label), ['Dio sus primeros pasos', 'Aprendió a ir en bici sin rueditas']);
  assertEquals(scenes(holiday(memories, { milestones, language: 'en' }), 'firsts')[0].items.map((f) => f.label), ['Took their first steps', 'Learned to ride without training wheels']);
  // Year film: the catalog label, as before.
  assertEquals(scenes(family(memories, { milestones }), 'firsts')[0].items.map((f) => f.label), ['Camina con confianza', 'Bici sin rueditas']);
});

Deno.test('holiday film: every catalog milestone has plain phrasing in both languages (no tag-speak)', () => {
  for (const language of ['es', 'en'] as const) {
    const gaps = Object.keys(MILESTONE_NAMES_ES).filter((id) => !SHARE_SENSITIVE_MILESTONES.has(id) && id !== 'birthday' && !HOLIDAY_FIRST_PHRASES[language][id]);
    assertEquals(gaps, [], `${language} phrases missing`);
    for (const phrase of Object.values(HOLIDAY_FIRST_PHRASES[language])) assert(phrase.trim().length > 0 && !/confianza|unassisted/i.test(phrase), phrase);
  }
});

Deno.test('holidayFirstLabel: the plain phrase, else the catalog label, else null', () => {
  assertEquals(holidayFirstLabel('first-steps', 'es'), 'Dio sus primeros pasos');
  assertEquals(holidayFirstLabel('no-such-milestone', 'es'), null);
  assertEquals(holidayFirstLabel('potty-trained', 'es'), 'Adiós al pañal'); // not in the plain map: catalog label (never shown, sensitive)
});

Deno.test('holiday film close: falls back to the core plus others (recorded), then to everyone\'s portraits', () => {
  const withOthers = holiday(withClose([together('uncle', '2026-09-25', [...CORE, GRAN]), together('no-dad', '2026-09-26', [TOMAS, LUCIA, ADRI])]));
  assertEquals(closeIds(withOthers), ['uncle']);
  assert(scenes(withOthers, 'close')[0].frames[0].why.includes('fallback'));
  assert(withOthers.dropped.some((d) => d.scene === 'close' && d.reason.includes('plus other people')));
  const none = holiday(withClose([together('no-dad', '2026-09-26', [TOMAS, LUCIA, ADRI])]));
  const close = scenes(none, 'close')[0];
  assertEquals(close.source, 'portraits');
  assertEquals(close.frames.length, 4); // both children and both parents
  assert(none.dropped.some((d) => d.scene === 'close' && d.reason.includes('core family')));
});

Deno.test('holiday film: certain firsts are in the film, by date, within the budget', () => {
  const memories = withClose([
    memory({ id: 'bike', date: '2026-06-11', taggedMemberIds: [TOMAS] }),
    memory({ id: 'steps', date: '2026-04-11', taggedMemberIds: [LUCIA] }),
    memory({ id: 'unsure', date: '2026-05-11', taggedMemberIds: [TOMAS], text: 'Hoy andó en bici otra vez, qué contento' }),
  ]);
  const milestones = [
    { memoryId: 'bike', familyMemberId: TOMAS, milestoneId: 'bike-no-training-wheels', status: 'confirmed' as const },
    { memoryId: 'steps', familyMemberId: LUCIA, milestoneId: 'first-steps', status: 'confirmed' as const },
    { memoryId: 'unsure', familyMemberId: TOMAS, milestoneId: 'balance-bike', status: 'candidate' as const },
  ];
  const script = holiday(memories, { milestones });
  const firsts = scenes(script, 'firsts')[0];
  assertEquals(firsts.items.map((f) => f.memoryId), ['steps', 'bike']);
  assertEquals(firsts.items.map((f) => f.childName), ['Lucía', 'Tomás']);
  assert(script.estimatedSeconds <= 60, `${script.estimatedSeconds}s`);
  assertEquals(scenes(holiday(memories), 'firsts').length, 0);
  // The unconfirmed list: the candidate, with why the gate says no.
  const list = unconfirmedFirsts(memories, milestones, [tomas, lucia], 'es');
  assertEquals(list.map((f) => [f.memoryId, f.childName, f.gatePasses]), [['unsure', 'Tomás', false]]);
  assert(list[0].reason.includes('"first"'));
  const said = [{ ...memories.at(-1)!, id: 'said', text: 'Primera vez que anda en bici sin ayuda' }];
  const gate = unconfirmedFirsts(said, [{ memoryId: 'said', familyMemberId: TOMAS, milestoneId: 'balance-bike', status: 'candidate' }], [tomas], 'en');
  assertEquals(gate.map((f) => f.gatePasses), [true]);
});

Deno.test('familyDisplayName strips "The … Family" / "Familia …"', () => {
  assertEquals(familyDisplayName('The Rivera Soto Family'), 'Rivera Soto');
  assertEquals(familyDisplayName('Familia Rivera Soto'), 'Rivera Soto');
  assertEquals(familyDisplayName('Rivera Soto'), 'Rivera Soto');
});
