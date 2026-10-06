import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { PortraitVersionCandidate } from './portrait-versions.ts';
import { buildDigestFromPool, buildDigestFromScript, DIGEST_EXCERPT_MAX, excerptOf, namedTrips, withQuoteContext } from './holiday-card-digest.ts';
import { holidayFilmScope } from './year-film-eligibility.ts';
import { buildHolidayScript, type FilmMemorySource, type FilmPerson } from './year-film-script.ts';

const TOMAS = 'tomas';
const LUCIA = 'lucia';
const EDU = 'edu';
const ADRI = 'adri';
const ABU = 'abu';
const SCOPE = holidayFilmScope(2026, '2026-10-04');

function portrait(id: string, memberId: string): PortraitVersionCandidate {
  return {
    id,
    family_member_id: memberId,
    reference_date: '2026-01-01',
    profile_picture_key: `${id}.jpg`,
    illustrated_profile_key: `${id}-ill.png`,
    illustrated_profile_status: 'ready',
    created_at: '2025-01-01T00:00:00Z',
  };
}

function person(id: string, name: string, dob: string | null, relationship: string, createdAt: string): FilmPerson {
  return { id, name, dateOfBirth: dob, relationship, createdAt, portraits: [portrait(`p-${id}`, id)] };
}

const tomas = person(TOMAS, 'Tomás Rivera Soto', '2022-10-17', 'child', '2024-01-02');
const lucia = person(LUCIA, 'Lucía Rivera Soto', '2024-11-14', 'child', '2024-11-10');
const edu = person(EDU, 'Eduardo Rivera', '1985-05-05', 'parent', '2024-01-01');
const adri = person(ADRI, 'Adriana Soto', '1987-03-14', 'parent', '2024-01-02');
const abu = person(ABU, 'Rosa Soto', '1955-01-01', 'grandparent', '2024-01-03');
const members = [edu, adri, tomas, lucia, abu];

let counter = 0;
function memory(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  counter += 1;
  const id = overrides.id ?? `m${String(counter).padStart(3, '0')}`;
  return {
    id,
    date: '2026-03-15',
    type: 'media',
    text: `Un día en el parque con la familia, memoria número ${counter}`,
    emotion: 'joy',
    topics: ['park-playground'],
    taggedMemberIds: [TOMAS],
    illustrationReady: false,
    illustrationKey: null,
    media: [{ kind: 'image', durationMs: null, hasPreview: true }],
    assets: [{ kind: 'image', key: `${id}.jpg`, previewKey: `${id}-p.jpg`, durationMs: null, aspectRatio: 0.75 }],
    reported: false,
    ...overrides,
  };
}

function year(): FilmMemorySource[] {
  const out: FilmMemorySource[] = [];
  ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].forEach((month, i) => {
    out.push(memory({ date: `${month}-03`, topics: ['park-playground'], taggedMemberIds: [TOMAS, LUCIA] }));
    out.push(memory({ date: `${month}-09`, topics: ['beach'], taggedMemberIds: [TOMAS, ABU, LUCIA, EDU] }));
    out.push(memory({ date: `${month}-14`, topics: ['pretend-play'], taggedMemberIds: [TOMAS] }));
    out.push(memory({ date: `${month}-20`, topics: ['christmas'], emotion: i % 2 ? 'funny' : 'joy', taggedMemberIds: [LUCIA] }));
  });
  return out;
}

const context = { familyName: 'Rivera Soto' };

Deno.test('excerptOf: one line, no links, cut within the cap on a word boundary', () => {
  assertEquals(excerptOf('  hola\n\n  mundo  https://example.com/x?y=1 fin '), 'hola mundo fin');
  const long = excerptOf(`${'palabra '.repeat(40)}`);
  assert(Array.from(long).length <= DIGEST_EXCERPT_MAX, `${Array.from(long).length}`);
  assert(long.endsWith('…'));
  assertEquals(excerptOf(null), '');
});

