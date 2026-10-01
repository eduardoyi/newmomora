/**
 * Everything-scope (multi-year) outline + manifest behaviour --
 * docs/plans/memory-book-everything-phase2.md §0, 2.2, 2.4-2.7 (worker side).
 * Drives `runOutlineStage` + `buildBookManifest` for a seeded synthetic
 * 4-year context (synthetic text only; DOB 2022-10-23, 600 eligible memories,
 * 17 portraits, 23 milestones incl. birthday ones) with the OpenAI call
 * mocked, like outline.golden.test.ts does. The age_year / calendar_year
 * "unchanged" proof is outline.golden.test.ts itself (its snapshots must stay
 * green, untouched).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectMemoryIdsFromElements,
  mergeCandidateMemoryIds,
} from '../../../supabase/functions/_shared/memory-book-manifest.ts';
import { computeAgeYearChapters } from '../src/chapters';
import { buildBookManifest } from '../src/manifest';
import { runOutlineStage } from '../src/outline';
import type {
  DbFamilyMemberRow,
  DbMediaRow,
  DbMemoryRow,
  DbMilestoneRow,
  DbPortraitVersionRow,
  DbTagRow,
  Env,
  GenerationContextResponse,
} from '../src/types';

const chatCalls: Array<Record<string, unknown>> = [];
let nextResponse: (body: Record<string, unknown>) => string = () => '{}';

vi.mock('../src/openai', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/openai')>();
  return {
    ...original,
    callOpenAiChat: vi.fn(async (_env: Env, body: Record<string, unknown>) => {
      chatCalls.push(body);
      return { content: nextResponse(body), usage: { prompt_tokens: 1234, completion_tokens: 567 } };
    }),
  };
});

// ---------------------------------------------------------------------------
// Seeded synthetic context
// ---------------------------------------------------------------------------

type Rng = () => number;
function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const LOREM = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore').split(' ');
function lorem(rng: Rng, chars: number): string {
  let out = '';
  while (out.length < chars) out += (out ? ' ' : '') + pick(rng, LOREM);
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

const DOB = '2022-10-23';
const WINDOW_START = '2022-10-23';
const WINDOW_END_EXCLUSIVE = '2026-10-01';
const CHILD_ID = 'family-member-child-0001';
const OTHER_MEMBER_ID = 'family-member-other-0002';
/** 48 months: 2022-10 .. 2026-09 */
const MONTHS: string[] = Array.from({ length: 48 }, (_, i) => `${2022 + Math.floor((9 + i) / 12)}-${pad2(((9 + i) % 12) + 1)}`);
const TOPICS_POOL = [
  'beach', 'park-playground', 'mealtime', 'friends', 'travel', 'bath', 'bedtime-sleep',
  'pretend-play', 'music', 'pets', 'grandparents', 'outdoors', 'art-crafts', 'books-reading', 'cooking',
  // Smaller clusters (< a quarter-sized backbone segment) so themed spreads win single placement, like real data.
  'topic-a', 'topic-b', 'topic-c', 'topic-d', 'topic-e', 'topic-f', 'topic-g', 'topic-h', 'topic-i', 'topic-j', 'topic-k', 'topic-l', 'topic-m',
] as const;
const FIRSTS_IDS = [
  'first-steps', 'first-word', 'crawling', 'first-solid-food', 'first-laugh', 'climbing', 'first-haircut',
  'first-swim', 'first-tooth', 'rolling-over', 'sitting-up', 'first-trip', 'first-bike', 'first-day-school', 'first-sentence',
] as const;

/** `textOnlyHeavy` (default, used by every assertion): 15% text-only memories. `realistic`: ~2% text-only (28% illustrated). `photoHeavy`: 72% photo, 8% video,
 * 17% illustrated, 3% text-only (closest to the WP-C fixture). Only the env-gated SEAM_MIX export uses the non-default mixes. */
