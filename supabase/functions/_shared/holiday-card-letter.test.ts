import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { YearDigest } from './holiday-card-digest.ts';
import type { VoiceCard } from './holiday-card-voice.ts';
import {
  ABSTRACT_FILLER_EXAMPLES,
  CARD_GREETINGS,
  greetingWishNote,
  isCardGreeting,
  occasionMismatch,
  buildLetterRequestBody,
  buildLetterSystemPrompt,
  greetingOnItsOwnLine,
  quotesLineCore,
  sharedSpecifics,
  turningNote,
  bestDetails,
  buildLetterUserPrompt,
  checkLetterText,
  defaultSignature,
  isHardFlag,
  LETTER_MAX_CHARS,
  LETTER_MODEL,
  mergeLetterRetry,
  parseLetterResponse,
  plainFirst,
  QR_CAPTION_MAX_CHARS,
  registerNote,
  resolveLetterLanguage,
  tonesNeedingLine,
} from './holiday-card-letter.ts';

function digest(overrides: Partial<YearDigest> = {}): YearDigest {
  return {
    familyName: 'Rivera Soto',
    language: 'es',
    scope: { start: '2026-01-01', endExclusive: '2026-10-05' },
    people: [
      { name: 'Enzo', role: 'child', ageYears: 3 },
      { name: 'Mara', role: 'child', ageYears: 1 },
      { name: 'Eduardo', role: 'parent', ageYears: null },
      { name: 'Adriana', role: 'parent', ageYears: null },
    ],
    children: [
      {
        memberId: 'enzo', specifics: [{ detail: 'Spider-Man', memories: 4, recurring: true }, { detail: 'el tren azul', memories: 1, recurring: false }], name: 'Enzo', gender: 'male', nicknames: ['Enzito'], details: [{ label: 'superhero costume', memories: 6 }, { label: 'red slide', memories: 4 }], firsts: [],
        ageYears: 3, ageThisYear: 4, birthdayThisYear: '2026-10-23', memories: 41,
        recurring: [{ topicId: 'pretend-play', phrase: 'disfrazarse y jugar a imaginar', memories: 9, lift: 1.8, details: [{ label: 'superhero costume', memories: 6 }] }, { topicId: 'park-playground', phrase: 'ir al parque', memories: 12, lift: 1.1 }],
        emotions: [{ emotion: 'joy', share: 0.55 }, { emotion: 'funny', share: 0.2 }],
        excerpts: [{ memoryId: 'h1', excerpt: 'Enzo se disfrazó de bombero en el parque' }],
        line: { quote: 'ay qué rico', memoryId: 'h1' },
      },
      {
        memberId: 'mara', specifics: [], name: 'Mara', gender: 'female', nicknames: [], details: [], ageYears: 1, ageThisYear: 2, birthdayThisYear: '2026-11-08', memories: 30,
        firsts: [{ milestoneId: 'walking', label: 'Camina con confianza', date: '2026-01-17', month: 1, memoryId: 'steps', confirmed: true }],
        recurring: [{ topicId: 'beach', phrase: 'ir a la playa', memories: 7, lift: 1.5 }],
        emotions: [{ emotion: 'joy', share: 0.6 }],
        excerpts: [{ memoryId: 'h2', excerpt: 'Día de playa con los abuelos, Mara probó la arena' }],
        line: null,
      },
    ],
    parents: [{ name: 'Eduardo', memories: 9, recurring: [{ topicId: 'beach', phrase: 'ir a la playa', memories: 9, lift: 3.1 }] }],
    familyThemes: [{ topicId: 'beach', phrase: 'ir a la playa', memories: 9, lift: 2 }],
    places: [{ topicId: 'beach', phrase: 'ir a la playa', memories: 9, lift: 1 }],
    highlights: [
      { memoryId: 'h3', date: '2026-08-20', month: 8, excerpt: 'Cumpleaños con globos y pastel en casa', taggedPeople: ['Enzo', 'Mara'], withRoles: ['grandparent'], emotion: 'joy', topics: ['birthday'], inFilm: false },
    ],
    lineOfYear: { quote: 'ay qué rico', speaker: 'Enzo', memoryId: 'h1' },
    counts: { moments: 163, photos: 114, videos: 28, drawings: 2, sounds: 2, outings: 40, months: 9 },
    filmPresent: true,
    forbiddenNames: ['Rivera', 'Rosa', 'Soto'],
    ...overrides,
  };
}

const GOOD = 'Querida familia, este año Enzo no se quita el disfraz de bombero, y Mara vive para la playa. Les deseamos unas fiestas tranquilas.';

function raw(variants: unknown[], qr: unknown = 'Escanea para ver nuestro año: la playa y los disfraces') {
  return JSON.stringify({ language: 'es', variants, qr_caption: qr });
}

const four = (text = GOOD) => [
  { tone: 'classic', text },
  { tone: 'short', text: 'Enzo y Mara, juntos y felices. Les deseamos unas fiestas muy lindas.' },
  { tone: 'playful', text },
  { tone: 'reflective', text },
];

Deno.test('system prompt: the genre, the stand-alone rules, the shapes and the caps', () => {
  const system = buildLetterSystemPrompt({ language: 'en' });
  assert(system.includes('English') && system.includes('STAND ON ITS OWN'));
  assert(system.includes('NEVER MENTION') && system.includes('QR'));
  assert(system.includes('two or three plain, specific, true things') && system.includes('ONLY place for a list') && system.includes('VARIETY') && system.includes('NATIVELY'));
  assert(system.includes('"classic"') && system.includes('"reflective"') && !system.includes('"warm"'));
  assert(system.includes(String(LETTER_MAX_CHARS.classic)) && system.includes(String(LETTER_MAX_CHARS.short)));
  assert(!system.includes('mentioned_memory_ids'));
  const es = buildLetterSystemPrompt({ language: 'es' });
  assert(es.includes('Spanish') && es.includes('neutral Latin-American Spanish'));
});

