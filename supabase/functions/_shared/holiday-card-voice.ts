// Holiday card voice: infers the parents' own writing style from a sample of
// their captions, so the letter reads as if "we" wrote it (owner review,
// round 3, 2026-10-04). Two steps:
//   1. selectVoiceSamples → buildVoiceCardPrompt → (one model call, by the
//      caller) → parseVoiceCard: a STYLE CARD that describes how the parents
//      write — register, how they name the kids, person, rhythm, humor,
//      punctuation, the words they actually use, what they never do. It
//      describes style only: parseVoiceCard drops anything that names a
//      person or copies a long run of a caption, so no memory content or
//      events survive into the card.
//   2. voiceExamples: a few short verbatim caption snippets the letter prompt
//      shows as "voice examples (do not reuse their content)".
//
// Pure: no I/O, no Deno APIs. Production note: the style card depends only on
// the parents' captions, so it is computed ONCE per family per card (the
// Edge Function / Workflow that writes the letters) and cached with the card;
// regenerating letters reuses it. Samples are the CORE PARENTS' captions only
// — never a relative's — and share-safe only.
//
// PII: samples and examples are memory text; never log them. The style card
// is safe to store and show.
import { addYears } from './date-context.ts';
import { excerptOf } from './holiday-card-digest.ts';
import { HOLIDAY_EXCLUDED_EMOTIONS, type FilmMilestoneInput } from './year-film-eligibility.ts';
import { type FilmMemorySource, shareSensitiveIds } from './year-film-script.ts';
import { FRAME_CHECK_MODEL } from './year-film-vision.ts';

/** The style card is an extraction task over ~40 short captions, run once per
 * card: the cheap model (GPT-6 Luna, the film's bulk-check model) is enough;
 * the creative step (the letters) stays on the letter model. */
export const VOICE_CARD_MODEL = FRAME_CHECK_MODEL;

export const VOICE_SAMPLE_COUNT = 40;
export const VOICE_SAMPLE_MIN_CHARS = 40;
export const VOICE_SAMPLE_MAX_CHARS = 240;
export const VOICE_WINDOW_YEARS = 1;
export const VOICE_EXAMPLE_COUNT = 5;
export const VOICE_EXAMPLE_MAX_CHARS = 160;
const EXAMPLE_MIN_CHARS = 50;

export interface CaptionSample {
  memoryId: string;
  date: string;
  emotion: string | null;
  /** ≤ VOICE_SAMPLE_MAX_CHARS, one line, no links. */
  text: string;
}

/** ~40 diverse captions written by the core parents: share-safe, long enough
 * to show a voice, from the last ~12 months before `today`, spread over the
 * months and across moods. Deterministic. */
export function selectVoiceSamples(
  memories: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  options: { parentAuthorIds: readonly string[]; today: string; count?: number },
): CaptionSample[] {
  const authors = new Set(options.parentAuthorIds);
  const from = addYears(options.today, -VOICE_WINDOW_YEARS);
  const sensitive = shareSensitiveIds(memories, milestones);
  const eligible = memories.filter((m) =>
    !!m.authorId && authors.has(m.authorId) && !m.reported && !sensitive.has(m.id) &&
    !(m.emotion && HOLIDAY_EXCLUDED_EMOTIONS.has(m.emotion)) &&
    m.date >= from && m.date <= options.today &&
    Array.from(excerptOf(m.text, Number.MAX_SAFE_INTEGER)).length >= VOICE_SAMPLE_MIN_CHARS
  );
  const byMonth = new Map<string, FilmMemorySource[]>();
  for (const m of [...eligible].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const key = m.date.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), m]);
  }
  const months = [...byMonth.keys()].sort();
  const target = options.count ?? VOICE_SAMPLE_COUNT;
  const picked: FilmMemorySource[] = [];
  const emotions = new Map<string, number>();
  // Round-robin over the months; inside a month, the memory whose mood has
  // been picked least so far.
  while (picked.length < target && months.some((k) => byMonth.get(k)!.length > 0)) {
    for (const key of months) {
      const list = byMonth.get(key)!;
      if (list.length === 0 || picked.length >= target) continue;
      list.sort((a, b) =>
        (emotions.get(a.emotion ?? '') ?? 0) - (emotions.get(b.emotion ?? '') ?? 0) || a.id.localeCompare(b.id)
      );
      const next = list.shift()!;
      picked.push(next);
      emotions.set(next.emotion ?? '', (emotions.get(next.emotion ?? '') ?? 0) + 1);
    }
  }
  return picked
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
    .map((m) => ({ memoryId: m.id, date: m.date, emotion: m.emotion, text: excerptOf(m.text, VOICE_SAMPLE_MAX_CHARS) }));
}

