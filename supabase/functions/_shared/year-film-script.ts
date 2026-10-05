// Year Film FilmScript builder (docs/plans/year-film.md §5, §5.1, §7.3).
// Pure: rows in, FilmScript out. The FilmScript is the whole contract
// between curation and rendering — the renderer never selects anything.
//
// Rhythm (owner feedback, 2026-09-27): films alternate FOCUS beats (a
// portrait, a line, a sound, an award — time to look) with BURSTS (many
// photos and clips in quick succession, like Google's recap), so they feel
// dense and dynamic. Bursts use every asset of multi-photo memories.
//
// Balance: selection works from a target media mix, not kind weights, so
// captioned illustrations no longer crowd out photos and videos.
//
// Accuracy: any frame that makes a claim about a child (award, then/now
// close, voice-fallback clip) must pass the vision frame check when checks
// are supplied (year-film-vision.ts), or be solo-tagged to that child when
// they aren't. Unverifiable claims are dropped, never guessed.
//
// Every on-screen string is a template from STRINGS, a verbatim quote, a
// family member's name, a catalog label (year-film-i18n.ts) or a count.
import { addYears, toJulianDayNumber } from './date-context.ts';
import { type FilmLanguage, holidayFirstLabel, milestoneLabel, topicActivity, topicTitle } from './year-film-i18n.ts';
import { getTopicById } from './memory-topics.ts';
import { type PortraitVersionCandidate, resolvePortraitVersionAtDate } from './portrait-versions.ts';
import {
  addDays,
  BIRTHDAY_FILM_DAYS_AFTER,
  birthdayPool,
  chapterChildren,
  countPool,
  familyPool,
  familyYearScope,
  type FilmMediaKind,
  type FilmMemoryInput,
  type FilmMilestoneInput,
  type FilmScope,
  HOLIDAY_TOPICS,
  hasVideoClip,
  holidayPool,
  isSoundCandidate,
  MONTAGE_EXCLUDED_EMOTIONS,
  monthScope,
  previousDay,
  soundDurationMs,
  STARRING_MIN_SHARED,
  VIDEO_CLIP_MIN_DURATION_MS,
  visualKind,
  WORLD_MIN_MEMORIES_PER_TOPIC,
} from './year-film-eligibility.ts';
import { describeCheck, type FrameCheck, isVerifiedSubject } from './year-film-vision.ts';

export type { FilmLanguage } from './year-film-i18n.ts';

// ── Inputs ───────────────────────────────────────────────────────────────

export interface FilmAssetRef {
  /** memory_media.id when known (production + eval rows; legacy single-asset
   * memories have none). The holiday card passes its front's top picks by it. */
  id?: string;
  kind: FilmMediaKind;
  key: string;
  previewKey: string | null;
  durationMs: number | null;
  aspectRatio: number | null;
}

export interface FilmMemorySource extends FilmMemoryInput {
  assets: FilmAssetRef[];
  illustrationKey: string | null;
  /** memories.labels: open-vocabulary search labels (holiday letter: the
   * concrete words — a costume, a park). Not on screen. */
  labels?: string[];
  /** memories.user_id: who wrote it (holiday letter: the parents' voice). */
  authorId?: string | null;
}

export interface FilmPerson {
  id: string;
  name: string;
  dateOfBirth: string | null;
  /** family_members.relationship (null = unsorted); drives isFilmChild. */
  relationship?: string | null;
  createdAt: string;
  portraits: PortraitVersionCandidate[];
  /** family_members.user_id: the account this person is ("this is me"). */
  userId?: string | null;
  /** family_members.nicknames and gender (holiday letter: how the family
   * names a child, and pronoun agreement). */
  nicknames?: string[];
  gender?: string | null;
}

/** A quote already verified against its memory's real text. */
export interface VerifiedQuote {
  memoryId: string;
  quote: string;
  speakerId: string;
}

/** Vision verdicts keyed by `checkKey(frame)`. */
export type FrameChecks = Map<string, FrameCheck>;

// ── Output ───────────────────────────────────────────────────────────────

export type FrameKind = 'illustration' | 'photo' | 'video' | 'audio' | 'portrait';

export interface FrameRef {
  memoryId: string | null; // null for portraits
  date: string | null;
  kind: FrameKind;
  key: string;
  previewKey: string | null;
  durationMs: number | null;
  aspectRatio: number | null;
  emotion: string | null;
  /** Portraits: the real photo the illustration was drawn from, so the
   * motion design can turn one into the other (like the printed book). */
  pairKey?: string | null;
  /** The memory's tagged family members — F2 weighs vision against these. */
  tags?: string[];
  /** Why this frame was picked — storyboard/debug only, never rendered. */
  why: string;
}

export type BurstRole = 'first_half' | 'second_half' | 'finale' | 'month' | 'emotion' | 'together';

export type FilmScene =
  | { type: 'cold_open'; title: string; from: FrameRef | null; to: FrameRef }
  | { type: 'title'; title: string; subtitle: string; kicker?: string; cards: FrameRef[] }
  | {
    type: 'counters';
    kicker?: string;
    counts: { key: string; label: string; value: number }[];
    /** A muted mosaic of the scope's memories that fills in behind the
     * numbers (owner, sketch v1: the counts alone carry no feeling). */
    backdrop: FrameRef[];
  }
  | {
    type: 'burst';
    role: BurstRole;
    /** Optional overlay titles (Google's "Playgrounds / Brick by brick"). */
    titles: string[];
    /** The line the titles hang from — themes read as things loved
     * ("Lo que más te gustó este año": "ir al parque", "moverte sobre ruedas"). */
    titlesKicker?: string;
    frames: FrameRef[];
    /** Seconds each still stays on screen; clips hold ~2× this. */
    secondsPerFrame: number;
    /** Slower pacing: how long each frame holds relative to the year film's
     * approved pace (default 1). Holiday card film: 1.5. RENDERER CONTRACT
     * (film-renderer/assemble.mjs `burst()`, C4): multiply the spare-quarter-
     * beat target — `frames.length * (accelerate ? 0.6 : 1) * (holdFactor ?? 1)
     * * 4 * TEMPO` — and scale the per-frame caps (6 quarter beats for clips, 4
     * for stills) by the same factor so the extra time is not clipped away. */
    holdFactor?: number;
  }
  | {
    type: 'sound';
    kicker?: string;
    source: 'audio' | 'video';
    frame: FrameRef;
    caption: string | null;
    /** Video fallbacks must pass F2's voice check before rendering. */
    needsVoiceCheck: boolean;
    alternates: FrameRef[];
    /** Each alternate's OWN memory caption, parallel to `alternates`. When a
     * fallback replaces the primary the scene shows its caption, never the
     * primary's (holiday round 3: the caption told a story the audio was not). */
    alternateCaptions?: (string | null)[];
  }
  | { type: 'line'; kicker?: string; quote: string; memoryId: string; speakerName: string; frame: FrameRef | null; alternates: string[] }
  | {
    type: 'starring';
    kicker?: string;
    /** Personal reveals: the most present people, shown in creation order. */
    people: { memberId: string; name: string; portrait: FrameRef; moments: FrameRef[] }[];
    /** The closing group shot: everyone who qualifies, creation order. */
    together?: { memberId: string; name: string; portrait: FrameRef }[];
  }
  | {
    type: 'firsts';
    kicker?: string;
    /** `childName` only in family films, where several children's firsts share the scene. */
    items: { milestoneId: string; label: string; date: string; memoryId: string; frame?: FrameRef; childName?: string }[];
  }
  | {
    /** Year-end family film: one per child, equal length whatever the data
     * (plan §3, the sibling trap) — portrait, up to 3 verified moments of
     * them, and their line of the year when there is one. */
    type: 'chapter';
    childId: string;
    name: string;
    portrait: FrameRef | null;
    frames: FrameRef[];
    line: { quote: string; memoryId: string } | null;
  }
  | {
    type: 'award';
    childId: string;
    childName: string;
    intro: string;
    award: string;
    /** What backs the award: a vision-verified expression, or none. */
    evidence: 'laughing' | 'smiling' | 'subject' | 'portrait';
    frame: FrameRef;
  }
  | {
    type: 'close';
    line: string;
    /** 'celebration': the child's real birthday memories (owner, round 2);
     * 'then_now': verified frames from the start and end of the year;
     * 'portraits': the portrait pair, when nothing else exists;
     * 'family': the family's latest moments together (year-end film). */
    source: 'celebration' | 'then_now' | 'portraits' | 'family';
    /** The birthday the celebration frames are from. */
    celebrationDate: string | null;
    frames: FrameRef[];
  }
  | {
    type: 'end_card';
    grid: FrameRef[];
    /** Holiday card film: the greeting and the family's sign-off, shown
     * instead of the plain "made with Momora" close (C4 renders them). */
    greeting?: string;
    from?: string;
  };

export type FilmSceneType = FilmScene['type'];

export interface FilmScript {
  version: 1;
  kind: 'birthday' | 'family_month' | 'family_year' | 'family_holiday';
  /** 'holiday': the card film's theme (palette, music, end card) — C4. */
  theme?: 'holiday';
  language: FilmLanguage;
  title: string;
  scope: FilmScope;
  stats: {
    pool: number;
    visuals: number;
    videoClips: number;
    sounds: number;
    frames: number;
    mix: Record<'photo' | 'video' | 'illustration', number>;
  };
  /** 'vision' when frame checks backed the claims, 'tags' when only tags did. */
  verification: 'vision' | 'tags';
  /** The dates the timeline strip spans — its only labels. A dot sits at the
   * real date of whatever is on screen (owner, sketch v1: month ticks
   * implied frames came from months they didn't). Birthday: last birthday →
   * this birthday. Monthly: first → last day of the month. */
  span: { from: string; to: string };
  /** The children the film is about, with the real photo the frame check
   * compares against (F2 re-checks the frames it actually cuts). */
  subjects: { id: string; name: string; referenceKey: string | null }[];
  /** All of the family's own children with reference photos — so F2 can
   * tell a sibling-led frame in a birthday film (F2 round 2). */
  references: { id: string; name: string; referenceKey: string | null }[];
  scenes: FilmScene[];
  dropped: { scene: FilmSceneType; reason: string }[];
  estimatedSeconds: number;
}

// ── Strings (templates only; plan §3) ────────────────────────────────────

const ORDINAL_EN = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen'];
const ORDINAL_EN_LOWER = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth'];
const ORDINAL_ES = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo', 'undécimo', 'duodécimo', 'decimotercer'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Awards are limited to what a frame can prove (owner, 2026-09-27): a
 * vision-verified laugh or smile, else "star of the month" for a verified
 * main subject. Text-emotion awards (troublemaker, curious…) are gone. */
type AwardKind = 'laugh' | 'smile' | 'star';

/** Who the film speaks to: birthday films are written from the parent to
 * the child ("tu"); family films in the family's voice ("nuestro"). */
type Voice = 'child' | 'family';

/** Which greeting the holiday card film's end card shows (docs/plans/holiday-cards.md §2). */
export type HolidayGreeting = 'christmas' | 'holidays' | 'new-year';
export const HOLIDAY_GREETINGS: readonly HolidayGreeting[] = ['christmas', 'holidays', 'new-year'];
export const DEFAULT_HOLIDAY_GREETING: HolidayGreeting = 'holidays';

const STRINGS = {
  en: {
    // Written from the parent to the child (owner, sketch v1).
    birthdayTitle: (name: string, n: number) => `Memories of your ${ORDINAL_EN_LOWER[n] ?? `${n}th`} year, ${name}`,
    birthdayClose: (name: string, n: number) => `Happy ${ORDINAL_EN_LOWER[n] ?? `${n}th`} birthday, ${name}.`,
    monthTitle: (month: number) => MONTHS_EN[month - 1],
    familyYearClose: (year: number) => `Here's to ${year + 1}, together`,
    holidayGreetings: { christmas: 'Merry Christmas', holidays: 'Happy holidays', 'new-year': 'Happy New Year' } as Record<HolidayGreeting, string>,
    holidayFrom: (family: string) => `from the ${family} family`,
    /** The holiday film's title card, under the year. */
    holidayTitleSub: 'A year as a family',
    counters: {
      moments: ['moment', 'moments'],
      photos: ['photo', 'photos'],
      videos: ['video', 'videos'],
      drawings: ['drawing', 'drawings'],
      sounds: ['sound', 'sounds'],
    },
    award: { laugh: 'biggest laugh', smile: 'biggest smile', star: 'star of the month' } as Record<AwardKind, string>,
    /** Looking Back's emotion package titles. */
    /** Looking Back's package titles for family films; the child's own for birthdays. */
    emotionTitle: {
      family: { funny: 'The funny ones', mischief: 'Tiny troublemakers' },
      child: { funny: 'Your funniest moments', mischief: 'Your little mischief' },
    } as Record<Voice, Record<string, string>>,
    kicker: {
      child: { counters: 'Your year in', starring: 'With your people', line: 'What you told us', sound: 'Your voice', firsts: 'Your milestones', themes: 'What you loved this year' },
      family: { counters: 'Our month in', starring: 'Together', line: 'Line of the month', sound: 'The sound of', firsts: 'Milestones', title: 'Our', themes: 'What we loved this month', yearCounters: 'Our year in', yearThemes: 'What we loved this year' },
    } as Record<Voice, Record<string, string>>,
    awardGoesTo: (award: string) => `and the ${award} award goes to`,
  },
  es: {
    birthdayTitle: (name: string, n: number) => `Recuerdos de tu ${ORDINAL_ES[n] ?? `${n}º`} año, ${name}`,
    birthdayClose: (name: string, _n: number) => `¡Feliz cumpleaños, ${name}!`,
    monthTitle: (month: number) => MONTHS_ES[month - 1],
    familyYearClose: (year: number) => `¡Por un ${year + 1} juntos!`,
    holidayGreetings: { christmas: 'Feliz Navidad', holidays: 'Felices fiestas', 'new-year': 'Feliz Año Nuevo' } as Record<HolidayGreeting, string>,
    holidayFrom: (family: string) => `de parte de la familia ${family}`,
    holidayTitleSub: 'Un año en familia',
    counters: {
      moments: ['momento', 'momentos'],
      photos: ['foto', 'fotos'],
      videos: ['vídeo', 'vídeos'],
      drawings: ['dibujo', 'dibujos'],
      sounds: ['sonido', 'sonidos'],
    },
    award: { laugh: 'la risa más grande', smile: 'la sonrisa más grande', star: 'la estrella del mes' } as Record<AwardKind, string>,
    emotionTitle: {
      family: { funny: 'Los momentos más graciosos', mischief: 'Pequeñas travesuras' },
      child: { funny: 'Tus momentos más graciosos', mischief: 'Tus travesuras' },
    } as Record<Voice, Record<string, string>>,
    kicker: {
      child: { counters: 'Tu año en', starring: 'Con tu gente', line: 'Lo que nos dijiste', sound: 'Tu voz', firsts: 'Tus logros', themes: 'Lo que más te gustó este año' },
      family: { counters: 'Nuestro mes en', starring: 'Juntos', line: 'La frase del mes', sound: 'Así sonó', firsts: 'Logros', title: 'Nuestro', themes: 'Lo que más nos gustó este mes', yearCounters: 'Nuestro año en', yearThemes: 'Lo que más nos gustó este año' },
    } as Record<Voice, Record<string, string>>,
    awardGoesTo: (award: string) => `y el premio ${award.startsWith('el ') ? `al ${award.slice(3)}` : `a ${award}`} es para`,
  },
} as const;

