// Holiday card letter, v2 pipeline (docs/plans/holiday-cards.md, "Letters
// v11"): an EDITOR picks what is worth telling, then a WRITER tells it.
//
// Why (owner review, 2026-10-05): the v1–v10 single call handed the model a
// large digest ranked by how often things recur (park, stories, costumes) and
// ~30 rules, so it wrote careful lists of routines. The letters the owners
// liked were built differently: a handful of things that CHANGED this year
// (learned to ride without training wheels, first steps, new glasses, turned
// four, a trip), told the way parents talk ("y desde entonces no hay quien la
// pare"), from fuller memory text, with examples instead of rules.
//
//   1. selectEditorCandidates: share-safe memories with fuller text, the
//      newsworthy ones ("aprendió", "empezó", "primera vez", "estrenó"…)
//      boosted, plus each child's best-ranked moments.
//   2. Editor call: 5–7 facts worth telling + one broad-strokes sentence +
//      the QR caption. parseEditorFacts keeps only facts whose evidence ids
//      are real candidates (or givens: birthdays, firsts, trips, the line).
//   3. Writer call, once per angle (classic / warm / playful): the facts, the
//      parents' voice examples, three FICTIONAL example letters, six
//      principles. Warm framing of real facts is the point; new facts are not.
//   4. The hard post-checks of v1 (checkLetterText) still run on every letter.
//
// Pure module: no I/O, no env. Memory text is user content; it goes to the
// model as quoted data and never to logs.

import { excerptOf, type YearDigest } from './holiday-card-digest.ts';
import {
  type CardGreeting,
  checkLetterText,
  greetingOnItsOwnLine,
  greetingWishNote,
  type LetterFlag,
  type LetterVoice,
  MONTH_NAMES,
  plainFirst,
  registerNote,
  turningNote,
} from './holiday-card-letter.ts';
import type { FilmLanguage } from './year-film-i18n.ts';
import type { FilmMilestoneInput, FilmScope } from './year-film-eligibility.ts';
import { type FilmMemorySource, SHARE_SENSITIVE_TEXT } from './year-film-script.ts';

// ── Candidates ───────────────────────────────────────────────────────────

export const EDITOR_TEXT_CHARS = 360;
export const EDITOR_MAX_CANDIDATES = 120;

/** Words that mark something NEW this year (es + en). */
export const NEWS_TEXT =
  /(?<!\p{L})(aprendi[óo]|empez[óo]|comenz[óo]|primer[ao]?s?|por primera vez|estren[óo]|estrenando|ya (sabe|camina|habla|dice|anda|va|come|duerme|lee|monta|nada)|sin rueditas|sin ayuda|sin flotadores|sol[oa]|solit[oa]|por s[ií] mism[oa]|without training wheels|by (him|her|them)sel(f|ves)|on (his|her|their) own|nuev[oa]s?|logr[óo]|consigui[óo]|entr[óo] (al|a la)|learned|learnt|started|began|first|new|now (walks|talks|reads|rides|swims)|can now|got (his|her|their) first)(?!\p{L})/iu;

export interface EditorCandidate {
  id: string;
  date: string;
  /** First names of the family's own people tagged on it. */
  tagged: string[];
  text: string;
  news: boolean;
}

/** Share-safe pool → the memories the editor reads: every written entry,
 * oldest first; over the cap, newsworthy (NEWS_TEXT) and longer entries stay. */