Deno.test('user prompt: profiles first, phrases in the letter language, no surnames, no film talk', () => {
  const user = buildLetterUserPrompt(digest(), { language: 'en' });
  assert(user.includes('TARGET LANGUAGE: English (en)'));
  assert(user.includes('Enzo — age this December: 4; TURNS 4 on'));
  assert(user.includes('dress-up and pretend play ×9 (about 1.8× the family\'s usual)')); // English phrase, third person
  assert(user.includes('going to the park ×12') && !user.includes('(about 1.1×'));
  assert(user.includes('usual mood: joy 55%, funny 20%'));
  assert(user.includes('tone only') && user.includes('PARENTS (light evidence') && user.includes('specific things about Enzo'));
  assert(user.includes('Spider-Man (comes up in 4 moments); el tren azul') && user.includes('(none extracted)'));
  assert(user.includes('OPTIONAL DETAILS (at most ONE'));
  // The child's line is only offered in the journal language.
  assert(!user.includes('ay qué rico'));
  assert(buildLetterUserPrompt(digest(), { language: 'es' }).includes('REQUIRED LINE — the "classic" and "playful" letters MUST quote this word for word, in quotation marks, as Enzo\'s main detail: "ay qué rico"'));
  assert(buildLetterUserPrompt(digest(), { language: 'es' }).includes('disfrazarse y jugar a imaginar ×9'));
  for (const secret of ['Soto', 'Rosa', 'Rivera Soto']) assert(!user.includes(secret), secret);
  const noFilm = buildLetterUserPrompt(digest({ filmPresent: false }), { language: 'es' });
  assert(noFilm.includes('FILM: no') && !noFilm.includes('FILM: yes'));
  const body = buildLetterRequestBody(LETTER_MODEL, 'sys', user) as { model: string; messages: { role: string }[] };
  assertEquals(body.model, LETTER_MODEL);
  assertEquals(body.messages.map((m) => m.role), ['system', 'user']);
});

Deno.test('defaultSignature from the family name, es + en', () => {
  assertEquals(defaultSignature('Rivera Soto', 'es'), 'Con cariño, la familia Rivera Soto');
  assertEquals(defaultSignature('Rivera Soto', 'en'), 'Love, the Rivera Soto family');
  assertEquals(defaultSignature('The Rivera Family', 'en'), 'Love, the Rivera family');
});

Deno.test('parseLetterResponse: four clean variants in shape order, a caption and the signature', () => {
  const result = parseLetterResponse(raw(four()), digest({ lineOfYear: null }), { language: 'es' });
  assertEquals(result.variants.map((v) => v.tone), ['classic', 'short', 'playful', 'reflective']);
  assertEquals(result.rejected, []);
  assertEquals(result.flags, []);
  assertEquals(result.qrCaption, 'Escanea para ver nuestro año: la playa y los disfraces');
  assertEquals(result.signature, 'Con cariño, la familia Rivera Soto');
  assert(result.variants.every((v) => v.flags.length === 0), JSON.stringify(result.variants.map((v) => v.flags)));
});

Deno.test('parseLetterResponse never trusts the model: bad JSON, shapes, duplicates, missing tones', () => {
  assertEquals(parseLetterResponse('nope', digest(), { language: 'es' }).flags[0].code, 'bad_shape');
  assertEquals(parseLetterResponse('{"variants":"x"}', digest(), { language: 'es' }).flags[0].code, 'bad_shape');
  const result = parseLetterResponse(raw([
    { tone: 'classic', text: GOOD },
    { tone: 'classic', text: GOOD },
    { tone: 'warm', text: GOOD }, // the old tone is not a tone any more
    { tone: 'short', text: 42 },
  ]), digest(), { language: 'es' });
  assertEquals(result.variants.map((v) => v.tone), ['classic']);
  assertEquals(result.rejected.map((r) => r.flags[0].code), ['duplicate_tone', 'bad_shape', 'bad_shape']);
  assertEquals(result.flags.filter((f) => f.code === 'missing_tone').map((f) => f.detail), ['short', 'playful', 'reflective']);
});

Deno.test('post-checks: length caps are hard, per shape', () => {
  const long = (n: number) => `${'Enzo '.repeat(Math.ceil(n / 5))}`.slice(0, n);
  const codes = (text: string, tone: 'classic' | 'short') => checkLetterText(text, tone, digest(), 'es').map((f) => f.code);
  assert(!codes(long(650), 'classic').includes('over_length'));
  assert(codes(long(651), 'classic').includes('over_length'));
  assert(!codes(long(280), 'short').includes('over_length'));
  assert(codes(long(281), 'short').includes('over_length'));
  const rejected = parseLetterResponse(raw([{ tone: 'short', text: long(300) }]), digest(), { language: 'es' });
  assertEquals(rejected.variants, []);
  assertEquals(rejected.rejected[0].flags.filter(isHardFlag).map((f) => f.code), ['over_length']);
});

