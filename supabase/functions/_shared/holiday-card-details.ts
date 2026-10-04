// Holiday card per-child SPECIFIC details (owner review, round 4: "thin kid
// details — labels are generic ('cuentos', 'parque'); Enzo = likes stories").
// The open labels the analysis wrote are too generic to say who a child is, so
// the letter's concrete detail comes from the memories' own TEXT:
//   1. selectDetailExcerpts: up to 25 share-safe, high-scoring excerpts that
//      tag the child (same scoring and spread as the films);
//   2. buildDetailsPrompt → (one cheap model call, by the caller) →
//      parseDetails: 3–5 concrete things (which costume, which game, a book,
//      a song, an animal, a place they love) as `{detail, memoryIds,
//      recurring}`;
//   3. parseDetails never trusts the model: every detail must appear
//      literally (normalized) in the excerpts it cites, `recurring` is
//      recomputed from how many excerpts really contain it, and a detail that
//      names a person, is sensitive, or is too long is dropped. The counts of
//      extracted / verified / dropped come back for the review page.
//
// Pure: no I/O, no Deno APIs. Production note: computed once per child per
// card and cached with the card, like the voice card.
//
// PII: excerpts and details are memory text; never log them.
import { excerptOf } from './holiday-card-digest.ts';
import { type FilmMilestoneInput, type FilmScope, holidayPool } from './year-film-eligibility.ts';
import { type FilmMemorySource, rankMemories, SHARE_SENSITIVE_TEXT, shareSensitiveIds } from './year-film-script.ts';
import { FRAME_CHECK_MODEL } from './year-film-vision.ts';

/** An extraction task over ≤25 short captions, once per child per card: the
 * cheap model (GPT-6 Luna) like the voice card. */
export const DETAILS_MODEL = FRAME_CHECK_MODEL;

export const DETAIL_EXCERPTS_MAX = 25;
export const DETAIL_EXCERPT_CHARS = 240;
/** A caption needs this much of its own words to be read for details. */
const DETAIL_EXCERPT_MIN_CHARS = 25;
export const DETAILS_MAX = 5;
const DETAIL_MAX_WORDS = 4;
const DETAIL_MAX_CHARS = 40;

export interface DetailExcerpt {
  memoryId: string;
  date: string;
  /** ≤ DETAIL_EXCERPT_CHARS, one line, no links. */
  text: string;
}

/** Up to DETAIL_EXCERPTS_MAX share-safe excerpts that tag `childId`, best
 * first by the films' scoring and spread over the scope. Deterministic. */
