// Holiday card year digest (docs/plans/holiday-cards.md §6 C2): the one
// structure the card's letter is written from.
//
// v2 (owner review, 2026-10-04: the letters "felt forced, oddly specific"):
// the primary input is no longer a list of events but PER-PERSON PROFILES —
// who each child is right now (age, the themes that RECUR across their
// memories with count and lift vs the family's base rate, dominant moods, a
// few grounding excerpts for tone only), a light parent profile only with
// real evidence, and the family's recurring themes and places. A small
// secondary list of highlights (≤6) is optional detail. The letter stands on
// its own: the film only decides `filmPresent` (the QR caption) and the line
// of the year; both paths (script / pool) build the same profiles from the
// same share-safe pool.
//
// v3 (owner review round 3: "a bit more concrete"): each child profile also
// carries the CONCRETE words that recur across their memories — the open
// labels the analysis wrote (a costume, a park…), overall and under each
// recurring theme — and their certain firsts (confirmed, or the text says it
// is a first), so the letter can say one plain, true, specific thing per child.
//
// Pure: no I/O, no Deno APIs. The digest carries memory EXCERPTS (≤160
// chars, share-safe memories only): callers must never log it. Excluded
// upstream, never in a digest: share-sensitive memories (shareSensitiveIds),
// worried/sad/weary moments, reported memories, and every pasted URL.
import { getAgeInYearsAtDate } from './age.ts';
import { addYears } from './date-context.ts';
import { getTopicById } from './memory-topics.ts';
import {
  countPool,
  type FilmMilestoneInput,
  type FilmScope,
  holidayPool,
  isFilmChild,
  previousDay,
} from './year-film-eligibility.ts';
import { type FilmLanguage, topicActivity, topicTitle } from './year-film-i18n.ts';
import {
  certainFirstsOf,
  distinctiveThemes,
  type FilmMemorySource,
  type FilmPerson,
  type FilmScene,
  type FilmScript,
  rankMemories,
  SHARE_SENSITIVE_TOPICS,
  shareSensitiveIds,
  type VerifiedQuote,
} from './year-film-script.ts';

// ── Shape ────────────────────────────────────────────────────────────────

export interface DigestPerson {
  /** First name only. */
  name: string;
  role: 'child' | 'parent';
  /** Children only: whole years at the end of the scope. */
  ageYears: number | null;
}

export interface DigestHighlight {
  memoryId: string;
  date: string;
  /** 1–12. */
  month: number;
  /** ≤ DIGEST_EXCERPT_MAX chars of the memory's own words, share-safe only. */
  excerpt: string;
  /** First names of the core people tagged on the memory. */
  taggedPeople: string[];
  /** Roles (never names) of other tagged people: "grandparent", "cousin"… */
  withRoles: string[];
  emotion: string | null;
  /** Topic ids that exist in the catalog. */
  topics: string[];
  /** Whether the holiday film shows this memory (information for the review
   * page only: the letter does not prefer film moments). */
  inFilm: boolean;
  /** Where the film shows it (film path only), e.g. "Tomás's chapter". */
  sceneHint?: string;
}

/** A theme that recurs: the topic id (the letter writer resolves the phrase
 * in its own language), the phrase in the journal language for review, how
 * many memories carry it and how much more often than the family's usual. */
export interface DigestTheme {
  topicId: string;
  phrase: string;
  memories: number;
  lift: number;
  /** The concrete words that recur inside this theme's memories (labels). */
  details?: DigestDetail[];
}

/** A concrete word or phrase that recurs, with how many memories carry it. */
export interface DigestDetail {
  label: string;
  memories: number;
}

/** A certain first (parent-confirmed, or the memory's own words say it is
 * one inside the age band): the letter says it plainly. */
export interface DigestFirst {
  milestoneId: string;
  /** Catalog label in the journal language ("Camina con confianza"). */
  label: string;
  date: string;
  month: number;
  memoryId: string;
  confirmed: boolean;
}