function buildContext(options: { dob: string | null; mix?: 'textOnlyHeavy' | 'realistic' | 'photoHeavy' } = { dob: DOB }): GenerationContextResponse {
  // photo / video / illustrated cumulative thresholds; the remainder is text-only.
  const [photoBelow, videoBelow, illustratedBelow] =
    options.mix === 'realistic' ? [0.6, 0.7, 0.98] : options.mix === 'photoHeavy' ? [0.72, 0.8, 0.97] : [0.6, 0.7, 0.85];
  const rng = makeRng(0xe0e70001);
  const members: DbFamilyMemberRow[] = [
    { id: CHILD_ID, name: 'Nova', date_of_birth: options.dob, nicknames: [] },
    { id: OTHER_MEMBER_ID, name: 'Sibling Two', date_of_birth: '2019-05-05', nicknames: [] },
    { id: 'family-member-parent-0003', name: 'Parent Three', date_of_birth: '1990-01-01', nicknames: ['Pa'] },
  ];
  const memories: DbMemoryRow[] = [];
  const media: DbMediaRow[] = [];
  const tags: DbTagRow[] = [];
  const milestones: DbMilestoneRow[] = [];
  const engagementCounts: Record<string, number> = {};

  for (let i = 0; i < 640; i++) {
    const monthIdx = Math.min(47, Math.floor((i / 640) * 48 + rng() * 1.2));
    const month = MONTHS[monthIdx];
    const day = month === '2022-10' ? randInt(rng, 24, 28) : randInt(rng, 1, 28);
    const id = `mem-${String(i).padStart(4, '0')}`;
    const kind = rng();
    // Topics drift over time so themed candidates have different centres of gravity.
    const topics = rng() < 0.75 ? [TOPICS_POOL[(Math.floor(monthIdx / 2) + randInt(rng, 0, 3)) % TOPICS_POOL.length]] : [];
    const row: DbMemoryRow = {
      id,
      content: null,
      memory_date: `${month}-${pad2(day)}`,
      memory_type: 'media',
      emotion: rng() < 0.4 ? pick(rng, ['funny', 'tender', 'joy', 'mischief']) : null,
      topics,
      topic_details: {},
      illustration_key: null,
    };
    if (kind < photoBelow) {
      if (rng() < 0.35) row.content = lorem(rng, randInt(rng, 24, 180));
      media.push({
        id: `media-${id}-0`, memory_id: id, object_key: `orig/${id}.jpg`, preview_object_key: `preview/${id}.jpg`,
        content_type: 'image/jpeg', position: 0, duration_ms: null, aspect_ratio: pick(rng, [0.75, 1, 1.33, 1.78, 2]),
      });
    } else if (kind < videoBelow) {
      media.push({
        id: `media-${id}-0`, memory_id: id, object_key: `orig/${id}.mp4`, preview_object_key: `poster/${id}.webp`,
        content_type: 'video/mp4', position: 0, duration_ms: 12000, aspect_ratio: 1.78,
      });
    } else if (kind < illustratedBelow) {
      row.memory_type = 'text_illustration';
      row.content = lorem(rng, randInt(rng, 40, 300));
      row.illustration_key = `illustrations/${id}.webp`;
    } else {
      row.memory_type = 'text_only';
      row.content = lorem(rng, randInt(rng, 30, 400));
    }
    memories.push(row);

    // 40 memories (i % 16 === 15) are tagged ONLY to another member -> excluded; the other 600 are eligible.
    if (i % 16 === 15) tags.push({ memory_id: id, family_member_id: OTHER_MEMBER_ID });
    else if (rng() < 0.7) tags.push({ memory_id: id, family_member_id: CHILD_ID });
    if (rng() < 0.4) engagementCounts[id] = randInt(rng, 1, 10);
  }

  // 23 milestone rows: 15 distinct "firsts" on 15 distinct memories + 8 birthday rows (ages 1-4, twice each).
  const eligible = memories.filter((m) => !tags.some((t) => t.memory_id === m.id && t.family_member_id === OTHER_MEMBER_ID));
  FIRSTS_IDS.forEach((milestoneId, i) => {
    const m = eligible[20 + i * 37];
    milestones.push({
      memory_id: m.id, family_member_id: CHILD_ID, milestone_id: milestoneId, detail: null,
      out_of_band: i % 5 === 0, status: i % 3 === 0 ? 'confirmed' : 'candidate',
    });
  });
  [1, 1, 2, 2, 3, 3, 4, 4].forEach((age, i) => {
    const m = eligible[5 + i * 61];
    milestones.push({ memory_id: m.id, family_member_id: CHILD_ID, milestone_id: 'birthday', detail: String(age), out_of_band: false, status: 'confirmed' });
  });

  const portraitVersions: DbPortraitVersionRow[] = Array.from({ length: 17 }, (_, i) => {
    const monthsIn = Math.round((i * 47) / 16);
    return {
      id: `portrait-${i}`,
      reference_date: `${MONTHS[monthsIn]}-15`,
      illustrated_profile_key: `portraits/illustrated-${i}.webp`,
      profile_picture_key: `portraits/source-${i}.jpg`,
    };
  });

  return {
    book: {
      id: 'book-everything-0001',
      familyId: 'family-synthetic-0001',
      childId: CHILD_ID,
      scopeKind: 'everything',
      windowStart: WINDOW_START,
      windowEndExclusive: WINDOW_END_EXCLUSIVE,
      scopeLabel: 'Everything',
      pageBudget: 122,
    },
    child: { id: CHILD_ID, name: 'Nova', dateOfBirth: options.dob },
    familyName: 'The Synthetic Family',
    configuredLanguage: 'en',
    memories,
    media,
    tags,
    milestones,
    engagementCounts,
    familyMembers: members,
    portraitVersions,
    languageEvidenceCaptions: [],
  };
}