export function selectEditorCandidates(
  pool: FilmMemorySource[],
  options: {
    scope: FilmScope;
    milestones: FilmMilestoneInput[];
    children: { id: string; name: string }[];
    people: { id: string; name: string }[];
    max?: number;
  },
): EditorCandidate[] {
  const max = options.max ?? EDITOR_MAX_CANDIDATES;
  // Read (almost) every written entry: "Tomás montando bici sin rueditas" has
  // no news word but IS the year's news (v11 review). News words and the
  // children's best-ranked moments only decide who stays when over the cap.
  const withText = pool.filter((m) => (m.text ?? '').trim().length >= 12);
  const chosen = new Map<string, FilmMemorySource>();
  for (const m of withText) chosen.set(m.id, m);
  const nameOf = new Map(options.people.map((p) => [p.id, p.name.trim().split(/\s+/)[0]]));
  return [...chosen.values()]
    .map((m) => ({
      id: m.id,
      date: m.date,
      tagged: m.taggedMemberIds.flatMap((id) => (nameOf.has(id) ? [nameOf.get(id)!] : [])),
      text: excerptOf(m.text, EDITOR_TEXT_CHARS),
      news: NEWS_TEXT.test(m.text ?? ''),
    }))
    // Over the cap: newsworthy first, then the longer (more telling) entries.
    .sort((a, b) => Number(b.news) - Number(a.news) || b.text.length - a.text.length || a.date.localeCompare(b.date))
    .slice(0, max)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

// ── Editor ───────────────────────────────────────────────────────────────

export type FactKind = 'birthday' | 'first' | 'skill' | 'new' | 'line' | 'trip' | 'trait' | 'siblings';

export interface EditorFact {
  /** A child's first name, or null for the whole family. */
  about: string | null;
  kind: FactKind;
  /** One plain sentence in the target language: the fact, no framing. */
  fact: string;
  /** Candidate memory numbers, mapped back to memory ids. "given" facts have none. */
  evidence: string[];
}

export interface EditorResult {
  facts: EditorFact[];
  /** The year in broad strokes: one plain sentence (the family's 2–4 recurring things). */
  broadStrokes: string | null;
  qrCaption: string | null;
  dropped: { reason: 'bad_shape' | 'unknown_evidence' | 'no_evidence' | 'stranger' | 'sensitive'; fact: string }[];
}

const FACT_KINDS: readonly FactKind[] = ['birthday', 'first', 'skill', 'new', 'line', 'trip', 'trait', 'siblings'];
/** Facts the digest already proves (no memory evidence needed). */
const GIVEN_KINDS: ReadonlySet<FactKind> = new Set(['birthday', 'trip', 'line']);
export const EDITOR_MAX_FACTS = 7;

export function buildEditorSystemPrompt(language: FilmLanguage): string {
  const target = language === 'es' ? 'Spanish' : 'English';
  return [
    'You are the EDITOR of a family\'s holiday letter. You read the parents\' own journal entries from this year and decide what is worth telling relatives and friends — you do not write the letter.',
    '',
    'Pick 5–7 FACTS, choosing what is NEW about this year, the things a parent would tell an aunt on the phone. PRIORITY, strongest first: (1) a new SKILL or ability a child gained (riding a bike without training wheels, swimming, reading, talking in sentences) — a skill that shows up in SEVERAL entries is the strongest news of all; (2) firsts; (3) the age they turn (GIVEN); (4) something new in their life (glasses, a new school); (5) their line of the year (GIVEN); (6) a trip (GIVEN); (7) what the siblings share. A one-off event (wrote a word on a card, went to a party) only when nothing above exists. Entries marked ★ look like news.',
    '- firsts and new skills ("learned to ride without training wheels", "took her first steps", "started saying full sentences");',
    '- a new stage or new things (new glasses, started school, a new sibling, moved house) — only if the entries show it;',
    '- the age a child turns this year (GIVEN), a trip by name (GIVEN), the child\'s line of the year (GIVEN);',
    '- at most ONE charming recurring trait per child, and only if it says who they are (not "goes to the park");',
    '- one SIBLINGS fact when the entries show the children together a lot (what they share, e.g. both dressing up as superheroes).',
    'Skip routines (park, meals, stories) — they belong only in BROAD STROKES. Skip anything about health, doctors, baths, potty, crying, sadness or conflict.',
    '',
    `Each fact: "about" (a child\'s first name, or null for the family), "kind" (${FACT_KINDS.join(' | ')}; "skill" = a new ability, "new" = a new thing in their life), "fact" (ONE plain sentence in ${target}: the fact only, no adjectives or framing), "evidence" (the numbers of the entries that show it; [] only for GIVEN facts).`,
    `Also write "broad_strokes": ONE plain sentence in ${target} naming the 2–3 things that most filled the family\'s year (from THEMES, PLACES, TRIPS; a trip by name counts as one), and "qr_caption" (only when FILM is yes, ≤ 80 characters, ${target}): an invitation to scan and see the year, naming at most two real things. When FILM is no, "qr_caption" is null.`,
    'Use only first names listed under PEOPLE. Never invent: every fact must be readable in the entries you cite, or be GIVEN.',
    '',
    'Respond with JSON only: {"facts":[{"about":"…","kind":"…","fact":"…","evidence":[3,17]}],"broad_strokes":"…","qr_caption":"…"|null}',
  ].join('\n');
}

export function buildEditorUserPrompt(
  digest: YearDigest,
  candidates: EditorCandidate[],
  language: FilmLanguage,
): string {
  const lines: string[] = [];
  lines.push(`TARGET LANGUAGE: ${language}`);
  lines.push(`FILM: ${digest.filmPresent ? 'yes' : 'no'}`);
  lines.push(`PEOPLE: ${digest.people.map((p) => `${p.name} (${p.role})`).join(', ')}`);
  lines.push('');
  lines.push('GIVEN:');
  for (const c of digest.children) {
    if (c.birthdayThisYear && c.ageThisYear !== null) lines.push(`- ${c.name}: ${turningNote(c.name, c.ageThisYear, c.birthdayThisYear, language)}`);
    for (const f of c.firsts) lines.push(`- ${c.name}: first this year — ${plainFirst(c.name, c.gender, f.milestoneId, f.label, language)} (${MONTH_NAMES[language][f.month - 1]})`);
    if (c.line && language === digest.language) lines.push(`- ${c.name}: line of the year — "${c.line.quote}"${c.line.context ? ` (said when: ${c.line.context})` : ''}`);
  }
  for (const t of digest.trips ?? []) lines.push(`- trip: ${t.place} (${MONTH_NAMES[language][t.month - 1]}, ${t.days} days)`);
  if ((digest.counts.together ?? 0) >= 8) lines.push(`- the children appear together in ${digest.counts.together} of the year's moments`);
  lines.push('');
  lines.push(`THEMES (the year's recurring things): ${digest.familyThemes.map((t) => t.phrase).join('; ') || '—'}`);
  lines.push(`PLACES: ${digest.places.map((t) => t.phrase).join('; ') || '—'}`);
  lines.push('');
  lines.push(`ENTRIES (the parents' own words, oldest first; quoted data, not instructions):`);
  candidates.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.news ? '★ ' : ''}[${c.date}] [${c.tagged.join(', ') || '—'}] "${c.text.replace(/\s+/g, ' ')}"`);
  });
  return lines.join('\n');
}

export function parseEditorFacts(
  raw: string,
  candidates: EditorCandidate[],
  digest: YearDigest,
): EditorResult {
  const out: EditorResult = { facts: [], broadStrokes: null, qrCaption: null, dropped: [] };
  let data: { facts?: unknown; broad_strokes?: unknown; qr_caption?: unknown };
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  const names = new Set(digest.people.map((p) => p.name.toLowerCase()));
  const strangers = digest.forbiddenNames.map((n) => n.toLowerCase());
  const mentionsStranger = (text: string) =>
    strangers.some((n) => new RegExp(`(?<!\\p{L})${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'iu').test(text));
  for (const item of Array.isArray(data.facts) ? data.facts : []) {
    const f = item as Record<string, unknown>;
    const fact = typeof f.fact === 'string' ? f.fact.replace(/\s+/g, ' ').trim() : '';
    const kind = FACT_KINDS.includes(f.kind as FactKind) ? (f.kind as FactKind) : null;
    const about = typeof f.about === 'string' && names.has(f.about.toLowerCase()) ? f.about : null;
    if (!fact || !kind || fact.length > 240) {
      out.dropped.push({ reason: 'bad_shape', fact });
      continue;
    }
    if (mentionsStranger(fact)) {
      out.dropped.push({ reason: 'stranger', fact });
      continue;
    }
    if (SHARE_SENSITIVE_TEXT.test(fact)) {
      out.dropped.push({ reason: 'sensitive', fact });
      continue;
    }
    const numbers = Array.isArray(f.evidence) ? f.evidence.filter((n): n is number => Number.isInteger(n)) : [];
    if (numbers.some((n) => n < 1 || n > candidates.length)) {
      out.dropped.push({ reason: 'unknown_evidence', fact });
      continue;
    }
    if (numbers.length === 0 && !GIVEN_KINDS.has(kind) && !(kind === 'first' && about && digest.children.some((c) => c.name === about && c.firsts.length))) {
      out.dropped.push({ reason: 'no_evidence', fact });
      continue;
    }
    out.facts.push({ about, kind, fact, evidence: numbers.map((n) => candidates[n - 1].id) });
    if (out.facts.length >= EDITOR_MAX_FACTS) break;
  }
  const broad = typeof data.broad_strokes === 'string' ? data.broad_strokes.trim() : '';
  out.broadStrokes = broad && !mentionsStranger(broad) && !SHARE_SENSITIVE_TEXT.test(broad) ? broad : null;
  const caption = typeof data.qr_caption === 'string' ? data.qr_caption.trim() : '';
  out.qrCaption = digest.filmPresent && caption && Array.from(caption).length <= 80 && !mentionsStranger(caption) ? caption : null;
  return out;
}