/** A specific thing about a child, read from their memories' own text and
 * verified there (holiday-card-details.ts): "Spider-Man", a game, a book. */
export interface DigestSpecific {
  detail: string;
  /** Memories that contain it. */
  memories: number;
  recurring: boolean;
}

export interface DigestChildProfile {
  /** family_members.id (the key of `DigestContext.specifics`). */
  memberId: string;
  name: string;
  /** Specific details from their memories' text, recurring first (≤5). The
   * letter prefers these; `details` (open labels) is the generic fallback. */
  specifics: DigestSpecific[];
  /** family_members.gender, as stored (pronouns and agreement). */
  gender: string | null;
  /** Nicknames the family keeps on the profile. */
  nicknames: string[];
  /** Concrete words that recur across their memories, strongest first. */
  details: DigestDetail[];
  /** Their certain firsts this year, oldest first. */
  firsts: DigestFirst[];
  /** Whole years at the card date. */
  ageYears: number | null;
  /** The age they are (or turn) by Dec 31 of the card's year: the card is
   * read in December, so this is the age the letter states. */
  ageThisYear: number | null;
  /** The date of their birthday inside the card's calendar year. */
  birthdayThisYear: string | null;
  /** Share-safe memories in scope that tag them. */
  memories: number;
  /** Themes that recur across THEIR memories, strongest first (≤4). */
  recurring: DigestTheme[];
  /** Dominant moods among their memories (share of memories with a mood). */
  emotions: { emotion: string; share: number }[];
  /** 2–3 short excerpts that show tone. NOT events to retell. */
  excerpts: { memoryId: string; excerpt: string }[];
  /** Their verified line of the year, when there is one. `context` is the
   * parents' own words just before the quote (the moment it was said), so the
   * letter can set it in its scene instead of dropping it in cold. */
  line: { quote: string; memoryId: string; context?: string } | null;
}

/** A light profile, only with real evidence (enough memories tagging them
 * and a theme that recurs more than for the family at large). */
export interface DigestParentProfile {
  name: string;
  memories: number;
  recurring: DigestTheme[];
}

export interface DigestTrip {
  place: string;
  /** 1–12, the month the trip started. */
  month: number;
  days: number;
  memories: number;
}

export interface YearDigest {
  familyName: string;
  /** The journal's language: the language of every excerpt. */
  language: FilmLanguage;
  scope: FilmScope;
  people: DigestPerson[];
  /** One profile per own child, oldest first. */
  children: DigestChildProfile[];
  /** Parents with evidence only; often empty. */
  parents: DigestParentProfile[];
  /** What sets this year apart for the family (≤5). */
  familyThemes: DigestTheme[];
  /** Places and outings that recur (beach, park days…), most first (≤4). */
  places: DigestTheme[];
  /** Named trips: a place the parents labelled (e.g. "Cartagena") on memories
   * of consecutive days, or on travel memories (owner review v8: a real trip
   * lived only in labels). */
  trips?: DigestTrip[];
  /** Optional secondary details (≤6): the writer MAY draw one. */
  highlights: DigestHighlight[];
  /** The first verified line of the year (a child's own words) + who said it. */
  lineOfYear: { quote: string; speaker: string; memoryId: string } | null;
  counts: { moments: number; photos: number; videos: number; drawings: number; sounds: number; outings: number; months: number; together?: number };
  /** The card has a film behind its QR code (only the QR caption cares). */
  filmPresent: boolean;
  /** Names the letter must never use — other family members' first names and
   * every surname token. For the post-check only: never shown to the model. */
  forbiddenNames: string[];
}

export interface DigestContext {
  /** families.name (signature + surname check). */
  familyName: string;
  /** Milestones decide share-sensitivity (potty-trained…) and scoring. */
  milestones?: FilmMilestoneInput[];
  /** Verified quotes for the line of the year when there is no film script. */
  quotes?: VerifiedQuote[];
  /** Verified specific details per child member id (holiday-card-details.ts). */
  specifics?: Record<string, { detail: string; memoryIds: string[]; recurring: boolean }[]>;
}