// ── Tuning ───────────────────────────────────────────────────────────────

/** Target media mix for bursts (owner, 2026-09-27: "less heavy on
 * illustrations, more balanced"). Shortfalls in one kind are filled by
 * the others. */
export const BURST_MIX: Readonly<Record<'video' | 'photo' | 'illustration', number>> = {
  video: 0.35,
  photo: 0.45,
  illustration: 0.2,
};
/** A multi-photo memory can contribute this many frames to a burst. */
const BURST_ASSETS_PER_MEMORY = 3;
/** Burst pace (owner, F3 round 2 — "the length of the bursts is right now"):
 * a still holds one beat (~0.51s at 118 BPM), a clip one and a half; the
 * finale's second half runs at half beats (~0.6 beat per frame overall). The
 * renderer lays the same rule on the music's beat grid
 * (film-renderer/assemble.mjs); estimateSeconds mirrors its layout. */
const BEAT_SECONDS = 60 / 118;
const BURST_SECONDS_PER_FRAME = BEAT_SECONDS; // on average, clips included
const FINALE_SECONDS_PER_FRAME = 0.6 * BEAT_SECONDS;

/** Year films scale with the year (owner: "use as much as possible"):
 * ~35% of the pool's visuals across the three bursts, 36–72 frames, then
 * trimmed to the length cap. */
const YEAR_BURST_SHARE = 0.35;
const YEAR_BURST_MIN = 36;
const YEAR_BURST_MAX = 72;
/** Owner: bursts at the approved pace even if the film runs longer (F3
 * round 2, was 50s); a music bed is ~60s. */
export const MAX_FILM_SECONDS = 60;
const MIN_BURST_FRAMES = 8;
/** Fewer frames than this and a half-year burst is folded into the finale. */
const HALF_BURST_MIN = 4;
/** An emotion burst needs this many memories with the label (Looking Back's
 * package minimum). */
const EMOTION_BURST_MIN = 4;
const EMOTION_BURST_FRAMES = 8;
const MONTH_BURST_FRAMES = 26;
const CELEBRATION_FRAMES = 5;
const BACKDROP_TILES = 108; // fills the renderer's tilted 9×12 mosaic without repeats
const MONTH_THEME_FRAMES = 12;
const STARRING_MAX = 6;
const STARRING_TOGETHER_MAX = 9;
/** Memory cards shown with each person's reveal (owner, F3 round 2). */
const STARRING_MOMENTS = 3;
const FIRSTS_MAX = 3;
const TITLE_CARDS = 8;
const GRID_CARDS = 9;
const SOUND_VIDEO_MAX_MS = 60_000;
/** Focus-slot candidates sent to the vision check per claim. */
const VISION_CANDIDATES_PER_SLOT = 6;
/** Voice-fallback clips get more: F2's voice check rejects many (an adult
 * talking over the child), and each rejection falls to the next one. */
const VOICE_CANDIDATES = 10;
const VOICE_ALTERNATES = 5;
/** Year films need a theme to hold for a year, not a weekend (F1). */
const YEAR_THEME_MIN_MEMORIES = 3;

const EMOTION_WEIGHT: Record<string, number> = {
  funny: 0.6,
  joy: 0.6,
  wonder: 0.6,
  mischief: 0.6,
  tender: 0.5,
  pride: 0.5,
  calm: 0.2,
  bittersweet: 0.1,
};
const CAPTION_MIN_CHARS = 20;
const SMILES: ReadonlySet<string> = new Set(['laughing', 'big_smile', 'smiling']);

// ── Share safety (F1, 2026-09-27) ────────────────────────────────────────
// A film is made to be posted publicly. Moments a private book can hold —
// potty training, bath time, medical visits, hard days — never appear in a
// film frame, quote, sound, or first. Topic/milestone ids come from
// analyze-memory; the text pattern catches untagged memories (es + en). The
// vision check's `unsafe` flag is a second layer on focus frames.

export const SHARE_SENSITIVE_TOPICS: ReadonlySet<string> = new Set(['bath', 'doctor-dentist', 'tough-days']);
export const SHARE_SENSITIVE_MILESTONES: ReadonlySet<string> = new Set([
  'potty-trained',
  'first-bath',
  'first-dentist',
  'last-bottle',
]);
/** Catalog entries that aren't "firsts" on screen. */
const NOT_A_FIRST: ReadonlySet<string> = new Set(['birthday']);
export const SHARE_SENSITIVE_TEXT =
  /(?<!\p{L})(pip[ií]|pup[uú]|poceta|pa[ñn]al(?:es)?|caca|orinal|inodoro|potty|poop|pee|diapers?|nappy|nappies|toilet|v[oó]mit\w*|fiebre|fever|hospital|urgencias|desnud\w*|naked)(?!\p{L})/iu;
/** A first is shown only when it is certain (owner, round 2: "Primera
 * pregunta" and "Primer corte de pelo" at age 3–4 were model inferences):
 * the parent confirmed it, or the memory's own words say it's a first and
 * the claim sits inside the milestone's age band. */
const EXPLICIT_FIRST_TEXT =
  /(?<!\p{L})(primer[oa]?s?|primera\s+vez|por\s+primera|estren\p{L}*|first|for\s+the\s+first\s+time)(?!\p{L})/iu;

export function isCertainFirst(milestone: FilmMilestoneInput, text: string | null): boolean {
  if (milestone.status === 'dismissed') return false;
  if (milestone.status === 'confirmed') return true;
  return milestone.outOfBand !== true && !!text && EXPLICIT_FIRST_TEXT.test(text);
}

/** Low-mood moments stay in the journal, out of the film's frames. */
const FRAME_EXCLUDED_EMOTIONS: ReadonlySet<string> = new Set([...MONTAGE_EXCLUDED_EMOTIONS, 'weary']);

/** The holiday card film is watched by anyone who scans the card (owner,
 * 2026-10-05), so its text/topic screen is stricter than the family films':
 * caregiving topics (diapers, nursing), and words for baths, showers,
 * undressed children (es + en); a shirtless beach or pool moment stays in (the vision check decides). Bath/diaper words are already in
 * SHARE_SENSITIVE_TEXT. The vision check (`underdressed`) is the real guard —
 * this only keeps likely candidates out of the pool early. */
export const PUBLIC_SENSITIVE_TOPICS: ReadonlySet<string> = new Set(['baby-care']);
export const PUBLIC_SENSITIVE_TEXT =
  /(?<!\p{L})(ba[ñn]era|ba[ñn]ito|ba[ñn]ándose\s+con|hora\s+del\s+ba[ñn]o|ducha\w*|duch[oó]\w*|bath(?:s|tub|time|room)?|bathe\w*|bathing(?!\s+suit)|shower\w*|topless|sin\s+ropa|underwear|undies|ropa\s+interior|calzoncillos?|undress\w*|desvest\w*|en\s+bolas|bare\s+(?:bottom|bum|butt)|breastfe\w*|nursing|amamant\w*|lactancia)(?!\p{L})/iu;

export function shareSensitiveIds(
  memories: FilmMemoryInput[],
  milestones: FilmMilestoneInput[],
  options: { publicAudience?: boolean } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const row of milestones) {
    if (row.status !== 'dismissed' && SHARE_SENSITIVE_MILESTONES.has(row.milestoneId)) ids.add(row.memoryId);
  }
  for (const m of memories) {
    if (m.topics.some((t) => SHARE_SENSITIVE_TOPICS.has(t)) || (m.text && SHARE_SENSITIVE_TEXT.test(m.text))) {
      ids.add(m.id);
    } else if (
      options.publicAudience &&
      (m.topics.some((t) => PUBLIC_SENSITIVE_TOPICS.has(t)) || (m.text && PUBLIC_SENSITIVE_TEXT.test(m.text)))
    ) {
      ids.add(m.id);
    }
  }
  return ids;
}

// ── Scoring (within a media kind) ────────────────────────────────────────

interface ScoreContext {
  milestoneMemoryIds: Set<string>;
  ownChildIds: Set<string>;
  sensitive: Set<string>;
  /** Birthday films: solo moments score up so siblings' films differ (F1). */
  focusChildId?: string;
  checks?: FrameChecks;
  names: Map<string, string>;
  /** Holiday card film: holiday topics score up (HOLIDAY_TOPICS). */
  holiday?: boolean;
}

/** How much a holiday topic lifts a memory in the holiday film (an emotion
 * is worth up to 0.6, a caption 0.15): a nudge, not an override. */
const HOLIDAY_BOOST = 0.35;

function scoreMemory(memory: FilmMemoryInput, ctx: ScoreContext): { score: number; why: string } {
  const kind = visualKind(memory) ?? (memory.type === 'audio' ? 'audio' : 'none');
  const parts: string[] = [kind];
  let score = EMOTION_WEIGHT[memory.emotion ?? ''] ?? 0;
  parts.push(memory.emotion ?? 'no emotion');
  // Small: captions are a weak signal of importance, and must not decide
  // between kinds (F1: they tilted every pick toward illustrations).
  if ((memory.text?.trim().length ?? 0) >= CAPTION_MIN_CHARS) {
    score += 0.15;
    parts.push('captioned');
  }
  if (ctx.milestoneMemoryIds.has(memory.id)) {
    score += 0.4;
    parts.push('milestone');
  }
  if (ctx.holiday && memory.topics.some((t) => HOLIDAY_TOPICS.has(t))) {
    score += HOLIDAY_BOOST;
    parts.push('holiday');
  }
  const ownKids = memory.taggedMemberIds.filter((id) => ctx.ownChildIds.has(id));
  if (ctx.focusChildId) {
    if (ownKids.length === 1 && ownKids[0] === ctx.focusChildId) {
      score += 0.4;
      parts.push('solo');
    }
  } else if (ownKids.length >= 2) {
    score += 0.2;
    parts.push('kids together');
  }
  return { score: Math.round(score * 100) / 100, why: `${parts.join(' · ')} · score ${score.toFixed(2)}` };
}

type Scored = { memory: FilmMemorySource; score: number; why: string };

function byScoreThenId(a: Scored, b: Scored) {
  return b.score - a.score || a.memory.id.localeCompare(b.memory.id);
}

function usable(memory: FilmMemorySource, ctx: ScoreContext): boolean {
  return !ctx.sensitive.has(memory.id) && !(memory.emotion && FRAME_EXCLUDED_EMOTIONS.has(memory.emotion));
}

// ── Frames ───────────────────────────────────────────────────────────────

function assetFrame(memory: FilmMemorySource, asset: FilmAssetRef, kind: FrameKind, why: string): FrameRef {
  return {
    memoryId: memory.id,
    date: memory.date,
    kind,
    key: asset.key,
    previewKey: asset.previewKey,
    durationMs: asset.durationMs,
    aspectRatio: asset.aspectRatio,
    emotion: memory.emotion,
    tags: memory.taggedMemberIds,
    why,
  };
}

function isClip(asset: FilmAssetRef): boolean {
  return asset.kind === 'video' && (asset.durationMs === null || asset.durationMs >= VIDEO_CLIP_MIN_DURATION_MS);
}

/** The single frame a memory shows as, in visualKind order. */
export function frameFor(memory: FilmMemorySource, why: string): FrameRef | null {
  const kind = visualKind(memory);
  if (kind === 'illustration' && memory.illustrationKey) {
    return { ...assetFrame(memory, { kind: 'image', key: memory.illustrationKey, previewKey: null, durationMs: null, aspectRatio: 1 }, 'illustration', why) };
  }
  if (kind === 'video') {
    const clip = memory.assets.find(isClip);
    if (clip) return assetFrame(memory, clip, 'video', why);
  }
  const image = memory.assets.find((a) => a.kind === 'image');
  if (image && (kind === 'photo' || kind === 'video')) return assetFrame(memory, image, 'photo', why);
  if (memory.type === 'audio') {
    const audio = memory.assets.find((a) => a.kind === 'audio');
    if (audio) return assetFrame(memory, audio, 'audio', why);
  }
  return null;
}