/** Fixed, schema-valid LLM response derived from the prompt: up to 14 themed spreads (>= 12 candidates), each with a
 * deliberately useless insert index (the worker must ignore it), plus titles for every flagged month. */
function buildLlmResponse(context: GenerationContextResponse, body: Record<string, unknown>, spreadSize: (i: number) => number): string {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const user = messages[1].content;
  const candidates = [...user.matchAll(/^- candidate_id="([^"]+)" \[[^\]]+\] \("[^"]*"\) -- \d+ member memories: (.*)$/gm)].map((m) => ({
    id: m[1],
    memberIds: m[2].split(', ').filter(Boolean),
  }));
  const flagged = [...user.matchAll(/^\[\d+\] (\S+) "[^"]*"(?: \[chapter \d+\])? -- \d+ memories -- FLAGGED: (birth month|birthday (month|period) \(turns (\d+))/gm)].map((m) => ({
    id: m[1],
    title: m[4] ? (m[3] === 'period' ? `When you turned ${m[4]}` : `The month you turned ${m[4]}`) : 'The month you were born',
  }));
  const firstsRows = [...user.matchAll(/^- memory_id="([^"]+)" milestone_id="([^"]+)"/gm)].map((m) => ({ memoryId: m[1], milestoneId: m[2] }));
  const offered = new Set([...user.matchAll(/^(mem-\d{4}) \| /gm)].map((m) => m[1]));
  const photoIds = context.media.filter((r) => r.content_type.startsWith('image/') && offered.has(r.memory_id)).map((r) => r.memory_id);

  const spreads = candidates.slice(0, 14).map((candidate, i) => ({
    candidate_id: candidate.id,
    insert_after_segment_index: i % 2 === 0 ? 0 : 1,
    title: `Synthetic spread title ${i + 1}`,
    title_mode: 'descriptive',
    kicker: `synthetic kicker ${i + 1}`,
    // The model selects a SUBSET of a candidate's members; single placement keeps a memory in the smaller of its spreads.
    memory_ids: candidate.memberIds.slice(0, spreadSize(i)),
    rationale: {},
  }));

  return JSON.stringify({
    language: 'en',
    spreads,
    backbone_highlights: [],
    hero_candidates: [...new Set(photoIds)].slice(3, 8),
    cover_candidates: [...new Set(photoIds)].slice(10, 13),
    panorama_candidates: [],
    segment_titles: Object.fromEntries(flagged.map((f) => [f.id, f.title])),
    firsts_title: 'Big and small victories',
    firsts_milestones: firstsRows.map((row, i) => ({ memory_id: row.memoryId, milestone_id: row.milestoneId, warm_name: `Synthetic warm name ${i + 1}` })),
    dedication: 'Synthetic dedication body without a salutation. Lorem ipsum dolor sit amet.',
    back_cover_line: 'A synthetic line for the back cover.',
    editorial_note: 'Synthetic internal editorial note.',
  });
}