Deno.test('post-checks: the letter never mentions the film, video or QR (hard); the caption may', () => {
  const check = (text: string) => checkLetterText(text, 'classic', digest(), 'es');
  for (const bad of ['Hicimos una película de nuestro año con Enzo y Mara', 'We made a little film about Enzo and Mara', 'Escanea el código para ver a Enzo', 'Watch the video of Enzo and Mara', 'Scan the QR']) {
    assert(check(bad).some((f) => f.code === 'film_mention' && isHardFlag(f)), bad);
  }
  assert(!check(GOOD).some((f) => f.code === 'film_mention'));
  assertEquals(parseLetterResponse(raw(four(), 'Escanea para ver nuestro año'), digest(), { language: 'es' }).qrCaption, 'Escanea para ver nuestro año');
});

Deno.test('post-checks: sensitive, health and developmental text are rejected; mood words only warn', () => {
  const check = (text: string) => checkLetterText(text, 'classic', digest(), 'es');
  for (const bad of ['Mara tuvo fiebre en agosto', 'Enzo dejó el pañal', 'We went to the hospital', 'Enzo went to the doctor', 'Mara está adelantada para su edad', 'Enzo is behind his cousins']) {
    assert(check(bad).some(isHardFlag), bad);
  }
  const mood = check('Enzo lloró un poco al despedirse del abuelo pero luego se rió con Mara en la playa');
  assert(mood.some((f) => f.code === 'mood_words') && !mood.some(isHardFlag));
});

Deno.test('post-checks: clichés and ages are soft flags; the classic letter must cover every child', () => {
  const flags = (text: string, tone: 'classic' | 'playful' = 'classic') => checkLetterText(text, tone, digest(), 'es').map((f) => f.code);
  assert(flags('Enzo y Mara llenaron el año de momentos inolvidables').includes('cliche'));
  assert(flags('This year was full of love for Enzo and Mara', 'playful').includes('cliche'));
  assert(!flags(GOOD).includes('cliche'));
  assert(flags('Enzo, de 7 años, y Mara, de 2 años, juegan mucho').includes('age_mismatch'));
  assert(!flags('Enzo, de 4 años, y Mara, de 2 años, juegan mucho').includes('age_mismatch'));
  assert(!flags('Enzo cumplió 3 años en el parque y Mara, de 2 años').includes('age_mismatch')); // the age at the card date is allowed too
  assert(flags('Enzo juega mucho en el parque con sus amigos').includes('child_missing'));
  assert(!flags('Enzo juega mucho en el parque con sus amigos', 'playful').includes('child_missing'));
});

Deno.test("post-checks: only the family's own first names; other members and surnames are rejected, strays flagged", () => {
  const check = (text: string) => checkLetterText(text, 'playful', digest(), 'es');
  assert(check('Enzo y Mara fueron con la abuela Rosa a la playa').some((f) => f.code === 'forbidden_name' && f.detail === 'Rosa'));
  assert(check('Un abrazo de los Soto').some((f) => f.code === 'forbidden_name'));
  assert(check('Un abrazo de Eduardo Rivera').some((f) => f.code === 'forbidden_name' && f.detail === 'Rivera'));
  const stray = check('Enzo y Mara jugaron con su amigo Tomás en la playa');
  assert(stray.some((f) => f.code === 'unknown_capitalized' && f.detail === 'Tomás') && !stray.some(isHardFlag));
  assertEquals(check('Querida familia,\n\nEste año Enzo y Mara vieron el mar en agosto. Eduardo y Adriana, felices.').filter((f) => f.code === 'unknown_capitalized'), []);
});

Deno.test('post-checks: quoted words must be words the digest has; language mismatch is flagged', () => {
  const flags = (text: string) => checkLetterText(text, 'playful', digest(), 'es').map((f) => f.code);
  assert(flags('Enzo dijo “me gusta el mar” todo el día en el parque.').includes('unverified_quote'));
  assert(!flags('Enzo dijo “ay qué rico” todo el día en el parque.').includes('unverified_quote'));
  assert(flags('We saw Enzo and Mara play at the park and the beach this year').includes('language_mismatch'));
});

Deno.test('QR caption: only with a film, ≤ 80 chars, same name and sensitivity checks', () => {
  const parse = (caption: unknown, d = digest()) => parseLetterResponse(raw(four(), caption), d, { language: 'es' });
  assertEquals(parse('x'.repeat(QR_CAPTION_MAX_CHARS)).qrCaption, 'x'.repeat(QR_CAPTION_MAX_CHARS));
  const long = parse('x'.repeat(QR_CAPTION_MAX_CHARS + 1));
  assertEquals(long.qrCaption, null);
  assert(long.flags.some((f) => f.code === 'caption_too_long'));
  assert(parse(null).flags.some((f) => f.code === 'caption_missing'));
  assert(parse('   ').flags.some((f) => f.code === 'caption_missing'));
  const rosa = parse('Escanea para ver a la abuela Rosa');
  assertEquals(rosa.qrCaption, null);
  assert(rosa.flags.some((f) => f.code === 'caption_rejected'));
  const none = parse('Escanea para ver nuestro año', digest({ filmPresent: false }));
  assertEquals(none.qrCaption, null);
  assertEquals(none.flags, []);
});

const VOICE: { card: VoiceCard; examples: string[]; language: 'es' } = {
  language: 'es',
  card: {
    register: 'casual tú, slangy',
    kidsReference: 'first names with diminutives',
    person: 'we',
    addressee: 'about_the_child',
    sentenceLength: 'short',
    rhythm: 'short fragments',
    formality: 'casual',
    humor: 'playful',
    openers: ['Hoy'],
    closers: [],
    punctuation: { exclamations: 'rare', emojis: 'none', ellipses: 'none', notes: '' },
    characteristic: ['súper', 'jaja', 'lentes'],
    never: ['use emojis'],
  },
  examples: ['Hoy fuimos al parque otra vez y nos reímos muchísimo con los chicos'],
};