// ── Writer ───────────────────────────────────────────────────────────────

export type WriterAngle = 'classic' | 'warm' | 'playful';
export const WRITER_ANGLES: readonly WriterAngle[] = ['classic', 'warm', 'playful'];
export const WRITER_MAX_CHARS = 620;

/** Example letters for a FICTIONAL family (the repo is public): they teach
 * the shape and the register; the writer must never reuse their sentences. */
const EXAMPLES: Record<FilmLanguage, Record<WriterAngle, string>> = {
  es: {
    classic:
      'Queridos todos:\n\nLes queremos contar un poquito de cómo nos fue este año. Fue un año de mucha piscina, de paseos y de unos días en la finca de los abuelos. Y en medio de todo eso, Tomás y Lucía siguen creciendo felices.\n\nTomás cumplió cinco y ya se sabe todas las canciones del colegio. Una noche, mirando por la ventana, se volteó y nos dijo: "la luna nos está siguiendo". Lucía dijo sus primeras palabras en marzo, empezó a caminar en mayo y desde entonces no hay quien la pare.\n\nLos queremos mucho y les deseamos una feliz Navidad.',
    warm:
      'Queridos todos:\n\nEste año queríamos mandarles un pedacito de nuestra vida. Lo pasamos entre la piscina, paseos y unos días en la finca de los abuelos, viendo a Tomás y a Lucía crecer.\n\nTomás ya tiene cinco, aprendió a nadar sin flotadores y sigue convencido de que "la luna nos está siguiendo". Lucía empezó a caminar en mayo y, desde que descubrió los columpios, no hay parque que se le escape.\n\nLes mandamos mucho cariño y les deseamos una feliz Navidad.',
    playful:
      'Queridos todos:\n\nLes contamos en qué andamos. Este año fue de piscina, de paseos y de comer helado más veces de las que nos gustaría admitir.\n\nTomás cumplió cinco, se volvió experto en nadar sin flotadores y tiene su propia teoría: "la luna nos está siguiendo". Lucía empezó a caminar y no se pierde una aventura si su hermano va adelante.\n\nLos queremos mucho. ¡Feliz Navidad!',
  },
  en: {
    classic:
      'Dear family and friends,\n\nWe wanted to tell you a little about our year. It was a year of the pool, long walks and a few days at Grandma\'s farm, and through all of it, Tom and Lucy kept growing up happy.\n\nTom turned five and now knows every song from school. One night, looking out the window, he turned to us and said, "the moon is following us." Lucy said her first words in March, started walking in May, and there has been no stopping her since.\n\nWe love you all and wish you a merry Christmas.',
    warm:
      'Dear family and friends,\n\nThis year we wanted to send you a little piece of our life. We spent it between the pool, long walks and a few days at Grandma\'s farm, watching Tom and Lucy grow.\n\nTom is five now, learned to swim without floaties and is still convinced that "the moon is following us." Lucy started walking in May and, since she discovered the swings, no playground is safe.\n\nSending you lots of love and wishing you a merry Christmas.',
    playful:
      'Dear family and friends,\n\nHere is what we have been up to. This year was all pool, long walks and more ice cream than we would like to admit.\n\nTom turned five, became an expert swimmer without floaties and has his own theory: "the moon is following us." Lucy started walking and never misses an adventure if her brother is leading it.\n\nWe love you all. Merry Christmas!',
  },
};