// ── Tuning ───────────────────────────────────────────────────────────────

export const DIGEST_EXCERPT_MAX = 160;
export const DIGEST_HIGHLIGHTS = 6;
/** A memory needs this much of its own words to be a highlight. */
const EXCERPT_MIN_CHARS = 20;
const CHILD_EXCERPTS = 3;
const CHILD_DETAILS = 6;
const CHILD_DETAIL_MIN_MEMORIES = 3;
const THEME_DETAILS = 3;
const THEME_DETAIL_MIN_MEMORIES = 2;
const CHILD_THEMES = 4;
const CHILD_THEME_MIN_MEMORIES = 3;
const FAMILY_THEMES = 5;
const FAMILY_THEME_MIN_MEMORIES = 3;
const PLACES = 4;
const PLACE_MIN_MEMORIES = 2;
/** A mood is "dominant" at this share of a child's memories with a mood. */
const EMOTION_MIN_SHARE = 0.2;
/** A parent profile needs this much evidence. */
const PARENT_MIN_MEMORIES = 6;
const PARENT_THEME_MIN_MEMORIES = 4;
const PARENT_THEME_MIN_LIFT = 1.4;
/** Topics that are not personality: a birthday party recurs for everyone. */
const NOT_A_TRAIT: ReadonlySet<string> = new Set(['birthday']);
const PLACE_TOPICS: ReadonlySet<string> = new Set([
  'beach',
  'lake-river',
  'mountains-hiking',
  'camping',
  'countryside-farm',
  'park-playground',
  'days-out',
  'travel',
]);
/** Topics that mean "we went somewhere". */
const OUTING_TOPICS: ReadonlySet<string> = new Set([
  'beach',
  'lake-river',
  'mountains-hiking',
  'camping',
  'countryside-farm',
  'park-playground',
  'days-out',
  'out-and-about',
  'travel',
]);

// ── Helpers ──────────────────────────────────────────────────────────────

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** The memory's own words, one line, no links, cut on a word boundary. */
/** The parents' words leading up to a quoted line ("mirando la luna por la
 * ventana, Tomás se volteó y me dijo:"), trimmed to the sentence or two before
 * it. Only from the quote's own (share-safe, in-pool) memory. */