Deno.test('digest v2 from the pool: people, per-child profiles, themes and places, a few optional highlights', () => {
  const memories = [
    ...year(),
    memory({ id: 'bath', date: '2026-04-04', topics: ['bath'], text: 'Bañándose con los patitos de goma', taggedMemberIds: [TOMAS] }),
    memory({ id: 'potty', date: '2026-05-04', text: 'Hoy hizo pipí en el baño por primera vez', taggedMemberIds: [TOMAS] }),
    memory({ id: 'sad', date: '2026-06-04', emotion: 'sad', text: 'Un día difícil para todos en casa', taggedMemberIds: [TOMAS] }),
    memory({ id: 'reported', date: '2026-07-04', reported: true, text: 'Memoria reportada por alguien más', taggedMemberIds: [TOMAS] }),
    memory({ id: 'after', date: '2026-10-05', text: 'Una memoria posterior al día de la tarjeta', taggedMemberIds: [TOMAS] }),
  ];
  const digest = buildDigestFromPool(memories, [], members, SCOPE, 'es', context);
  assertEquals(digest.filmPresent, false);
  assertEquals(digest.familyName, 'Rivera Soto');
  assertEquals(digest.language, 'es');
  assertEquals(digest.people, [
    { name: 'Tomás', role: 'child', ageYears: 3 },
    { name: 'Lucía', role: 'child', ageYears: 1 },
    { name: 'Eduardo', role: 'parent', ageYears: null },
    { name: 'Adriana', role: 'parent', ageYears: null },
  ]);
  // Profiles, oldest first, with the age the letter states (December) and the birthday inside the year.
  const [tomasP, luciaP] = digest.children;
  assertEquals([tomasP.name, tomasP.ageYears, tomasP.ageThisYear, tomasP.birthdayThisYear], ['Tomás', 3, 4, '2026-10-17']);
  assertEquals([luciaP.name, luciaP.ageYears, luciaP.ageThisYear, luciaP.birthdayThisYear], ['Lucía', 1, 2, '2026-11-14']);
  assertEquals(tomasP.memories, 27); // park, beach and pretend-play, 9 each; the sensitive/sad/reported ones never count
  assert(tomasP.recurring.length > 0 && tomasP.recurring.length <= 4);
  const pretend = tomasP.recurring.find((t) => t.topicId === 'pretend-play');
  assertEquals(pretend?.phrase, 'disfrazarse y jugar a imaginar'); // third person, not "disfrazarte"/"disfrazarnos"
  assertEquals(pretend?.memories, 9);
  assert(tomasP.recurring.every((t) => t.memories >= 3 && t.lift > 0));
  assertEquals(tomasP.emotions.map((e) => e.emotion), ['joy']);
  assert(tomasP.excerpts.length > 0 && tomasP.excerpts.length <= 3);
  assert(!tomasP.recurring.some((t) => ['bath', 'tough-days', 'doctor-dentist'].includes(t.topicId)));
  // Highlights are secondary: ≤ 6, never sensitive, sad, reported or after the card date.
  assert(digest.highlights.length > 0 && digest.highlights.length <= 6, `${digest.highlights.length}`);
  const ids = digest.highlights.map((h) => h.memoryId);
  for (const bad of ['bath', 'potty', 'sad', 'reported', 'after']) assert(!ids.includes(bad), bad);
  assert(digest.highlights.every((h) => !h.inFilm && h.sceneHint === undefined));
  assert(digest.highlights.every((h) => Array.from(h.excerpt).length <= DIGEST_EXCERPT_MAX));
  assertEquals([...digest.highlights].map((h) => h.date), [...digest.highlights].map((h) => h.date).sort());
  // The grandparent is never named: only a role.
  const beach = buildDigestFromPool([year().find((m) => m.topics.includes('beach'))!], [], members, SCOPE, 'es', context).highlights[0];
  assertEquals(beach.withRoles, ['grandparent']);
  assertEquals(beach.taggedPeople, ['Tomás', 'Lucía', 'Eduardo']);
  // Family level.
  assert(digest.familyThemes.length > 0 && digest.familyThemes.length <= 5);
  assertEquals(digest.places.map((p) => [p.topicId, p.memories]), [['beach', 9], ['park-playground', 9]]);
  assertEquals(digest.counts.moments, year().length);
  assertEquals(digest.counts.months, 9);
  // Other family members' first names and every surname are for the post-check only.
  assertEquals(digest.forbiddenNames, ['Rivera', 'Rosa', 'Soto']);
  // A parent profile only with evidence: Eduardo is in 9 beach moments, Adriana in none.
  assertEquals(digest.parents.map((p) => [p.name, p.memories, p.recurring.map((t) => t.topicId)]), [['Eduardo', 9, ['beach']]]);
});

