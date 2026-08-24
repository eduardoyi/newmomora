// Milestone catalog for `analyze-memory` (docs/plans/memory-book.md §5 Stage
// A milestone axis, docs/plans/milestone-catalog.md v1.1 -- the source of
// truth this file is a typed, production-ready port of).
//
// Principles (restated from the doc because they shape every consumer of
// this file -- never relax these when extending the catalog):
//
// 1. EXPLICIT TEXT ONLY. A memory matches a milestone only when the parent's
//    own words record it. Photos, dates, and ages never *detect* a
//    milestone -- `ageBandMonths` below is only a plausibility filter on
//    what the text already claims. The one sanctioned exception is
//    `birthday`, whose recurring match also fires from the deterministic DOB
//    join (see docs/plans/milestone-catalog.md "Notes for implementation"
//    and analyze-memory-core.ts's birthday resolution) -- that is a database
//    fact lookup, not model inference.
// 2. CELEBRATION, NEVER TRACKING. No surface may ever show a "missing" or
//    "late" milestone, cross-child comparisons, or developmental norms. An
//    explicit claim outside the age band is not rejected -- it is kept and
//    flagged `out_of_band: true` for later confirmation (parents backfill
//    old memories; dates can be approximate).
// 3. VERSIONED DATA. `id` is stable forever; entries may be added or
//    deprecated but never repurposed.
//
// A sync test (memory-milestones.test.ts) parses the catalog doc's tables
// the same way `supabase/scripts/eval-memory-book-tagging.ts` does and
// asserts these ids match the doc exactly (ids + count), so the doc and this
// file cannot silently drift.
//
// NOTE for future readers: the doc's own "Notes for implementation" section
// says "78 entries across 7 categories" -- that count is stale prose. The
// doc's actual tables (which the sync test parses) contain 77 entries across
// 8 `##`-level category sections; this file matches the tables, not the
// stale summary line.

export type MilestoneCategory =
  | 'body-movement'
  | 'talking-language'
  | 'eating'
  | 'sleep-growing-up'
  | 'self-care-independence'
  | 'social-emotional'
  | 'school-learning'
  | 'firsts-experiences';

export interface AgeBandMonths {
  /** Inclusive lower bound in months, or null for the `any`-age band. */
  readonly min: number | null;
  /** Inclusive upper bound in months, or null for the `any`-age band. */
  readonly max: number | null;
}

export interface MilestoneDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: MilestoneCategory;
  /** The catalog doc's raw band string (e.g. "8–19m", "any"), kept for
   * auditability against the doc. */
  readonly band: string;
  readonly ageBandMonths: AgeBandMonths;
}

interface RawEntry {
  readonly id: string;
  readonly name: string;
  readonly category: MilestoneCategory;
  readonly band: string;
}

function parseAgeToken(token: string): { value: number; unit: 'm' | 'y' } | null {
  const match = /^(\d+(?:\.\d+)?)(m|y)$/.exec(token.trim());
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2] as 'm' | 'y' };
}

function toMonths(value: number, unit: 'm' | 'y'): number {
  return unit === 'y' ? Math.round(value * 12) : Math.round(value);
}

/**
 * Parses a catalog band string ("0–4m", "10m–3y", "2.5–7y", "any") into
 * inclusive month bounds. A bare number on one side of the en dash (no unit
 * letter) inherits the unit from the other, explicit side -- e.g. in
 * "2–6y" the "2" means 2 years, not 2 months. Exported for direct unit
 * testing.
 */
export function parseAgeBandMonths(band: string): AgeBandMonths {
  const trimmed = band.trim();
  if (trimmed.toLowerCase() === 'any') {
    return { min: null, max: null };
  }

  const parts = trimmed.split('–').map((part) => part.trim());
  if (parts.length !== 2) {
    throw new Error(`Unparsable milestone age band "${band}"`);
  }

  const [rawMin, rawMax] = parts;
  const parsedMax = parseAgeToken(rawMax);
  if (!parsedMax) {
    throw new Error(`Unparsable milestone age band max "${band}"`);
  }

  const parsedMin = parseAgeToken(rawMin);
  const minUnit = parsedMin?.unit ?? parsedMax.unit;
  const minValue = parsedMin ? parsedMin.value : Number(rawMin);
  if (Number.isNaN(minValue)) {
    throw new Error(`Unparsable milestone age band min "${band}"`);
  }

  return { min: toMonths(minValue, minUnit), max: toMonths(parsedMax.value, parsedMax.unit) };
}