export function withQuoteContext(
  line: { quote: string; memoryId: string },
  pool: readonly { id: string; text: string | null }[],
): { quote: string; memoryId: string; context?: string } {
  const text = pool.find((m) => m.id === line.memoryId)?.text ?? '';
  const at = text.toLowerCase().indexOf(line.quote.slice(0, 12).toLowerCase());
  if (at <= 0) return { quote: line.quote, memoryId: line.memoryId };
  const before = text.slice(0, at).replace(/["“«']\s*$/u, '').trim();
  const context = before.length > QUOTE_CONTEXT_MAX ? `…${before.slice(before.length - QUOTE_CONTEXT_MAX).replace(/^\S*\s/u, '')}` : before;
  return context ? { quote: line.quote, memoryId: line.memoryId, context } : { quote: line.quote, memoryId: line.memoryId };
}

const QUOTE_CONTEXT_MAX = 200;

export function excerptOf(text: string | null, max = DIGEST_EXCERPT_MAX): string {
  const clean = (text ?? '').replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  const cut = chars.slice(0, max - 1).join('');
  const atWord = cut.replace(/\s+\S*$/, '');
  return `${(atWord.length >= max / 2 ? atWord : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

function hasExcerpt(memory: FilmMemorySource): boolean {
  return Array.from(excerptOf(memory.text)).length >= EXCERPT_MIN_CHARS;
}

function byCreation(a: FilmPerson, b: FilmPerson): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

interface Roster {
  children: FilmPerson[];
  parents: FilmPerson[];
  core: Map<string, FilmPerson>;
  others: FilmPerson[];
}

function rosterOf(members: FilmPerson[], lastDay: string): Roster {
  const children = members
    .filter((m) => isFilmChild({ id: m.id, dateOfBirth: m.dateOfBirth, relationship: m.relationship }, lastDay))
    .sort((a, b) => (a.dateOfBirth ?? '').localeCompare(b.dateOfBirth ?? '') || a.id.localeCompare(b.id));
  const parents = members.filter((m) => m.relationship === 'parent' && !children.some((c) => c.id === m.id)).sort(byCreation);
  const core = new Map([...children, ...parents].map((p) => [p.id, p]));
  return { children, parents, core, others: members.filter((m) => !core.has(m.id)).sort(byCreation) };
}

/** Other family members' first names and every surname token (the family
 * name's and each member's), minus the core people's own first names. */
function forbiddenNamesOf(roster: Roster, familyName: string): string[] {
  const coreFirst = new Set([...roster.core.values()].map((p) => firstNameOf(p.name).toLowerCase()));
  const out = new Set<string>();
  const add = (token: string, min: number) => {
    // Capitalized tokens only: "de", "la", "del" are particles, not names.
    if (token.length >= min && /^\p{Lu}/u.test(token) && !coreFirst.has(token.toLowerCase())) out.add(token);
  };
  for (const person of roster.others) {
    if (person.relationship === 'pet') continue; // a pet is not a person; the owner reviews it
    add(firstNameOf(person.name), 3);
  }
  for (const member of [...roster.core.values(), ...roster.others]) {
    for (const token of member.name.trim().split(/\s+/).slice(1)) add(token.replace(/[.,]/g, ''), 2);
  }
  for (const token of familyName.trim().split(/\s+/)) add(token.replace(/[.,]/g, ''), 2);
  return [...out].sort();
}

function peopleOf(roster: Roster, lastDay: string): DigestPerson[] {
  return [
    ...roster.children.map((c) => ({
      name: firstNameOf(c.name),
      role: 'child' as const,
      ageYears: c.dateOfBirth ? getAgeInYearsAtDate(c.dateOfBirth, lastDay) : null,
    })),
    ...roster.parents.map((p) => ({ name: firstNameOf(p.name), role: 'parent' as const, ageYears: null })),
  ];
}

/** Where the film shows each memory, strongest placement first. */
function sceneHints(script: FilmScript): Map<string, string> {
  const hints = new Map<string, string>();
  const put = (memoryId: string | null | undefined, hint: string) => {
    if (memoryId && !hints.has(memoryId)) hints.set(memoryId, hint);
  };
  const rank = (scene: FilmScene): number => {
    switch (scene.type) {
      case 'chapter': return 0;
      case 'sound': return 1;
      case 'line': return 2;
      case 'close': return 3;
      case 'burst': return scene.role === 'second_half' ? 4 : 5;
      default: return 6;
    }
  };
  for (const scene of [...script.scenes].sort((a, b) => rank(a) - rank(b))) {
    switch (scene.type) {
      case 'chapter':
        scene.frames.forEach((f) => put(f.memoryId, `${scene.name}'s chapter`));
        put(scene.line?.memoryId, `${scene.name}'s chapter`);
        break;
      case 'sound':
        put(scene.frame.memoryId, 'the sound of the year');
        break;
      case 'line':
        put(scene.memoryId, 'the line of the year');
        break;
      case 'close':
        scene.frames.forEach((f) => put(f.memoryId, 'the closing family shot'));
        break;
      case 'burst':
        scene.frames.forEach((f) => put(f.memoryId, scene.role === 'second_half' && scene.titles.length > 0 ? 'the montage under the year\'s themes' : 'the montage'));
        break;
      case 'title':
        scene.cards.forEach((f) => put(f.memoryId, 'the opening'));
        break;
      case 'end_card':
        scene.grid.forEach((f) => put(f.memoryId, 'the end card'));
        break;
    }
  }
  return hints;
}

