// Holiday card letters, orchestration (docs/plans/holiday-cards-p1.md Step
// 4a): the production port of eval-holiday-card-letters.ts's v2 path, with the
// owner's 2026-10-06 decisions:
//   - letters are written from the POOL digest during generation (no waiting
//     for the film); `filmPresent` = the card's film is eligible (it only
//     decides the QR caption); the line of the year comes from the quote
//     verifier (year-film-quotes.ts) run over the same share-safe pool;
//   - v2: an EDITOR picks what is worth telling, then one WRITER call per
//     angle (classic, warm, playful); the v1 hard checks reject a letter.
//
// Steps (each is exported; `writeCardLetters` composes them and
// `prepareCardLetters` runs the paid preparation ones so a Workflow can make
// them separate durable steps):
//   verifyLineOfYear   one quote-pick call -> verified quotes (code-checked
//                      verbatim against the memory text)
//   extractChildDetails one cheap call per child (retried once) -> verified
//                      specific details
//   buildParentsVoice  one cheap call -> the parents' style card (style only)
//   buildPoolDigest    pure; the profiles the writer sees
//   writeLanguageLetters  editor call + one writer call per angle + checks
//
// All IO is injected (holiday-card-generate-ports.ts). Pure otherwise: no
// supabase-js, no Deno.*, no env. PII: memory text goes to the model as quoted
// data and into the returned values (letters, facts, the line of the year,
// details); it is never logged here. Results that hold text are named so.
import {
  buildDigestFromPool,
  type DigestContext,
  type YearDigest,
} from './holiday-card-digest.ts';
import {
  buildDetailsPrompt,
  buildDetailsRequestBody,
  DETAILS_MODEL,
  type DetailsResult,
  parseDetails,
  type SpecificDetail,
  selectDetailExcerpts,
} from './holiday-card-details.ts';
import {
  buildVoiceCardPrompt,
  buildVoiceCardRequestBody,
  type CaptionSample,
  parseVoiceCard,
  selectVoiceSamples,
  VOICE_CARD_MODEL,
  type VoiceCard,
  type VoiceCardFlag,
  voiceExamples,
} from './holiday-card-voice.ts';
import {
  buildLetterRequestBody,
  type CardGreeting,
  defaultSignature,
  LETTER_MODEL,
  type LetterFlag,
  type LetterVoice,
  type ResolvedLetterLanguage,
  resolveLetterLanguage,
} from './holiday-card-letter.ts';
import {
  buildEditorSystemPrompt,
  buildEditorUserPrompt,
  buildWriterSystemPrompt,
  buildWriterUserPrompt,
  checkV2Letter,
  type EditorCandidate,
  type EditorFact,
  type EditorResult,
  parseEditorFacts,
  parseWriterText,
  selectEditorCandidates,
  WRITER_ANGLES,
  type WriterAngle,
} from './holiday-card-letter-v2.ts';
import { callModel, type ChatPort, type UsageSink } from './holiday-card-generate-ports.ts';
import {
  chapterChildren,
  type FilmMilestoneInput,
  type FilmScope,
  holidayFilmScope,
  holidayPool,
  isFilmChild,
} from './year-film-eligibility.ts';
import { detectJournalLanguage, type FilmLanguage, resolveFilmLanguage } from './year-film-i18n.ts';
import {
  buildQuotePrompt,
  buildQuoteRequestBody,
  HOLIDAY_QUOTE_MODEL,
  parseQuoteResponse,
  type QuoteRejection,
  selectQuotePool,
} from './year-film-quotes.ts';
import { type FilmMemorySource, type FilmPerson, shareSensitiveIds, type VerifiedQuote } from './year-film-script.ts';

// ── Input ────────────────────────────────────────────────────────────────

/** What the letters read: the year-film mapping's output
 * (`mapFamilyRows(...)` in year-film-context.ts: `FamilyFilmData`) plus the
 * family's caption guidance. DB fields behind each part:
 *   familyName       families.name
 *   language         families.gallery_caption_language (e.g. "es-CO")
 *   members          family_members: id, name, date_of_birth, relationship,
 *                    created_at, user_id, nicknames, gender
 *   memories         memories (saved only): id, content, memory_date,
 *                    memory_type, emotion, topics, labels, user_id,
 *                    illustration_status/key, media_key/content_type, plus
 *                    memory_media, memory_family_members tags and the open
 *                    content reports (reported memories are excluded)
 *   milestones       memory_milestones: memory_id, family_member_id,
 *                    milestone_id, status, out_of_band
 *   captionInstructions  families.gallery_caption_instructions (kept for the
 *                    v1 writer; the v2 writer does not read it, as in the eval) */