Deno.test('digest: a thin year gives fewer highlights and profiles with no pattern, never padding', () => {
  const memories = [
    memory({ id: 'xmas', date: '2026-01-04', topics: ['christmas'], emotion: 'calm', text: 'Abriendo los regalos de Reyes en familia' }),
    memory({ id: 'plain', date: '2026-01-05', topics: [], emotion: 'calm', text: 'Un martes cualquiera en casa con todos' }),
  ];
  const digest = buildDigestFromPool(memories, [], members, SCOPE, 'es', context);
  assertEquals(digest.highlights.map((h) => h.memoryId), ['xmas', 'plain']);
  assertEquals(digest.children[0].recurring, []); // nothing recurs 3 times
  assertEquals(digest.children[1].memories, 0);
  assertEquals(digest.parents, []);
  const noText = buildDigestFromPool([memory({ id: 'x', text: null }), memory({ id: 'y', text: 'corto' })], [], members, SCOPE, 'es', context);
  assertEquals(noText.highlights, []);
});

Deno.test('digest from the film script: same profiles as the pool path; the film adds filmPresent, marks and the line of the year', () => {
  const memories = year();
  const quoteMemory = memories.find((m) => m.taggedMemberIds.length === 1 && m.taggedMemberIds[0] === TOMAS)!;
  const script = buildHolidayScript({
    year: 2026,
    scope: SCOPE,
    familyName: 'Rivera Soto',
    memories,
    children: [tomas, lucia],
    members,
    milestones: [],
    quotes: [{ memoryId: quoteMemory.id, quote: 'ay qué rico', speakerId: TOMAS }],
    language: 'es',
  });
  const digest = buildDigestFromScript(script, memories, members, 'es', context);
  assertEquals(digest.filmPresent, true);
  assert(digest.highlights.some((h) => h.inFilm && h.sceneHint));
  assertEquals(digest.children.find((n) => n.name === 'Tomás')!.line?.quote, 'ay qué rico');
  assertEquals(digest.lineOfYear, { quote: 'ay qué rico', speaker: 'Tomás', memoryId: quoteMemory.id });
  const pooled = buildDigestFromPool(memories, [], members, SCOPE, 'es', context);
  assertEquals(pooled.lineOfYear, null);
  assertEquals(digest.counts, pooled.counts);
  const strip = (d: typeof digest) => d.children.map((c) => ({ ...c, line: null }));
  assertEquals(strip(digest), strip(pooled));
  assertEquals(digest.familyThemes, pooled.familyThemes);
  assertEquals(digest.places, pooled.places);
  // Quotes can also come from the caller on the pool path.
  const quoted = buildDigestFromPool(memories, [], members, SCOPE, 'es', { ...context, quotes: [{ memoryId: quoteMemory.id, quote: 'ay qué rico', speakerId: TOMAS }] });
  assertEquals(quoted.lineOfYear?.speaker, 'Tomás');
});

Deno.test('digest: a milestone that makes a memory share-sensitive keeps it out', () => {
  const memories = [...year(), memory({ id: 'ms', date: '2026-04-04', text: 'Gran día, ya no usa pañal ni nada', taggedMemberIds: [TOMAS], emotion: 'pride' })];
  const milestones = [{ memoryId: 'ms', familyMemberId: TOMAS, milestoneId: 'potty-trained', status: 'confirmed' }];
  const digest = buildDigestFromPool(memories, milestones, members, SCOPE, 'es', context);
  assert(!digest.highlights.some((h) => h.memoryId === 'ms'));
  assert(!digest.children[0].excerpts.some((e) => e.memoryId === 'ms'));
});

