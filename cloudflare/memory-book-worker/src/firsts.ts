/**
 * Firsts selection and the explicit-evidence gate --
 * docs/plans/memory-book-everything-phase2.md §2.6 (D5 Firsts cap) and
 * docs/plans/memory-book-everything-phase2d.md (Phase 2e: the book NEVER
 * asserts a "first" without the parent's own words or a parent
 * confirmation). Pure and deterministic: no env, no IO, no clock.
 * `hasExplicitFirstLanguage` / `gateFirstsMilestones` apply to ALL scopes
 * (year books and Everything); the cap/selection below is Everything-only.
 *
 * A multi-year book holds hundreds of milestone rows; the Firsts spread is
 * capped to the few most meaningful memories, then re-sorted
 * chronologically (the single-year path returns them in memory-id insertion
 * order -- this selection sorts explicitly). Everything not selected stays in
 * the backbone; milestone holders stay protected from cap demotion.
 *
 * Input shapes are structural so `MemoryFeature` (eligibility.ts) satisfies
 * `FirstsMemoryInput` directly: its `milestones` are already the subject
 * child's NON-birthday rows. `status` is the optional milestone status from
 * the bridge (additive, WP-E): absent is treated as a 'candidate'.
 */

/** Max memories on a multi-year Firsts spread (title page + ~2 grid pages;
 * confirm the page cost on the dogfood run). */
export const FIRSTS_MAX_MEMORIES_MULTI_YEAR = 6;

/** The catalog id of the recurring birthday milestone -- never a "first".
 * (`MemoryFeature.milestones` already excludes it; kept as a defensive filter.) */
export const BIRTHDAY_MILESTONE_ID = 'birthday';

const SCORE_PER_CONFIRMED_MILESTONE = 2;
const SCORE_PER_IN_BAND_MILESTONE = 1;
const SCORE_FOR_VISUAL_MEDIA = 2;

export interface FirstsMilestoneInput {
  milestoneId: string;
  outOfBand: boolean;
  /** `'confirmed'` earns the confirmation bonus; anything else, `null` or
   * `undefined` is a plain candidate. */
  status?: string | null;
}

export interface FirstsMemoryInput {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  photoCount: number;
  videoCount: number;
  engagementCount: number;
  milestones: ReadonlyArray<FirstsMilestoneInput>;
}

/**
 * `+2` per confirmed milestone, `+1` per milestone not `out_of_band`, `+2`
 * once if the memory has a photo or video. Birthday milestones are ignored.
 * (A confirmed in-band milestone therefore scores 3.)
 */
export function scoreFirstsMemory(memory: FirstsMemoryInput): number {
  let score = 0;
  for (const milestone of memory.milestones) {
    if (milestone.milestoneId === BIRTHDAY_MILESTONE_ID) continue;
    if (milestone.status === 'confirmed') score += SCORE_PER_CONFIRMED_MILESTONE;
    if (!milestone.outOfBand) score += SCORE_PER_IN_BAND_MILESTONE;
  }
  if (memory.photoCount + memory.videoCount > 0) score += SCORE_FOR_VISUAL_MEDIA;
  return score;
}

/** Date ascending, then id ascending (stable chronological order). */
function compareChronological(a: FirstsMemoryInput, b: FirstsMemoryInput): number {
  return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
}

/**
 * Picks the Firsts memories for a multi-year book and returns their ids in
 * chronological order (date asc, then id asc).
 *
 * 1. Candidates: for each non-birthday `milestone_id`, the EARLIEST memory
 *    holding it (ties on date break on id).
 * 2. Rank candidates by `scoreFirstsMemory` desc, then engagement desc, then
 *    date asc (then id asc, for determinism).
 * 3. Keep the top `maxMemories`, then sort chronologically.
 */
export function selectMultiYearFirsts(
  memories: ReadonlyArray<FirstsMemoryInput>,
  maxMemories: number = FIRSTS_MAX_MEMORIES_MULTI_YEAR,
): string[] {
  const earliestByMilestone = new Map<string, FirstsMemoryInput>();
  for (const memory of memories) {
    for (const milestone of memory.milestones) {
      if (milestone.milestoneId === BIRTHDAY_MILESTONE_ID) continue;
      const current = earliestByMilestone.get(milestone.milestoneId);
      if (!current || compareChronological(memory, current) < 0) {
        earliestByMilestone.set(milestone.milestoneId, memory);
      }
    }
  }

  const candidates = [...new Set(earliestByMilestone.values())];
  const scoreById = new Map(candidates.map((m) => [m.id, scoreFirstsMemory(m)]));

  const ranked = candidates.sort(
    (a, b) =>
      scoreById.get(b.id)! - scoreById.get(a.id)! ||
      b.engagementCount - a.engagementCount ||
      compareChronological(a, b),
  );

  return ranked
    .slice(0, Math.max(0, maxMemories))
    .sort(compareChronological)
    .map((m) => m.id);
}

// ── Explicit-evidence gate (Phase 2e owner rule) ───────────────────────────
//
// Milestone detector rows are over-inferred (a haircut memory tagged
// first-haircut). A memory may sit in the Firsts section for a milestone only
// if (a) the milestone row is parent-`confirmed`, or (b) the memory's OWN text
// contains explicit first-time language. Nothing is inferred from milestone
// ids, photos, dates or the AI.

/** Single words are enough: "por primera vez", "la primera vez", "el primer",
 * "first time", "for the first time", "pela primeira vez" all contain one of
 * these. Matched case/diacritic-insensitively on word boundaries, for the
 * journal languages es / en / pt. */
const EXPLICIT_FIRST_WORDS = [
  'primer',
  'primera',
  'primeros',
  'primeras',
  'first',
  'primeiro',
  'primeira',
  'primeiros',
  'primeiras',
];
const EXPLICIT_FIRST_RE = new RegExp(`\\b(?:${EXPLICIT_FIRST_WORDS.join('|')})\\b`);

function foldForMatch(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** True when the memory's own text explicitly says "first" (es/en/pt). */
export function hasExplicitFirstLanguage(text: string | null | undefined): boolean {
  if (!text) return false;
  return EXPLICIT_FIRST_RE.test(foldForMatch(text));
}

/**
 * The milestones of a memory that may appear in Firsts: every one if the
 * memory's text carries explicit first-time language, otherwise only the
 * parent-`confirmed` ones.
 */
export function gateFirstsMilestones<M extends { status?: string | null }>(
  milestones: ReadonlyArray<M>,
  memoryText: string | null | undefined,
): M[] {
  if (milestones.length === 0) return [];
  if (hasExplicitFirstLanguage(memoryText)) return [...milestones];
  return milestones.filter((m) => m.status === 'confirmed');
}