async function runEverything(
  context: GenerationContextResponse,
  spreadSize: (i: number) => number = (i) => 6 + (i % 5),
  originalDimensionsByMediaId?: Record<string, { width: number; height: number }>,
) {
  chatCalls.length = 0;
  nextResponse = (body) => buildLlmResponse(context, body, spreadSize);
  const result = await runOutlineStage({} as Env, context);
  const referencedMemoryIds = mergeCandidateMemoryIds(
    collectMemoryIdsFromElements(result.elements),
    result.parsed.panoramaCandidates,
    result.parsed.heroCandidates,
    result.parsed.coverCandidates,
  );
  const manifest = buildBookManifest({
    context,
    memoryIds: referencedMemoryIds,
    outlineRunId: 'everything-run',
    language: 'en',
    shareTokensByMemoryId: new Map(),
    originalDimensionsByMediaId,
  });
  const messages = chatCalls[0].messages as Array<{ role: string; content: string }>;
  return { result, manifest, system: messages[0].content, user: messages[1].content };
}

const ord = (monthKey: string) => Number(monthKey.slice(0, 4)) * 12 + Number(monthKey.slice(5, 7));
const backboneMonths = (elementId: string) => elementId.slice('backbone:'.length).split('_');

beforeEach(() => {
  chatCalls.length = 0;
});