/** Every frame a memory can put into a burst: each photo and clip of a
 * carousel (up to `max`), or its illustration. */
function burstFrames(memory: FilmMemorySource, why: string, max: number): FrameRef[] {
  if (memory.illustrationReady && memory.illustrationKey) return [frameFor(memory, why)!];
  return memory.assets
    .filter((a) => a.kind === 'image' || isClip(a))
    .slice(0, max)
    .map((a) => assetFrame(memory, a, a.kind === 'image' ? 'photo' : 'video', why));
}

/** The key the vision check sees for a frame (preview/poster first). */
export function checkKey(frame: FrameRef): string {
  return frame.previewKey ?? frame.key;
}

function portraitFrame(version: PortraitVersionCandidate, why: string): FrameRef | null {
  if (!version.illustrated_profile_key) return null;
  return {
    memoryId: null,
    date: version.reference_date,
    kind: 'portrait',
    key: version.illustrated_profile_key,
    previewKey: null,
    durationMs: null,
    aspectRatio: 1,
    emotion: null,
    pairKey: version.profile_picture_key,
    why,
  };
}

// ── Selection ────────────────────────────────────────────────────────────

/** The best memory per time bucket first, then the best of the rest —
 * memories, chronological. */
function spreadMemories(scored: Scored[], n: number, scope: FilmScope, onePerDay: boolean): Scored[] {
  if (n <= 0) return [];
  const start = toJulianDayNumber(scope.start);
  const span = Math.max(1, toJulianDayNumber(scope.endExclusive) - start);
  const sorted = [...scored].sort(byScoreThenId);
  const chosen: Scored[] = [];
  const days = new Set<string>();
  const ok = (item: Scored) => !chosen.includes(item) && (!onePerDay || !days.has(item.memory.date));
  const take = (item: Scored) => {
    chosen.push(item);
    days.add(item.memory.date);
  };
  const buckets = new Map<number, Scored[]>();
  for (const item of sorted) {
    const b = Math.min(n - 1, Math.floor(((toJulianDayNumber(item.memory.date) - start) * n) / span));
    buckets.set(b, [...(buckets.get(b) ?? []), item]);
  }
  for (let b = 0; b < n; b += 1) {
    const best = (buckets.get(b) ?? []).find(ok);
    if (best) take(best);
  }
  for (const item of sorted) {
    if (chosen.length >= n) break;
    if (ok(item)) take(item);
  }
  return chosen.sort((a, b) => a.memory.date.localeCompare(b.memory.date) || a.memory.id.localeCompare(b.memory.id));
}

/** A burst of ~n frames at the target media mix, spread over the scope.
 * Photo memories contribute up to BURST_ASSETS_PER_MEMORY frames (the
 * density Google gets from the whole camera roll). Marks memories used. */
function pickBurst(
  pool: FilmMemorySource[],
  n: number,
  scope: FilmScope,
  ctx: ScoreContext,
  used: Set<string>,
): FrameRef[] {
  // Only memories inside the burst's own window: spreadMemories tops a thin
  // window up with "the best of the rest", which let a first-half burst reach
  // into July–August when the journal got dense mid-year (F3 round 1).
  const inWindow = (m: FilmMemorySource) => m.date >= scope.start && m.date < scope.endExclusive;
  const candidates = pool.filter((m) => inWindow(m) && visualKind(m) !== null && !used.has(m.id) && usable(m, ctx));
  const byKind = (k: 'video' | 'photo' | 'illustration') =>
    candidates.filter((m) => visualKind(m) === k).map((memory) => ({ memory, ...scoreMemory(memory, ctx) }));

  const frames: FrameRef[] = [];
  const takeKind = (k: 'video' | 'photo' | 'illustration', target: number) => {
    let got = 0;
    // Photos: fewer memories, more frames each; clips/drawings: one each.
    const perMemory = k === 'photo' ? BURST_ASSETS_PER_MEMORY : 1;
    const memories = spreadMemories(
      byKind(k).filter((s) => !used.has(s.memory.id)),
      Math.ceil(target / (k === 'photo' ? 2 : 1)),
      scope,
      false,
    );
    for (const item of memories) {
      if (got >= target) break;
      const add = burstFrames(item.memory, item.why, Math.min(perMemory, target - got));
      if (add.length === 0) continue;
      frames.push(...add);
      got += add.length;
      used.add(item.memory.id);
    }
    return got;
  };

  const targets = {
    video: Math.round(n * BURST_MIX.video),
    illustration: Math.round(n * BURST_MIX.illustration),
    photo: 0,
  };
  targets.photo = n - targets.video - targets.illustration;
  let short = 0;
  short += targets.video - takeKind('video', targets.video);
  short += targets.illustration - takeKind('illustration', targets.illustration);
  short += targets.photo - takeKind('photo', targets.photo);
  // Fill shortfalls from whatever is left, photos first.
  for (const k of ['photo', 'video', 'illustration'] as const) {
    if (short <= 0) break;
    short -= takeKind(k, short);
  }
  return frames.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || (a.memoryId ?? '').localeCompare(b.memoryId ?? ''));
}

function mixOf(frames: FrameRef[]): Record<'photo' | 'video' | 'illustration', number> {
  const mix = { photo: 0, video: 0, illustration: 0 };
  for (const f of frames) if (f.kind in mix) mix[f.kind as keyof typeof mix] += 1;
  return mix;
}

function halves(scope: FilmScope): [FilmScope, FilmScope] {
  const start = toJulianDayNumber(scope.start);
  const mid = start + Math.floor((toJulianDayNumber(scope.endExclusive) - start) / 2);
  // Midpoint as a date: walk from start (pure, no Date objects).
  const midDate = addDays(scope.start, mid - start);
  return [{ start: scope.start, endExclusive: midDate }, { start: midDate, endExclusive: scope.endExclusive }];
}


// ── Claims about a child (vision-gated) ──────────────────────────────────

/** Photo/clip frames of this child for a focus slot, best first. With vision
 * checks these are the frames to verify; without, only solo-tagged frames
 * are trusted. */
function childFrameCandidates(
  pool: FilmMemorySource[],
  childId: string,
  ctx: ScoreContext,
  used: Set<string>,
  filter: (m: FilmMemorySource) => boolean = () => true,
): { memory: FilmMemorySource; frame: FrameRef }[] {
  return pool
    .filter((m) =>
      m.taggedMemberIds.includes(childId) && !used.has(m.id) && usable(m, ctx) && filter(m) &&
      (visualKind(m) === 'photo' || visualKind(m) === 'video')
    )
    .map((memory) => ({ memory, ...scoreMemory(memory, { ...ctx, focusChildId: childId }) }))
    .sort(byScoreThenId)
    .flatMap((item) => {
      const frame = frameFor(item.memory, item.why);
      return frame && frame.kind !== 'audio' ? [{ memory: item.memory, frame }] : [];
    });
}

function isSoloTagged(memory: FilmMemoryInput, childId: string, ctx: ScoreContext): boolean {
  const kids = memory.taggedMemberIds.filter((id) => ctx.ownChildIds.has(id));
  return kids.length === 1 && kids[0] === childId && memory.taggedMemberIds.length <= 2;
}

/** Keeps candidates whose frame shows this child as the clear subject:
 * vision-verified when checks exist, else solo-tagged. Annotates `why`. */
function verifiedFor(
  candidates: { memory: FilmMemorySource; frame: FrameRef }[],
  childId: string,
  ctx: ScoreContext,
): { memory: FilmMemorySource; frame: FrameRef; check?: FrameCheck }[] {
  if (!ctx.checks) {
    return candidates
      .filter((c) => isSoloTagged(c.memory, childId, ctx))
      .map((c) => ({ ...c, frame: { ...c.frame, why: `${c.frame.why} · tags only (no vision)` } }));
  }
  return candidates.flatMap((c) => {
    const check = ctx.checks!.get(checkKey(c.frame));
    // A child crying or frowning never backs a claim (F1: Enzo's "now" shot).
    if (!isVerifiedSubject(check, childId, { publicAudience: ctx.holiday }) || check!.expression === 'upset') return [];
    return [{ ...c, check, frame: { ...c.frame, why: `${c.frame.why} · ${describeCheck(check, ctx.names)}` } }];
  });
}

// ── Scene builders ───────────────────────────────────────────────────────

/** Up to BACKDROP_TILES memories spread over the scope, stills and drawings
 * (video posters) — the counters' muted mosaic. Doesn't consume memories. */
function backdropFrames(pool: FilmMemorySource[], scope: FilmScope, ctx: ScoreContext): FrameRef[] {
  const scored = pool
    .filter((m) => visualKind(m) !== null && usable(m, ctx))
    .map((memory) => ({ memory, ...scoreMemory(memory, ctx) }));
  return spreadMemories(scored, BACKDROP_TILES, scope, false).flatMap((item) => frameFor(item.memory, 'backdrop') ?? []);
}

/** Up to STARRING_MOMENTS memories of the child with one person, spread over
 * the scope — the cards of that person's reveal. Just the two of them ranks
 * first; a memory already on an earlier person's cards only fills in when
 * this person has nothing else. Bursts may also show them. */
function starringMoments(
  pool: FilmMemorySource[],
  personId: string,
  scope: FilmScope,
  ctx: ScoreContext,
  given: Set<string>,
): FrameRef[] {
  const scored = pool
    .filter((m) => m.taggedMemberIds.includes(personId) && visualKind(m) !== null && usable(m, ctx))
    .map((memory) => {
      const { score, why } = scoreMemory(memory, ctx);
      const pair = memory.taggedMemberIds.length <= 2;
      return { memory, score: score + (pair ? 0.5 : 0), why: `${pair ? 'just the two of them · ' : ''}${why}` };
    });
  const fresh = scored.filter((item) => !given.has(item.memory.id));
  const picked = spreadMemories(fresh, STARRING_MOMENTS, scope, true);
  if (picked.length < STARRING_MOMENTS) {
    const fill = spreadMemories(scored.filter((item) => !picked.includes(item)), STARRING_MOMENTS - picked.length, scope, true);
    picked.push(...fill.filter((item) => !picked.some((p) => p.memory.date === item.memory.date)));
    picked.sort((a, b) => a.memory.date.localeCompare(b.memory.date) || a.memory.id.localeCompare(b.memory.id));
  }
  for (const item of picked) given.add(item.memory.id);
  return picked.flatMap((item) => frameFor(item.memory, item.why) ?? []);
}

function countersScene(
  pool: FilmMemorySource[],
  language: FilmLanguage,
  kicker: string,
  scope: FilmScope,
  ctx: ScoreContext,
): FilmScene | null {
  const c = countPool(pool);
  const labels = STRINGS[language].counters;
  const label = (forms: readonly [string, string], n: number) => forms[n === 1 ? 0 : 1];
  const counts = [
    { key: 'moments', label: label(labels.moments, c.moments), value: c.moments },
    { key: 'photos', label: label(labels.photos, c.photos), value: c.photos },
    { key: 'videos', label: label(labels.videos, c.videos), value: c.videos },
    { key: 'drawings', label: label(labels.drawings, c.drawings), value: c.drawings },
    { key: 'sounds', label: label(labels.sounds, c.sounds), value: c.sounds },
  ].filter((entry) => entry.value > 0); // zero counts are omitted, never shown (plan §5)
  return counts.length > 0 ? { type: 'counters', kicker, counts, backdrop: backdropFrames(pool, scope, ctx) } : null;
}

/** Topics that set this scope apart from the family's usual life: lift over
 * the family-wide rate, weighted by volume (F0: raw frequency surfaced
 * routine topics like mealtime everywhere). */
export function distinctiveThemes(
  pool: FilmMemoryInput[],
  allMemories: FilmMemoryInput[],
  limit: number,
  minMemories = WORLD_MIN_MEMORIES_PER_TOPIC,
  language: FilmLanguage = 'en',
  /** Given a voice, titles are activities in that voice ("moverte sobre
   * ruedas") and topics that can't be called loved are skipped. */
  voice?: Voice,
): { topicId: string; title: string; memories: number; lift: number }[] {
  const familyCounts = new Map<string, number>();
  for (const m of allMemories) for (const t of new Set(m.topics)) familyCounts.set(t, (familyCounts.get(t) ?? 0) + 1);
  const poolCounts = new Map<string, number>();
  for (const m of pool) for (const t of new Set(m.topics)) poolCounts.set(t, (poolCounts.get(t) ?? 0) + 1);

  return [...poolCounts.entries()]
    .filter(([id, n]) => n >= minMemories && !SHARE_SENSITIVE_TOPICS.has(id) && getTopicById(id))
    .filter(([id]) => voice === undefined || topicActivity(id, language, voice) !== null)
    .map(([id, n]) => {
      const familyRate = (familyCounts.get(id) ?? n) / Math.max(1, allMemories.length);
      const lift = n / Math.max(1, pool.length) / Math.max(familyRate, 1e-6);
      const title = voice === undefined ? topicTitle(id, language)! : topicActivity(id, language, voice)!;
      return { topicId: id, title, memories: n, lift: Math.round(lift * 100) / 100 };
    })
    .sort((a, b) => b.lift * Math.sqrt(b.memories) - a.lift * Math.sqrt(a.memories) || a.topicId.localeCompare(b.topicId))
    .slice(0, limit);
}