export function selectDetailExcerpts(
  memories: FilmMemorySource[],
  milestones: FilmMilestoneInput[],
  options: { childId: string; scope: FilmScope; ownChildIds: string[]; max?: number },
): DetailExcerpt[] {
  const pool = holidayPool(memories, options.scope, shareSensitiveIds(memories, milestones));
  const mine = pool.filter((m) =>
    m.taggedMemberIds.includes(options.childId) &&
    Array.from(excerptOf(m.text, DETAIL_EXCERPT_CHARS)).length >= DETAIL_EXCERPT_MIN_CHARS
  );
  return rankMemories(mine, {
    scope: options.scope,
    milestones,
    ownChildIds: options.ownChildIds,
    n: options.max ?? DETAIL_EXCERPTS_MAX,
    holiday: true,
  })
    .map(({ memory }) => ({ memoryId: memory.id, date: memory.date, text: excerptOf(memory.text, DETAIL_EXCERPT_CHARS) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.memoryId.localeCompare(b.memoryId));
}

// ── Prompt ───────────────────────────────────────────────────────────────

export function buildDetailsSystemPrompt(): string {
  return [
    'You read short captions that parents wrote about their child and pull out the SPECIFIC things that say who this child is, for a family holiday letter.',
    `Return ${3}–${DETAILS_MAX} details: concrete nouns or activities — which costume or character, which game or toy, which book, song or animal, a specific place they love. Prefer things that come up in at least two captions (recurring); if nothing recurs, give the single most vivid specific thing from the best captions.`,
    'Rules:',
    `- "detail" is copied from the captions: the words AS WRITTEN (same language, same spelling), ${DETAIL_MAX_WORDS} words at most, no articles needed. Never translate, paraphrase or invent. Code rejects any detail that is not literally in the captions you cite.`,
    '- "memory_ids" are the caption numbers that contain it. "recurring" is true only if at least two different captions contain it.',
    '- Be specific: a character, a named game, a specific book, a named place. NOT generic categories like "parque", "playa", "cuentos", "comida", "jugar", "familia".',
    '- Only things the CHILD does or loves. If a caption names several people, take only what this child does or has.',
    '- No names of people (not the child, not relatives, not friends). Nothing about health, bath, potty, tantrums, sadness or conflict.',
    'Respond with JSON only: {"details":[{"detail":"...","memory_ids":[1,4],"recurring":true}]}',
  ].join('\n');
}

export function buildDetailsPrompt(childName: string, excerpts: DetailExcerpt[]): { system: string; user: string } {
  const user = [
    `Child: ${childName}`,
    `${excerpts.length} captions that tag ${childName}, oldest first:`,
    ...excerpts.map((e, i) => `[${i + 1}] ${e.text}`),
  ].join('\n');
  return { system: buildDetailsSystemPrompt(), user };
}

export function buildDetailsRequestBody(model: string, system: string, user: string): Record<string, unknown> {
  return {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

// ── Parse + verify ───────────────────────────────────────────────────────

/** A verified specific detail. */
export interface SpecificDetail {
  /** The words as written in the captions. */
  detail: string;
  /** Memories that really contain it (all excerpts, not just the cited ones). */
  memoryIds: string[];
  /** In at least two memories. Recomputed in code. */
  recurring: boolean;
}

export type DetailDropReason =
  | 'bad_shape'
  | 'unknown_id'
  | 'not_in_cited_excerpts'
  | 'too_long'
  | 'names_someone'
  | 'sensitive'
  | 'duplicate';

export interface DetailsResult {
  details: SpecificDetail[];
  /** What the model returned, how many held up, and why the rest did not. */
  extracted: number;
  verified: number;
  dropped: number;
  reasons: Partial<Record<DetailDropReason, number>>;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parses and verifies the model's details against the excerpts it read.
 * `names`: everyone's names (children, nicknames, relatives, surnames) a
 * detail must not carry. Never throws on model output. */
export function parseDetails(raw: string, excerpts: DetailExcerpt[], names: string[]): DetailsResult {
  const reasons: Partial<Record<DetailDropReason, number>> = {};
  const drop = (reason: DetailDropReason) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };
  let list: unknown;
  try {
    list = (JSON.parse(raw) as { details?: unknown })?.details;
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return { details: [], extracted: 0, verified: 0, dropped: 0, reasons: { bad_shape: 1 } };

  const normalized = excerpts.map((e) => ` ${normalize(e.text)} `);
  const namePatterns = names.filter((n) => n.trim().length >= 2).map((n) => new RegExp(`(?<!\\p{L})${escapeRegExp(n.trim())}(?!\\p{L})`, 'iu'));
  const out: SpecificDetail[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const detail = typeof item?.detail === 'string' ? item.detail.replace(/\s+/g, ' ').trim() : '';
    const ids: unknown[] = Array.isArray(item?.memory_ids) ? item.memory_ids : [];
    if (!detail || ids.length === 0) {
      drop('bad_shape');
      continue;
    }
    const cited = ids.map((id) => (typeof id === 'number' && Number.isInteger(id) ? id - 1 : -1));
    if (cited.some((i) => i < 0 || i >= excerpts.length)) {
      drop('unknown_id');
      continue;
    }
    if (Array.from(detail).length > DETAIL_MAX_CHARS || detail.split(' ').length > DETAIL_MAX_WORDS) {
      drop('too_long');
      continue;
    }
    if (namePatterns.some((p) => p.test(detail))) {
      drop('names_someone');
      continue;
    }
    if (SHARE_SENSITIVE_TEXT.test(detail)) {
      drop('sensitive');
      continue;
    }
    const phrase = normalize(detail);
    if (phrase.length < 3 || !cited.some((i) => normalized[i].includes(` ${phrase} `))) {
      drop('not_in_cited_excerpts');
      continue;
    }
    if (seen.has(phrase)) {
      drop('duplicate');
      continue;
    }
    seen.add(phrase);
    const memoryIds = excerpts.filter((_, i) => normalized[i].includes(` ${phrase} `)).map((e) => e.memoryId);
    out.push({ detail, memoryIds, recurring: memoryIds.length >= 2 });
  }
  out.sort((a, b) => Number(b.recurring) - Number(a.recurring) || b.memoryIds.length - a.memoryIds.length || a.detail.localeCompare(b.detail));
  const kept = out.slice(0, DETAILS_MAX);
  const extracted = list.length;
  return {
    details: kept,
    extracted,
    verified: kept.length,
    dropped: extracted - kept.length,
    reasons,
  };
}