describe('Everything outline + manifest (synthetic 4-year context)', () => {
  it('sanity: the synthetic context matches the brief', () => {
    const context = buildContext();
    expect(context.memories.length - context.tags.filter((t) => t.family_member_id === OTHER_MEMBER_ID).length).toBe(600);
    expect(context.portraitVersions).toHaveLength(17);
    expect(context.milestones).toHaveLength(23);
  });

  it('emits one chapter per age-year, in order, with the DOB-derived month bounds, each right before its first backbone segment', async () => {
    const { result } = await runEverything(buildContext());
    const expected = computeAgeYearChapters(DOB, '2022-10', '2026-09');
    expect(expected.map((c) => c.ageYear)).toEqual([1, 2, 3, 4]);

    const chapters = result.elements.filter((e) => e.kind === 'chapter');
    expect(chapters.map((c) => c.chapter)).toEqual(expected);
    expect(chapters.map((c) => c.id)).toEqual(['chapter:1', 'chapter:2', 'chapter:3', 'chapter:4']);
    expect(chapters.map((c) => c.title)).toEqual(['Year One', 'Year Two', 'Year Three', 'Year Four']);
    expect(chapters.every((c) => c.memoryIds.length === 0 && typeof c.subtitle === 'string' && c.subtitle.length > 0)).toBe(true);

    // The chapter-1 opener precedes every other content element (right after through-the-years)...
    const ids = result.elements.map((e) => e.id);
    expect(ids.slice(0, 4)).toEqual(['cover', 'title', 'through-the-years', 'chapter:1']);
    // ...and each chapter's next backbone element is a segment inside that chapter's bounds; the backbone element
    // just before a later chapter opener (skipping themed spreads) belongs to the previous chapter.
    chapters.forEach((chapter, i) => {
      const at = ids.indexOf(chapter.id);
      const nextBackbone = result.elements.slice(at + 1).find((e) => e.kind === 'backbone')!;
      const firstMonth = backboneMonths(nextBackbone.id)[0];
      expect(firstMonth >= chapter.chapter!.startMonth && firstMonth <= chapter.chapter!.endMonth).toBe(true);
      if (i > 0) {
        const prevBackbone = [...result.elements.slice(0, at)].reverse().find((e) => e.kind === 'backbone')!;
        const prevLast = backboneMonths(prevBackbone.id).slice(-1)[0];
        expect(prevLast <= chapters[i - 1].chapter!.endMonth).toBe(true);
        // Only themed spreads may sit between the previous backbone segment and this opener.
        const between = result.elements.slice(result.elements.indexOf(prevBackbone) + 1, at);
        expect(between.every((e) => e.kind === 'themed')).toBe(true);
      }
    });
  });

  it('emits no birthday elements, keeps birthday-milestone memories in the backbone, and flags birthday months deterministically from the DOB', async () => {
    const context = buildContext();
    const { result, user } = await runEverything(context);
    expect(result.elements.some((e) => e.kind === 'birthday')).toBe(false);
    expect(result.elements.some((e) => e.id.startsWith('birthday-'))).toBe(false);

    const backboneMemoryIds = new Set(result.elements.filter((e) => e.kind === 'backbone').flatMap((e) => e.memoryIds));
    const birthdayMemoryIds = context.milestones.filter((m) => m.milestone_id === 'birthday').map((m) => m.memory_id);
    expect(birthdayMemoryIds).toHaveLength(8);
    for (const id of birthdayMemoryIds) {
      expect(backboneMemoryIds.has(id) || result.elements.some((e) => e.kind !== 'backbone' && e.memoryIds.includes(id))).toBe(true);
    }
    expect(user).not.toContain('Birthdays in scope');
    expect(user).toMatch(/FLAGGED: birth month/);
    // Quarter-block sections span several months, so a birthday flag on one uses PERIOD wording; a block holding a
    // single month with memories keeps the single-month wording. Either way each age is flagged exactly once.
    for (const age of [1, 2, 3]) expect(user).toMatch(new RegExp(`FLAGGED: birthday (month|period) \\(turns ${age}[;)]`));
    expect(user).not.toContain('turns 4');
    const flaggedLines = user.split('\n').filter((l) => l.includes('FLAGGED: birthday'));
    for (const line of flaggedLines) {
      const label = line.match(/^\[\d+\] \S+ "([^"]*)"/)![1];
      const multiMonth = /[–-]/.test(label);
      expect(line.includes('FLAGGED: birthday period')).toBe(multiMonth);
      if (multiMonth) expect(line).toContain('Cuando cumpliste');
    }
  });

  it('caps Firsts at 6 memories, chronological, and lists only those in the prompt', async () => {
    const context = buildContext();
    const { result, user } = await runEverything(context);
    const firsts = result.elements.find((e) => e.kind === 'firsts')!;
    expect(firsts.title).toBe('Big and small victories');
    expect(firsts.memoryIds.length).toBeGreaterThan(0);
    expect(firsts.memoryIds.length).toBeLessThanOrEqual(6);
    const dateOf = new Map(context.memories.map((m) => [m.id, m.memory_date]));
    const dates = firsts.memoryIds.map((id) => dateOf.get(id)!);
    expect(dates).toEqual([...dates].sort());

    const promptRows = [...user.matchAll(/^- memory_id="([^"]+)" milestone_id="/gm)].map((m) => m[1]);
    expect(new Set(promptRows)).toEqual(new Set(firsts.memoryIds));
    expect(user).toContain('Firsts (non-birthday explicit milestones) in scope: 6');
    // Every non-selected milestone memory stays in the book's backbone, not Firsts.
    const milestoneMemoryIds = new Set(context.milestones.filter((m) => m.milestone_id !== 'birthday').map((m) => m.memory_id));
    expect(milestoneMemoryIds.size).toBe(15);
  });

  it('admits <= 8 themed spreads (budget floor(min(600,122)/15)), <= 2 per chapter, none adjacent, placed by the worker (not the AI index)', async () => {
    const { result, user } = await runEverything(buildContext());
    const candidateCount = [...user.matchAll(/^- candidate_id="/gm)].length;
    expect(candidateCount).toBeGreaterThanOrEqual(12);

    const themed = result.elements.filter((e) => e.kind === 'themed');
    expect(themed.length).toBeGreaterThan(0);
    expect(themed.length).toBeLessThanOrEqual(8);
    expect(result.violations.some((v) => v.kind === 'themed_spread_dissolved_budget')).toBe(true);

    // None adjacent: two themed elements never sit back to back.
    result.elements.forEach((e, i) => {
      if (e.kind === 'themed') expect(result.elements[i + 1]?.kind).not.toBe('themed');
    });

    // <= 2 per chapter (a themed spread belongs to the chapter opened before it).
    const perChapter = new Map<string, number>();
    let currentChapter = 'none';
    for (const e of result.elements) {
      if (e.kind === 'chapter') currentChapter = e.id;
      if (e.kind === 'themed') perChapter.set(currentChapter, (perChapter.get(currentChapter) ?? 0) + 1);
    }
    for (const count of perChapter.values()) expect(count).toBeLessThanOrEqual(2);

    // Dissolved spreads lose nothing: every eligible memory is still placed somewhere exactly once.
    const placed = result.elements.flatMap((e) => e.memoryIds);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('with every candidate surviving single placement (14 spreads), still admits <= 8, <= 2 per chapter, none adjacent', async () => {
    const { result } = await runEverything(buildContext(), () => 3);
    const themed = result.elements.filter((e) => e.kind === 'themed');
    expect(themed.length).toBeGreaterThanOrEqual(3);
    expect(themed.length).toBeLessThanOrEqual(8);
    const dissolvedForBudget = result.violations.filter((v) => v.kind === 'themed_spread_dissolved_budget');
    expect(dissolvedForBudget.length).toBeGreaterThanOrEqual(14 - 8);
    result.elements.forEach((e, i) => {
      if (e.kind === 'themed') expect(result.elements[i + 1]?.kind).not.toBe('themed');
    });
    const perChapter = new Map<string, number>();
    let currentChapter = 'none';
    for (const e of result.elements) {
      if (e.kind === 'chapter') currentChapter = e.id;
      if (e.kind === 'themed') perChapter.set(currentChapter, (perChapter.get(currentChapter) ?? 0) + 1);
    }
    for (const count of perChapter.values()) expect(count).toBeLessThanOrEqual(2);
    // Dissolved members returned to the backbone: nothing placed twice.
    const placed = result.elements.flatMap((e) => e.memoryIds);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('keeps every backbone segment within a quarter and inside one chapter', async () => {
    const { result } = await runEverything(buildContext());
    const chapters = result.elements.filter((e) => e.kind === 'chapter').map((e) => e.chapter!);
    const backbone = result.elements.filter((e) => e.kind === 'backbone');
    expect(backbone.length).toBeGreaterThan(16);
    for (const element of backbone) {
      const months = backboneMonths(element.id);
      expect(ord(months[months.length - 1]) - ord(months[0]) + 1).toBeLessThanOrEqual(3);
      const owning = new Set(months.map((m) => chapters.findIndex((c) => m >= c.startMonth && m <= c.endMonth)));
      expect(owning.size).toBe(1);
      expect([...owning][0]).toBeGreaterThanOrEqual(0);
    }
  });

  it('quarter blocks (phase 2b fix A): 3-month blocks per chapter from the chapter start, the birthday month is its own 1-month segment, sparse blocks are not merged', async () => {
    const context = buildContext();
    const { result } = await runEverything(context);
    const chapters = result.elements.filter((e) => e.kind === 'chapter').map((e) => e.chapter!);
    const backbone = result.elements.filter((e) => e.kind === 'backbone');
    // Every segment lies inside ONE fixed block counted from its chapter's start month (calendar-aligned).
    for (const element of backbone) {
      const months = backboneMonths(element.id);
      const chapter = chapters.find((c) => months[0] >= c.startMonth && months[0] <= c.endMonth)!;
      const blockStart = ord(chapter.startMonth) + Math.floor((ord(months[0]) - ord(chapter.startMonth)) / 3) * 3;
      expect(months.every((m) => ord(m) >= blockStart && ord(m) <= blockStart + 2)).toBe(true);
    }
    // Chapter 1 (2022-10..2023-10) is 13 months -> blocks 3,3,3,3,1: its birthday month (2023-10) is a lone 1-month
    // segment, flagged by the DOB birthday flag. (12-month chapters cut 3,3,3,3: their birthday month closes a block.)
    const birthdaySegment = backbone.find((e) => backboneMonths(e.id).includes(chapters[0].endMonth))!;
    expect(backboneMonths(birthdaySegment.id)).toEqual([chapters[0].endMonth]);
    // The 1-month birthday section is its own segment even though it holds fewer memories than its neighbours (no merging).
    expect(birthdaySegment.memoryIds.length).toBeGreaterThan(0);
  });

  it('themed spreads stay in their chapter (phase 2b fix 3): every member and the placed spread sit in one home chapter', async () => {
    const context = buildContext();
    const { result } = await runEverything(context);
    const chapters = result.elements.filter((e) => e.kind === 'chapter').map((e) => e.chapter!);
    const chapterOf = (id: string) => {
      const month = context.memories.find((m) => m.id === id)!.memory_date.slice(0, 7);
      return chapters.findIndex((c) => month >= c.startMonth && month <= c.endMonth);
    };
    const themed = result.elements.filter((e) => e.kind === 'themed');
    expect(themed.length).toBeGreaterThan(0);

    let currentChapterElement = -1;
    const placedChapterBySpread = new Map<string, number>();
    for (const e of result.elements) {
      if (e.kind === 'chapter') currentChapterElement += 1;
      if (e.kind === 'themed') placedChapterBySpread.set(e.id, currentChapterElement);
    }
    for (const e of themed) {
      const memberChapters = new Set(e.memoryIds.map(chapterOf));
      expect(memberChapters.size).toBe(1);
      expect(e.memoryIds.length).toBeGreaterThanOrEqual(3);
      // The element sits inside its members' chapter in the final reading order (between that chapter's opener and the next).
      expect(placedChapterBySpread.get(e.id)).toBe([...memberChapters][0]);
    }
    // The chapter-blind AI membership forces a real cross-chapter pull-back (not a vacuous pass).
    const outOfChapter = result.violations.filter((v) => v.kind === 'themed_spread_out_of_chapter');
    expect(outOfChapter.length).toBeGreaterThan(0);
    expect(outOfChapter.every((v) => / \d+ moved$| dissolved$/.test(v.detail))).toBe(true);
    // Nothing is lost: still exactly-once placement.
    const placed = result.elements.flatMap((e) => e.memoryIds);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('samples <= 6 portraits (first + last kept), sets scope kind "everything", and feeds the sampled count to the prompt', async () => {
    const context = buildContext();
    const { manifest, user } = await runEverything(context);
    expect(manifest.scope.kind).toBe('everything');
    expect(manifest.portraits.length).toBeLessThanOrEqual(6);
    expect(manifest.portraits.length).toBeGreaterThanOrEqual(2);
    const dates = manifest.portraits.map((p) => p.date);
    expect(dates[0]).toBe(context.portraitVersions[0].reference_date);
    expect(dates[dates.length - 1]).toBe(context.portraitVersions[16].reference_date);
    expect(user).toContain(`Through-the-years portraits in scope: ${manifest.portraits.length}`);
  });

  it('sends the MULTI-YEAR system prompt block and a CHAPTERS block with tagged segments', async () => {
    const { system, user } = await runEverything(buildContext());
    expect(system).toContain('MULTI-YEAR BOOK');
    expect(user).toContain('CHAPTERS (one per age-year');
    expect(user).toContain('- chapter 1: 2022-10 to 2023-10');
    expect(user).toContain('- chapter 4: 2025-11 to 2026-10');
    expect(user).toMatch(/^\[0\] \S+ "[^"]*" \[chapter 1\] -- /m);
  });

  it('with no DOB: no chapters (legacy structure), but the quarter cap and multi-year prompt still apply', async () => {
    const { result, system, user } = await runEverything(buildContext({ dob: null }));
    expect(result.elements.some((e) => e.kind === 'chapter')).toBe(false);
    expect(user).not.toContain('CHAPTERS (');
    expect(system).toContain('MULTI-YEAR BOOK');
    for (const element of result.elements.filter((e) => e.kind === 'backbone')) {
      const months = backboneMonths(element.id);
      expect(ord(months[months.length - 1]) - ord(months[0]) + 1).toBeLessThanOrEqual(3);
    }
  });

  it('year-book prompts do not carry the multi-year block', async () => {
    const context = buildContext();
    const yearContext: GenerationContextResponse = {
      ...context,
      book: { ...context.book, scopeKind: 'calendar_year', windowStart: '2024-01-01', windowEndExclusive: '2025-01-01' },
      memories: context.memories.filter((m) => m.memory_date >= '2024-01-01' && m.memory_date < '2025-01-01'),
    };
    const { system, user } = await runEverything(yearContext);
    expect(system).not.toContain('MULTI-YEAR BOOK');
    expect(user).not.toContain('CHAPTERS (');
  });
});

/**
 * Seam export (WP-F): when SEAM_OUT is set, write this pipeline's real result as a `book_document`-shaped
 * export that book-renderer/scripts/audit-layout.mts accepts, so the worker's output is fitted by the renderer's
 * fitter. Mirrors workflow.ts's publish step (outlineDocument fields + `{ outline, manifest }`). The one thing
 * the test pipeline lacks is the workflow's dimension-measurement step, so the measured original dimensions
 * are SYNTHESIZED here from each photo's stored aspect ratio (4032px long edge, a typical phone photo).
 * Synthetic text only. No-op (skipped) in normal runs.
 */
// No @types/node in this package (workers types only): read env through globalThis and load node:fs/path lazily
// (only reached when SEAM_OUT is set, i.e. under vitest.seam.config.ts's Node pool).
const seamEnv: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe('seam export (env-gated)', () => {
  it.runIf(Boolean(seamEnv.SEAM_OUT))('writes the everything book_document for the renderer audit', async () => {
    const context = buildContext({ dob: DOB, mix: seamEnv.SEAM_MIX === 'realistic' || seamEnv.SEAM_MIX === 'photoHeavy' ? seamEnv.SEAM_MIX : 'textOnlyHeavy' });
    const dims: Record<string, { width: number; height: number }> = {};
    for (const row of context.media) {
      if (!row.content_type.startsWith('image/')) continue;
      const ratio = row.aspect_ratio && row.aspect_ratio > 0 ? row.aspect_ratio : 1.33;
      dims[row.id] = ratio >= 1 ? { width: 4032, height: Math.round(4032 / ratio) } : { width: Math.round(4032 * ratio), height: 4032 };
    }
    const { result, manifest } = await runEverything(context, undefined, dims);
    const outline = {
      runId: 'seam-run',
      child: { id: context.child!.id, name: context.child!.name },
      scope: { type: manifest.scope.kind },
      window: { start: context.book.windowStart, endExclusive: context.book.windowEndExclusive, label: context.book.scopeLabel },
      language: 'en',
      pageEstimate: 0,
      imageCount: 0,
      pageCap: context.book.pageBudget,
      counts: result.counts,
      elements: result.elements,
      heroCandidates: result.parsed.heroCandidates,
      coverCandidates: result.parsed.coverCandidates,
      panoramaCandidates: result.parsed.panoramaCandidates,
      dedication: result.parsed.dedication,
      backCoverLine: result.parsed.backCoverLine,
      internalEditorialNote: result.parsed.internalEditorialNote,
      integrity: { violations: result.violations },
    };
    const coverMemoryId = result.parsed.coverCandidates[0];
    const out = {
      id: 'seam-everything-0001',
      scopeLabel: 'Everything',
      scopeKind: 'everything',
      coverAssetKey: coverMemoryId ? manifest.memories[coverMemoryId]?.assets[0]?.file ?? null : null,
      bookDocument: { outline, manifest },
      edits: null,
    };
    const nodeModules = { fs: 'node:fs', path: 'node:path' };
    const fs = await import(/* @vite-ignore */ nodeModules.fs);
    const path = await import(/* @vite-ignore */ nodeModules.path);
    const target = seamEnv.SEAM_OUT as string;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(out));
    expect(fs.existsSync(target)).toBe(true);
  });
});