/** Whose voice a clip most likely is: the first of the family's children
 * named in its description ("Enzo contándole un cuento a Mara" → Enzo). */
export function firstNamedChild(text: string | null, children: { id: string; name: string }[]): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let best: { id: string; at: number } | null = null;
  for (const child of children) {
    const name = firstNameOf(child.name).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'u').exec(lower);
    if (match && (!best || match.index < best.at)) best = { id: child.id, at: match.index };
  }
  return best?.id ?? null;
}

function soundCandidates(
  pool: FilmMemorySource[],
  subjectId: string | null,
  ctx: ScoreContext,
  children: { id: string; name: string }[],
): { audio: Scored[]; videos: { memory: FilmMemorySource; frame: FrameRef }[] } {
  // A birthday film uses the child's own voice: a clip whose description
  // names another child first is that child's sound, not this one's.
  const voiceIsSubject = (m: FilmMemoryInput) => {
    if (subjectId === null) return true;
    const named = firstNamedChild(m.text, children);
    return named === null || named === subjectId;
  };
  const mine = (m: FilmMemorySource) =>
    !ctx.sensitive.has(m.id) && (subjectId === null || m.taggedMemberIds.includes(subjectId)) && voiceIsSubject(m);
  const audio = pool
    .filter((m) => mine(m) && isSoundCandidate(m))
    .map((memory) => ({ memory, ...scoreMemory(memory, ctx) }))
    .sort((a, b) => b.score - a.score || (soundDurationMs(b.memory) ?? 0) - (soundDurationMs(a.memory) ?? 0) || a.memory.id.localeCompare(b.memory.id));
  const videos = subjectId === null ? [] : childFrameCandidates(pool, subjectId, ctx, new Set(), (m) => {
    if (!mine(m) || !hasVideoClip(m)) return false;
    const clip = m.assets.find((a) => a.kind === 'video');
    return !clip?.durationMs || (clip.durationMs >= 3000 && clip.durationMs <= SOUND_VIDEO_MAX_MS);
  }).filter((c) => c.frame.kind === 'video');
  return { audio, videos };
}

function soundScene(
  pool: FilmMemorySource[],
  subjectId: string | null,
  ctx: ScoreContext,
  allowVideo: boolean,
  children: { id: string; name: string }[] = [],
): FilmScene | null {
  const { audio, videos } = soundCandidates(pool, subjectId, ctx, children);
  if (audio.length > 0) {
    const picked = audio.slice(0, 3).flatMap((item) => {
      const frame = frameFor(item.memory, item.why);
      return frame ? [{ frame, caption: item.memory.text?.trim() || null }] : [];
    });
    if (picked.length > 0) {
      return {
        type: 'sound',
        source: 'audio',
        frame: picked[0].frame,
        caption: picked[0].caption,
        needsVoiceCheck: false,
        alternates: picked.slice(1).map((p) => p.frame),
        alternateCaptions: picked.slice(1).map((p) => p.caption),
      };
    }
  }
  if (!allowVideo || subjectId === null) return null;
  // The clip is on screen with the child's voice: it must show the child.
  const verified = verifiedFor(videos.slice(0, VOICE_CANDIDATES), subjectId, ctx);
  if (verified.length === 0) return null;
  return {
    type: 'sound',
    source: 'video',
    frame: { ...verified[0].frame, why: `${verified[0].frame.why} · voice fallback` },
    caption: verified[0].memory.text?.trim() || null,
    needsVoiceCheck: true,
    alternates: verified.slice(1, 1 + VOICE_ALTERNATES).map((v) => v.frame),
    alternateCaptions: verified.slice(1, 1 + VOICE_ALTERNATES).map((v) => v.memory.text?.trim() || null),
  };
}

function lineScene(
  quotes: VerifiedQuote[],
  pool: FilmMemorySource[],
  names: Map<string, string>,
  ctx: ScoreContext,
): FilmScene | null {
  const poolById = new Map(pool.map((m) => [m.id, m]));
  const usableQuotes = quotes.filter(
    (q) => poolById.has(q.memoryId) && names.has(q.speakerId) && !ctx.sensitive.has(q.memoryId),
  );
  if (usableQuotes.length === 0) return null;
  const [first, ...rest] = usableQuotes;
  const memory = poolById.get(first.memoryId)!;
  return {
    type: 'line',
    quote: first.quote,
    memoryId: first.memoryId,
    speakerName: names.get(first.speakerId)!,
    frame: frameFor(memory, 'source of the quote'),
    alternates: rest.slice(0, 2).map((q) => q.quote),
  };
}

function estimateSeconds(scenes: FilmScene[]): number {
  let seconds = 0;
  for (const scene of scenes) {
    switch (scene.type) {
      case 'cold_open':
        seconds += 4;
        break;
      case 'title':
      case 'line':
        seconds += 3.5;
        break;
      case 'starring':
        seconds += 1.5 * scene.people.length + 1; // a reveal per person, then everyone
        break;
      case 'close':
        seconds += 4 + (scene.source === 'celebration' ? 0.5 * Math.max(0, scene.frames.length - 2) : 0);
        break;
      case 'counters':
        seconds += 2; // a quick beat over the mosaic (owner, sketch v1)
        break;
      case 'burst':
        seconds += scene.role === 'emotion' || scene.role === 'together'
          ? BEAT_SECONDS * (1 + Math.min(4, scene.frames.length)) // a title beat, then up to 4 cards
          : scene.secondsPerFrame * (scene.holdFactor ?? 1) * scene.frames.length +
            BEAT_SECONDS * (scene.titlesKicker ? 1 + 1.5 * scene.titles.length : scene.titles.length); // heading beat + 1.5 per activity
        break;
      case 'sound':
        seconds += Math.min(6, (scene.frame.durationMs ?? 6000) / 1000) + 1.5;
        break;
      case 'firsts':
        seconds += scene.items.reduce((sum, item) => sum + (item.frame ? 2 : 1.5), 0); // 4 beats with a card, 3 without
        break;
      case 'chapter':
        seconds += CHAPTER_BEATS * BEAT_SECONDS;
        break;
      case 'award':
        seconds += 3;
        break;
      case 'end_card':
        seconds += 3;
        break;
    }
  }
  return Math.round(seconds * 10) / 10;
}

function milestoneIds(milestones: FilmMilestoneInput[]): Set<string> {
  return new Set(milestones.filter((m) => m.status !== 'dismissed').map((m) => m.memoryId));
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function reference(p: FilmPerson, scope: FilmScope) {
  return {
    id: p.id,
    name: firstNameOf(p.name),
    referenceKey: resolvePortraitVersionAtDate(p.portraits, scope.endExclusive)?.profile_picture_key ?? null,
  };
}

function finish(args: {
  kind: FilmScript['kind'];
  language: FilmLanguage;
  title: string;
  scope: FilmScope;
  pool: FilmMemoryInput[];
  scenes: FilmScene[];
  dropped: FilmScript['dropped'];
  vision: boolean;
  subjects: FilmPerson[];
  references: FilmPerson[];
  span: { from: string; to: string };
}): FilmScript {
  const counts = countPool(args.pool);
  const burstFramesAll = args.scenes.flatMap((s) => (s.type === 'burst' ? s.frames : []));
  return {
    version: 1,
    kind: args.kind,
    language: args.language,
    title: args.title,
    scope: args.scope,
    stats: {
      pool: args.pool.length,
      visuals: args.pool.filter((m) => visualKind(m) !== null).length,
      videoClips: args.pool.filter(hasVideoClip).length,
      sounds: counts.sounds,
      frames: burstFramesAll.length,
      mix: mixOf(burstFramesAll),
    },
    verification: args.vision ? 'vision' : 'tags',
    span: args.span,
    subjects: args.subjects.map((p) => reference(p, args.scope)),
    references: args.references.map((p) => reference(p, args.scope)),
    scenes: args.scenes,
    dropped: args.dropped,
    estimatedSeconds: estimateSeconds(args.scenes),
  };
}

/** A half-year burst too thin to read as a burst (a journal that started
 * mid-year) is dropped and its memories handed back to the finale. Returns
 * the frames it kept. */
function pushHalfBurst(
  scenes: FilmScene[],
  dropped: { scene: string; reason: string }[],
  used: Set<string>,
  burst: Extract<FilmScene, { type: 'burst' }>,
): number {
  if (burst.frames.length >= HALF_BURST_MIN) {
    scenes.push(burst);
    return burst.frames.length;
  }
  for (const f of burst.frames) if (f.memoryId) used.delete(f.memoryId);
  dropped.push({ scene: 'burst', reason: `${burst.role}: only ${burst.frames.length} visual memories in that half — folded into the finale` });
  return 0;
}

/** Trims bursts, largest first and from the middle (keeping each burst's
 * opening and closing frames), until the film fits `budget` seconds. */
function fitLength(scenes: FilmScene[], budget: number): void {
  const bursts = scenes.filter((s): s is Extract<FilmScene, { type: 'burst' }> => s.type === 'burst');
  while (estimateSeconds(scenes) > budget) {
    const largest = bursts.filter((b) => b.frames.length > MIN_BURST_FRAMES).sort((a, b) => b.frames.length - a.frames.length)[0];
    if (!largest) return;
    largest.frames.splice(Math.floor(largest.frames.length / 2), 1);
  }
}

/** A titled burst of the scope's funny or mischievous moments, like Looking
 * Back's "The funny ones" / "Tiny troublemakers" packages: whichever label
 * has more unused visual memories, at least EMOTION_BURST_MIN. */
function emotionBurst(
  pool: FilmMemorySource[],
  scope: FilmScope,
  ctx: ScoreContext,
  used: Set<string>,
  language: FilmLanguage,
  voice: Voice,
): Extract<FilmScene, { type: 'burst' }> | null {
  const count = (emotion: string) =>
    pool.filter((m) => m.emotion === emotion && visualKind(m) !== null && !used.has(m.id) && usable(m, ctx)).length;
  const [emotion, n] = (['funny', 'mischief'] as const)
    .map((e) => [e, count(e)] as const)
    .sort((a, b) => b[1] - a[1])[0];
  if (n < EMOTION_BURST_MIN) return null;
  const frames = pickBurst(pool.filter((m) => m.emotion === emotion), EMOTION_BURST_FRAMES, scope, ctx, used);
  return {
    type: 'burst',
    role: 'emotion',
    titles: [STRINGS[language].emotionTitle[voice][emotion]],
    frames,
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
  };
}

function withinDays(date: string, anchor: string, before: number, after: number): boolean {
  const delta = toJulianDayNumber(date) - toJulianDayNumber(anchor);
  return delta >= -before && delta <= after;
}

/** The child's real birthday memories in scope (owner, round 2): tagged to
 * the child, dated on the birthday or carrying the deterministic birthday
 * milestone (a DOB join, not model inference), from a day before to
 * BIRTHDAY_FILM_DAYS_AFTER after. The latest birthday in scope wins — with
 * birthdayFilmScope that is this year's party. */
/** A child's certain firsts in the pool (isCertainFirst), each with its
 * memory as a card when it has a shareable picture — confirmed ones first,
 * then oldest. The caller caps and orders what it shows. */
function certainFirsts(
  pool: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  childId: string,
  language: FilmLanguage,
  ctx: ScoreContext,
): { milestoneId: string; label: string; date: string; memoryId: string; confirmed: boolean; frame?: FrameRef }[] {
  const byId = new Map(pool.map((m) => [m.id, m]));
  const firstsById = new Map<string, { milestoneId: string; label: string; date: string; memoryId: string; confirmed: boolean }>();
  for (const row of milestones) {
    const memory = byId.get(row.memoryId);
    if (row.status === 'dismissed' || !memory) continue;
    if (SHARE_SENSITIVE_MILESTONES.has(row.milestoneId) || NOT_A_FIRST.has(row.milestoneId)) continue;
    if (row.familyMemberId !== null && row.familyMemberId !== childId) continue;
    if (row.familyMemberId === null && !memory.taggedMemberIds.includes(childId)) continue;
    if (!isCertainFirst(row, memory.text ?? null)) continue;
    const label = milestoneLabel(row.milestoneId, language);
    if (!label) continue;
    const item = { milestoneId: row.milestoneId, label, date: memory.date, memoryId: row.memoryId, confirmed: row.status === 'confirmed' };
    const existing = firstsById.get(row.milestoneId);
    if (!existing || item.date < existing.date) firstsById.set(row.milestoneId, item);
  }
  return [...firstsById.values()]
    .sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || a.date.localeCompare(b.date))
    .map((item) => {
      // The milestone's own memory as a small card beside its label (owner,
      // F3 round 3), when it has a picture and is shareable.
      const memory = byId.get(item.memoryId)!;
      const frame = visualKind(memory) !== null && usable(memory, ctx) ? frameFor(memory, 'the milestone\'s memory') : null;
      return frame ? { ...item, frame } : item;
    });
}

/** A child's certain firsts in a share-safe pool (confirmed, or the text says
 * so inside the age band), oldest first — for the holiday letter's profile. */