function monthsCovered(pool: FilmMemorySource[]): number {
  return new Set(pool.map((m) => m.date.slice(0, 7))).size;
}

// ── Shared builder ───────────────────────────────────────────────────────

interface Source {
  scope: FilmScope;
  language: FilmLanguage;
  sources: FilmMemorySource[];
  members: FilmPerson[];
  context: DigestContext;
  script: FilmScript | null;
}

/** Topics that recur in `subset`, strongest first: how many memories carry
 * the topic and how much more often than across all the family's memories
 * (the film's distinctiveThemes formula), as activities about a person. */
function recurringThemes(
  subset: FilmMemorySource[],
  all: FilmMemorySource[],
  language: FilmLanguage,
  voice: 'third' | 'family',
  limit: number,
  minMemories: number,
  minLift = 0,
  only?: ReadonlySet<string>,
): DigestTheme[] {
  const familyCounts = new Map<string, number>();
  for (const m of all) for (const t of new Set(m.topics)) familyCounts.set(t, (familyCounts.get(t) ?? 0) + 1);
  const counts = new Map<string, number>();
  for (const m of subset) for (const t of new Set(m.topics)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([id, n]) => n >= minMemories && !NOT_A_TRAIT.has(id) && !SHARE_SENSITIVE_TOPICS.has(id) && getTopicById(id) && (!only || only.has(id)))
    .flatMap(([id, n]) => {
      const phrase = topicActivity(id, language, voice);
      if (!phrase) return [];
      const familyRate = (familyCounts.get(id) ?? n) / Math.max(1, all.length);
      const lift = n / Math.max(1, subset.length) / Math.max(familyRate, 1e-6);
      return lift >= minLift ? [{ topicId: id, phrase, memories: n, lift: Math.round(lift * 100) / 100 }] : [];
    })
    .sort((a, b) => b.lift * Math.sqrt(b.memories) - a.lift * Math.sqrt(a.memories) || a.topicId.localeCompare(b.topicId))
    .slice(0, limit);
}

const TRIP_TOPICS: ReadonlySet<string> = new Set(['travel', 'beach', 'camping', 'road-trip', 'vacation', 'snow-play']);

/** Place names among the parents' labels (capitalized, not a person, not a
 * generic word) that mark a trip: memories on 2+ consecutive days, or any
 * memory with a travel topic. "Cartagena" on Jul 10–12 → one 3-day trip. */
export function namedTrips(pool: readonly FilmMemorySource[], bannedNames: readonly string[]): DigestTrip[] {
  const byPlace = new Map<string, { display: string; dates: Set<string>; travel: boolean; memories: number }>();
  for (const m of pool) {
    for (const raw of m.labels ?? []) {
      const label = raw.replace(/\s+/g, ' ').trim();
      if (!/^\p{Lu}/u.test(label) || label.length < 3 || label.length > 30 || /\d/.test(label)) continue;
      const key = label.toLowerCase();
      if (GENERIC_LABELS.has(key)) continue;
      if (bannedNames.some((name) => name && key.includes(name.toLowerCase()))) continue;
      const entry = byPlace.get(key) ?? { display: label, dates: new Set<string>(), travel: false, memories: 0 };
      entry.dates.add(m.date);
      entry.memories += 1;
      if (m.topics.some((t) => TRIP_TOPICS.has(t))) entry.travel = true;
      byPlace.set(key, entry);
    }
  }
  const trips: DigestTrip[] = [];
  for (const entry of byPlace.values()) {
    const dates = [...entry.dates].sort();
    let longest = 1;
    let run = 1;
    for (let i = 1; i < dates.length; i += 1) {
      const gap = (Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)) / 86_400_000;
      run = gap === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    if (longest < 2 && !(entry.travel && entry.memories >= 2)) continue;
    trips.push({ place: entry.display, month: Number(dates[0].slice(5, 7)), days: Math.max(longest, 1), memories: entry.memories });
  }
  return trips.sort((a, b) => b.memories - a.memories || a.place.localeCompare(b.place)).slice(0, 3);
}