const RAW_ENTRIES: readonly RawEntry[] = [
  // ── Body & movement ──────────────────────────────────────────────────
  { id: 'first-smile', name: 'First smile', category: 'body-movement', band: '0–4m' },
  { id: 'holds-head-up', name: 'Holds head up', category: 'body-movement', band: '0–6m' },
  { id: 'rolls-over', name: 'Rolls over', category: 'body-movement', band: '2–8m' },
  { id: 'sits-up', name: 'Sits up unassisted', category: 'body-movement', band: '3–10m' },
  { id: 'crawling', name: 'Starts crawling', category: 'body-movement', band: '5–13m' },
  { id: 'pulls-to-stand', name: 'Pulls up to stand', category: 'body-movement', band: '6–14m' },
  { id: 'first-steps', name: 'First steps', category: 'body-movement', band: '8–19m' },
  { id: 'walking', name: 'Walking confidently', category: 'body-movement', band: '10–24m' },
  { id: 'climbing', name: 'First climbing', category: 'body-movement', band: '10m–3y' },
  { id: 'running', name: 'Starts running', category: 'body-movement', band: '14m–3y' },
  { id: 'first-jump', name: 'First jump (two feet)', category: 'body-movement', band: '18m–4y' },
  { id: 'balance-bike', name: 'Rides scooter / balance bike', category: 'body-movement', band: '2–5y' },
  { id: 'bike-training-wheels', name: 'Rides bike with training wheels', category: 'body-movement', band: '3–6y' },
  { id: 'bike-no-training-wheels', name: 'Rides bike without training wheels', category: 'body-movement', band: '4–9y' },
  { id: 'swims-unassisted', name: 'Swims without help', category: 'body-movement', band: '3–8y' },
  { id: 'first-somersault', name: 'First somersault / cartwheel', category: 'body-movement', band: '3–8y' },
  { id: 'catches-ball', name: 'Catches a ball', category: 'body-movement', band: '2–6y' },

  // ── Talking & language ───────────────────────────────────────────────
  { id: 'first-laugh', name: 'First laugh', category: 'talking-language', band: '1–8m' },
  { id: 'first-babble', name: 'First babbling', category: 'talking-language', band: '3–10m' },
  { id: 'says-mama-dada', name: 'First "mama"/"dada"', category: 'talking-language', band: '5–16m' },
  { id: 'first-word', name: 'First word', category: 'talking-language', band: '7–20m' },
  { id: 'first-sentence', name: 'First sentence / two-word phrase', category: 'talking-language', band: '14m–3y' },
  { id: 'says-own-name', name: 'Says own name', category: 'talking-language', band: '16m–3.5y' },
  { id: 'first-question', name: 'First question asked', category: 'talking-language', band: '18m–4y' },
  { id: 'first-joke', name: 'First joke / deliberate silliness', category: 'talking-language', band: '2–6y' },
  { id: 'counts-to-ten', name: 'Counts to ten', category: 'talking-language', band: '2–6y' },
  { id: 'knows-alphabet', name: 'Knows the alphabet', category: 'talking-language', band: '2.5–7y' },
  { id: 'second-language-word', name: 'First word in second language', category: 'talking-language', band: '7m–8y' },
  { id: 'sings-song', name: 'Sings a whole song', category: 'talking-language', band: '2–6y' },

  // ── Eating ───────────────────────────────────────────────────────────
  { id: 'first-solid-food', name: 'First solid food', category: 'eating', band: '3–9m' },
  { id: 'feeds-self', name: 'Feeds self with hands/spoon', category: 'eating', band: '6–24m' },
  { id: 'drinks-from-cup', name: 'Drinks from a cup', category: 'eating', band: '6–20m' },
  { id: 'uses-fork-spoon', name: 'Uses fork/spoon properly', category: 'eating', band: '12m–3.5y' },
  { id: 'last-bottle', name: 'Weaning / last bottle or nursing', category: 'eating', band: '6m–3.5y' },
  { id: 'tries-notable-food', name: 'Memorable first food', category: 'eating', band: '3m–10y' },

  // ── Sleep & growing up ───────────────────────────────────────────────
  { id: 'sleeps-through-night', name: 'Sleeps through the night', category: 'sleep-growing-up', band: '2m–3y' },
  { id: 'own-room', name: 'First night in own room', category: 'sleep-growing-up', band: '3m–4y' },
  { id: 'big-kid-bed', name: 'Moves to big-kid bed', category: 'sleep-growing-up', band: '14m–5y' },
  { id: 'first-tooth', name: 'First tooth', category: 'sleep-growing-up', band: '3–14m' },
  { id: 'loses-first-tooth', name: 'Loses first tooth', category: 'sleep-growing-up', band: '4.5–8.5y' },

  // ── Self-care & independence ─────────────────────────────────────────
  { id: 'potty-trained', name: 'Potty trained / diaper-free', category: 'self-care-independence', band: '16m–4.5y' },
  { id: 'dresses-self', name: 'Dresses themselves', category: 'self-care-independence', band: '2–6y' },
  { id: 'brushes-teeth-self', name: 'Brushes own teeth', category: 'self-care-independence', band: '18m–6y' },
  { id: 'ties-shoelaces', name: 'Ties shoelaces', category: 'self-care-independence', band: '4–9y' },
  { id: 'first-chore', name: 'First chore / helping task', category: 'self-care-independence', band: '18m–8y' },
  { id: 'stays-with-sitter', name: 'First time with babysitter', category: 'self-care-independence', band: '1m–4y' },

  // ── Social & emotional ───────────────────────────────────────────────
  { id: 'waves-bye', name: 'Waves bye-bye', category: 'social-emotional', band: '6–16m' },
  { id: 'blows-kiss', name: 'Blows a kiss', category: 'social-emotional', band: '8m–2.5y' },
  { id: 'first-friend', name: 'First friend', category: 'social-emotional', band: '1–6y' },
  { id: 'says-i-love-you', name: 'First "I love you"', category: 'social-emotional', band: '14m–4.5y' },
  { id: 'meets-sibling', name: 'Meets sibling for the first time', category: 'social-emotional', band: 'any' },
  { id: 'meets-grandparents', name: 'Meets grandparent for the first time', category: 'social-emotional', band: '0–3y' },

  // ── School & learning ────────────────────────────────────────────────
  { id: 'first-day-daycare', name: 'First day of daycare/nursery', category: 'school-learning', band: '2m–4y' },
  { id: 'first-day-preschool', name: 'First day of preschool', category: 'school-learning', band: '2–5.5y' },
  { id: 'first-day-school', name: 'First day of school', category: 'school-learning', band: '4–8y' },
  { id: 'writes-name', name: 'Writes own name', category: 'school-learning', band: '3–7y' },
  { id: 'first-drawing', name: 'First recognizable drawing', category: 'school-learning', band: '18m–5y' },
  { id: 'learns-to-read', name: 'Reads first word/book', category: 'school-learning', band: '3.5–8y' },
  { id: 'graduation', name: 'Preschool/kinder graduation', category: 'school-learning', band: '4–8y' },
  { id: 'first-medal', name: 'First medal / trophy / prize', category: 'school-learning', band: '2–12y' },

  // ── Firsts & experiences ─────────────────────────────────────────────
  { id: 'first-bath', name: 'First bath', category: 'firsts-experiences', band: '0–2m' },
  { id: 'first-haircut', name: 'First haircut', category: 'firsts-experiences', band: '3m–4y' },
  { id: 'first-beach', name: 'First time at the beach', category: 'firsts-experiences', band: '0–6y' },
  { id: 'first-pool', name: 'First swim / pool visit', category: 'firsts-experiences', band: '0–5y' },
  { id: 'first-snow', name: 'First snow', category: 'firsts-experiences', band: '0–7y' },
  { id: 'first-rain-play', name: 'First time playing in the rain', category: 'firsts-experiences', band: '0–6y' },
  { id: 'first-plane', name: 'First plane flight', category: 'firsts-experiences', band: 'any' },
  { id: 'first-trip', name: 'First trip / vacation', category: 'firsts-experiences', band: 'any' },
  { id: 'first-abroad', name: 'First time abroad', category: 'firsts-experiences', band: 'any' },
  { id: 'first-camping', name: 'First camping trip', category: 'firsts-experiences', band: '1–12y' },
  { id: 'first-sleepover', name: 'First sleepover away from parents', category: 'firsts-experiences', band: '2–11y' },
  { id: 'first-pet', name: 'Meets first family pet', category: 'firsts-experiences', band: 'any' },
  // `birthday` recurs (birthday/1, birthday/2, ...) -- see the deterministic
  // resolution note at the top of this file and analyze-memory-core.ts.
  { id: 'birthday', name: 'Birthday (every year, detail = age turned)', category: 'firsts-experiences', band: 'any' },
  { id: 'first-holiday-season', name: 'First Christmas / Hanukkah / holiday', category: 'firsts-experiences', band: '0–14m' },
  { id: 'first-halloween', name: 'First Halloween / costume', category: 'firsts-experiences', band: '0–2y' },
  { id: 'first-tooth-fairy', name: "First tooth-fairy visit", category: 'firsts-experiences', band: '4.5–8.5y' },
  { id: 'first-dentist', name: 'First dentist visit', category: 'firsts-experiences', band: '6m–5y' },
];

