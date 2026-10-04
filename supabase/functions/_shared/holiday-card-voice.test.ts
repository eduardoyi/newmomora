import { assert, assertEquals } from 'jsr:@std/assert@1';
import {
  buildVoiceCardPrompt,
  buildVoiceCardRequestBody,
  characteristicWords,
  describeVoiceCard,
  parseVoiceCard,
  selectVoiceSamples,
  sharedWordRun,
  VOICE_CARD_MODEL,
  VOICE_SAMPLE_MAX_CHARS,
  voiceExamples,
} from './holiday-card-voice.ts';
import type { FilmMemorySource } from './year-film-script.ts';

const PARENT = 'acct-parent';
const RELATIVE = 'acct-aunt';

let n = 0;
function memory(overrides: Partial<FilmMemorySource>): FilmMemorySource {
  n += 1;
  return {
    id: `m${String(n).padStart(3, '0')}`,
    date: '2026-03-15',
    type: 'text_only',
    text: `Hoy fuimos al parque con los chicos y nos reímos muchísimo, captura ${n}`,
    emotion: 'joy',
    topics: [],
    taggedMemberIds: [],
    illustrationReady: false,
    illustrationKey: null,
    media: [],
    assets: [],
    reported: false,
    authorId: PARENT,
    ...overrides,
  };
}

const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

Deno.test('voice samples: the parents\' captions only, share-safe, long enough, last 12 months, spread and mixed', () => {
  const memories: FilmMemorySource[] = [];
  months.forEach((month, i) => {
    for (let k = 1; k <= 6; k += 1) memories.push(memory({ date: `${month}-${String(k * 4).padStart(2, '0')}`, emotion: k % 2 ? 'joy' : 'funny' }));
    if (i === 3) memories.push(memory({ id: 'tooshort', date: `${month}-02`, text: 'Parque hoy' }));
  });
  memories.push(
    memory({ id: 'aunt', date: '2026-05-05', authorId: RELATIVE }),
    memory({ id: 'old', date: '2024-05-05' }),
    memory({ id: 'sad', date: '2026-05-06', emotion: 'sad' }),
    memory({ id: 'potty', date: '2026-05-07', text: 'Hoy hizo pipí en el baño y todos aplaudimos mucho en casa' }),
    memory({ id: 'reported', date: '2026-05-08', reported: true }),
    memory({ id: 'long', date: '2026-06-09', text: `${'palabra '.repeat(80)}` }),
  );
  const samples = selectVoiceSamples(memories, [], { parentAuthorIds: [PARENT], today: '2026-10-04' });
  const ids = samples.map((s) => s.memoryId);
  assertEquals(samples.length, 40);
  for (const bad of ['aunt', 'old', 'sad', 'potty', 'reported', 'tooshort']) assert(!ids.includes(bad), bad);
  assert(samples.every((s) => Array.from(s.text).length <= VOICE_SAMPLE_MAX_CHARS && s.date >= '2025-10-04'));
  assertEquals([...samples].map((s) => s.date), [...samples].map((s) => s.date).sort());
  // Every month is represented; both moods are.
  assertEquals(new Set(samples.map((s) => s.date.slice(0, 7))).size, months.length);
  assertEquals(new Set(samples.map((s) => s.emotion)), new Set(['joy', 'funny']));
  // Deterministic, and no parent accounts means no samples.
  assertEquals(selectVoiceSamples(memories, [], { parentAuthorIds: [PARENT], today: '2026-10-04' }), samples);
  assertEquals(selectVoiceSamples(memories, [], { parentAuthorIds: [], today: '2026-10-04' }), []);
});

const SAMPLES = [
  { memoryId: 'a', date: '2026-01-01', emotion: 'joy', text: 'Hoy Enzo se puso sus lentes de sol y salió corriendo al jardín gritando que era un pirata' },
  { memoryId: 'b', date: '2026-02-01', emotion: 'funny', text: 'Jaja Mara no quiso soltar la cuchara en todo el almuerzo, súper terca' },
];

const GOOD_CARD = {
  register: 'casual tú; slangy; short fragments',
  kids_reference: 'first names, often with diminutives',
  person: 'we',
  addressee: 'about_the_child',
  sentence_length: 'short',
  rhythm: 'short fragments, then one longer one',
  formality: 'casual',
  humor: 'playful',
  openers: ['Hoy', 'Jaja'],
  closers: ['a light remark'],
  punctuation: { exclamations: 'rare', emojis: 'none', ellipses: 'rare', notes: 'no accents on caps' },
  characteristic: ['súper', 'jaja', 'lentes', 'terca'],
  never: ['use emojis'],
};

Deno.test('voice card prompt describes style only and the request uses the cheap model', () => {
  const { system, user } = buildVoiceCardPrompt(SAMPLES);
  assert(system.includes('STYLE only') || system.includes('Describe STYLE only'));
  assert(system.includes('no names of any person') && system.includes('characteristic'));
  assert(user.includes('2 captions') && user.includes('1. Hoy Enzo'));
  const body = buildVoiceCardRequestBody(VOICE_CARD_MODEL, system, user) as { model: string };
  assertEquals(body.model, 'gpt-6-luna');
});