/** Words that say nothing: generic labels the analysis writes for any photo. */
const GENERIC_LABELS: ReadonlySet<string> = new Set([
  'family', 'familia', 'kids', 'kid', 'child', 'children', 'baby', 'toddler', 'boy', 'girl', 'niño', 'niña', 'niños', 'niñas',
  'bebé', 'bebe', 'outdoors', 'outdoor', 'indoor', 'indoors', 'exterior', 'interior', 'photo', 'foto', 'video', 'vídeo',
  'home', 'casa', 'smile', 'smiling', 'sonrisa', 'happy', 'feliz', 'fun', 'diversión', 'together', 'juntos', 'day', 'día',
  'people', 'personas', 'play', 'playing', 'jugando', 'juego', 'portrait', 'retrato', 'selfie', 'daytime', 'sunny', 'cute',
  // Owner review v8: these crowded out distinctive things (glasses).
  'siblings', 'sibling', 'hermanos', 'hermano', 'hermana', 'playtime', 'smiles', 'sonrisas', 'toys', 'toy', 'juguetes',
  'playful', 'juguetón', 'juguetona', 'laughing', 'riendo', 'love', 'amor', 'cuddle', 'hug', 'abrazo',
]);

/** Recurring labels in `subset`, cleaned: not generic, not a topic name, no
 * person's name (the family's own or anyone else's), short, no digits. */
function recurringLabels(
  subset: FilmMemorySource[],
  language: FilmLanguage,
  banned: string[],
  limit: number,
  minMemories: number,
): DigestDetail[] {
  const topicWords = new Set<string>();
  for (const m of subset) {
    for (const t of m.topics) {
      topicWords.add(t.replace(/-/g, ' '));
      const title = topicTitle(t, language);
      if (title) topicWords.add(title.toLowerCase());
    }
  }
  const counts = new Map<string, number>();
  for (const m of subset) {
    const seen = new Set<string>();
    for (const raw of m.labels ?? []) {
      const label = raw.replace(/\s+/g, ' ').trim().toLowerCase();
      if (label.length < 3 || label.length > 40 || label.split(' ').length > 4 || /\d/.test(label)) continue;
      if (GENERIC_LABELS.has(label) || topicWords.has(label)) continue;
      if (banned.some((name) => new RegExp(`(?<!\\p{L})${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\p{L})`, 'iu').test(label))) continue;
      seen.add(label);
    }
    for (const label of seen) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= minMemories)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, memories]) => ({ label, memories }));
}

function dominantEmotions(subset: FilmMemorySource[]): { emotion: string; share: number }[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const m of subset) {
    if (!m.emotion) continue;
    counts.set(m.emotion, (counts.get(m.emotion) ?? 0) + 1);
    total += 1;
  }
  return [...counts.entries()]
    .map(([emotion, n]) => ({ emotion, share: Math.round((n / Math.max(1, total)) * 100) / 100 }))
    .filter((e) => e.share >= EMOTION_MIN_SHARE)
    .sort((a, b) => b.share - a.share || a.emotion.localeCompare(b.emotion))
    .slice(0, 2);
}