export interface CardLettersData {
  familyName: string;
  language: string | null;
  members: FilmPerson[];
  memories: FilmMemorySource[];
  milestones: FilmMilestoneInput[];
  captionInstructions?: string | null;
}

export interface LetterModels {
  /** Editor + writers (default LETTER_MODEL = gpt-6.1-sol). */
  letter?: string;
  /** The parents' style card (default VOICE_CARD_MODEL). */
  voice?: string;
  /** Per-child specific details (default DETAILS_MODEL). */
  details?: string;
  /** The line-of-the-year pick (default HOLIDAY_QUOTE_MODEL = gpt-6.1-sol). */
  quote?: string;
}

export interface LettersPorts {
  chat: ChatPort;
  usage: UsageSink;
}

/** The paid preparation results, small and serializable (a Workflow keeps
 * them between steps). `quotes` and `specifics` hold short phrases of memory
 * text; `voiceCard` is style only. */
export interface PreparedLetters {
  quotes: VerifiedQuote[];
  /** child member id -> verified specific details. */
  specifics: Record<string, SpecificDetail[]>;
  voiceCard: VoiceCard | null;
  dropped: { quotes: number; details: number };
}

export interface CardLettersInput {
  /** The card's date, YYYY-MM-DD. The scope is Jan 1 of its year -> today. */
  today: string;
  data: CardLettersData;
  /** The card's greeting (the closing wish follows it). */
  greeting: CardGreeting | null;
  /** The card's film is eligible: the editor may write a QR caption. */
  filmPresent: boolean;
  /** Override the scope (default `holidayFilmScope(year, today)`). */
  scope?: FilmScope;
  /** Results of `prepareCardLetters`; when absent they are computed. */
  prepared?: PreparedLetters;
  models?: LetterModels;
}

// ── Language, scope, pool, digest ────────────────────────────────────────

export function holidayLetterScope(today: string): FilmScope {
  return holidayFilmScope(Number(today.slice(0, 4)), today);
}

/** The share-safe pool the letters read (holidayPool minus share-sensitive
 * memories and worried/sad/weary moments). */
export function holidayLetterPool(
  memories: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  scope: FilmScope,
): FilmMemorySource[] {
  return holidayPool(memories, scope, shareSensitiveIds(memories, milestones));
}

/** The family's caption-language setting is authoritative (language AND
 * regional register); detection from the journal is only the fallback. */
export function resolveLettersLanguage(setting: string | null | undefined, pool: FilmMemorySource[]): ResolvedLetterLanguage {
  const detected = resolveFilmLanguage(null, detectJournalLanguage(pool.map((m) => m.text)), null);
  return resolveLetterLanguage(setting, detected);
}

export interface PoolDigestArgs {
  memories: FilmMemorySource[];
  milestones: FilmMilestoneInput[];
  members: FilmPerson[];
  scope: FilmScope;
  language: FilmLanguage;
  familyName: string;
  /** Verified quotes: the line of the year. */
  quotes?: VerifiedQuote[];
  specifics?: DigestContext['specifics'];
  /** The card has a film behind its QR code. `buildDigestFromPool` says no;
   * the card's own decision overrides it. */
  filmPresent: boolean;
}

export function buildPoolDigest(args: PoolDigestArgs): YearDigest {
  const digest = buildDigestFromPool(args.memories, args.milestones, args.members, args.scope, args.language, {
    familyName: args.familyName,
    ...(args.quotes ? { quotes: args.quotes } : {}),
    ...(args.specifics ? { specifics: args.specifics } : {}),
  });
  return { ...digest, filmPresent: args.filmPresent };
}

// ── Line of the year (quote check) ───────────────────────────────────────

/** The children a quote can belong to: the film's own rule (planFilm,
 * `family_holiday`): own children at the scope end, born before it. */