Deno.test('parseVoiceCard: validates the card, drops names and copied captions, rejects missing essentials', () => {
  const ctx = { samples: SAMPLES, names: ['Enzo', 'Mara', 'Rivera', 'Soto'] };
  const ok = parseVoiceCard(JSON.stringify(GOOD_CARD), ctx);
  assertEquals(ok.flags, []);
  assertEquals(ok.card?.person, 'we');
  assertEquals(ok.card?.punctuation, { exclamations: 'rare', emojis: 'none', ellipses: 'rare', notes: 'no accents on caps' });
  assertEquals(ok.card?.characteristic, ['súper', 'jaja', 'lentes', 'terca']);
  const dirty = parseVoiceCard(JSON.stringify({
    ...GOOD_CARD,
    kids_reference: 'calls Enzo "Enzito"',
    characteristic: ['súper', 'jaja', 'lentes', 'Mara no quiso soltar la cuchara en todo el almuerzo', 'Enzo pirata', 'x'.repeat(200)],
    openers: ['Hoy', 'Hoy', 7, ''],
    humor: 'sarcastic',
  }), ctx);
  assertEquals(dirty.card, null); // an invalid enum on an essential field
  const partial = parseVoiceCard(JSON.stringify({
    ...GOOD_CARD,
    kids_reference: 'calls Enzo "Enzito"',
    characteristic: ['súper', 'jaja', 'lentes', 'no quiso soltar la cuchara en todo el almuerzo', 'Enzo pirata'],
    openers: ['Hoy', 'Hoy', 7, ''],
    addressee: 'whatever',
  }), ctx);
  assertEquals(partial.card?.kidsReference, 'not clear from the samples');
  assertEquals(partial.card?.characteristic, ['súper', 'jaja', 'lentes']);
  assertEquals(partial.card?.openers, ['Hoy']);
  assertEquals(partial.card?.addressee, 'about_the_child');
  assertEquals(new Set(partial.flags), new Set(['dropped_name', 'dropped_copy']));
  assertEquals(parseVoiceCard('nope', ctx), { card: null, flags: ['bad_json'] });
  assertEquals(parseVoiceCard('[]', ctx).card, null);
  assertEquals(parseVoiceCard(JSON.stringify({ language: 'es' }), ctx).flags.includes('bad_shape'), true);
  assert(parseVoiceCard(JSON.stringify({ ...GOOD_CARD, characteristic: ['uno'] }), ctx).flags.includes('too_few_characteristic'));
});

Deno.test('describeVoiceCard: every field becomes a prompt line, no sample content', () => {
  const card = parseVoiceCard(JSON.stringify(GOOD_CARD), { samples: SAMPLES, names: [] }).card!;
  const lines = describeVoiceCard(card).join('\n');
  assert(lines.includes('how they address people: casual tú') && lines.includes('they never: "use emojis"') && lines.includes('how they end a thought'));
  // Voice is register and rhythm: caption openers and catchphrases are not in the style lines.
  assert(!lines.includes('Hoy') && !lines.includes('súper') && !lines.includes('jaja'));
  assert(!lines.includes('pirata'));
  assertEquals(characteristicWords(card), ['súper', 'jaja', 'lentes', 'terca']);
});

Deno.test('voice examples: short verbatim snippets, spread, never naming someone outside the family', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    memoryId: `s${i}`,
    date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    emotion: 'joy',
    text: i === 4 ? 'Hoy fuimos con la abuela Rosa al mercado y compramos de todo un poco' : `Hoy fuimos al parque otra vez y nos reímos muchísimo, vuelta número ${i}`,
  }));
  const examples = voiceExamples(samples, { forbiddenNames: ['Rosa'] });
  assertEquals(examples.length, 5);
  assert(examples.every((e) => !e.includes('Rosa') && Array.from(e).length <= 160));
  assertEquals(new Set(examples).size, 5);
  assertEquals(voiceExamples([], { forbiddenNames: [] }), []);
});

Deno.test('sharedWordRun finds the longest copied run of words', () => {
  assertEquals(sharedWordRun('Nos reímos muchísimo en el parque hoy', 'Ayer nos reímos muchísimo en el parque'), 6);
  assertEquals(sharedWordRun('algo distinto', 'nada que ver'), 0);
});

Deno.test('parseVoiceCard: a register that names someone falls back instead of losing the whole card', () => {
  const { card, flags } = parseVoiceCard(JSON.stringify({ ...GOOD_CARD, register: 'Spanish as Enzo writes it' }), { samples: SAMPLES, names: ['Enzo'] });
  assertEquals(card?.register, 'not clear from the samples');
  assert(flags.includes('dropped_name'));
});

Deno.test('parseVoiceCard: no region guessing — a register that names a country or dialect is replaced', () => {
  const ctx = { samples: SAMPLES, names: [] };
  for (const bad of ['Colombian Spanish; ustedes', 'Latin American Spanish, tuteo', 'español de España', 'Mexican, casual', 'a Caribbean dialect']) {
    const { card, flags } = parseVoiceCard(JSON.stringify({ ...GOOD_CARD, register: bad }), ctx);
    assertEquals(card?.register, 'not clear from the samples', bad);
    assert(flags.includes('dropped_region'), bad);
  }
  assertEquals(parseVoiceCard(JSON.stringify({ ...GOOD_CARD, register: 'casual tú; very slangy' }), ctx).card?.register, 'casual tú; very slangy');
  // The card no longer carries a language, and does not require one from the model.
  const { card } = parseVoiceCard(JSON.stringify({ ...GOOD_CARD, language: 'es-CO' }), ctx);
  assert(card && !('language' in card));
  assert(buildVoiceCardPrompt(SAMPLES).system.includes('Do NOT guess or mention a country, region, dialect'));
  assert(!buildVoiceCardPrompt(SAMPLES).system.includes('"language"'));
});