export function certainFirstsOf(
  pool: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  childId: string,
  language: FilmLanguage,
): { milestoneId: string; label: string; date: string; memoryId: string; confirmed: boolean }[] {
  const ctx: ScoreContext = { milestoneMemoryIds: new Set(), ownChildIds: new Set(), sensitive: new Set(), names: new Map() };
  return certainFirsts(pool, milestones, childId, language, ctx)
    .map(({ milestoneId, label, date, memoryId, confirmed }) => ({ milestoneId, label, date, memoryId, confirmed }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function birthdayCelebration(
  pool: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  child: FilmPerson,
  scope: FilmScope,
  sensitive: Set<string> = new Set(),
  /** A birthday film celebrates one birthday — the one its window ends on.
   * Its window also *starts* on the previous birthday, so without this a film
   * whose party isn't logged yet closed on last year's party (owner, F3). */
  celebrated?: string,
): { date: string; memories: FilmMemorySource[] } | null {
  if (!child.dateOfBirth) return null;
  const birthdayRows = new Set(
    milestones
      .filter((r) => r.milestoneId === 'birthday' && r.status !== 'dismissed' && r.familyMemberId === child.id)
      .map((r) => r.memoryId),
  );
  const groups: { date: string; memories: FilmMemorySource[] }[] = [];
  for (let years = 0; years <= 21; years += 1) {
    const date = addYears(child.dateOfBirth, years);
    if (date < scope.start || date >= scope.endExclusive) continue;
    if (celebrated !== undefined && date !== celebrated) continue;
    const memories = pool.filter(
      (m) =>
        m.taggedMemberIds.includes(child.id) && visualKind(m) !== null && !sensitive.has(m.id) &&
        withinDays(m.date, date, 1, BIRTHDAY_FILM_DAYS_AFTER) && (m.date === date || birthdayRows.has(m.id)),
    );
    if (memories.length > 0) groups.push({ date, memories });
  }
  return groups.at(-1) ?? null;
}

// ── Birthday film ────────────────────────────────────────────────────────

export interface BirthdayInput {
  child: FilmPerson;
  ageYear: number;
  scope: FilmScope;
  memories: FilmMemorySource[];
  members: FilmPerson[];
  ownChildIds: string[];
  milestones: FilmMilestoneInput[];
  quotes: VerifiedQuote[];
  language: FilmLanguage;
  checks?: FrameChecks;
}

function birthdayContext(input: BirthdayInput): ScoreContext {
  return {
    milestoneMemoryIds: milestoneIds(input.milestones),
    ownChildIds: new Set(input.ownChildIds),
    sensitive: shareSensitiveIds(input.memories, input.milestones),
    focusChildId: input.child.id,
    checks: input.checks,
    names: new Map(input.members.map((m) => [m.id, firstNameOf(m.name)])),
  };
}

/** Frames of the child that could back a claim — for the vision check. */
export function birthdayVisionCandidates(input: BirthdayInput): FrameRef[] {
  const ctx = birthdayContext(input);
  const pool = birthdayPool(input.memories, input.child.id, input.scope, 'exclude');
  const [first, second] = halves(input.scope);
  const own = input.members.filter((m) => input.ownChildIds.includes(m.id));
  const all = childFrameCandidates(pool, input.child.id, ctx, new Set());
  const inScope = (s: FilmScope) => all.filter((c) => c.memory.date >= s.start && c.memory.date < s.endExclusive);
  // Then/now: the earliest and latest candidates, not just the best.
  const earliest = [...inScope(first)].sort((a, b) => a.memory.date.localeCompare(b.memory.date)).slice(0, VISION_CANDIDATES_PER_SLOT);
  const latest = [...inScope(second)].sort((a, b) => b.memory.date.localeCompare(a.memory.date)).slice(0, VISION_CANDIDATES_PER_SLOT);
  const voice = soundCandidates(pool, input.child.id, ctx, own).videos.slice(0, VOICE_CANDIDATES);
  return dedupeFrames([...earliest, ...latest, ...voice].map((c) => c.frame));
}

export function buildBirthdayScript(input: BirthdayInput): FilmScript {
  const { child, scope, language } = input;
  const strings = STRINGS[language];
  const pool = birthdayPool(input.memories, child.id, scope, 'exclude');
  const ctx = birthdayContext(input);
  const scenes: FilmScene[] = [];
  const dropped: FilmScript['dropped'] = [];
  const used = new Set<string>();
  const name = firstNameOf(child.name);
  const title = strings.birthdayTitle(name, input.ageYear);
  const [firstHalf, secondHalf] = halves(scope);
  const own = input.members.filter((m) => input.ownChildIds.includes(m.id));

  // FOCUS — cold open: portrait photo ↔ illustration, start → end of year.
  const startVersion = resolvePortraitVersionAtDate(child.portraits, scope.start);
  const endVersion = resolvePortraitVersionAtDate(child.portraits, scope.endExclusive);
  const endPortrait = endVersion ? portraitFrame(endVersion, 'portrait at the birthday') : null;
  const startPortrait = startVersion && startVersion.id !== endVersion?.id
    ? portraitFrame(startVersion, 'portrait at the start of the year')
    : null;
  if (endPortrait) scenes.push({ type: 'cold_open', title, from: startPortrait, to: endPortrait });
  else dropped.push({ scene: 'cold_open', reason: 'no ready portrait' });

  // FOCUS — counters.
  const k = STRINGS[language].kicker.child;
  const counters = countersScene(pool, language, k.counters, scope, ctx);
  if (counters) scenes.push(counters);

  // Claims first, so bursts don't spend their frames.
  const sound = soundScene(pool, child.id, ctx, true, own);
  if (sound && sound.type === 'sound') used.add(sound.frame.memoryId!);
  const line = lineScene(input.quotes, pool, new Map([[child.id, name]]), ctx);
  if (line && line.type === 'line') used.add(line.memoryId);
  // Close: the real birthday party when there is one (owner, round 2).
  const celebration = birthdayCelebration(pool, input.milestones, child, scope, ctx.sensitive, addYears(child.dateOfBirth!, input.ageYear));
  const celebrationFrames = celebration
    ? celebration.memories
      .map((memory) => ({ memory, ...scoreMemory(memory, ctx) }))
      .sort(byScoreThenId)
      .flatMap((item) => burstFrames(item.memory, `birthday ${celebration.date} · ${item.why}`, 2))
      .slice(0, CELEBRATION_FRAMES)
    : [];
  for (const f of celebrationFrames) used.add(f.memoryId!);
  const closeCands = celebration ? [] : childFrameCandidates(pool, child.id, ctx, used);
  const inHalf = (s: FilmScope) => (c: { memory: FilmMemorySource }) => c.memory.date >= s.start && c.memory.date < s.endExclusive;
  // Then/now: among the earliest/latest verified frames, a smile wins.
  const smileFirst = <T extends { check?: FrameCheck }>(items: T[]): T | undefined =>
    items.find((v) => v.check && SMILES.has(v.check.expression)) ?? items[0];
  const thenFrame = smileFirst(verifiedFor(
    closeCands.filter(inHalf(firstHalf)).sort((a, b) => a.memory.date.localeCompare(b.memory.date)).slice(0, VISION_CANDIDATES_PER_SLOT),
    child.id,
    ctx,
  ));
  const nowFrame = smileFirst(verifiedFor(
    closeCands.filter(inHalf(secondHalf)).sort((a, b) => b.memory.date.localeCompare(a.memory.date)).slice(0, VISION_CANDIDATES_PER_SLOT),
    child.id,
    ctx,
  ));
  if (thenFrame) used.add(thenFrame.memory.id);
  if (nowFrame) used.add(nowFrame.memory.id);

  // Bursts scale with the year: richer years get fuller films.
  const visuals = pool.filter((m) => visualKind(m) !== null).length;
  const burstTotal = Math.max(YEAR_BURST_MIN, Math.min(YEAR_BURST_MAX, Math.round(visuals * YEAR_BURST_SHARE)));
  const halfBurst = Math.round(burstTotal * 0.3);

  // Themes title the second burst (Google's titles-over-grid).
  const themes = distinctiveThemes(pool, input.memories.filter((m) => !m.reported), 3, YEAR_THEME_MIN_MEMORIES, language, 'child');

  // BURST — first half of the year.
  const firstHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'first_half',
    titles: [],
    frames: pickBurst(pool, halfBurst, firstHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
  });

  // FOCUS — line of the year.
  if (line) scenes.push({ ...line, kicker: k.line } as FilmScene);
  else dropped.push({ scene: 'line', reason: 'no verified quote from the child' });

  // FOCUS — starring (portrait photo ↔ illustration), no counts (plan §3).
  const shared = new Map<string, number>();
  for (const m of pool) for (const id of m.taggedMemberIds) if (id !== child.id) shared.set(id, (shared.get(id) ?? 0) + 1);
  // Who gets a reveal is decided by how present they were in the child's year
  // (the most shared memories, then family creation order) — never by
  // profile creation order alone, which let four early profiles with 2–4
  // shared memories crowd out a parent with 22 (owner, F3 round 3). What's
  // shown stays neutral: creation order, no counts. Everyone who qualifies
  // (up to STARRING_TOGETHER_MAX) is in the closing group shot.
  const byCreation = (a: FilmPerson, b: FilmPerson) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  const cast = input.members
    .filter((p) => (shared.get(p.id) ?? 0) >= STARRING_MIN_SHARED)
    .flatMap((p) => {
      const version = resolvePortraitVersionAtDate(p.portraits, scope.endExclusive);
      const portrait = version ? portraitFrame(version, 'portrait at the birthday') : null;
      return portrait ? [{ person: p, portrait }] : [];
    });
  const presence = [...cast].sort((a, b) => (shared.get(b.person.id) ?? 0) - (shared.get(a.person.id) ?? 0) || byCreation(a.person, b.person));
  const revealed = new Set(presence.slice(0, STARRING_MAX).map((c) => c.person.id));
  const together = presence.slice(0, STARRING_TOGETHER_MAX).sort((a, b) => byCreation(a.person, b.person))
    .map(({ person, portrait }) => ({ memberId: person.id, name: firstNameOf(person.name), portrait }));
  const given = new Set<string>(); // each person's cards are their own moments first
  const people = cast
    .filter((c) => revealed.has(c.person.id))
    .sort((a, b) => byCreation(a.person, b.person))
    .map(({ person, portrait }) => ({ memberId: person.id, name: firstNameOf(person.name), portrait, moments: starringMoments(pool, person.id, scope, ctx, given) }));
  if (people.length > 0) scenes.push({ type: 'starring', kicker: k.starring, people, together });
  else dropped.push({ scene: 'starring', reason: 'nobody else with a portrait shares ≥2 memories' });

  // BURST — second half, titled with the year's distinctive themes.
  const secondHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'second_half',
    titles: themes.length >= 2 ? themes.map((t) => t.title) : [],
    ...(themes.length >= 2 ? { titlesKicker: k.themes } : {}),
    frames: pickBurst(pool, halfBurst, secondHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
  });
  if (themes.length < 2) dropped.push({ scene: 'burst', reason: `no theme titles: only ${themes.length} topics on ≥${YEAR_THEME_MIN_MEMORIES} memories` });

  // FOCUS — sound of the year.
  if (sound) scenes.push({ ...sound, kicker: k.sound } as FilmScene);
  else dropped.push({ scene: 'sound', reason: 'no audio memory, and no video clip verified to show the child' });

  // FOCUS — firsts: celebration only, and only when certain (isCertainFirst).
  const firsts = certainFirsts(pool, input.milestones, child.id, language, ctx).slice(0, FIRSTS_MAX)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ confirmed: _c, ...rest }) => rest);
  if (firsts.length > 0) scenes.push({ type: 'firsts', kicker: k.firsts, items: firsts });
  else dropped.push({ scene: 'firsts', reason: 'no certain firsts (parent-confirmed, or the text says "first" within the age band)' });

  // BURST — the funny ones / tiny troublemakers (Looking Back's packages).
  const moods = emotionBurst(pool, scope, ctx, used, language, 'child');
  if (moods) scenes.push(moods);
  else dropped.push({ scene: 'burst', reason: `no emotion burst: fewer than ${EMOTION_BURST_MIN} funny or mischief moments left` });

  // BURST — finale: the whole year, faster. It takes up whatever a thin half
  // couldn't fill, so a year that started slow keeps its full burst length.
  const finale = pickBurst(pool, burstTotal - firstHalfFrames - secondHalfFrames, scope, ctx, used);
  scenes.push({ type: 'burst', role: 'finale', titles: [], frames: finale, secondsPerFrame: FINALE_SECONDS_PER_FRAME });

  // FOCUS — close: the birthday party; else then → now (verified); else portraits.
  const closeLine = strings.birthdayClose(name, input.ageYear);
  if (celebration && celebrationFrames.length > 0) {
    scenes.push({ type: 'close', line: closeLine, source: 'celebration', celebrationDate: celebration.date, frames: celebrationFrames });
  } else if (thenFrame && nowFrame) {
    scenes.push({
      type: 'close',
      line: closeLine,
      source: 'then_now',
      celebrationDate: null,
      frames: [{ ...thenFrame.frame, why: `then · ${thenFrame.frame.why}` }, { ...nowFrame.frame, why: `now · ${nowFrame.frame.why}` }],
    });
    dropped.push({ scene: 'close', reason: 'no birthday memories in scope — then/now instead' });
  } else if (endPortrait) {
    scenes.push({
      type: 'close',
      line: closeLine,
      source: 'portraits',
      celebrationDate: null,
      frames: startPortrait ? [startPortrait, endPortrait] : [endPortrait],
    });
    dropped.push({ scene: 'close', reason: 'no birthday memories or verified then/now frames — portraits instead' });
  } else dropped.push({ scene: 'close', reason: 'no birthday memories, verified frames or portraits' });

  fitLength(scenes, MAX_FILM_SECONDS - 3); // the end card follows
  scenes.push({ type: 'end_card', grid: finale.slice(0, GRID_CARDS) });

  return finish({ kind: 'birthday', language, title, scope, pool, scenes, dropped, vision: !!input.checks, subjects: [child], references: own,
    span: { from: scope.start, to: addYears(child.dateOfBirth!, input.ageYear) } });
}

// ── Monthly family recap ─────────────────────────────────────────────────

