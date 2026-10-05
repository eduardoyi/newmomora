import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { YearDigest } from './holiday-card-digest.ts';
import {
  buildEditorUserPrompt,
  buildWriterSystemPrompt,
  buildWriterUserPrompt,
  type EditorCandidate,
  NEWS_TEXT,
  parseEditorFacts,
  parseWriterText,
} from './holiday-card-letter-v2.ts';

// A fictional family (the repo is public).
const digest = {
  familyName: 'Rivera Soto',
  language: 'es',
  people: [
    { name: 'Tomás', role: 'child', ageYears: 4 },
    { name: 'Lucía', role: 'child', ageYears: 1 },
    { name: 'Ana', role: 'parent', ageYears: null },
  ],
  children: [
    { memberId: 't', name: 'Tomás', gender: 'male', ageThisYear: 5, birthdayThisYear: '2026-10-02', firsts: [], line: { quote: 'papá, la luna nos sigue', memoryId: 'm9', context: 'Mirando por la ventana' } },
    { memberId: 'l', name: 'Lucía', gender: 'female', ageThisYear: 2, birthdayThisYear: null, firsts: [{ milestoneId: 'walking', label: 'walking', date: '2026-05-03', month: 5 }], line: null },
  ],
  forbiddenNames: ['Rivera', 'Soto', 'Rosa'],
  familyThemes: [{ topicId: 'swimming', phrase: 'ir a la piscina', memories: 9, lift: 2 }],
  places: [],
  trips: [{ place: 'Cartagena', month: 7, days: 3, memories: 3 }],
  counts: { moments: 120, photos: 90, videos: 20, drawings: 5, sounds: 1, outings: 30, months: 10, together: 40 },
  filmPresent: true,
} as unknown as YearDigest;

const candidates: EditorCandidate[] = [
  { id: 'm1', date: '2026-03-02', tagged: ['Tomás'], text: 'Tomás aprendió a nadar sin flotadores', news: true },
  { id: 'm2', date: '2026-04-10', tagged: ['Lucía'], text: 'Lucía estrenando sus gafas', news: true },
  { id: 'm3', date: '2026-06-01', tagged: ['Tomás', 'Lucía'], text: 'Fuimos al parque', news: false },
];

Deno.test('v2: newsworthy words are recognized (es + en)', () => {
  for (const t of ['aprendió a nadar', 'Lucía estrenando sus gafas', 'por primera vez', 'ya camina sola', 'learned to ride', 'her first words', 'montando bici sin rueditas', 'rides without training wheels']) assert(NEWS_TEXT.test(t), t);
  for (const t of ['fuimos al parque', 'comimos pasta', 'we went to the park']) assert(!NEWS_TEXT.test(t), t);
});

Deno.test('v2 editor: facts need real evidence (or be given); strangers and sensitive facts are dropped', () => {
  const raw = JSON.stringify({
    facts: [
      { about: 'Tomás', kind: 'new', fact: 'Tomás aprendió a nadar sin flotadores.', evidence: [1] },
      { about: 'Lucía', kind: 'new', fact: 'Lucía estrenó gafas.', evidence: [2] },
      { about: 'Tomás', kind: 'birthday', fact: 'Tomás cumplió cinco.', evidence: [] },
      { about: 'Lucía', kind: 'first', fact: 'Lucía dio sus primeros pasos en mayo.', evidence: [] },
      { about: 'Tomás', kind: 'new', fact: 'Tomás ganó un concurso.', evidence: [] },
      { about: 'Tomás', kind: 'new', fact: 'Tomás fue a casa de Rosa.', evidence: [3] },
      { about: 'Lucía', kind: 'trait', fact: 'Lucía odia el pañal.', evidence: [2] },
      { about: 'Tomás', kind: 'new', fact: 'Tomás leyó un libro.', evidence: [42] },
    ],
    broad_strokes: 'Fue un año de piscina y de unos días en Cartagena.',
    qr_caption: 'Escanea para ver nuestro año: la piscina y Cartagena.',
  });
  const result = parseEditorFacts(raw, candidates, digest);
  assertEquals(result.facts.map((f) => f.fact), [
    'Tomás aprendió a nadar sin flotadores.',
    'Lucía estrenó gafas.',
    'Tomás cumplió cinco.',
    'Lucía dio sus primeros pasos en mayo.',
  ]);
  assertEquals(result.facts[0].evidence, ['m1']);
  assertEquals(result.dropped.map((d) => d.reason).sort(), ['no_evidence', 'sensitive', 'stranger', 'unknown_evidence']);
  assertEquals(result.broadStrokes, 'Fue un año de piscina y de unos días en Cartagena.');
  assert(result.qrCaption);
  assertEquals(parseEditorFacts('not json', candidates, digest).facts, []);
});

Deno.test('v2 editor prompt: givens (birthday, first, line + moment, trip, together) and numbered entries', () => {
  const user = buildEditorUserPrompt(digest, candidates, 'es');
  assert(user.includes('Tomás: TURNS 5'));
  assert(user.includes('Lucía: first this year'));
  assert(user.includes('line of the year — "papá, la luna nos sigue" (said when: Mirando por la ventana)'));
  assert(user.includes('trip: Cartagena'));
  assert(user.includes('together in 40'));
  assert(user.includes('1. ★ [2026-03-02] [Tomás] "Tomás aprendió a nadar sin flotadores"'));
  assert(user.includes('3. [2026-06-01] [Tomás, Lucía] "Fuimos al parque"'));
});

Deno.test('v2 writer: short prompt with fictional examples; warm framing allowed, new facts not', () => {
  const system = buildWriterSystemPrompt({ language: 'es', locale: 'es-CO', greeting: 'christmas' });
  assert(system.includes('FICTIONAL family') && system.includes('turns of phrase') && system.includes('Never add a fact'));
  assert(system.includes('Colombian'));
  const user = buildWriterUserPrompt({
    angle: 'warm',
    facts: [{ about: 'Tomás', kind: 'new', fact: 'Tomás aprendió a nadar.', evidence: ['m1'] }],
    broadStrokes: 'Un año de piscina.',
    children: [{ name: 'Tomás', gender: 'male' }],
    voice: { card: null, examples: ['Hoy Tomás nadó solo.'], language: 'es' },
    language: 'es',
  });
  assert(user.startsWith('WRITE THE WARM LETTER') && user.includes('TONE: plain and warm'));
  assert(buildWriterUserPrompt({ angle: 'playful', facts: [], broadStrokes: null, children: [], language: 'es' }).includes('TONE: charm is the point'));
  assert(system.includes('[skill] fact') && system.includes('at most THREE things'));
  assert(user.includes('- Tomás [new]: Tomás aprendió a nadar.') && user.includes('"Hoy Tomás nadó solo."'));
  assertEquals(parseWriterText('{"text":"  Queridos todos:\\n\\nHola.  "}'), 'Queridos todos:\n\nHola.');
  assertEquals(parseWriterText('{"text":""}'), null);
});