Deno.test('v3 prompts: concrete-not-abstract rules, the banned filler list, the parents\' voice, gender and firsts', () => {
  const system = buildLetterSystemPrompt({ language: 'es', voice: VOICE });
  assert(system.includes('CONCRETE, NOT ABSTRACT') && system.includes('two or three plain, specific, true things') && system.includes('at most ONE sentence of general reflection'));
  for (const w of ['amplio', 'cercano', 'textura', 'ritmo', 'forma muy suya', 'verdaderamente suyos', 'steady shape', 'texture', 'rhythms', 'small rituals', 'unhurried']) {
    assert(ABSTRACT_FILLER_EXAMPLES.includes(w) && system.includes(`"${w}"`), w);
  }
  assert(system.includes('WRITE LIKE THEM') && system.includes('how they address people') && system.includes('Latin-American'));
  assert(system.includes('never "milestone"'));
  // Another language than the card's: carry the voice, skip the regional words.
  // No card: the default register.
  assert(buildLetterSystemPrompt({ language: 'es' }).includes('neutral Latin-American Spanish'));
  const user = buildLetterUserPrompt(digest(), { language: 'en', voice: VOICE });
  assert(user.includes('STYLE CARD (how these parents write') && user.includes('how they address people: casual tú'));
  // Another language than the card's: none of their words, and no openers anywhere.
  assert(user.includes('none to carry over') && !user.includes('"súper"') && !user.includes('openers:'));
  const es = buildLetterUserPrompt(digest(), { language: 'es', voice: VOICE });
  assert(es.includes('words they use (at most ONE in the whole letter') && es.includes('"súper", "jaja", "lentes"'));
  assert(user.includes('VOICE EXAMPLES') && user.includes('nos reímos muchísimo con los chicos'));
  assert(user.includes('gender: male; nicknames on file: Enzito') && user.includes('gender: female'));
  assert(user.includes('things that recur in their photos (a distinctive one — glasses, a costume, a toy — can be a detail; skip generic ones): superhero costume ×6, red slide ×4'));
  assert(user.includes('dress-up and pretend play ×9 (about 1.8× the family\'s usual) — superhero costume ×6'));
  assert(user.includes('FIRST this year (certain; a plain fact') && user.includes('(January)'));
  assert(!buildLetterUserPrompt(digest(), { language: 'en' }).includes('STYLE CARD'));
});

Deno.test('v3 post-checks: abstract filler and a copied voice example are soft flags; nicknames are not strays', () => {
  const flags = (text: string, examples: string[] = []) => checkLetterText(text, 'playful', digest(), 'es', { card: null, examples, language: 'es' as const });
  const abstract = flags('Este año se sintió amplio y cercano, con la textura de nuestros días y un ritmo muy suyo.');
  assertEquals(abstract.find((f) => f.code === 'abstract')?.detail, 'amplio, cercano, textura, ritmo');
  assert(!abstract.some(isHardFlag));
  assert(flags('This year had a steady shape, with small rituals and an unhurried pace').some((f) => f.code === 'abstract'));
  assert(!flags('Enzo no se quita el disfraz de superhéroe y Mara ya camina sola.').some((f) => f.code === 'abstract'));
  const example = VOICE.examples[0];
  assert(flags('Hoy fuimos al parque otra vez y nos reímos muchísimo, Enzo y Mara', [example]).some((f) => f.code === 'copied_voice_example'));
  assert(!flags('Enzo y Mara fueron al parque y se rieron mucho', [example]).some((f) => f.code === 'copied_voice_example'));
  assert(!flags('Y Enzito se disfrazó de superhéroe, otra vez.').some((f) => f.code === 'unknown_capitalized'));
  // parseLetterResponse threads the examples through.
  const parsed = parseLetterResponse(raw(four('Hoy fuimos al parque otra vez y nos reímos muchísimo con Enzo y Mara')), digest(), { language: 'es', voice: VOICE });
  assert(parsed.variants.find((v) => v.tone === 'classic')!.flags.some((f) => f.code === 'copied_voice_example'));
});