export interface MonthlyInput {
  yearMonth: string;
  memories: FilmMemorySource[];
  children: FilmPerson[]; // the family's own children
  milestones: FilmMilestoneInput[];
  quotes: VerifiedQuote[];
  language: FilmLanguage;
  checks?: FrameChecks;
}

function monthlyContext(input: MonthlyInput): ScoreContext {
  return {
    milestoneMemoryIds: milestoneIds(input.milestones),
    ownChildIds: new Set(input.children.map((c) => c.id)),
    sensitive: shareSensitiveIds(input.memories, input.milestones),
    checks: input.checks,
    names: new Map(input.children.map((c) => [c.id, firstNameOf(c.name)])),
  };
}

function monthKids(input: MonthlyInput, scope: FilmScope): FilmPerson[] {
  return chapterChildren(input.children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
    .map((k) => input.children.find((c) => c.id === k.id)!)
    .sort((a, b) => (a.dateOfBirth ?? '').localeCompare(b.dateOfBirth ?? '') || a.id.localeCompare(b.id));
}

/** Award-beat candidates for every child — for the vision check. */
export function monthlyVisionCandidates(input: MonthlyInput): FrameRef[] {
  const scope = monthScope(input.yearMonth);
  const pool = familyPool(input.memories, scope);
  const ctx = monthlyContext(input);
  return dedupeFrames(
    monthKids(input, scope).flatMap((kid) =>
      childFrameCandidates(pool, kid.id, ctx, new Set()).slice(0, VISION_CANDIDATES_PER_SLOT * 2).map((c) => c.frame)
    ),
  );
}

export function buildMonthlyScript(input: MonthlyInput): FilmScript {
  const { language } = input;
  const strings = STRINGS[language];
  const scope = monthScope(input.yearMonth);
  const pool = familyPool(input.memories, scope);
  const ctx = monthlyContext(input);
  const scenes: FilmScene[] = [];
  const dropped: FilmScript['dropped'] = [];
  const used = new Set<string>();
  const [year, month] = input.yearMonth.split('-').map(Number);
  const title = strings.monthTitle(month);
  const kids = monthKids(input, scope);

  // Claims first: one award per child, oldest first.
  const awards: Extract<FilmScene, { type: 'award' }>[] = [];
  const usedAwards = new Set<AwardKind>();
  kids.forEach((kid) => {
    const kidName = firstNameOf(kid.name);
    const candidates = childFrameCandidates(pool, kid.id, ctx, used).slice(0, VISION_CANDIDATES_PER_SLOT * 2);
    // Prefer moving clips for the beat, like Google's.
    const verified = verifiedFor(candidates, kid.id, ctx).sort((a, b) =>
      Number(b.frame.kind === 'video') - Number(a.frame.kind === 'video')
    );
    const pick = (): { kind: AwardKind; hit?: (typeof verified)[number] } => {
      if (ctx.checks) {
        const laugh = verified.find((v) => v.check?.expression === 'laughing');
        if (laugh && !usedAwards.has('laugh')) return { kind: 'laugh', hit: laugh };
        const smile = verified.find((v) => v.check?.expression === 'big_smile' || v.check?.expression === 'smiling');
        if (smile && !usedAwards.has('smile')) return { kind: 'smile', hit: smile };
        if (laugh) return { kind: 'star', hit: laugh };
        if (smile) return { kind: 'star', hit: smile };
      }
      return { kind: 'star', hit: verified[0] };
    };
    const { kind, hit } = pick();
    const award = strings.award[kind];
    // Every award announces itself — "and don't forget about…" followed by a
    // chip read as a mixed message (owner, F3 monthly review).
    const intro = strings.awardGoesTo(award);
    if (hit) {
      usedAwards.add(kind);
      used.add(hit.memory.id);
      awards.push({
        type: 'award',
        childId: kid.id,
        childName: kidName,
        intro,
        award,
        evidence: kind === 'laugh' ? 'laughing' : kind === 'smile' ? 'smiling' : 'subject',
        frame: hit.frame,
      });
      return;
    }
    // Nothing verifiable this month: the child still appears (equal time).
    const version = resolvePortraitVersionAtDate(kid.portraits, scope.endExclusive);
    const portrait = version ? portraitFrame(version, 'no verified frame this month — portrait') : null;
    if (portrait) {
      awards.push({ type: 'award', childId: kid.id, childName: kidName, intro, award: strings.award.star, evidence: 'portrait', frame: portrait });
    } else dropped.push({ scene: 'award', reason: `${kidName}: no verified frame and no portrait` });
  });

  // Voice beat: the month's sound, else its line — never both (F1).
  const names = new Map(kids.map((k) => [k.id, firstNameOf(k.name)]));
  const sound = soundScene(pool, null, ctx, false);
  const line = lineScene(input.quotes, pool, names, ctx);
  const voice = sound ?? line;
  if (voice?.type === 'sound') used.add(voice.frame.memoryId!);
  if (voice?.type === 'line') used.add(voice.memoryId);

  // FOCUS — title over floating cards.
  const titleCards = pickBurst(pool, TITLE_CARDS, scope, ctx, new Set(used)).filter((f) => f.kind !== 'video').slice(0, TITLE_CARDS);
  const k = STRINGS[language].kicker.family;
  scenes.push({ type: 'title', title, subtitle: String(year), kicker: k.title, cards: titleCards });

  const counters = countersScene(pool, language, k.counters, scope, ctx);
  if (counters) scenes.push(counters);

  // BURST — themes grid (optional; ~half of months qualify, F0).
  const themes = distinctiveThemes(pool, input.memories.filter((m) => !m.reported), 3, WORLD_MIN_MEMORIES_PER_TOPIC, language, 'family');
  if (themes.length >= 2) {
    const themed = pool.filter((m) => m.topics.some((t) => themes.some((th) => th.topicId === t)));
    scenes.push({
      type: 'burst',
      role: 'month',
      titles: themes.map((t) => t.title),
      titlesKicker: k.themes,
      frames: pickBurst(themed, MONTH_THEME_FRAMES, scope, ctx, used),
      secondsPerFrame: BURST_SECONDS_PER_FRAME,
    });
  } else dropped.push({ scene: 'burst', reason: `no themes grid: only ${themes.length} topic(s) on ≥2 memories` });

  // FOCUS — awards.
  scenes.push(...awards);

  // FOCUS — one voice beat.
  if (voice?.type === 'sound') scenes.push({ ...voice, kicker: `${k.sound} ${title}` });
  if (voice?.type === 'line') scenes.push({ ...voice, kicker: k.line });
  if (voice?.type !== 'sound') dropped.push({ scene: 'sound', reason: 'no audio memory this month' });
  if (voice?.type !== 'line') {
    dropped.push({ scene: 'line', reason: line ? 'monthly keeps one voice beat; the sound won' : 'no verified quote from the kids this month' });
  }

  // BURST — the funny ones / tiny troublemakers, when the month has them.
  const moods = emotionBurst(pool, scope, ctx, used, language, 'family');
  if (moods) scenes.push(moods);

  // BURST — the rest of the month, fast.
  const burst = pickBurst(pool, MONTH_BURST_FRAMES, scope, ctx, used);
  scenes.push({ type: 'burst', role: 'finale', titles: [], frames: burst, secondsPerFrame: FINALE_SECONDS_PER_FRAME });

  fitLength(scenes, MAX_FILM_SECONDS - 3); // the end card follows
  const awardFrames = awards.map((a) => a.frame);
  scenes.push({ type: 'end_card', grid: [...awardFrames, ...burst].slice(0, GRID_CARDS) });

  return finish({ kind: 'family_month', language, title: `${title} ${year}`, scope, pool, scenes, dropped, vision: !!input.checks, subjects: kids, references: kids,
    span: { from: scope.start, to: addDays(scope.start, toJulianDayNumber(scope.endExclusive) - toJulianDayNumber(scope.start) - 1) } });
}

// ── Year-end family film ─────────────────────────────────────────────────

export interface FamilyYearInput {
  year: number;
  /** Override for a film built before the cut-off (dogfood "so far"). */
  scope?: FilmScope;
  memories: FilmMemorySource[];
  children: FilmPerson[]; // the family's own children
  members: FilmPerson[];
  milestones: FilmMilestoneInput[];
  quotes: VerifiedQuote[];
  language: FilmLanguage;
  checks?: FrameChecks;
}

/** Verified moments on each child's chapter card fan. */
const CHAPTER_FRAMES = 3;
/** "Juntos": memories tagging at least this many family members. */
const TOGETHER_MIN_TAGGED = 3;
const TOGETHER_FRAMES = 4;
const FAMILY_FIRSTS_MAX = 4;
/** Chapter length in the renderer — equal for every child (plan §3). */
const CHAPTER_BEATS = 10;

function familyYearScopeOf(input: FamilyYearInput): FilmScope {
  return input.scope ?? familyYearScope(input.year);
}

function familyYearContext(input: FamilyYearInput): ScoreContext {
  return {
    milestoneMemoryIds: milestoneIds(input.milestones),
    ownChildIds: new Set(input.children.map((c) => c.id)),
    sensitive: shareSensitiveIds(input.memories, input.milestones),
    checks: input.checks,
    names: new Map(input.members.map((m) => [m.id, firstNameOf(m.name)])),
  };
}

function yearKids(input: FamilyYearInput, scope: FilmScope): FilmPerson[] {
  return chapterChildren(input.children.map((c) => ({ id: c.id, dateOfBirth: c.dateOfBirth })), scope)
    .map((k) => input.children.find((c) => c.id === k.id)!)
    .sort((a, b) => (a.dateOfBirth ?? '').localeCompare(b.dateOfBirth ?? '') || a.id.localeCompare(b.id));
}

/** Up to n candidates spread over the scope: the best of each part of the
 * year first (candidates arrive best-first), then the best of the rest. */
function spreadOverScope<T extends { memory: FilmMemorySource }>(items: T[], n: number, scope: FilmScope): T[] {
  const start = toJulianDayNumber(scope.start);
  const span = Math.max(1, toJulianDayNumber(scope.endExclusive) - start);
  const part = (item: T) => Math.min(n - 1, Math.floor(((toJulianDayNumber(item.memory.date) - start) * n) / span));
  const chosen: T[] = [];
  for (let p = 0; p < n; p += 1) {
    const best = items.find((item) => part(item) === p && !chosen.includes(item));
    if (best) chosen.push(best);
  }
  for (const item of items) {
    if (chosen.length >= n) break;
    if (!chosen.includes(item)) chosen.push(item);
  }
  return chosen.sort((a, b) => a.memory.date.localeCompare(b.memory.date) || a.memory.id.localeCompare(b.memory.id));
}

/** Chapter and voice candidates for every child — for the vision check. */
export function familyYearVisionCandidates(input: FamilyYearInput): FrameRef[] {
  const scope = familyYearScopeOf(input);
  const pool = familyPool(input.memories, scope);
  const ctx = familyYearContext(input);
  const kids = yearKids(input, scope);
  const named = kids.map((k) => ({ id: k.id, name: k.name }));
  return dedupeFrames(kids.flatMap((kid) => [
    ...childFrameCandidates(pool, kid.id, ctx, new Set()).slice(0, VISION_CANDIDATES_PER_SLOT * 3),
    ...soundCandidates(pool, kid.id, ctx, named).videos.slice(0, VOICE_CANDIDATES),
  ].map((c) => c.frame)));
}

/** One chapter per child, equal length whatever the data (plan §3, the
 * sibling trap): the portrait at the end of the scope, up to CHAPTER_FRAMES
 * verified moments spread over it, and the child's verified line when there
 * is one. Marks the moments used. */
function buildChapters(
  kids: FilmPerson[],
  pool: FilmMemorySource[],
  ctx: ScoreContext,
  scope: FilmScope,
  used: Set<string>,
  quotes: VerifiedQuote[],
  dropped: FilmScript['dropped'],
): Extract<FilmScene, { type: 'chapter' }>[] {
  const chapters: Extract<FilmScene, { type: 'chapter' }>[] = kids.map((kid) => {
    const version = resolvePortraitVersionAtDate(kid.portraits, scope.endExclusive);
    const portrait = version ? portraitFrame(version, 'portrait at the end of the year') : null;
    const verified = verifiedFor(childFrameCandidates(pool, kid.id, ctx, used).slice(0, VISION_CANDIDATES_PER_SLOT * 3), kid.id, ctx);
    const picked = spreadOverScope(verified, CHAPTER_FRAMES, scope);
    for (const v of picked) used.add(v.memory.id);
    const quote = quotes.find((q) => q.speakerId === kid.id && pool.some((m) => m.id === q.memoryId) && !ctx.sensitive.has(q.memoryId));
    return {
      type: 'chapter',
      childId: kid.id,
      name: firstNameOf(kid.name),
      portrait,
      frames: picked.map((v) => v.frame),
      line: quote ? { quote: quote.quote, memoryId: quote.memoryId } : null,
    };
  });
  for (const c of chapters) if (!c.portrait && c.frames.length === 0) dropped.push({ scene: 'chapter', reason: `${c.name}: no portrait and no verified frames` });
  return chapters;
}

/** "Nuestro 2025" (plan §4.2): the family's year, with one equal chapter per
 * child. Scope Jan 1 → Dec 27; renders Dec 28, surfaces Dec 30. */
export function buildFamilyYearScript(input: FamilyYearInput): FilmScript {
  const { language, year } = input;
  const strings = STRINGS[language];
  const scope = familyYearScopeOf(input);
  const pool = familyPool(input.memories, scope);
  const ctx = familyYearContext(input);
  const scenes: FilmScene[] = [];
  const dropped: FilmScript['dropped'] = [];
  const used = new Set<string>();
  const kids = yearKids(input, scope);
  const named = kids.map((k) => ({ id: k.id, name: k.name }));
  const k = STRINGS[language].kicker.family;
  const [firstHalf, secondHalf] = halves(scope);

  // Claims first, so bursts don't spend their frames. One chapter per child,
  // equal length whatever the data: a child with little still gets the
  // portrait and whatever verified moments exist (plan §3).
  const chapters = buildChapters(kids, pool, ctx, scope, used, input.quotes, dropped);

  // The year's sound: any child's audio memory, else a verified clip of a
  // child with their voice (oldest child first).
  let sound = soundScene(pool, null, ctx, false);
  for (const kid of kids) {
    if (sound) break;
    sound = soundScene(pool, kid.id, ctx, true, named);
  }
  if (sound && sound.type === 'sound') used.add(sound.frame.memoryId!);

  // Close: the family's latest moments together.
  const togetherPool = pool.filter((m) => m.taggedMemberIds.length >= TOGETHER_MIN_TAGGED && visualKind(m) !== null && usable(m, ctx));
  const closeFrames = [...togetherPool]
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, 2)
    .flatMap((m) => frameFor(m, 'the family together, late in the year') ?? []);
  for (const f of closeFrames) used.add(f.memoryId!);

  // FOCUS — title over the year's cards.
  const titleCards = pickBurst(pool, TITLE_CARDS, scope, ctx, new Set(used)).filter((f) => f.kind !== 'video').slice(0, TITLE_CARDS);
  scenes.push({ type: 'title', title: String(year), subtitle: '', kicker: k.title, cards: titleCards });

  const counters = countersScene(pool, language, k.yearCounters, scope, ctx);
  if (counters) scenes.push(counters);

  const visuals = pool.filter((m) => visualKind(m) !== null).length;
  const burstTotal = Math.max(YEAR_BURST_MIN, Math.min(YEAR_BURST_MAX, Math.round(visuals * YEAR_BURST_SHARE)));
  const halfBurst = Math.round(burstTotal * 0.3);

  // BURST — first half of the year.
  const firstHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'first_half',
    titles: [],
    frames: pickBurst(pool, halfBurst, firstHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
  });

  // FOCUS — one chapter per child.
  scenes.push(...chapters);

  // BURST — second half, under what the family loved this year.
  const themes = distinctiveThemes(pool, input.memories.filter((m) => !m.reported), 3, YEAR_THEME_MIN_MEMORIES, language, 'family');
  const secondHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'second_half',
    titles: themes.length >= 2 ? themes.map((t) => t.title) : [],
    ...(themes.length >= 2 ? { titlesKicker: k.yearThemes } : {}),
    frames: pickBurst(pool, halfBurst, secondHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
  });
  if (themes.length < 2) dropped.push({ scene: 'burst', reason: `no theme titles: only ${themes.length} topics on ≥${YEAR_THEME_MIN_MEMORIES} memories` });

  // FOCUS — the sound of the year.
  if (sound) scenes.push({ ...sound, kicker: `${k.sound} ${year}` } as FilmScene);
  else dropped.push({ scene: 'sound', reason: 'no audio memory, and no video clip verified to show a child' });

  // BURST — together: moments with several of the family in them.
  const togetherFrames = pickBurst(togetherPool, TOGETHER_FRAMES, scope, ctx, used);
  if (togetherFrames.length >= 3) {
    scenes.push({ type: 'burst', role: 'together', titles: [k.starring], frames: togetherFrames, secondsPerFrame: BURST_SECONDS_PER_FRAME });
  } else dropped.push({ scene: 'burst', reason: `no "together" burst: ${togetherFrames.length} memories tag ≥${TOGETHER_MIN_TAGGED} members` });

  // FOCUS — firsts, every child's, taken in turn so no child crowds the others.
  const perKid = kids.map((kid) => certainFirsts(pool, input.milestones, kid.id, language, ctx).map((f) => ({ ...f, childName: firstNameOf(kid.name) })));
  const firsts: Extract<FilmScene, { type: 'firsts' }>['items'] = [];
  for (let round = 0; firsts.length < FAMILY_FIRSTS_MAX && perKid.some((list) => list.length > round); round += 1) {
    for (const list of perKid) {
      if (firsts.length < FAMILY_FIRSTS_MAX && list[round] && !firsts.some((f) => f.memoryId === list[round].memoryId)) {
        const { confirmed: _c, ...item } = list[round];
        firsts.push(item);
      }
    }
  }
  firsts.sort((a, b) => a.date.localeCompare(b.date));
  if (firsts.length > 0) scenes.push({ type: 'firsts', kicker: k.firsts, items: firsts });
  else dropped.push({ scene: 'firsts', reason: 'no certain firsts this year' });

  // BURST — the funny ones.
  const moods = emotionBurst(pool, scope, ctx, used, language, 'family');
  if (moods) scenes.push(moods);

  // BURST — finale, taking up whatever the halves couldn't fill.
  const finale = pickBurst(pool, burstTotal - firstHalfFrames - secondHalfFrames, scope, ctx, used);
  scenes.push({ type: 'burst', role: 'finale', titles: [], frames: finale, secondsPerFrame: FINALE_SECONDS_PER_FRAME });

  // FOCUS — close: the family together; else the children's portraits.
  const closeLine = strings.familyYearClose(year);
  if (closeFrames.length > 0) {
    scenes.push({ type: 'close', line: closeLine, source: 'family', celebrationDate: null, frames: closeFrames });
  } else {
    const portraits = chapters.flatMap((c) => (c.portrait ? [c.portrait] : []));
    if (portraits.length > 0) scenes.push({ type: 'close', line: closeLine, source: 'portraits', celebrationDate: null, frames: portraits });
    dropped.push({ scene: 'close', reason: `no memories tagging ≥${TOGETHER_MIN_TAGGED} family members — portraits instead` });
  }

  fitLength(scenes, MAX_FILM_SECONDS - 3); // the end card follows
  scenes.push({ type: 'end_card', grid: finale.slice(0, GRID_CARDS) });

  return finish({ kind: 'family_year', language, title: `${k.title} ${year}`, scope, pool, scenes, dropped, vision: !!input.checks, subjects: kids, references: kids,
    span: { from: scope.start, to: addDays(scope.endExclusive, -1) } });
}