export function quoteSubjectsFor(members: FilmPerson[], scope: FilmScope): { id: string; name: string }[] {
  const children = members.filter((m) => isFilmChild({ id: m.id, dateOfBirth: m.dateOfBirth, relationship: m.relationship }, scope.endExclusive));
  return chapterChildren(children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
    .map((k) => children.find((c) => c.id === k.id)!)
    .map((c) => ({ id: c.id, name: c.name.trim().split(/\s+/)[0] || c.name }));
}

export interface QuoteCheckResult {
  /** Code-verified (verbatim substring, known speaker): safe to print. */
  quotes: VerifiedQuote[];
  rejected: number;
  rejectedReasons: Partial<Record<QuoteRejection['reason'], number>>;
  /** Null when the call ran; otherwise 'no_candidates' | 'call_failed' | the
   * caller's `disabledReason`. */
  skipped: string | null;
}

/** One quote-pick call over the share-safe pool (the film's own quote
 * verifier on the pool path). The model only selects; every returned quote
 * must be a verbatim substring of its memory's text. A failed call is not an
 * error: the letters simply have no line of the year. */
export async function verifyLineOfYear(
  args: { memories: FilmMemorySource[]; milestones: FilmMilestoneInput[]; members: FilmPerson[]; scope: FilmScope; model?: string; disabledReason?: string },
  ports: LettersPorts,
): Promise<QuoteCheckResult> {
  if (args.disabledReason) return { quotes: [], rejected: 0, rejectedReasons: {}, skipped: args.disabledReason };
  const quotable = holidayLetterPool(args.memories, args.milestones, args.scope);
  const subjects = quoteSubjectsFor(args.members, args.scope);
  const pool = selectQuotePool(quotable, subjects);
  if (subjects.length === 0 || pool.length === 0) return { quotes: [], rejected: 0, rejectedReasons: {}, skipped: 'no_candidates' };
  const { system, user } = buildQuotePrompt(subjects, pool);
  const content = await callModel(ports, 'holiday_card_quote_check', 'quote_check', buildQuoteRequestBody(system, user, args.model ?? HOLIDAY_QUOTE_MODEL));
  if (content === null) return { quotes: [], rejected: 0, rejectedReasons: {}, skipped: 'call_failed' };
  const parsed = parseQuoteResponse(content, subjects, new Map(pool.map((m) => [m.id, m.text])));
  const rejectedReasons: QuoteCheckResult['rejectedReasons'] = {};
  for (const r of parsed.rejected) rejectedReasons[r.reason] = (rejectedReasons[r.reason] ?? 0) + 1;
  return { quotes: parsed.accepted, rejected: parsed.rejected.length, rejectedReasons, skipped: null };
}

// ── Specific details per child ───────────────────────────────────────────

export interface ChildDetailsEntry {
  name: string;
  /** Excerpts read. */
  excerpts: number;
  result: DetailsResult | null;
  /** 'no_excerpts' | 'call_failed' | the caller's `disabledReason` | null. */
  skipped: string | null;
}

/** Specific details per child, read from their memories' own text (one cheap
 * call per child over <= 25 excerpts, retried once when fewer than 3 verify)
 * and verified there. `digest` supplies the children, people and names (any
 * digest of the same pool: specifics do not change them). */
export async function extractChildDetails(
  args: {
    memories: FilmMemorySource[];
    milestones: FilmMilestoneInput[];
    scope: FilmScope;
    digest: YearDigest;
    model?: string;
    disabledReason?: string;
  },
  ports: LettersPorts,
): Promise<{ specifics: Record<string, SpecificDetail[]>; entries: ChildDetailsEntry[] }> {
  const { digest } = args;
  const ownChildIds = digest.children.map((c) => c.memberId);
  const names = [
    ...digest.people.map((p) => p.name),
    ...digest.forbiddenNames,
    ...digest.children.flatMap((c) => c.nicknames.flatMap((n) => [n, ...n.split(/\s+/)])),
  ];
  const childNames = Object.fromEntries(digest.children.map((c) => [c.memberId, c.name]));
  const specifics: Record<string, SpecificDetail[]> = {};
  const entries: ChildDetailsEntry[] = [];
  for (const child of digest.children) {
    const excerpts = selectDetailExcerpts(args.memories, args.milestones, { childId: child.memberId, scope: args.scope, ownChildIds, childNames });
    const entry: ChildDetailsEntry = { name: child.name, excerpts: excerpts.length, result: null, skipped: null };
    entries.push(entry);
    if (args.disabledReason) entry.skipped = args.disabledReason;
    else if (excerpts.length === 0) entry.skipped = 'no_excerpts';
    else {
      const { system, user } = buildDetailsPrompt(child.name, excerpts);
      // The cheap model sometimes returns too few: one retry, keep the better.
      for (let attempt = 0; attempt < 2 && (entry.result === null || entry.result.verified < 3); attempt += 1) {
        const content = await callModel(
          ports,
          'holiday_card_details',
          `details:${child.memberId}:${attempt}`,
          buildDetailsRequestBody(args.model ?? DETAILS_MODEL, system, user),
        );
        if (content === null) {
          if (entry.result === null) entry.skipped = 'call_failed';
          continue;
        }
        const next = parseDetails(content, excerpts, names, { name: child.name, nicknames: child.nicknames });
        if (entry.result === null || next.verified > entry.result.verified) entry.result = next;
        entry.skipped = null;
      }
      if (entry.result) specifics[child.memberId] = entry.result.details;
    }
  }
  return { specifics, entries };
}

// ── The parents' voice ───────────────────────────────────────────────────

export interface VoiceRun {
  /** Whose captions: the parents linked to an account, else the account that
   * wrote the most memories, else nobody. */
  source: 'linked_parents' | 'top_author' | 'none';
  authors: number;
  samples: CaptionSample[];
  card: VoiceCard | null;
  flags: VoiceCardFlag[];
  /** Verbatim caption snippets (memory text): for the writer's prompt only. */
  examples: string[];
  /** 'no_samples' | 'call_failed' | the caller's `disabledReason` | null. */
  skipped: string | null;
  model: string;
  /** The model's raw card (style only). */
  raw: string | null;
}

/** The parents' voice: their own captions only (members whose role is parent,
 * through the account each is linked to; if none is linked, the account that
 * wrote the most memories). `memories` should be all of the family's memories
 * (it is how they write, independent of the card's scope). */
export async function buildParentsVoice(
  args: {
    memories: FilmMemorySource[];
    milestones: FilmMilestoneInput[];
    members: FilmPerson[];
    digest: YearDigest;
    today: string;
    model?: string;
    disabledReason?: string;
    /** Skip the model call and only select examples (a Workflow that already
     * has the style card from an earlier step). */
    knownCard?: VoiceCard | null;
  },
  ports: LettersPorts,
): Promise<VoiceRun> {
  const model = args.model ?? VOICE_CARD_MODEL;
  const linked = args.members.filter((m) => m.relationship === 'parent' && m.userId).map((m) => m.userId!);
  let authors = linked;
  let source: VoiceRun['source'] = linked.length > 0 ? 'linked_parents' : 'none';
  if (authors.length === 0) {
    const counts = new Map<string, number>();
    for (const m of args.memories) if (m.authorId) counts.set(m.authorId, (counts.get(m.authorId) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    authors = top ? [top[0]] : [];
    if (top) source = 'top_author';
  }
  const samples = selectVoiceSamples(args.memories, args.milestones, { parentAuthorIds: authors, today: args.today });
  // Names the style card must not carry: the children (and their nicknames) and
  // everyone outside the core family. The parents' own names are left out on
  // purpose: families name themselves "Mami"/"Papi", which IS their voice.
  const personNames = [
    ...args.digest.people.filter((p) => p.role === 'child').map((p) => p.name),
    ...args.members
      .filter((m) => args.digest.people.some((p) => p.role === 'child' && p.name === m.name.trim().split(/\s+/)[0]))
      .flatMap((m) => m.nicknames ?? []),
    ...args.digest.forbiddenNames,
  ];
  const run: VoiceRun = { source, authors: authors.length, samples, card: null, flags: [], examples: [], skipped: null, model, raw: null };
  if (args.knownCard !== undefined) run.card = args.knownCard;
  else if (args.disabledReason) run.skipped = args.disabledReason;
  else if (samples.length === 0) run.skipped = 'no_samples';
  else {
    const { system, user } = buildVoiceCardPrompt(samples);
    const content = await callModel(ports, 'holiday_card_voice', 'voice', buildVoiceCardRequestBody(model, system, user));
    if (content === null) run.skipped = 'call_failed';
    else {
      run.raw = content;
      const parsed = parseVoiceCard(content, { samples, names: personNames });
      run.card = parsed.card;
      run.flags = parsed.flags;
    }
  }
  run.examples = voiceExamples(samples, { forbiddenNames: args.digest.forbiddenNames });
  return run;
}

// ── Editor + writers ─────────────────────────────────────────────────────

export interface LanguageLetters {
  language: FilmLanguage;
  /** 'no_highlights' | 'editor_call_failed' | null. */
  skipped: string | null;
  /** Accepted letters; `flags` are the soft findings. `tone` is the writer
   * angle (the card renderer's 'reflective' is the 'warm' angle). */
  variants: { tone: WriterAngle; text: string; chars: number; flags: LetterFlag[] }[];
  /** Letters a hard check rejected (or the model left empty): holds text. */
  rejected: { tone: WriterAngle; text: string; flags: LetterFlag[] }[];
  /** What the editor chose; the candidate entries it read (holds text). */
  editor: (EditorResult & { candidates: EditorCandidate[] }) | null;
}

/** The card renderer's tone for a writer angle (book-renderer
 * `LETTER_TONES`: classic | short | playful | reflective). */
export function cardToneForAngle(angle: WriterAngle): 'classic' | 'playful' | 'reflective' {
  return angle === 'warm' ? 'reflective' : angle;
}

/** The v2 pipeline for one language: the editor call (facts + broad strokes
 * + QR caption), then one writer call per angle, each letter run through the
 * v1 hard checks. `pool` is the share-safe pool (`holidayLetterPool`).
 * `locale` is the regional setting ("es-CO") for the family's own language
 * and null for any other. */
export async function writeLanguageLetters(
  args: {
    digest: YearDigest;
    pool: FilmMemorySource[];
    scope: FilmScope;
    milestones: FilmMilestoneInput[];
    members: FilmPerson[];
    language: FilmLanguage;
    locale: string | null;
    voice: LetterVoice;
    greeting: CardGreeting | null;
    model?: string;
  },
  ports: LettersPorts,
): Promise<LanguageLetters> {
  const { digest, language } = args;
  const model = args.model ?? LETTER_MODEL;
  if (digest.highlights.length === 0) return { language, skipped: 'no_highlights', variants: [], rejected: [], editor: null };
  const greeting = args.greeting ?? undefined;

  const candidates = selectEditorCandidates(args.pool, {
    scope: args.scope,
    milestones: args.milestones,
    children: digest.children.map((c) => ({ id: c.memberId, name: c.name })),
    people: args.members.map((m) => ({ id: m.id, name: m.name })),
  });
  const editorRaw = await callModel(
    ports,
    'holiday_card_editor',
    `editor:${language}`,
    buildLetterRequestBody(model, buildEditorSystemPrompt(language), buildEditorUserPrompt(digest, candidates, language)),
  );
  if (editorRaw === null) return { language, skipped: 'editor_call_failed', variants: [], rejected: [], editor: null };
  const editor = parseEditorFacts(editorRaw, candidates, digest);

  const variants: LanguageLetters['variants'] = [];
  const rejected: LanguageLetters['rejected'] = [];
  for (const angle of WRITER_ANGLES) {
    const raw = await callModel(
      ports,
      'holiday_card_writer',
      `writer:${language}:${angle}`,
      buildLetterRequestBody(
        model,
        buildWriterSystemPrompt({ language, locale: args.locale, greeting }),
        buildWriterUserPrompt({
          angle,
          facts: editor.facts,
          broadStrokes: editor.broadStrokes,
          children: digest.children.map((c) => ({ name: c.name, gender: c.gender })),
          voice: args.voice,
          language,
        }),
      ),
    );
    const text = raw === null ? null : parseWriterText(raw);
    if (!text) {
      rejected.push({ tone: angle, text: '', flags: [{ code: 'empty' }] });
      continue;
    }
    const checks = checkV2Letter(text, angle, digest, language, { voice: args.voice, greeting, locale: args.locale });
    if (checks.hard.length) rejected.push({ tone: angle, text, flags: checks.hard });
    else variants.push({ tone: angle, text, chars: Array.from(text).length, flags: checks.soft });
  }
  return { language, skipped: null, variants, rejected, editor: { ...editor, candidates } };
}

// ── Composition (production entry points) ────────────────────────────────

/** Quote check + per-child details + the parents' voice: the paid
 * preparation, in the eval's order. */
export async function prepareCardLetters(input: Omit<CardLettersInput, 'prepared'>, ports: LettersPorts): Promise<PreparedLetters> {
  const { data } = input;
  const scope = input.scope ?? holidayLetterScope(input.today);
  const pool = holidayLetterPool(data.memories, data.milestones, scope);
  const language = resolveLettersLanguage(data.language, pool).language;
  const digestArgs = { memories: data.memories, milestones: data.milestones, members: data.members, scope, language, familyName: data.familyName, filmPresent: input.filmPresent };

  const quoteCheck = await verifyLineOfYear({ ...digestArgs, model: input.models?.quote }, ports);
  const base = buildPoolDigest({ ...digestArgs, quotes: quoteCheck.quotes });
  const details = await extractChildDetails({ memories: data.memories, milestones: data.milestones, scope, digest: base, model: input.models?.details }, ports);
  const voice = await buildParentsVoice({ memories: data.memories, milestones: data.milestones, members: data.members, digest: base, today: input.today, model: input.models?.voice }, ports);
  return {
    quotes: quoteCheck.quotes,
    specifics: details.specifics,
    voiceCard: voice.card,
    dropped: { quotes: quoteCheck.rejected, details: details.entries.reduce((n, e) => n + (e.result?.dropped ?? 0), 0) },
  };
}

export interface CardLettersResult {
  language: FilmLanguage;
  /** The family's regional setting ("es-CO") or null. */
  locale: string | null;
  /** Up to three letters (classic, warm, playful), each hard-checked. Holds
   * the letter text: never log it. */
  letters: { tone: WriterAngle; text: string; chars: number; softFlags: LetterFlag[] }[];
  /** Null when the card has no film or the caption failed a check. */
  qrCaption: string | null;
  /** The default signature ("Con cariño, la familia Rivera Soto"). */
  signature: string;
  /** What the editor chose (facts + evidence memory ids). Holds text. */
  editorFacts: EditorFact[];
  broadStrokes: string | null;
  /** The verified line of the year (a child's own words), if any. Holds text. */
  lineOfYear: { quote: string; speaker: string; memoryId: string } | null;
  /** 'no_highlights' | 'editor_call_failed' | null. */
  skipped: string | null;
  dropped: {
    /** Editor facts the code dropped, by reason. */
    editorFacts: number;
    editorReasons: Record<string, number>;
    /** Letters rejected by a hard check (or empty). */
    letters: number;
    /** Hard-check codes of the rejected letters, per tone (codes only). */
    letterCodes: { tone: WriterAngle; codes: string[] }[];
    quotes: number;
    details: number;
  };
}

/** Production entry point: the card's letters from the pool digest. */
export async function writeCardLetters(input: CardLettersInput, ports: LettersPorts): Promise<CardLettersResult> {
  const { data } = input;
  const scope = input.scope ?? holidayLetterScope(input.today);
  const prepared = input.prepared ?? await prepareCardLetters(input, ports);
  const pool = holidayLetterPool(data.memories, data.milestones, scope);
  const resolved = resolveLettersLanguage(data.language, pool);
  const language = resolved.language;

  const digest = buildPoolDigest({
    memories: data.memories,
    milestones: data.milestones,
    members: data.members,
    scope,
    language,
    familyName: data.familyName,
    quotes: prepared.quotes,
    specifics: prepared.specifics,
    filmPresent: input.filmPresent,
  });
  const voice = await buildParentsVoice(
    { memories: data.memories, milestones: data.milestones, members: data.members, digest, today: input.today, knownCard: prepared.voiceCard },
    ports,
  );
  const written = await writeLanguageLetters(
    {
      digest,
      pool,
      scope,
      milestones: data.milestones,
      members: data.members,
      language,
      locale: resolved.locale,
      voice: { card: prepared.voiceCard, examples: voice.examples, language },
      greeting: input.greeting,
      model: input.models?.letter,
    },
    ports,
  );

  const editorReasons: Record<string, number> = {};
  for (const d of written.editor?.dropped ?? []) editorReasons[d.reason] = (editorReasons[d.reason] ?? 0) + 1;
  return {
    language,
    locale: resolved.locale,
    letters: written.variants.map((v) => ({ tone: v.tone, text: v.text, chars: v.chars, softFlags: v.flags })),
    qrCaption: written.editor?.qrCaption ?? null,
    signature: defaultSignature(data.familyName, language),
    editorFacts: written.editor?.facts ?? [],
    broadStrokes: written.editor?.broadStrokes ?? null,
    lineOfYear: digest.lineOfYear,
    skipped: written.skipped,
    dropped: {
      editorFacts: written.editor?.dropped.length ?? 0,
      editorReasons,
      letters: written.rejected.length,
      letterCodes: written.rejected.map((r) => ({ tone: r.tone, codes: r.flags.map((f) => f.code) })),
      quotes: prepared.dropped.quotes,
      details: prepared.dropped.details,
    },
  };
}