Deno.test('v4 post-checks: catchphrases, foreign words, repetition, enumerations and quotes', () => {
  const voice = { card: { ...VOICE.card, characteristic: ['súper', 'jaja', 'abracito', 'fine dining'] }, examples: [], language: 'es' as const };
  const flags = (text: string, language: 'es' | 'en' = 'es') => checkLetterText(text, 'playful', digest(), language, voice);
  const find = (f: ReturnType<typeof flags>, code: string) => f.find((x) => x.code === code);
  // One catchphrase is fine; two is sprinkling.
  assert(!find(flags('Enzo anda súper contento con su disfraz y Mara camina sola.'), 'catchphrase_overuse'));
  assertEquals(find(flags('Enzo anda súper contento y Mara dice jaja a todo el mundo.'), 'catchphrase_overuse')?.detail, 'súper, jaja');
  // The other language's words never cross over.
  assert(find(flags('Enzo got a big abracito from Mara at the park', 'en'), 'foreign_word'));
  assert(find(flags('This year was fine dining naturally, with Enzo and Mara', 'es'), 'foreign_word'));
  assert(find(flags('Querida familia, este año fue muy lindo para Enzo y Mara', 'en'), 'foreign_word'));
  assert(!find(flags('Dear family, this year Enzo and Mara loved the park', 'en'), 'foreign_word'));
  // Repetition: filler at all, "volvimos" twice, a repeated 3-word phrase.
  assert(find(flags('Fuimos al parque una y otra vez con Enzo y Mara'), 'repetition'));
  assert(find(flags('Enzo and Mara went to the park again and again', 'en'), 'repetition'));
  assert(find(flags('Volvimos al parque y volvimos a la playa con Enzo y Mara'), 'repetition'));
  assert(find(flags('Enzo juega con su tren azul y Mara mira el tren azul'), 'repetition'));
  assert(!find(flags('Enzo juega con su tren azul y Mara prefiere los libros de animales'), 'repetition'));
  // Enumerations of three or more activities.
  assert(!find(flags('Fueron al parque, a las excursiones y a la playa con Enzo y Mara'), 'enumeration')); // one list is the broad strokes (v7)
  assert(find(flags('Fueron al parque, a las excursiones y a la playa. Mara ama el columpio, los disfraces y las burbujas.'), 'enumeration'));
  // A second list in the same letter is flagged (the first is the broad strokes).
  assert(find(flags('Nos encantó ir al parque, salir a comer y las excursiones. Enzo ama los trenes, los libros y las burbujas.'), 'enumeration'));
  assert(find(flags('We loved going to the park, eating out and the beach. Mara loves the swings, the slides and the bubbles.', 'en'), 'enumeration'));
  assert(!find(flags('We loved the park and the beach with Mara', 'en'), 'enumeration'));
  // At most one quote; a child\'s own quoted line is not flagged as filler or a cliché.
  assertEquals(find(flags('Enzo dijo “ay qué rico” y también “ay qué rico” otra vez.'), 'many_quotes')?.detail, '2');
  const quoted = flags('Enzo nos dijo “papi, el mundo es un lugar mágico” y se fue a jugar.');
  assert(!find(quoted, 'cliche') && find(quoted, 'unverified_quote'));
  const verified = checkLetterText('Enzo nos dijo “ay qué rico, mágico” y se fue.', 'playful', digest({ lineOfYear: { quote: 'ay qué rico, mágico', speaker: 'Enzo', memoryId: 'h1' } }), 'es', voice);
  assert(!find(verified, 'cliche') && !find(verified, 'unverified_quote'));
});

Deno.test('v4: a child\'s specific detail words (even "Spiderman" for "Spider-Man") are not stray names', () => {
  const flags = checkLetterText('Este año Enzo anda de Spiderman todo el día, y Mara de Spider-Man no, pero sí del Tren Azul y de Pikachu.', 'playful', digest(), 'es');
  assertEquals(flags.find((f) => f.code === 'unknown_capitalized')?.detail, 'Pikachu'); // only the one that is not a detail
});

Deno.test('v5: the line of the year is REQUIRED (verbatim) in classic and playful; a retry merges per tone', () => {
  const missing = (text: string, tone: 'classic' | 'playful' | 'short', language: 'es' | 'en' = 'es') =>
    checkLetterText(text, tone, digest(), language).some((f) => f.code === 'line_missing');
  assert(missing('Enzo anda feliz con su disfraz y Mara camina sola.', 'classic'));
  assert(missing('Enzo dice “ay qué sabroso” a todo y Mara camina sola.', 'playful')); // a quote, but not the line
  assert(!missing('Enzo dice “ay qué rico” a todo y Mara camina sola.', 'classic'));
  assert(!missing('Enzo dice “Ay, qué rico!” a todo y Mara camina sola.', 'playful')); // punctuation and case are normalized
  assert(!missing('Enzo anda feliz con su disfraz y Mara camina sola.', 'short'));
  assert(!missing('Enzo is happy in his costume and Mara walks on her own.', 'classic', 'en')); // other language: no verbatim line

  const withLine = 'Querida familia, Enzo dice “ay qué rico” a todo y Mara camina sola. Que tengan unas fiestas lindas.';
  const without = 'Querida familia, Enzo anda feliz con su disfraz y Mara camina sola. Que tengan unas fiestas lindas.';
  const first = parseLetterResponse(raw([{ tone: 'classic', text: without }, { tone: 'short', text: 'Enzo y Mara, felices fiestas.' }, { tone: 'playful', text: withLine }, { tone: 'reflective', text: without }]), digest(), { language: 'es' });
  assertEquals(tonesNeedingLine(first, digest()), ['classic']);
  const retry = parseLetterResponse(raw([{ tone: 'classic', text: withLine }, { tone: 'short', text: 'Enzo y Mara, felices.' }, { tone: 'playful', text: without }, { tone: 'reflective', text: without }]), digest(), { language: 'es' });
  const merged = mergeLetterRetry(first, retry, digest());
  assertEquals(merged.variants.map((v) => [v.tone, v.text === greetingOnItsOwnLine(withLine)]), [['classic', true], ['short', false], ['playful', true], ['reflective', false]]);
  assertEquals(tonesNeedingLine(merged, digest()), []);
  // Still missing after the retry: kept, flagged.
  const stuck = mergeLetterRetry(first, first, digest());
  assertEquals(stuck.variants.find((v) => v.tone === 'classic')!.flags.some((f) => f.code === 'line_missing'), true);
  assertEquals(tonesNeedingLine(stuck, digest()), ['classic']);
  // No line (or another language): nothing to retry.
  assertEquals(tonesNeedingLine(first, digest({ lineOfYear: null })), []);
});