export function buildWriterSystemPrompt(options: {
  language: FilmLanguage;
  locale?: string | null;
  greeting?: CardGreeting;
}): string {
  const lang = options.language;
  return [
    `You write a family's holiday letter, as the parents ("we"), to relatives and friends, in ${lang === 'es' ? 'Spanish' : 'English'} — ${registerNote(lang, options.locale)}.`,
    '',
    'How it goes:',
    '1. Three short paragraphs: a greeting line ("Queridos todos:" / "Dear family and friends,") followed by a blank line, then why you are writing + the year in broad strokes ending on the kids; then each child in one flowing sentence that strings two or three of their facts together; then love and the wish.',
    '2. CHOOSE: you do not have to use every fact. Per child, pick the two or three that make the best sentence and connect them with one warm turn of your own, the way the examples do — never a bare list like "cumplió dos, dio sus primeros pasos y estrenó lentes". Good letters leave things out.',
    '2b. Use ONLY the FACTS and BROAD STROKES given. Tell them the way parents talk: warm framing of a real fact is exactly right. Never add a fact: no new events, places, dates, numbers, skills, gifts or feelings.',
    '3. A child\'s words stay exact inside quotation marks. When they open with "papi,"/"mami,"/"daddy," or end in "!", quote just the core ("el mundo es un lugar mágico") and let the sentence say who heard it.',
    '3b. A child\'s [skill] fact (a new ability) is the best news about them: when there is one, it is always one of their two or three things.',
    '3c. The opening names at most THREE things the year was about; never a longer list.',
    '4. Sound like a person talking, not a report: vary the sentences; no clichés ("momentos inolvidables", "lleno de amor", "magical moments"); no invitations to meet or catch up; never mention a film, video, QR or app; no names other than the children and the people listed.',
    `5. The close is love + the wish${options.greeting ? ` (${greetingWishNote(options.greeting, lang)})` : ''}.`,
    `6. Plain text, at most ${WRITER_MAX_CHARS} characters, no emoji.`,
    '',
    'Three example letters for a FICTIONAL family — they show the shape and the voice. Never reuse their sentences, names, facts or turns of phrase (find your own: a turn that fits THIS child):',
    '',
    `CLASSIC:\n${EXAMPLES[lang].classic}`,
    '',
    `WARM:\n${EXAMPLES[lang].warm}`,
    '',
    `PLAYFUL:\n${EXAMPLES[lang].playful}`,
    '',
    'Respond with JSON only: {"text":"…"}',
  ].join('\n');
}