export const MILESTONES: readonly MilestoneDefinition[] = RAW_ENTRIES.map((entry) => ({
  ...entry,
  ageBandMonths: parseAgeBandMonths(entry.band),
}));

export const MILESTONE_IDS: ReadonlySet<string> = new Set(MILESTONES.map((entry) => entry.id));

export function getMilestoneById(id: string): MilestoneDefinition | undefined {
  return MILESTONES.find((entry) => entry.id === id);
}

/**
 * The catalog entries in-band (or `any`-band) for a child of `ageMonths` at
 * the memory date -- the pre-call filter the plan brief describes ("the
 * child's age on memory_date filters the catalog to in-band entries before
 * the model call"). `ageMonths === null` (unknown DOB, or an adult/no
 * tagged member) returns only the `any`-band entries.
 */
export function milestonesInBand(ageMonths: number | null): MilestoneDefinition[] {
  return MILESTONES.filter((entry) => {
    if (entry.ageBandMonths.min === null || entry.ageBandMonths.max === null) {
      return true;
    }
    if (ageMonths === null) {
      return false;
    }
    return ageMonths >= entry.ageBandMonths.min && ageMonths <= entry.ageBandMonths.max;
  });
}

export function formatMilestoneCatalogForPrompt(entries: readonly MilestoneDefinition[]): string {
  return entries.map((entry) => `${entry.id} — ${entry.name} (${entry.band})`).join('\n');
}