Deno.test('v5: tag phrases copied from the digest are a soft label_calque flag', () => {
  const flags = (text: string, language: 'es' | 'en' = 'es') => checkLetterText(text, 'playful', digest(), language);
  const calque = (text: string, language: 'es' | 'en' = 'es') => flags(text, language).find((f) => f.code === 'label_calque');
  assert(calque('A Enzo le encanta jugar a imaginar y a Mara caminar con confianza.'));
  assert(calque('Mara ya camina con confianza por toda la casa y Enzo.'));
  assert(calque('Enzo loves imaginative play and Mara loves outdoor activities.', 'en'));
  assert(calque('Les encanta salir de excursión los fines de semana, Enzo y Mara.')); // a catalog activity phrase
  assert(!calque('A Enzo le encanta disfrazarse e inventar historias, y Mara dio sus primeros pasos.'));
  assert(!calque('A Enzo y a Mara les encanta ir al parque.')); // what people really say
  assert(!calque('Lo mejor del año fue comer en familia, Enzo y Mara.'));
  assert(!flags('Enzo loves dressing up and making up stories; Mara took her first steps.', 'en').some((f) => f.code === 'label_calque'));
});

Deno.test('v5: formulaic age openings across variants, and a short one-sentence wish', () => {
  const variants = (texts: string[]) => texts.map((text, i) => ({ tone: (['classic', 'short', 'playful', 'reflective'] as const)[i], text }));
  const parse = (texts: string[]) => parseLetterResponse(raw(variants(texts), 'Escanea para ver nuestro año'), digest({ lineOfYear: null }), { language: 'es' });
  const ageFirst = 'Querida familia, Enzo tiene 4 años y vive de superhéroe. Que tengan unas fiestas lindas.';
  const ageFirst2 = 'Mara, con 2 años, ya camina sola. Enzo, que ya tiene 4, es un superhéroe. Felices fiestas.';
  const woven = 'Querida familia, Enzo se pasó el año de superhéroe y Mara echó a caminar. Felices fiestas.';
  const one = parse([ageFirst, woven, woven, woven]);
  assert(!one.flags.some((f) => f.code === 'formulaic_age')); // one variant may open with the age
  const two = parse([ageFirst, woven, ageFirst2, woven]);
  assertEquals(two.flags.find((f) => f.code === 'formulaic_age')?.detail, 'classic, playful');
  assert(!two.rejected.length);
  // Omitting the age is fine: no age_mismatch, no flag.
  assert(!checkLetterText(woven, 'classic', digest({ lineOfYear: null }), 'es').some((f) => f.code === 'age_mismatch'));
  // The wish: one short sentence.
  const closer = (text: string) => checkLetterText(text, 'playful', digest({ lineOfYear: null }), 'es').find((f) => f.code === 'long_closer');
  assert(!closer('Querida familia, Enzo y Mara están felices. Que tengan unas fiestas muy lindas.'));
  assert(closer('Querida familia, Enzo y Mara están felices. Les deseamos unas fiestas con tiempo para conversar, reírse, descansar de todo y estar juntos sin prisa, con mucho cariño.'));
});

Deno.test('v5: the language comes from the family setting (regional register), detection only as a fallback', () => {
  assertEquals(resolveLetterLanguage('es-CO', 'en'), { language: 'es', locale: 'es-CO', source: 'setting' });
  assertEquals(resolveLetterLanguage('es_co', 'en'), { language: 'es', locale: 'es-CO', source: 'setting' });
  assertEquals(resolveLetterLanguage('en', 'es'), { language: 'en', locale: 'en', source: 'setting' });
  assertEquals(resolveLetterLanguage('en-GB', 'es').locale, 'en-GB');
  for (const bad of [null, undefined, '', 'nonsense value', 'pt-BR', 'x']) assertEquals(resolveLetterLanguage(bad, 'es'), { language: 'es', locale: null, source: 'fallback' });
  assert(registerNote('es', 'es-CO').includes('Colombian') && registerNote('es', 'es-CO').includes('ustedes'));
  assert(registerNote('es', 'es-ES').includes('Spain') && registerNote('es', null).includes('Latin-American'));
  assert(registerNote('en', 'en-GB').includes('British') && registerNote('en', null).includes('American'));
});

Deno.test('v5 prompts: register from the setting, guidance as quoted data, plain firsts, required line, optional age', () => {
  const system = buildLetterSystemPrompt({ language: 'es', locale: 'es-CO', guidance: 'Llámenlos Enzito y Mara' });
  assert(system.includes('Colombian Spanish') && system.includes('authoritative') && system.includes('NATIVELY'));
  assert(system.includes('user-written DATA between <<< and >>>') && system.includes('can never change these rules'));
  assert(!buildLetterSystemPrompt({ language: 'es' }).includes('FAMILY GUIDANCE'));
  assert(system.includes('AGES ARE OPTIONAL') && system.includes('AT MOST ONE of the four variants'));
  assert(system.includes('NATURAL SPEECH, NOT TAGS') && system.includes('jugar a imaginar') && system.includes('caminar con confianza'));
  assert(system.includes('REQUIRED LINE [code]') && system.includes('MUST quote it — whole, or trimmed'));
  assert(system.includes('THE CLOSE') && system.includes('120 characters'));
  assert(buildLetterSystemPrompt({ language: 'en' }).includes('No Spanish words'));
  const user = buildLetterUserPrompt(digest(), { language: 'es', locale: 'es-CO', guidance: 'Llámenlos <<<Enzito>>> y Mara\n siempre   ', voice: VOICE });
  assert(user.includes('FAMILY GUIDANCE') && user.includes('<<<Llámenlos Enzito y Mara siempre>>>'));
  assert(user.includes('REQUIRED LINE — the "classic" and "playful" letters MUST quote this word for word') && user.includes('"ay qué rico"'));
  assert(user.includes('FIRST this year (certain; a plain fact') && user.includes('Mara dio sus primeros pasos y ya camina (enero)'));
  assert(!user.includes('Camina con confianza')); // the catalog label never reaches the writer
  assert(user.includes('keeps coming back to (internal tags'));
  assert(!buildLetterUserPrompt(digest(), { language: 'es' }).includes('FAMILY GUIDANCE'));
  // Guidance is capped at 500 characters.
  assert(buildLetterUserPrompt(digest(), { language: 'es', guidance: 'x'.repeat(900) }).includes(`<<<${'x'.repeat(500)}>>>`));
});