export function buildWriterUserPrompt(args: {
  angle: WriterAngle;
  facts: EditorFact[];
  broadStrokes: string | null;
  children: { name: string; gender: string | null }[];
  voice?: LetterVoice;
  language: FilmLanguage;
}): string {
  const lines: string[] = [];
  lines.push(`WRITE THE ${args.angle.toUpperCase()} LETTER (lean on the ${args.angle.toUpperCase()} example's feel).`);
  // Owner choice (c), 2026-10-05: the classic and warm letters stay plain;
  // the playful one gets the charm (and may take a risk the parent edits).
  lines.push(args.angle === 'playful'
    ? 'TONE: charm is the point here — one light, affectionate turn per child, the kind that makes relatives smile. Still only real facts.'
    : 'TONE: plain and warm. Every turn must be something a parent would really say out loud to family; when a turn feels clever or strained, say it plainly instead.');
  lines.push('');
  lines.push(`CHILDREN: ${args.children.map((c) => `${c.name}${c.gender ? ` (${c.gender})` : ''}`).join(', ')}`);
  if (args.broadStrokes) lines.push(`BROAD STROKES: ${args.broadStrokes}`);
  lines.push('FACTS:');
  for (const f of args.facts) lines.push(`- ${f.about ?? 'family'} [${f.kind}]: ${f.fact}`);
  const examples = args.voice && args.voice.language === args.language ? args.voice.examples : [];
  if (examples.length) {
    lines.push('');
    lines.push('HOW THESE PARENTS WRITE (their own captions — match the voice, never reuse the content):');
    for (const e of examples) lines.push(`- "${e}"`);
  }
  return lines.join('\n');
}

export function parseWriterText(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { text?: unknown };
    return typeof data.text === 'string' && data.text.trim() ? greetingOnItsOwnLine(data.text.trim()) : null;
  } catch {
    return null;
  }
}

// ── Checks ───────────────────────────────────────────────────────────────

/** The v1 checks that matter for v2: hard ones reject; only a few soft ones
 * are shown (the rest pushed v1 toward stiffness). */
const SOFT_SHOWN: ReadonlySet<string> = new Set([
  'invitation', 'foreign_word', 'occasion_mismatch', 'age_mismatch', 'child_missing', 'unverified_quote', 'spain_perfect', 'cliche',
]);

export function checkV2Letter(
  text: string,
  angle: WriterAngle,
  digest: YearDigest,
  language: FilmLanguage,
  options: { voice?: LetterVoice; greeting?: CardGreeting; locale?: string | null } = {},
): { hard: LetterFlag[]; soft: LetterFlag[] } {
  const tone = angle === 'warm' ? 'reflective' : angle;
  const flags = checkLetterText(text, tone, digest, language, options.voice, options.greeting, options.locale);
  const hard = flags.filter((f) => HARD_CODES.has(f.code));
  if (Array.from(text).length > WRITER_MAX_CHARS + 80) hard.push({ code: 'over_length', detail: `${Array.from(text).length} chars` });
  return { hard, soft: flags.filter((f) => SOFT_SHOWN.has(f.code)) };
}

const HARD_CODES: ReadonlySet<string> = new Set(['empty', 'sensitive_text', 'developmental_language', 'forbidden_name', 'film_mention']);