// ── Style card ───────────────────────────────────────────────────────────

const PERSONS = ['we', 'I', 'mixed', 'other'] as const;
const ADDRESSEES = ['about_the_child', 'to_the_child', 'mixed'] as const;
const LENGTHS = ['short', 'medium', 'long', 'mixed'] as const;
const FORMALITY = ['casual', 'neutral', 'formal'] as const;
const HUMOR = ['none', 'dry', 'warm', 'playful'] as const;
const FREQUENCY = ['none', 'rare', 'frequent'] as const;

export interface VoiceCard {
  /** How they address people and how casual they sound ("tú, casual, slangy").
   * NEVER where they are from: language and region come from the family's
   * caption-language setting (owner, round 5), not from the style card. */
  register: string;
  /** How they refer to the kids, as a PATTERN (no names): "first names, often
   * with diminutives", "los chicos". */
  kidsReference: string;
  person: (typeof PERSONS)[number];
  addressee: (typeof ADDRESSEES)[number];
  sentenceLength: (typeof LENGTHS)[number];
  rhythm: string;
  formality: (typeof FORMALITY)[number];
  humor: (typeof HUMOR)[number];
  openers: string[];
  closers: string[];
  punctuation: {
    exclamations: (typeof FREQUENCY)[number];
    emojis: (typeof FREQUENCY)[number];
    ellipses: (typeof FREQUENCY)[number];
    notes: string;
  };
  /** 5–10 words or phrases they actually use. */
  characteristic: string[];
  /** Things they never do. */
  never: string[];
}

export function buildVoiceCardSystemPrompt(): string {
  return [
    'You describe HOW a family\'s parents write, from a sample of the captions they wrote about their kids, so that someone else can later write a short letter that sounds like them.',
    'Describe STYLE only. Never include any content from the captions: no events, no places, no names of any person (not even the kids), no quotes of whole sentences. Short characteristic words or phrases the parents really use are fine and wanted.',
    'Be factual and specific, grounded only in the samples. If you cannot tell, say so in the field or pick the neutral value. Do not flatter and do not invent habits.',
    'Fields:',
    '- register: how they address people and how casual they sound (tú / usted / ustedes, slang level, contractions) — about HOW they write. Do NOT guess or mention a country, region, dialect or nationality: the language and region are known from elsewhere.',
    '- kids_reference: how they refer to the children, as a pattern, WITHOUT names ("first names with frequent diminutives", "calls them los chicos", "uses nicknames").',
    `- person: ${PERSONS.map((v) => `"${v}"`).join(' | ')} — the grammatical person they write in ("we" = nosotros/we).`,
    `- addressee: ${ADDRESSEES.map((v) => `"${v}"`).join(' | ')} — whether they write ABOUT the child or TO the child.`,
    `- sentence_length: ${LENGTHS.map((v) => `"${v}"`).join(' | ')}; rhythm: one sentence on how sentences flow (fragments? run-ons? lists?).`,
    `- formality: ${FORMALITY.map((v) => `"${v}"`).join(' | ')}; humor: ${HUMOR.map((v) => `"${v}"`).join(' | ')}.`,
    '- openers / closers: up to 5 each, the typical ways they start and end a caption (as patterns or short phrases, never full sentences about an event).',
    `- punctuation: {"exclamations","emojis","ellipses"} each ${FREQUENCY.map((v) => `"${v}"`).join(' | ')}, plus "notes" (other habits: lowercase starts, no accents, parentheses…).`,
    '- characteristic: 5–10 everyday words or short phrases they actually use (interjections, favourite adjectives, register markers) — NOT in-jokes, family catchphrases or phrases that only make sense with the context of one event.',
    '- never: up to 8 things they never do (never use emojis, never sentimental, never write long paragraphs…).',
    'Respond with JSON only: {"register","kids_reference","person","addressee","sentence_length","rhythm","formality","humor","openers":[],"closers":[],"punctuation":{"exclamations","emojis","ellipses","notes"},"characteristic":[],"never":[]}',
  ].join('\n');
}