function build({ scope, language, sources, members, context, script }: Source): YearDigest {
  const lastDay = previousDay(scope.endExclusive);
  const cardYear = lastDay.slice(0, 4);
  const milestones = context.milestones ?? [];
  const roster = rosterOf(members, lastDay);
  const byId = new Map(sources.map((m) => [m.id, m]));
  const pool = holidayPool(sources, scope, shareSensitiveIds(sources, milestones));
  const poolIds = new Set(pool.map((m) => m.id));
  const ownChildIds = roster.children.map((c) => c.id);
  const everything = sources.filter((m) => !m.reported);

  const hints = script ? sceneHints(script) : new Map<string, string>();
  const inFilm = new Set(hints.keys());
  const forbiddenNames = forbiddenNamesOf(roster, context.familyName);
  // A label never carries a person's name: the family's own people are named
  // by the letter, everyone else is forbidden.
  const bannedInLabels = [...forbiddenNames, ...members.map((m) => firstNameOf(m.name)), ...members.flatMap((m) => m.nicknames ?? [])];

  // Secondary highlights: a few memories with text, same scoring and spread.
  const picked = rankMemories(pool.filter(hasExcerpt), {
    scope,
    milestones,
    ownChildIds,
    n: DIGEST_HIGHLIGHTS,
    holiday: true,
  });
  const memberById = new Map(members.map((m) => [m.id, m]));
  const highlights: DigestHighlight[] = picked.map(({ memory }) => {
    const tagged = memory.taggedMemberIds.flatMap((id) => (memberById.has(id) ? [memberById.get(id)!] : []));
    const coreTagged = [...roster.children, ...roster.parents].filter((p) => memory.taggedMemberIds.includes(p.id));
    const roles = [...new Set(tagged.filter((p) => !roster.core.has(p.id)).map((p) => p.relationship ?? 'other'))].sort();
    return {
      memoryId: memory.id,
      date: memory.date,
      month: Number(memory.date.slice(5, 7)),
      excerpt: excerptOf(memory.text),
      taggedPeople: coreTagged.map((p) => firstNameOf(p.name)),
      withRoles: roles,
      emotion: memory.emotion,
      topics: memory.topics.filter((t) => !!getTopicById(t)),
      inFilm: inFilm.has(memory.id),
      ...(hints.has(memory.id) ? { sceneHint: hints.get(memory.id) } : {}),
    };
  });

  // Per-child profiles: who they are right now, from what recurs.
  const chapters = script?.scenes.flatMap((s) => (s.type === 'chapter' ? [s] : [])) ?? [];
  const children: DigestChildProfile[] = roster.children.map((child) => {
    const mine = pool.filter((m) => m.taggedMemberIds.includes(child.id));
    const excerpts = rankMemories(mine.filter(hasExcerpt), { scope, milestones, ownChildIds, n: CHILD_EXCERPTS, holiday: true })
      .map(({ memory }) => ({ memoryId: memory.id, excerpt: excerptOf(memory.text) }));
    const quote = chapters.find((c) => c.childId === child.id)?.line ??
      context.quotes?.filter((q) => q.speakerId === child.id).map((q) => ({ quote: q.quote, memoryId: q.memoryId }))[0] ??
      null;
    const details = recurringLabels(mine, language, bannedInLabels, CHILD_DETAILS, CHILD_DETAIL_MIN_MEMORIES);
    const recurring = recurringThemes(mine, everything, language, 'third', CHILD_THEMES, CHILD_THEME_MIN_MEMORIES).map((theme) => ({
      ...theme,
      details: recurringLabels(mine.filter((m) => m.topics.includes(theme.topicId)), language, bannedInLabels, THEME_DETAILS, THEME_DETAIL_MIN_MEMORIES),
    }));
    const firsts = certainFirstsOf(pool, milestones, child.id, language).map((f) => ({ ...f, month: Number(f.date.slice(5, 7)) }));
    const ageThisYear = child.dateOfBirth ? getAgeInYearsAtDate(child.dateOfBirth, `${cardYear}-12-31`) : null;
    const birthday = child.dateOfBirth && ageThisYear !== null ? addYears(child.dateOfBirth, ageThisYear) : null;
    return {
      memberId: child.id,
      name: firstNameOf(child.name),
      specifics: (context.specifics?.[child.id] ?? []).map((d) => ({ detail: d.detail, memories: d.memoryIds.length, recurring: d.recurring })),
      ageYears: child.dateOfBirth ? getAgeInYearsAtDate(child.dateOfBirth, lastDay) : null,
      ageThisYear,
      birthdayThisYear: birthday && birthday.startsWith(cardYear) ? birthday : null,
      gender: child.gender ?? null,
      nicknames: child.nicknames ?? [],
      details,
      firsts,
      memories: mine.length,
      recurring,
      emotions: dominantEmotions(mine),
      excerpts,
      line: quote && poolIds.has(quote.memoryId) ? withQuoteContext(quote, pool) : null,
    };
  });
  const firstLine = children.find((n) => n.line);
  const lineOfYear = firstLine?.line ? { quote: firstLine.line.quote, speaker: firstLine.name, memoryId: firstLine.line.memoryId } : null;

  // Parents: a light profile only with real evidence.
  const parents: DigestParentProfile[] = roster.parents.flatMap((parent) => {
    const mine = pool.filter((m) => m.taggedMemberIds.includes(parent.id));
    if (mine.length < PARENT_MIN_MEMORIES) return [];
    const recurring = recurringThemes(mine, everything, language, 'third', 3, PARENT_THEME_MIN_MEMORIES, PARENT_THEME_MIN_LIFT);
    return recurring.length > 0 ? [{ name: firstNameOf(parent.name), memories: mine.length, recurring }] : [];
  });

  const counts = countPool(pool);
  const familyThemes = distinctiveThemes(pool, everything, FAMILY_THEMES, FAMILY_THEME_MIN_MEMORIES, language, 'family').map((t) => ({
    topicId: t.topicId,
    phrase: t.title,
    memories: t.memories,
    lift: t.lift,
  }));
  const places = recurringThemes(pool, everything, language, 'family', PLACES, PLACE_MIN_MEMORIES, 0, PLACE_TOPICS)
    .sort((a, b) => b.memories - a.memories || a.topicId.localeCompare(b.topicId));

  const trips = namedTrips(pool, bannedInLabels);

  return {
    familyName: context.familyName,
    language,
    scope,
    people: peopleOf(roster, lastDay),
    children,
    parents,
    familyThemes,
    places,
    trips,
    highlights,
    lineOfYear,
    counts: {
      moments: counts.moments,
      photos: counts.photos,
      videos: counts.videos,
      drawings: counts.drawings,
      sounds: counts.sounds,
      outings: pool.filter((m) => m.topics.some((t) => OUTING_TOPICS.has(t))).length,
      months: monthsCovered(pool),
      // Moments that tag every own child: evidence for a warm sibling line
      // ("no se pierde nada de lo que hace su hermano"; owner's edit, v10).
      together: roster.children.length >= 2 ? pool.filter((m) => roster.children.every((c) => m.taggedMemberIds.includes(c.id))).length : 0,
    },
    filmPresent: script !== null,
    forbiddenNames,
  };
}

// ── Public builders ──────────────────────────────────────────────────────

/** The digest for a card WITH a film. `sources` is every memory the film
 * builder saw (the digest re-derives the same share-safe pool over
 * `script.scope`, so the profiles equal the pool path's). The film adds
 * `filmPresent`, the `inFilm`/`sceneHint` marks on highlights and each
 * child's line of the year (their chapter's verified quote). */
export function buildDigestFromScript(
  script: FilmScript,
  sources: FilmMemorySource[],
  members: FilmPerson[],
  language: FilmLanguage,
  context: DigestContext,
): YearDigest {
  return build({ scope: script.scope, language, sources, members, context, script });
}

/** The digest for a card WITHOUT a film (a thin year, below the card floor):
 * the same pool, scoring, spread and themes, no film. */
export function buildDigestFromPool(
  memories: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  members: FilmPerson[],
  scope: FilmScope,
  language: FilmLanguage,
  context: Omit<DigestContext, 'milestones'>,
): YearDigest {
  return build({ scope, language, sources: memories, members, context: { ...context, milestones }, script: null });
}