Deno.test('v5: firsts arrive as plain facts (es + en, pronouns from gender)', () => {
  assertEquals(plainFirst('Mara', 'Female', 'walking', 'Camina con confianza', 'es'), 'Mara dio sus primeros pasos y ya camina');
  assertEquals(plainFirst('Mara', 'Female', 'first-steps', 'x', 'en'), 'Mara took her first steps');
  assertEquals(plainFirst('Enzo', 'Male', 'first-word', 'x', 'en'), 'Enzo said his first word');
  assertEquals(plainFirst('Sam', null, 'first-tooth', 'x', 'en'), 'Sam got their first tooth');
  assertEquals(plainFirst('Mara', 'Female', 'sits-up', 'x', 'es'), 'Mara aprendió a sentarse');
  assertEquals(plainFirst('Mara', 'Female', 'pulls-to-stand', 'x', 'es'), 'Mara se puso de pie agarrada de los muebles');
  assert(plainFirst('Enzo', 'Male', 'not-a-milestone', 'Algo nuevo', 'es').includes('rephrase in plain words'));
  assertEquals(LETTER_MODEL, 'gpt-6.1-sol');
});

Deno.test('greeting: the wish follows the card greeting (prompt note, soft occasion flag)', () => {
  assertEquals([...CARD_GREETINGS], ['christmas', 'holidays', 'new-year']);
  assert(isCardGreeting('holidays') && !isCardGreeting('easter') && !isCardGreeting(null));
  // No greeting: the prompt is the v5 prompt, byte for byte.
  assert(!buildLetterSystemPrompt({ language: 'es' }).includes('OCCASION'));
  // es: christmas may name Navidad, holidays and new-year never do.
  const christmas = buildLetterSystemPrompt({ language: 'es', greeting: 'christmas' });
  assert(christmas.includes('OCCASION [code, soft]') && christmas.includes('"Feliz Navidad"'));
  const holidays = buildLetterSystemPrompt({ language: 'es', greeting: 'holidays' });
  assert(holidays.includes('"Felices fiestas"') && holidays.includes('NEVER names Navidad'));
  const newYear = buildLetterSystemPrompt({ language: 'en', greeting: 'new-year' });
  assert(newYear.includes('"Happy New Year"') && newYear.includes('NEVER names Christmas'));
  assert(greetingWishNote('holidays', 'en').includes('the holidays'));
  // The soft check.
  assertEquals(occasionMismatch('Les deseamos una linda Navidad.', 'christmas'), null);
  assertEquals(occasionMismatch('Les deseamos una linda Navidad.', 'holidays'), 'Navidad');
  assertEquals(occasionMismatch('Les deseamos un feliz Año Nuevo.', 'holidays'), 'Año Nuevo');
  assertEquals(occasionMismatch('Wishing you a happy new year.', 'christmas'), 'new year');
  assertEquals(occasionMismatch('Merry Christmas and a happy new year.', 'christmas'), null);
  assertEquals(occasionMismatch('Merry Christmas to all.', 'new-year'), 'Christmas');
  assertEquals(occasionMismatch('Les deseamos unas lindas fiestas.', 'holidays'), null);
  // checkLetterText flags it softly (never rejects) and parseLetterResponse threads the option through.
  const flags = checkLetterText('Les deseamos una linda Navidad.', 'short', digest(), 'es', undefined, 'holidays');
  assert(flags.some((f) => f.code === 'occasion_mismatch') && !flags.some(isHardFlag));
  assert(!checkLetterText('Les deseamos una linda Navidad.', 'short', digest(), 'es').some((f) => f.code === 'occasion_mismatch'));
  const raw = JSON.stringify({ variants: [{ tone: 'short', text: 'Les deseamos una linda Navidad.' }], qr_caption: null });
  const parsed = parseLetterResponse(raw, digest(), { language: 'es', greeting: 'holidays' });
  assert(parsed.variants[0]?.flags.some((f) => f.code === 'occasion_mismatch'));
});

Deno.test('v6: a letter frames itself and lands on the reader; an add-on fact before the wish is flagged', () => {
  const system = buildLetterSystemPrompt({ language: 'es', locale: 'es-CO' });
  assert(system.includes('THE YEAR, WITH MEANING') && system.includes('THE CLOSE: affection and the wish'));
  const filler = (text: string) => checkLetterText(text, 'classic', digest({ lineOfYear: null }), 'es').find((f) => f.code === 'trailing_filler');
  assert(filler('Queridos todos, les contamos un poco de nuestro año. Enzo vive en el parque. También salimos a comer en familia más de una vez. Feliz Navidad.'));
  assert(filler('Dear all, a little of our year. Enzo loves the park. We also went to the beach. Merry Christmas.'));
  assert(!filler('Queridos todos, les contamos un poco de nuestro año. Enzo vive en el parque. Ojalá verlos pronto. Feliz Navidad.'));
});