// ── Holiday card film (docs/plans/holiday-cards.md §6 C2) ────────────────
// The family year film's sibling for a printed card's QR: Jan 1 → the day
// the card is made, up to 60 s, watched publicly, with slower bursts (owner
// review, 2026-10-04: "a bit longer… a little more time to see each moment").
// Same parts (chapters, the sound, themes, bursts) plus the family's certain
// firsts, no counters / emotion / "together" bursts, a close made of the CORE
// family (own children + parents) together, and an end card that greets and
// signs. fitLength never trims focus scenes, so the length is kept by what
// the film includes, then by the bursts, then by dropping the sound, then by
// capping the firsts at two.

export interface HolidayInput extends FamilyYearInput {
  /** The card's greeting, picked by the parent (default 'holidays'): feeds
   * the end card's large greeting. */
  greeting?: HolidayGreeting;
  /** families.name: the end card's "from the {family} family". */
  familyName: string;
  /** The card front's top picks, as memory_media ids (object keys match too):
   * the close uses them first when they qualify (tagged with the whole core
   * family and nobody else). */
  preferredCloseMedia?: string[];
}

/** Owner, 2026-10-04 (round 2): a card film runs up to ~60 s. */
export const HOLIDAY_MAX_FILM_SECONDS = 60;
/** Bursts hold each frame 1.5× longer than the year film (`holdFactor`). */
export const HOLIDAY_HOLD_FACTOR = 1.5;
/** Burst frames before fitLength trims to the cap (halves 30% each). */
const HOLIDAY_BURST_TOTAL = 36;
const HOLIDAY_FIRSTS_MAX = 4;
const HOLIDAY_FIRSTS_MIN = 2;
const CLOSE_FRAMES = 2;
const CLOSE_VISION_CANDIDATES = 12;