Deno.test('digest v3: concrete details per child and per theme, cleaned; certain firsts; gender and nicknames', () => {
  const memories = year().map((m, i) => ({
    ...m,
    labels: m.topics.includes('pretend-play')
      ? ['Superhero Costume', 'costume', 'photo', 'Rosa', 'park', 'tomás', 'a very long label that has too many words']
      : m.topics.includes('park-playground')
      ? ['red slide', 'family', `bench ${i}`]
      : [],
  }));
  const kids = [
    { ...tomas, gender: 'male', nicknames: ['Tomasito'] },
    { ...lucia, gender: 'female' },
  ];
  const withFirst = [...memories, memory({ id: 'steps', date: '2026-01-17', taggedMemberIds: [LUCIA], text: 'Lucía dio sus primeros pasos sola en la sala', labels: [] })];
  const milestones = [{ memoryId: 'steps', familyMemberId: LUCIA, milestoneId: 'walking', status: 'confirmed' }];
  const digest = buildDigestFromPool(withFirst, milestones, [edu, adri, ...kids, abu], SCOPE, 'es', context);
  const [e, m] = digest.children;
  assertEquals([e.gender, e.nicknames, m.gender, m.nicknames], ['male', ['Tomasito'], 'female', []]);
  // Generic labels, topic words, people's names, long labels and labels with digits never make it.
  assertEquals(e.details, [{ label: 'superhero costume', memories: 9 }, { label: 'costume', memories: 9 }, { label: 'red slide', memories: 9 }, { label: 'park', memories: 9 }].sort((a, b) => b.memories - a.memories || a.label.localeCompare(b.label)).slice(0, 6));
  const pretend = e.recurring.find((t) => t.topicId === 'pretend-play')!;
  assertEquals(pretend.details?.map((d) => d.label), ['costume', 'park', 'superhero costume']);
  assertEquals(e.firsts, []);
  assertEquals(m.firsts.map((f) => [f.milestoneId, f.date, f.month, f.memoryId, f.confirmed]), [['walking', '2026-01-17', 1, 'steps', true]]);
  assert(!digest.children.flatMap((c) => c.details).some((d) => /rosa|tom[aá]s/i.test(d.label)));
  // A candidate is a first only when the memory's own words say so; otherwise it is not.
  const quiet = withFirst.map((x) => (x.id === 'steps' ? { ...x, text: 'Lucía camina por toda la sala sola ahora' } : x));
  const candidate = buildDigestFromPool(quiet, [{ ...milestones[0], status: 'candidate' }], [edu, adri, ...kids, abu], SCOPE, 'es', context);
  assertEquals(candidate.children[1].firsts, []);
  const said = buildDigestFromPool(withFirst, [{ ...milestones[0], status: 'candidate' }], [edu, adri, ...kids, abu], SCOPE, 'es', context);
  assertEquals(said.children[1].firsts.map((f) => f.confirmed), [false]);
});

Deno.test('v7: the line of the year carries its moment (the words just before the quote)', () => {
  const line = { quote: 'papá, la luna nos sigue', memoryId: 'm1' };
  const pool = [{ id: 'm1', text: 'Mirando por la ventana de noche, Tomás se volteó y me dijo: "papá, la luna nos sigue". Nos reímos mucho.' }];
  assertEquals(withQuoteContext(line, pool).context, 'Mirando por la ventana de noche, Tomás se volteó y me dijo:');
  assertEquals(withQuoteContext(line, [{ id: 'm1', text: 'papá, la luna nos sigue' }]).context, undefined);
  assertEquals(withQuoteContext(line, []).context, undefined);
});

Deno.test('v8: named trips come from place labels on consecutive days or travel memories', () => {
  const mem = (id: string, date: string, labels: string[], topics: string[] = []) =>
    ({ id, date, labels, topics, text: null, emotion: null, taggedMemberIds: [], illustrationReady: false, media: [], reported: false }) as unknown as Parameters<typeof namedTrips>[0][number];
  const pool = [
    mem('a', '2026-07-10', ['Cartagena', 'beach'], ['beach']),
    mem('b', '2026-07-11', ['Cartagena', 'sand'], ['beach']),
    mem('c', '2026-07-12', ['Cartagena'], ['beach']),
    mem('d', '2026-05-02', ['Pelusa', 'Spiderman'], ['pretend-play']),
    mem('e', '2026-06-20', ['Pelusa'], ['days-out']),
    mem('f', '2026-04-02', ['Tomás', 'Lisboa'], []),
  ];
  assertEquals(namedTrips(pool, ['Tomás']), [{ place: 'Cartagena', month: 7, days: 3, memories: 3 }]);
});