Deno.test('v7: the close is love + wish (no invitation); es-CO avoids the Spain perfect; one list is fine, two are not', () => {
  const flags = (text: string, locale: string | null = 'es-CO') =>
    checkLetterText(text, 'classic', digest({ lineOfYear: null }), 'es', undefined, undefined, locale).map((f) => f.code);
  const base = 'Queridos todos:\n\nLes queremos contar un poquito de cómo nos fue este año. Fue un año de mucho parque, de paseos y de salir a comer.\n\nEnzo cumplió cuatro.';
  assert(!flags(`${base}\n\nLos queremos mucho y les deseamos una feliz Navidad.`).includes('invitation'));
  assert(flags(`${base}\n\nOjalá podamos vernos pronto. Feliz Navidad.`).includes('invitation'));
  assert(flags(`${base} Este año hemos ido mucho al parque.\n\nLos queremos mucho.`).includes('spain_perfect'));
  assert(!flags(`${base} Este año hemos ido mucho al parque.\n\nLos queremos mucho.`, 'es-ES').includes('spain_perfect'));
  assert(!flags(`${base}\n\nLos queremos mucho.`).includes('enumeration'));
  assert(flags(`${base} Fuimos al parque, a la playa y a comer fuera. Mara ama el columpio, los disfraces y las burbujas.\n\nLos queremos mucho.`).includes('enumeration'));
  const system = buildLetterSystemPrompt({ language: 'es', locale: 'es-CO' });
  assert(system.includes('SIMPLE PAST') && system.includes('NEVER an invitation') && system.includes('FICTIONAL family'));
});

Deno.test('v7: the greeting sits on its own line', () => {
  assertEquals(greetingOnItsOwnLine('Queridos todos: Les queremos contar algo.'), 'Queridos todos:\n\nLes queremos contar algo.');
  assertEquals(greetingOnItsOwnLine('Dear family and friends, We wanted to share.'), 'Dear family and friends,\n\nWe wanted to share.');
  assertEquals(greetingOnItsOwnLine('Queridos todos:\n\nYa estaba bien.'), 'Queridos todos:\n\nYa estaba bien.');
  assertEquals(greetingOnItsOwnLine('Este año, Enzo creció.'), 'Este año, Enzo creció.');
  assertEquals(greetingOnItsOwnLine('Hola a todos:\nLes queremos contar.'), 'Hola a todos:\n\nLes queremos contar.');
});

Deno.test('v8: a birthday before Christmas is told as done; after it, as coming', () => {
  assert(turningNote('Enzo', 4, '2026-10-23', 'es').includes('Enzo cumplió 4'));
  assert(turningNote('Mara', 2, '2026-11-08', 'en').includes('Mara turned 2'));
  assert(turningNote('Ana', 3, '2026-12-28', 'es').includes('está por cumplir 3'));
});

Deno.test('v9: best details skip labels that restate a theme, so the distinctive one (glasses) is offered', () => {
  const child = {
    memberId: 'k', name: 'Lucía', specifics: [], ageYears: 1, ageThisYear: 2, birthdayThisYear: '2026-11-08', gender: 'female', nicknames: [],
    details: [{ label: 'playground', memories: 10 }, { label: 'glasses', memories: 9 }],
    firsts: [{ milestoneId: 'walking', label: 'walking', date: '2026-01-17', month: 1 }],
    memories: 100, recurring: [{ topicId: 'park-playground', phrase: 'ir al parque', memories: 13, lift: 1.8 }], emotions: [], excerpts: [], line: null,
  } as unknown as Parameters<typeof bestDetails>[0];
  const best = bestDetails(child, 'es');
  assert(best[0].startsWith('turns 2'));
  assert(best.some((b) => b.startsWith('glasses')));
  assert(!best.some((b) => b.startsWith('playground')));
});

Deno.test('v10: the line of the year may be quoted whole or trimmed to a core of 4+ contiguous words', () => {
  const line = 'papá, la luna nos está siguiendo!';
  assert(quotesLineCore('Tomás sigue convencido de que "la luna nos está siguiendo".', line));
  assert(quotesLineCore('Nos dijo: "papá, la luna nos está siguiendo!"', line));
  assert(!quotesLineCore('Tomás dice que "la luna".', line)); // too short a core
  assert(!quotesLineCore('Tomás dice que "la luna nos persigue".', line)); // reworded inside the quotes
  assert(!quotesLineCore('Tomás mira la luna.', line));
});

Deno.test('v10: a specific both kids share goes to the sibling line, not to one child', () => {
  const kid = (name: string, specifics: string[]) => ({
    memberId: name, name, specifics: specifics.map((detail) => ({ detail, memories: 2, recurring: true })), ageYears: 3, ageThisYear: 4, birthdayThisYear: null,
    gender: null, nicknames: [], details: [{ label: 'glasses', memories: 9 }], firsts: [], memories: 50, recurring: [], emotions: [], excerpts: [], line: null,
  });
  const digest = { children: [kid('Tomás', ['Spiderman', 'bicicleta sin rueditas']), kid('Lucía', ['Spiderman'])] } as unknown as Parameters<typeof sharedSpecifics>[0];
  assertEquals([...sharedSpecifics(digest)], ['spiderman']);
  const lucia = bestDetails(digest.children[1], 'es', sharedSpecifics(digest));
  assert(!lucia.some((b) => b.startsWith('Spiderman')) && lucia.some((b) => b.startsWith('glasses')));
  assert(bestDetails(digest.children[0], 'es', sharedSpecifics(digest)).some((b) => b.startsWith('bicicleta sin rueditas')));
});