export function buildVoiceCardPrompt(samples: CaptionSample[]): { system: string; user: string } {
  const user = [
    `${samples.length} captions written by the parents, oldest first:`,
    ...samples.map((s, i) => `${i + 1}. ${s.text}`),
  ].join('\n');
  return { system: buildVoiceCardSystemPrompt(), user };
}

export function buildVoiceCardRequestBody(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

export type VoiceCardFlag =
  | 'bad_json'
  | 'bad_shape'
  | 'dropped_name'
  | 'dropped_copy'
  | 'dropped_region'
  | 'too_few_characteristic';

/** Country, region and dialect words the style card must not carry (es + en). */
const REGION_TEXT =
  /(?<!\p{L})(colomb\p{L}*|mexic\p{L}*|argentin\p{L}*|espa[ñn]\p{L}*|spain|spanish from|latin[- ]?americ\p{L}*|latam|per[uú]\p{L}*|chile\p{L}*|venezol\p{L}*|caribb?\p{L}*|rioplatense|castellano|dialect\p{L}*|dialecto|region\p{L}*|regi[oó]n\p{L}*|american english|british|uk english)(?!\p{L})/iu;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t.length > 0 ? Array.from(t).slice(0, max).join('') : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback?: T): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback ?? null;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parses and validates the model's style card. Never throws on model output.
 * Items that name a person (`names`: every family member, first names and
 * surname tokens) or reproduce a long run of a caption are dropped, so the
 * card stays a description of style. Returns null when the essentials are
 * missing. */