/** "Rivera Soto" from "The Rivera Soto Family" / "Familia Rivera Soto". */
export function familyDisplayName(name: string): string {
  const stripped = name
    .trim()
    .replace(/^(la\s+)?familia\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(/\s+family$/i, '')
    .trim();
  return stripped || name.trim();
}

function holidayScopeOf(input: HolidayInput): FilmScope {
  return input.scope ?? { start: `${input.year}-01-01`, endExclusive: `${input.year + 1}-01-01` };
}

function holidayContext(input: HolidayInput): ScoreContext {
  return {
    ...familyYearContext(input),
    // Public audience: the stricter text/topic screen (shareSensitiveIds).
    sensitive: shareSensitiveIds(input.memories, input.milestones, { publicAudience: true }),
    holiday: true,
  };
}

/** The holiday film's pool: the family pool minus share-sensitive memories
 * and worried/sad/weary moments (eligibility's holidayPool). */
function holidayFilmPool(input: HolidayInput, scope: FilmScope): FilmMemorySource[] {
  return holidayPool(input.memories, scope, shareSensitiveIds(input.memories, input.milestones, { publicAudience: true }));
}

/** The core family: the own children of the film and the members whose role
 * is 'parent' (never a child who is also marked parent). */
function holidayCore(input: HolidayInput, kids: FilmPerson[]): { kids: FilmPerson[]; parents: FilmPerson[]; ids: string[] } {
  const parents = input.members
    .filter((m) => m.relationship === 'parent' && !kids.some((k) => k.id === m.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { kids, parents, ids: [...kids.map((k) => k.id), ...parents.map((p) => p.id)] };
}

type CloseMode = 'exact' | 'with_others' | 'legacy' | 'none';

interface CloseCandidate {
  memory: FilmMemorySource;
  frame: FrameRef;
  /** One of the card front's top picks. */
  preferred: boolean;
}

/** Close candidates, best first, in the first mode that has any:
 * 'exact' — tagged with ALL core members and nobody else;
 * 'with_others' — all core members, others too (recorded as a fallback);
 * 'legacy' — a core of one has no "together": ≥3 people tagged (year-film rule);
 * 'none'. Ranking: front top picks, vision-verified group frames (every own
 * child visible, sharp, safe), holiday topics, then the latest. */
function closeCandidates(
  pool: FilmMemorySource[],
  core: string[],
  preferred: ReadonlySet<string>,
  ctx: ScoreContext,
  kidIds: string[],
): { mode: CloseMode; candidates: CloseCandidate[] } {
  const visual = pool.filter((m) => visualKind(m) !== null && usable(m, ctx));
  let mode: CloseMode;
  let chosen: FilmMemorySource[];
  if (core.length >= 2) {
    const all = visual.filter((m) => core.every((id) => m.taggedMemberIds.includes(id)));
    const exact = all.filter((m) => m.taggedMemberIds.every((id) => core.includes(id)));
    mode = exact.length > 0 ? 'exact' : all.length > 0 ? 'with_others' : 'none';
    chosen = exact.length > 0 ? exact : all;
  } else {
    chosen = visual.filter((m) => m.taggedMemberIds.length >= TOGETHER_MIN_TAGGED);
    mode = chosen.length > 0 ? 'legacy' : 'none';
  }
  const label = mode === 'exact' ? `all ${core.length} core members, nobody else` : mode === 'with_others' ? 'all core members, others tagged too (fallback)' : 'the family together';
  const items: (CloseCandidate & { score: number })[] = chosen.flatMap((memory) => {
    const pick = memory.assets.find((a) => (a.id && preferred.has(a.id)) || preferred.has(a.key));
    // The close shows a still: a clip would show its first frame, which the
    // public-audience vision check never saw (it checks clips at their middle).
    const pickFrame = pick && (pick.kind === 'image' || isClip(pick))
      ? assetFrame(memory, pick, pick.kind === 'image' ? 'photo' : 'video', '')
      : null;
    const stillPick = pickFrame && pickFrame.kind === 'video' ? null : pickFrame;
    // A real photo or clip of the family beats the memory's illustration.
    const real = memory.assets.find((a) => a.kind === 'image') ?? (ctx.holiday ? undefined : memory.assets.find(isClip));
    const frame = (ctx.holiday ? stillPick : pickFrame) ??
      (real ? assetFrame(memory, real, real.kind === 'image' ? 'photo' : 'video', '') : frameFor(memory, ''));
    if (!frame || frame.kind === 'audio' || (ctx.holiday && frame.kind === 'video')) return [];
    const check = ctx.checks?.get(checkKey(frame));
    let score = ((ctx.holiday ? stillPick : pickFrame) ? 100 : 0) + (frame.kind === 'illustration' ? -5 : 0) + (memory.topics.some((t) => HOLIDAY_TOPICS.has(t)) ? 3 : 0);
    let why = `${label}${(ctx.holiday ? stillPick : pickFrame) ? ' · front top pick' : ''}`;
    if (check) {
      const bad = check.unsafe || check.screenCapture || check.quality === 'blurry' || check.expression === 'upset' || check.underdressed !== false;
      const everyone = kidIds.every((id) => check.childrenVisible.includes(id) || check.mainSubject === id);
      const smiling = check.expression === 'laughing' || check.expression === 'big_smile' || check.expression === 'smiling';
      score += bad ? -50 : (everyone ? 10 : 0) + (check.faceVisible ? 3 : 0) + (smiling ? 2 : 0) + (check.quality === 'good' ? 1 : 0);
      why += ` · ${describeCheck(check, ctx.names)}`;
    }
    return [{ memory, frame: { ...frame, why }, preferred: !!(ctx.holiday ? stillPick : pickFrame), score }];
  });
  items.sort((a, b) => b.score - a.score || b.memory.date.localeCompare(a.memory.date) || a.memory.id.localeCompare(b.memory.id));
  const sound = items.filter((i) => i.score > -40);
  // A public film never falls back to a frame its checks flagged: with none
  // left the close shows everyone's portraits instead.
  return { mode, candidates: (sound.length > 0 || (ctx.holiday && ctx.checks) ? sound : items).map(({ memory, frame, preferred: p }) => ({ memory, frame, preferred: p })) };
}

/** Chapter, voice and close candidates for every child — for the vision check. */
export function holidayVisionCandidates(input: HolidayInput): FrameRef[] {
  const scope = holidayScopeOf(input);
  const pool = holidayFilmPool(input, scope);
  const ctx = holidayContext(input);
  const kids = yearKids(input, scope);
  const named = kids.map((k) => ({ id: k.id, name: k.name }));
  const core = holidayCore(input, kids);
  const close = closeCandidates(pool, core.ids, new Set(input.preferredCloseMedia ?? []), ctx, kids.map((k) => k.id));
  return dedupeFrames([
    ...kids.flatMap((kid) => [
      ...childFrameCandidates(pool, kid.id, ctx, new Set()).slice(0, VISION_CANDIDATES_PER_SLOT * 3),
      ...soundCandidates(pool, kid.id, ctx, named).videos.slice(0, VOICE_CANDIDATES),
    ].map((c) => c.frame)),
    ...close.candidates.slice(0, CLOSE_VISION_CANDIDATES).map((c) => c.frame),
  ]);
}

/** Candidate firsts the film does NOT show, with why: for the owner (and, in
 * P1, the card flow's "Did these happen this year?" step). Pool memories
 * only; a first is shown once it is certain (isCertainFirst). */
export interface UnconfirmedFirst {
  memoryId: string;
  milestoneId: string;
  label: string;
  date: string;
  /** The milestone's own child, else null. */
  childName: string | null;
  /** True when the text-evidence gate would already show it. */
  gatePasses: boolean;
  reason: string;
}

export function unconfirmedFirsts(
  pool: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  members: { id: string; name: string }[],
  language: FilmLanguage,
): UnconfirmedFirst[] {
  const byId = new Map(pool.map((m) => [m.id, m]));
  const names = new Map(members.map((m) => [m.id, firstNameOf(m.name)]));
  return milestones
    .flatMap((row) => {
      const memory = byId.get(row.memoryId);
      if (!memory || row.status !== 'candidate') return [];
      if (SHARE_SENSITIVE_MILESTONES.has(row.milestoneId) || NOT_A_FIRST.has(row.milestoneId)) return [];
      const label = milestoneLabel(row.milestoneId, language);
      if (!label) return [];
      const gatePasses = isCertainFirst(row, memory.text ?? null);
      return [{
        memoryId: row.memoryId,
        milestoneId: row.milestoneId,
        label,
        date: memory.date,
        childName: row.familyMemberId ? names.get(row.familyMemberId) ?? null : null,
        gatePasses,
        reason: gatePasses ? 'text says it is a first, inside the age band' : row.outOfBand ? 'outside the milestone\'s age band' : 'the text does not say "first"',
      }];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.milestoneId.localeCompare(b.milestoneId));
}

export function buildHolidayScript(input: HolidayInput): FilmScript {
  const { language, year } = input;
  const strings = STRINGS[language];
  const scope = holidayScopeOf(input);
  const pool = holidayFilmPool(input, scope);
  const ctx = holidayContext(input);
  const scenes: FilmScene[] = [];
  const dropped: FilmScript['dropped'] = [];
  const used = new Set<string>();
  const kids = yearKids(input, scope);
  const named = kids.map((k) => ({ id: k.id, name: k.name }));
  const k = strings.kicker.family;
  const [firstHalf, secondHalf] = halves(scope);
  const core = holidayCore(input, kids);

  // Claims first, so bursts don't spend their frames (same as the year film).
  const chapters = buildChapters(kids, pool, ctx, scope, used, input.quotes, dropped);

  let sound = soundScene(pool, null, ctx, false);
  for (const kid of kids) {
    if (sound) break;
    sound = soundScene(pool, kid.id, ctx, true, named);
  }
  if (sound && sound.type === 'sound') used.add(sound.frame.memoryId!);

  // Close: the CORE family together (owner, round 2) — every own child and
  // every parent, nobody else — front top picks first.
  const close = closeCandidates(pool, core.ids, new Set(input.preferredCloseMedia ?? []), ctx, kids.map((x) => x.id));
  const closeFrames: FrameRef[] = [];
  for (const c of close.candidates) {
    if (closeFrames.length >= CLOSE_FRAMES) break;
    if (!closeFrames.some((f) => f.memoryId === c.memory.id)) closeFrames.push(c.frame);
  }
  for (const f of closeFrames) used.add(f.memoryId!);
  if (close.mode === 'with_others') {
    dropped.push({ scene: 'close', reason: 'no memory tags the whole core family without others — used memories tagging all of them plus other people' });
  }

  // FOCUS — title over the year's cards.
  const titleCards = pickBurst(pool, TITLE_CARDS, scope, ctx, new Set(used)).filter((f) => f.kind !== 'video').slice(0, TITLE_CARDS);
  scenes.push({ type: 'title', title: String(year), subtitle: strings.holidayTitleSub, kicker: k.title, cards: titleCards });

  const halfBurst = Math.round(HOLIDAY_BURST_TOTAL * 0.3);
  const slow = { holdFactor: HOLIDAY_HOLD_FACTOR };

  // BURST — first part of the year.
  const firstHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'first_half',
    titles: [],
    frames: pickBurst(pool, halfBurst, firstHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
    ...slow,
  });

  // FOCUS — one chapter per child.
  scenes.push(...chapters);

  // BURST — second part, under what the family loved this year.
  const themes = distinctiveThemes(pool, input.memories.filter((m) => !m.reported), 3, YEAR_THEME_MIN_MEMORIES, language, 'family');
  const secondHalfFrames = pushHalfBurst(scenes, dropped, used, {
    type: 'burst',
    role: 'second_half',
    titles: themes.length >= 2 ? themes.map((t) => t.title) : [],
    ...(themes.length >= 2 ? { titlesKicker: k.yearThemes } : {}),
    frames: pickBurst(pool, halfBurst, secondHalf, ctx, used),
    secondsPerFrame: BURST_SECONDS_PER_FRAME,
    ...slow,
  });
  if (themes.length < 2) dropped.push({ scene: 'burst', reason: `no theme titles: only ${themes.length} topics on ≥${YEAR_THEME_MIN_MEMORIES} memories` });

  // FOCUS — the sound of the year (dropped below when the cap needs the room).
  if (sound) scenes.push({ ...sound, kicker: `${k.sound} ${year}` } as FilmScene);
  else dropped.push({ scene: 'sound', reason: 'no audio memory, and no video clip verified to show a child' });

  // FOCUS — firsts: every child's certain ones, in turn, by date (milestones
  // are part of the holiday film, owner round 2).
  // Plain words, as a parent says it ("Dio sus primeros pasos"), not the catalog's label.
  const perKid = kids.map((kid) =>
    certainFirsts(pool, input.milestones, kid.id, language, ctx).map((f) => ({
      ...f,
      label: holidayFirstLabel(f.milestoneId, language) ?? f.label,
      childName: firstNameOf(kid.name),
    }))
  );
  const firsts: Extract<FilmScene, { type: 'firsts' }>['items'] = [];
  for (let round = 0; firsts.length < HOLIDAY_FIRSTS_MAX && perKid.some((list) => list.length > round); round += 1) {
    for (const list of perKid) {
      if (firsts.length < HOLIDAY_FIRSTS_MAX && list[round] && !firsts.some((f) => f.memoryId === list[round].memoryId)) {
        const { confirmed: _c, ...item } = list[round];
        firsts.push(item);
      }
    }
  }
  firsts.sort((a, b) => a.date.localeCompare(b.date));
  if (firsts.length > 0) scenes.push({ type: 'firsts', kicker: k.firsts, items: firsts });
  else dropped.push({ scene: 'firsts', reason: 'no certain firsts this year (parent-confirmed, or the text says "first" within the age band)' });

  // BURST — finale, taking up whatever the halves couldn't fill.
  const finale = pickBurst(pool, HOLIDAY_BURST_TOTAL - firstHalfFrames - secondHalfFrames, scope, ctx, used);
  scenes.push({ type: 'burst', role: 'finale', titles: [], frames: finale, secondsPerFrame: FINALE_SECONDS_PER_FRAME, ...slow });

  // FOCUS — close: the core family together; else everyone's portraits
  // (children AND parents — never a close without a parent when parents exist).
  const closeLine = strings.familyYearClose(year);
  if (closeFrames.length > 0) {
    scenes.push({ type: 'close', line: closeLine, source: 'family', celebrationDate: null, frames: closeFrames });
  } else {
    const people = [...kids, ...core.parents];
    const portraits = people.flatMap((p) => {
      const version = resolvePortraitVersionAtDate(p.portraits, scope.endExclusive);
      const frame = version ? portraitFrame(version, 'portrait at the end of the year') : null;
      return frame ? [frame] : [];
    });
    if (portraits.length > 0) scenes.push({ type: 'close', line: closeLine, source: 'portraits', celebrationDate: null, frames: portraits });
    dropped.push({ scene: 'close', reason: `no memory tags the whole core family (${core.ids.length} people) — portraits of everyone instead` });
  }

  // Length: trim the bursts; if that is not enough (several children's
  // chapters are equal and untouchable), the sound goes, then the firsts are
  // capped at HOLIDAY_FIRSTS_MIN.
  const budget = HOLIDAY_MAX_FILM_SECONDS - 3; // the end card follows
  const attempts: ((s: FilmScene[]) => string | null)[] = [
    () => null,
    (s) => {
      const at = s.findIndex((x) => x.type === 'sound');
      if (at < 0) return null;
      s.splice(at, 1);
      return `sound dropped to keep the film under ${HOLIDAY_MAX_FILM_SECONDS}s`;
    },
    (s) => {
      const scene = s.find((x) => x.type === 'firsts');
      if (!scene || scene.type !== 'firsts' || scene.items.length <= HOLIDAY_FIRSTS_MIN) return null;
      scene.items = scene.items.slice(0, HOLIDAY_FIRSTS_MIN);
      return `firsts capped at ${HOLIDAY_FIRSTS_MIN} to keep the film under ${HOLIDAY_MAX_FILM_SECONDS}s`;
    },
  ];
  // Removals accumulate on `base`; the bursts are trimmed on a copy each time,
  // so a removal gives its time back to the bursts.
  const base = structuredClone(scenes);
  let fitted = base;
  const notes: string[] = [];
  for (const attempt of attempts) {
    const note = attempt(base);
    if (note) notes.push(note);
    fitted = structuredClone(base);
    fitLength(fitted, budget);
    if (estimateSeconds(fitted) <= budget) break;
  }
  scenes.splice(0, scenes.length, ...fitted);
  for (const note of notes) dropped.push({ scene: note.startsWith('sound') ? 'sound' : 'firsts', reason: note });

  const keptFinale = scenes.find((s) => s.type === 'burst' && s.role === 'finale');
  const grid = (keptFinale && keptFinale.type === 'burst' ? keptFinale.frames : finale).slice(0, GRID_CARDS);
  scenes.push({
    type: 'end_card',
    grid,
    greeting: strings.holidayGreetings[input.greeting ?? DEFAULT_HOLIDAY_GREETING],
    from: strings.holidayFrom(familyDisplayName(input.familyName)),
  });

  return {
    ...finish({ kind: 'family_holiday', language, title: `${k.title} ${year}`, scope, pool, scenes, dropped, vision: !!input.checks, subjects: kids, references: kids,
      // The strip spans the whole card year, Jan 1 → Dec 31 (owner, round 4): the
      // film is watched in December, so it must not end at the day it was made.
      // The content scope above (Jan 1 → creation day) is unchanged; every dot
      // still sits at its true date along the longer strip.
      span: { from: scope.start, to: `${year}-12-31` } }),
    theme: 'holiday',
  };
}

// ── Digest support (holiday-card-digest.ts) ──────────────────────────────

/** Ranks a share-safe pool the way the films do (scoreMemory, then the best
 * of each part of the scope first — spreadMemories), for the holiday letter's
 * year digest. `bonus` lifts memories (e.g. the ones already in the film). */
export function rankMemories(
  pool: FilmMemorySource[],
  options: {
    scope: FilmScope;
    milestones: FilmMilestoneInput[];
    ownChildIds: string[];
    n: number;
    holiday?: boolean;
    bonus?: ReadonlyMap<string, number>;
  },
): { memory: FilmMemorySource; score: number; why: string }[] {
  const ctx: ScoreContext = {
    milestoneMemoryIds: milestoneIds(options.milestones),
    ownChildIds: new Set(options.ownChildIds),
    sensitive: new Set(),
    names: new Map(),
    holiday: options.holiday,
  };
  const scored = pool.map((memory) => {
    const { score, why } = scoreMemory(memory, ctx);
    const bonus = options.bonus?.get(memory.id) ?? 0;
    return { memory, score: Math.round((score + bonus) * 100) / 100, why: bonus > 0 ? `${why} · in film` : why };
  });
  return spreadMemories(scored, options.n, options.scope, true);
}

function dedupeFrames(frames: FrameRef[]): FrameRef[] {
  const seen = new Set<string>();
  return frames.filter((f) => {
    const key = checkKey(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