export function parseVoiceCard(
  raw: string,
  context: { samples: CaptionSample[]; names: string[] },
): { card: VoiceCard | null; flags: VoiceCardFlag[] } {
  const flags = new Set<VoiceCardFlag>();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('shape');
  } catch {
    return { card: null, flags: ['bad_json'] };
  }
  const corpus = normalize(context.samples.map((s) => s.text).join(' | '));
  const namePatterns = context.names.filter((n) => n.length >= 2).map((n) => new RegExp(`(?<!\\p{L})${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'iu'));
  const clean = (value: unknown, cap: number, max = 80): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      const t = text(item, max);
      if (!t) continue;
      if (namePatterns.some((p) => p.test(t))) {
        flags.add('dropped_name');
        continue;
      }
      // A run of 30+ normalized characters that is verbatim in the captions is content, not style.
      if (normalize(t).length >= 30 && corpus.includes(normalize(t))) {
        flags.add('dropped_copy');
        continue;
      }
      if (!out.includes(t)) out.push(t);
      if (out.length >= cap) break;
    }
    return out;
  };
  const prose = (value: unknown, max: number): string | null => {
    const t = text(value, max);
    if (t && namePatterns.some((p) => p.test(t))) {
      flags.add('dropped_name');
      return null;
    }
    return t;
  };

  // The model must not guess where the parents are from: a register that names
  // a country, region or dialect is replaced (the setting decides, owner round 5).
  let register = prose(parsed.register, 200) ?? 'not clear from the samples';
  if (REGION_TEXT.test(register)) {
    flags.add('dropped_region');
    register = 'not clear from the samples';
  }
  const person = oneOf(parsed.person, PERSONS);
  const humor = oneOf(parsed.humor, HUMOR);
  const sentenceLength = oneOf(parsed.sentence_length, LENGTHS);
  if (!person || !humor || !sentenceLength) {
    return { card: null, flags: [...flags, 'bad_shape'] };
  }
  const punctuation = (parsed.punctuation ?? {}) as Record<string, unknown>;
  const characteristic = clean(parsed.characteristic, 10, 40);
  if (characteristic.length < 3) flags.add('too_few_characteristic');
  return {
    card: {
      register,
      kidsReference: prose(parsed.kids_reference, 200) ?? 'not clear from the samples',
      person,
      addressee: oneOf(parsed.addressee, ADDRESSEES, 'about_the_child')!,
      sentenceLength,
      rhythm: prose(parsed.rhythm, 200) ?? '',
      formality: oneOf(parsed.formality, FORMALITY, 'casual')!,
      humor,
      openers: clean(parsed.openers, 5),
      closers: clean(parsed.closers, 5),
      punctuation: {
        exclamations: oneOf(punctuation.exclamations, FREQUENCY, 'rare')!,
        emojis: oneOf(punctuation.emojis, FREQUENCY, 'none')!,
        ellipses: oneOf(punctuation.ellipses, FREQUENCY, 'none')!,
        notes: prose(punctuation.notes, 200) ?? '',
      },
      characteristic,
      never: clean(parsed.never, 8, 100),
    },
    flags: [...flags],
  };
}

/** The style card as prompt lines for the letter writer: REGISTER and RHYTHM
 * (owner, round 4: voice is not vocabulary). Caption openers are deliberately
 * left out — "Hoy…" opens a caption, not a letter — and `characteristic`
 * words are offered separately (`characteristicWords`), at most one per
 * letter. */
export function describeVoiceCard(card: VoiceCard): string[] {
  const list = (items: string[]) => (items.length ? items.map((i) => `"${i}"`).join(', ') : '—');
  return [
    `how they address people: ${card.register}`,
    `how they name the kids: ${card.kidsReference}`,
    `person: ${card.person === 'we' ? 'we (nosotros)' : card.person === 'I' ? 'I (one parent speaking)' : card.person}; they write ${card.addressee.replaceAll('_', ' ')}`,
    `sentences: ${card.sentenceLength}${card.rhythm ? ` — ${card.rhythm}` : ''}`,
    `formality: ${card.formality}; humor: ${card.humor}`,
    `how they end a thought (a pattern, not words to copy): ${list(card.closers)}`,
    `punctuation: exclamations ${card.punctuation.exclamations}, emojis ${card.punctuation.emojis}, ellipses ${card.punctuation.ellipses}${card.punctuation.notes ? `; ${card.punctuation.notes}` : ''}`,
    `they never: ${list(card.never)}`,
  ];
}

/** The words they really use, for the letter prompt (single plain words and
 * short phrases; in-jokes are the model's call to skip, and the post-check
 * flags more than one per letter). */
export function characteristicWords(card: VoiceCard): string[] {
  return card.characteristic.filter((w) => w.split(' ').length <= 3);
}

// ── Voice examples ───────────────────────────────────────────────────────

/** 4–6 short verbatim caption snippets, spread over the sample, none that
 * names someone outside the family (`forbiddenNames`) — shown to the letter
 * writer for voice only. */
export function voiceExamples(
  samples: CaptionSample[],
  options: { forbiddenNames: string[]; count?: number },
): string[] {
  const patterns = options.forbiddenNames.map((n) => new RegExp(`(?<!\\p{L})${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'u'));
  const usable = samples
    .map((s) => excerptOf(s.text, VOICE_EXAMPLE_MAX_CHARS))
    .filter((t) => Array.from(t).length >= EXAMPLE_MIN_CHARS && !patterns.some((p) => p.test(t)));
  const count = Math.min(options.count ?? VOICE_EXAMPLE_COUNT, usable.length);
  if (count === 0) return [];
  const step = usable.length / count;
  return Array.from({ length: count }, (_, i) => usable[Math.min(usable.length - 1, Math.floor(i * step + step / 2))]);
}

/** Longest run of words the two texts share (for the letter's "did not copy a
 * voice example" check). */
export function sharedWordRun(a: string, b: string): number {
  const x = normalize(a).split(' ').filter(Boolean);
  const y = normalize(b).split(' ').filter(Boolean);
  let best = 0;
  const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    let diagPrev = 0;
    for (let j = 1; j <= y.length; j += 1) {
      const saved = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diagPrev + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diagPrev = saved;
    }
  }
  return best;
}
