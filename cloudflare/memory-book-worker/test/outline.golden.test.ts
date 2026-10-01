/**
 * WP-0 characterization ("golden") tests for the worker's outline + manifest
 * stages — see docs/plans/memory-book-everything-phase2.md §2.8 and "Where
 * single-year behaviour could regress". The worker had NO outline-stage test
 * before this file. These freeze TODAY's `runOutlineStage` +
 * `buildBookManifest` output for synthetic seeded `age_year` and
 * `calendar_year` generation contexts (~300 memories each), with the OpenAI
 * call mocked to a fixed, schema-valid outline response derived
 * deterministically from the prompt the stage built.
 *
 * Phase 2 work packages (A / B1 / B2) change `outline.ts`, `backbone.ts`,
 * `reading-order.ts`, `manifest.ts` and the shared prompt builders; every
 * change there must keep THESE snapshots green for year books (all new
 * behaviour is gated on `scopeKind === 'everything'`). If a snapshot
 * changes, that is a behaviour change for existing book kinds: confirm it is
 * intended before `vitest -u`.
 *
 * What is covered: eligibility/exclusion, the backbone segmentation, special
 * (birth/birthday) segment flags, topic/people/emotion candidates, the
 * prompt text the model would see (system prompt hash; the whole user-prompt
 * header incl. FIRSTS / BACKBONE / CANDIDATES lines verbatim; the MEMORIES
 * block by hash), single placement + dissolve, the final reading order
 * (themed spacing, firsts, birthday spreads), parser violations, and the
 * manifest (scope mapping, portraits, assets incl. original dimensions,
 * milestones, share tokens, per-memory content hashes).
 *
 * What is NOT covered: the cover-verify vision pass, R2 dimension measuring,
 * the workflow/CAS/publish plumbing (workflow.integration.test.ts), the
 * `everything` and `custom_range` scope kinds (still paused / out of scope
 * for this golden; only the `custom` outline-type mapping is asserted), and
 * a real model's response variability.
 *
 * Non-determinism is normalized: `manifest.generatedAt` (a real
 * `new Date()` inside the shared builder) is replaced with a constant.
 * Everything else comes from a seeded PRNG (mulberry32) — no Math.random,
 * no Date.now.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectMemoryIdsFromElements,
  mergeCandidateMemoryIds,
} from '../../../supabase/functions/_shared/memory-book-manifest.ts';
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

// Capture the request body the stage would have sent; the response is a pure function of the prompt + the context.
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
// Seeded synthetic generation context
// ---------------------------------------------------------------------------

type Rng = () => number;

/** mulberry32 — fully deterministic 32-bit PRNG. */
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
function makeUuid(rng: Rng): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rng() * 4)]}${hex(3)}-${hex(12)}`;
}
const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo'
).split(' ');
function lorem(rng: Rng, chars: number): string {
  let out = '';
  while (out.length < chars) out += (out ? ' ' : '') + pick(rng, LOREM);
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}
const pad2 = (n: number) => String(n).padStart(2, '0');
const utcMs = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const isoDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const DAY_MS = 86_400_000;

interface ContextSpec {
  scopeKind: 'age_year' | 'calendar_year';
  seed: number;
  dob: string;
  windowStart: string;
  windowEndExclusive: string;
  scopeLabel: string;
}

const SPECS: Record<'age_year' | 'calendar_year', ContextSpec> = {
  age_year: { scopeKind: 'age_year', seed: 0x0a9e0001, dob: '2023-02-10', windowStart: '2024-02-10', windowEndExclusive: '2025-02-10', scopeLabel: 'Year Two' },
  calendar_year: { scopeKind: 'calendar_year', seed: 0x0ca10002, dob: '2022-07-19', windowStart: '2024-01-01', windowEndExclusive: '2025-01-01', scopeLabel: '2024' },
};

const CHILD_ID = 'family-member-child-0001';
const OTHER_MEMBER_ID = 'family-member-other-0002';
const MEMBERS: DbFamilyMemberRow[] = [
  { id: 'placeholder', name: 'Nova', date_of_birth: null, nicknames: [] },
  { id: OTHER_MEMBER_ID, name: 'Sibling Two', date_of_birth: '2019-05-05', nicknames: [] },
  { id: 'family-member-parent-0003', name: 'Parent Three', date_of_birth: '1990-01-01', nicknames: ['Pa'] },
  { id: 'family-member-grandma-0004', name: 'Grandma Four', date_of_birth: '1960-03-03', nicknames: [] },
  { id: 'family-member-cousin-0005', name: 'Cousin Five', date_of_birth: '2021-09-09', nicknames: [] },
];
const TOPICS_POOL = ['beach', 'park-playground', 'mealtime', 'friends', 'travel', 'bath', 'bedtime-sleep', 'pretend-play'] as const;
const FIRSTS_IDS = ['first-steps', 'first-word', 'crawling', 'first-solid-food', 'first-laugh', 'climbing'] as const;

function buildContext(spec: ContextSpec): GenerationContextResponse {
  const rng = makeRng(spec.seed);
  const startMs = utcMs(spec.windowStart);
  const endMs = utcMs(spec.windowEndExclusive);
  const monthKeys: string[] = [];
  for (let c = new Date(startMs); c.getTime() < endMs; c = new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1))) {
    monthKeys.push(`${c.getUTCFullYear()}-${pad2(c.getUTCMonth() + 1)}`);
  }
  const sparse = new Set([Math.floor(monthKeys.length * 0.3), Math.floor(monthKeys.length * 0.62)]);
  const weights = monthKeys.map((_, i) => (sparse.has(i) ? 0.04 : 0.6 + rng() * 0.8));
  const weightTotal = weights.reduce((a, b) => a + b, 0);

  const members = MEMBERS.map((m, i) => (i === 0 ? { ...m, id: CHILD_ID, date_of_birth: spec.dob } : m));
  const memories: DbMemoryRow[] = [];
  const media: DbMediaRow[] = [];
  const tags: DbTagRow[] = [];
  const milestones: DbMilestoneRow[] = [];
  const engagementCounts: Record<string, number> = {};

  for (let i = 0; i < 300; i++) {
    let roll = rng() * weightTotal;
    let monthIdx = 0;
    for (; monthIdx < weights.length - 1; monthIdx++) {
      roll -= weights[monthIdx];
      if (roll <= 0) break;
    }
    const [my, mm] = monthKeys[monthIdx].split('-').map(Number);
    let dayMs = Date.UTC(my, mm - 1, randInt(rng, 1, 28));
    if (dayMs < startMs) dayMs = startMs + randInt(rng, 0, 3) * DAY_MS;
    if (dayMs >= endMs) dayMs = endMs - (1 + randInt(rng, 0, 3)) * DAY_MS;

    const id = makeUuid(rng);
    const kind = rng();
    const topics = rng() < 0.7 ? [pick(rng, TOPICS_POOL)] : [];
    const emotion = rng() < 0.4 ? pick(rng, ['funny', 'tender', 'joy', 'mischief']) : null;
    const row: DbMemoryRow = {
      id,
      content: null,
      memory_date: isoDate(dayMs),
      memory_type: 'media',
      emotion,
      topics,
      topic_details: {},
      illustration_key: null,
    };
    if (kind < 0.6) {
      // photo(s), 1 in 3 captioned
      if (rng() < 0.35) row.content = lorem(rng, randInt(rng, 24, 180));
      const photoCount = rng() < 0.1 ? randInt(rng, 2, 4) : 1;
      for (let p = 0; p < photoCount; p++) {
        media.push({
          id: `media-${id}-${p}`,
          memory_id: id,
          object_key: `orig/${id}-${p}.jpg`,
          preview_object_key: `preview/${id}-${p}.jpg`,
          content_type: 'image/jpeg',
          position: p,
          duration_ms: null,
          aspect_ratio: pick(rng, [0.75, 1, 1.33, 1.5, 1.78, 2]),
        });
      }
    } else if (kind < 0.7) {
      media.push({
        id: `media-${id}-0`,
        memory_id: id,
        object_key: `orig/${id}-0.mp4`,
        preview_object_key: `poster/${id}-0.webp`,
        content_type: 'video/mp4',
        position: 0,
        duration_ms: randInt(rng, 3000, 40000),
        aspect_ratio: 1.78,
      });
    } else if (kind < 0.85) {
      row.memory_type = 'text_illustration';
      row.content = lorem(rng, randInt(rng, 40, 400));
      row.illustration_key = `illustrations/${id}.webp`;
    } else if (kind < 0.97) {
      row.memory_type = 'text_only';
      row.content = lorem(rng, randInt(rng, 30, 700));
    } else {
      row.memory_type = 'audio';
      row.content = rng() < 0.5 ? lorem(rng, 60) : null;
    }
    memories.push(row);

    // tags: 75% tagged to the child (+ maybe another member), 15% untagged, 10% tagged ONLY to another member (excluded).
    const tagRoll = rng();
    if (tagRoll < 0.75) {
      tags.push({ memory_id: id, family_member_id: CHILD_ID });
      if (rng() < 0.45) tags.push({ memory_id: id, family_member_id: pick(rng, MEMBERS.slice(1)).id });
    } else if (tagRoll >= 0.9) {
      tags.push({ memory_id: id, family_member_id: OTHER_MEMBER_ID });
    }
    if (rng() < 0.45) engagementCounts[id] = randInt(rng, 1, 12);
  }

  // Milestones on child-tagged memories: 9 "firsts" rows, plus birthday rows (age 1 x2 -> dissolves; age 2 x4 -> survives as birthday-2).
  const childTagged = memories.filter((m) => tags.some((t) => t.memory_id === m.id && t.family_member_id === CHILD_ID));
  let cursor = 0;
  // Phase 2e: Firsts require explicit evidence. Every other row is
  // parent-confirmed (qualifies); the rest are detector candidates on lorem
  // text with no first-time language (must NOT become firsts) -- so the
  // golden covers both sides of the gate.
  for (const [i, milestoneId] of [...FIRSTS_IDS, 'first-steps', 'first-word', 'crawling'].entries()) {
    const m = childTagged[cursor];
    cursor += 7;
    milestones.push({
      memory_id: m.id, family_member_id: CHILD_ID, milestone_id: milestoneId, detail: null, out_of_band: false,
      status: i % 2 === 0 ? 'confirmed' : 'candidate',
    });
  }
  for (const age of [1, 1, 2, 2, 2, 2]) {
    const m = childTagged[cursor];
    cursor += 5;
    milestones.push({ memory_id: m.id, family_member_id: CHILD_ID, milestone_id: 'birthday', detail: String(age), out_of_band: false });
  }

  const portraitVersions: DbPortraitVersionRow[] = Array.from({ length: 6 }, (_, i) => ({
    id: `portrait-${i}`,
    reference_date: isoDate(startMs + Math.floor(((endMs - startMs) * i) / 6)),
    illustrated_profile_key: `portraits/illustrated-${i}.webp`,
    profile_picture_key: `portraits/source-${i}.jpg`,
  }));

  return {
    book: {
      id: 'book-synthetic-0001',
      familyId: 'family-synthetic-0001',
      childId: CHILD_ID,
      scopeKind: spec.scopeKind,
      windowStart: spec.windowStart,
      windowEndExclusive: spec.windowEndExclusive,
      scopeLabel: spec.scopeLabel,
      pageBudget: 122,
    },
    child: { id: CHILD_ID, name: 'Nova', dateOfBirth: spec.dob },
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

// ---------------------------------------------------------------------------
// The fixed outline-LLM response (a pure function of prompt + context)
// ---------------------------------------------------------------------------

function buildLlmResponse(context: GenerationContextResponse, body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const user = messages[1].content;
  const memoryById = new Map(context.memories.map((m) => [m.id, m]));

  // Segment ids in prompt order: "[3] 2024-04_2024-05 "April–May 2024" -- 9 memories ..."
  const segments = [...user.matchAll(/^\[(\d+)\] (\S+) "/gm)].map((m) => ({ index: Number(m[1]), id: m[2] }));
  const flaggedSegmentIds = [...user.matchAll(/^\[\d+\] (\S+) "[^"]*" -- \d+ memories -- FLAGGED: (birth month|birthday month \(turns (\d+)\))/gm)].map((m) => ({
    id: m[1],
    title: m[3] ? `The month you turned ${m[3]}` : 'The month you were born',
  }));
  const candidates = [...user.matchAll(/^- candidate_id="([^"]+)" \[[^\]]+\] \("[^"]*"\) -- \d+ member memories: (.*)$/gm)].map((m) => ({
    id: m[1],
    memberIds: m[2].split(', ').filter(Boolean),
  }));
  const firstsRows = [...user.matchAll(/^- memory_id="([^"]+)" milestone_id="([^"]+)"/gm)].map((m) => ({ memoryId: m[1], milestoneId: m[2] }));

  // Only memories the stage actually offered the model (the MEMORIES block) are valid nominees.
  const offered = new Set([...user.matchAll(/^([0-9a-f-]{36}) \| /gm)].map((m) => m[1]));
  const photoIds = context.media.filter((r) => r.content_type.startsWith('image/') && offered.has(r.memory_id)).map((r) => r.memory_id);
  const wideIds = context.media.filter((r) => r.content_type.startsWith('image/') && (r.aspect_ratio ?? 0) > 1.15 && offered.has(r.memory_id)).map((r) => r.memory_id);

  // Up to 4 spreads, anchored at spread-out segment indexes; the first candidate that has a quotable member uses a verified quote title.
  const spreads: Array<Record<string, unknown>> = [];
  const anchors = [1, 3, 6, 9];
  candidates.slice(0, 4).forEach((candidate, i) => {
    const quoteSource = i === 0 ? candidate.memberIds.find((id) => (memoryById.get(id)?.content ?? '').length >= 20) : undefined;
    const quoteText = quoteSource ? memoryById.get(quoteSource)!.content!.split(' ').slice(0, 4).join(' ').replace(/[.,]$/, '') : null;
    spreads.push({
      candidate_id: candidate.id,
      insert_after_segment_index: anchors[i],
      title: quoteText ?? `Synthetic spread title ${i + 1}`,
      title_mode: quoteText ? 'quote' : 'descriptive',
      ...(quoteSource ? { title_source_memory_id: quoteSource } : {}),
      kicker: i % 2 === 0 ? `synthetic kicker ${i + 1}` : undefined,
      memory_ids: candidate.memberIds.slice(0, 9 + i),
      rationale: Object.fromEntries(candidate.memberIds.slice(0, 2).map((id) => [id, 'Synthetic spread rationale.'])),
    });
  });
  // One deliberately BAD candidate id and one bad memory id, so the parser's violation path is frozen too.
  spreads.push({ candidate_id: 'topic:does-not-exist', insert_after_segment_index: 2, title: 'Bad', memory_ids: [] });

  const backboneHighlights = segments.slice(0, 3).map((segment) => {
    const keys = segment.id.split('_');
    const members = context.memories.filter((m) => keys.includes(m.memory_date.slice(0, 7))).slice(0, 2).map((m) => m.id);
    return { segment_id: segment.id, memory_ids: members, rationale: Object.fromEntries(members.map((id) => [id, 'Synthetic highlight rationale.'])) };
  });

  const heroIds = [...new Set(photoIds)].slice(3, 8);
  const coverIds = [...new Set(photoIds)].slice(10, 13);

  return JSON.stringify({
    language: 'en',
    spreads,
    backbone_highlights: [...backboneHighlights, { segment_id: 'not-a-segment', memory_ids: [] }],
    // One deliberately unknown id so the parser's violation path is frozen too.
    hero_candidates: [...heroIds, 'not-a-memory-id'],
    cover_candidates: coverIds,
    panorama_candidates: [...new Set(wideIds)].slice(0, 5),
    segment_titles: Object.fromEntries(flaggedSegmentIds.map((f) => [f.id, f.title])),
    firsts_title: 'Big and small victories this year',
    firsts_milestones: firstsRows.map((row, i) => ({ memory_id: row.memoryId, milestone_id: row.milestoneId, warm_name: `Synthetic warm name ${i + 1}` })),
    dedication: 'Synthetic dedication body without a salutation. Lorem ipsum dolor sit amet.',
    back_cover_line: 'A synthetic line for the back cover.',
    editorial_note: 'Synthetic internal editorial note.',
  });
}

// ---------------------------------------------------------------------------
// Stable serialization
// ---------------------------------------------------------------------------

/** cyrb53 — small deterministic string hash (pure JS: no node:crypto dependency inside the workerd test pool). */
function hash(value: string, length = 10): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0').concat((h1 >>> 0).toString(16).padStart(8, '0')).slice(0, length);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Plain-object copy with undefined dropped (so `toMatchSnapshot` doesn't encode `kicker: undefined` noise) and keys sorted. */
const normalize = <T>(value: T): T => JSON.parse(stableStringify(value));

async function runStages(spec: ContextSpec) {
  chatCalls.length = 0;
  const context = buildContext(spec);
  nextResponse = (body) => buildLlmResponse(context, body);
  const result = await runOutlineStage({} as Env, context);

  // Mirror workflow.ts's referenced-id composition and share-token minting inputs.
  const referencedMemoryIds = mergeCandidateMemoryIds(
    collectMemoryIdsFromElements(result.elements),
    result.parsed.panoramaCandidates,
    result.parsed.heroCandidates,
    result.parsed.coverCandidates,
  );
  const shareTokensByMemoryId = new Map<string, string>();
  for (const id of referencedMemoryIds) {
    const memory = context.memories.find((m) => m.id === id)!;
    if (memory.memory_type === 'audio' || memory.memory_type === 'media') shareTokensByMemoryId.set(id, `synthetic-token-${id.slice(0, 8)}`);
  }
  const originalDimensionsByMediaId: Record<string, { width: number; height: number }> = {};
  for (const row of context.media) {
    if (row.content_type.startsWith('image/')) {
      const aspect = row.aspect_ratio ?? 1;
      originalDimensionsByMediaId[row.id] = aspect >= 1 ? { width: 4000, height: Math.round(4000 / aspect) } : { width: Math.round(4000 * aspect), height: 4000 };
    }
  }
  const manifest = buildBookManifest({
    context,
    memoryIds: referencedMemoryIds,
    outlineRunId: 'golden-run',
    language: 'en',
    shareTokensByMemoryId,
    originalDimensionsByMediaId,
  });
  return { context, result, manifest, referencedMemoryIds, body: chatCalls[0] };
}

function summarizePrompt(body: Record<string, unknown>) {
  const messages = body.messages as Array<{ role: string; content: string }>;
  const system = messages[0].content;
  const user = messages[1].content;
  const memoriesAt = user.indexOf('\nMEMORIES (');
  return {
    model: body.model,
    responseFormat: body.response_format,
    systemPrompt: { length: system.length, hash: hash(system) },
    // Everything the model sees BEFORE the per-memory rows, verbatim (firsts rows, backbone segments, candidates).
    userPromptHeader: user.slice(0, memoriesAt).split('\n'),
    userPromptMemories: { lineCount: user.slice(memoriesAt).split('\n').length, hash: hash(user.slice(memoriesAt)) },
    userPromptTotal: { length: user.length, hash: hash(user) },
  };
}

function summarizeManifest(manifest: ReturnType<typeof buildBookManifest>) {
  const memoryLines = Object.entries(manifest.memories)
    .map(([id, m]) => [
      id,
      m.date,
      m.type,
      `assets=${m.assets.length}`,
      `illo=${m.illustration ? m.illustration.file : '-'}`,
      `ms=${m.milestones.map((ms) => `${ms.id}:${ms.detail ?? ''}`).join(';') || '-'}`,
      `eng=${m.engagement}`,
      `tok=${m.shareToken ?? '-'}`,
      `tags=${m.taggedMembers.map((t) => `${t.name}${t.isChild ? '*' : ''}`).join(';') || '-'}`,
      `#${hash(stableStringify(m))}`,
    ].join(' | '));
  return {
    child: manifest.child,
    scope: manifest.scope,
    // `generatedAt` is a real `new Date()` inside the shared builder: normalized.
    generatedAt: manifest.generatedAt ? '<normalized>' : manifest.generatedAt,
    outlineRun: manifest.outlineRun,
    language: manifest.language,
    assetMode: (manifest as { assetMode?: string }).assetMode,
    downloadFailures: (manifest as { downloadFailures?: unknown }).downloadFailures,
    portraits: manifest.portraits,
    memoryCount: Object.keys(manifest.memories).length,
    memories: memoryLines,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  chatCalls.length = 0;
});

describe.each([
  ['age_year', SPECS.age_year],
  ['calendar_year', SPECS.calendar_year],
] as const)('outline + manifest golden — %s', (_name, spec) => {
  it('runOutlineStage output is unchanged (elements, parsed response, violations, counts, prompt)', async () => {
    const { result, body, context } = await runStages(spec);

    // Sanity on the synthetic context itself (so a fixture regression fails loudly, not as a snapshot diff).
    expect(context.memories).toHaveLength(300);
    expect(result.counts.inWindow).toBe(300);
    expect(result.counts.excluded).toBeGreaterThan(0);
    expect(result.features.size).toBe(result.counts.eligible);
    expect(chatCalls).toHaveLength(1);

    const elements = result.elements.map((e) => normalize(e));
    expect(elements.map((e) => e.kind)).toContain('firsts');
    expect(elements.filter((e) => e.kind === 'backbone').length).toBeGreaterThanOrEqual(8);
    expect(elements.filter((e) => e.kind === 'themed').length).toBeGreaterThan(0);

    expect({
      prompt: summarizePrompt(body),
      counts: result.counts,
      usage: result.usage,
      elements,
      parsed: normalize(result.parsed),
      violations: result.violations,
      features: { size: result.features.size, hash: hash(stableStringify([...result.features.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))) },
    }).toMatchSnapshot();
  });

  it('buildBookManifest output is unchanged (scope mapping, portraits, assets, milestones, tokens)', async () => {
    const { manifest, referencedMemoryIds } = await runStages(spec);
    expect(Object.keys(manifest.memories).sort()).toEqual([...referencedMemoryIds].sort());
    expect(manifest.scope.kind).toBe(spec.scopeKind === 'age_year' ? 'age-year' : 'calendar-year');
    expect(manifest.portraits).toHaveLength(6);
    expect(summarizeManifest(manifest)).toMatchSnapshot();
  });

  it('the whole pipeline is deterministic: two runs yield identical elements + manifest', async () => {
    const first = await runStages(spec);
    const second = await runStages(spec);
    expect(normalize(second.result.elements)).toEqual(normalize(first.result.elements));
    expect(second.result.violations).toEqual(first.result.violations);
    expect(summarizeManifest(second.manifest)).toEqual(summarizeManifest(first.manifest));
    expect(summarizePrompt(second.body)).toEqual(summarizePrompt(first.body));
  });
});

describe('outline golden — scope-kind mapping at the manifest boundary', () => {
  it.each([
    ['age_year', 'age-year'],
    ['calendar_year', 'calendar-year'],
    ['custom_range', 'custom'],
    // Phase 2: `everything` has its own outline type (was the legacy 'custom'); this is the ONLY pinned row that changed.
    ['everything', 'everything'],
  ] as const)('scopeKind %s -> manifest.scope.kind %s', (scopeKind, expected) => {
    const context = { ...buildContext(SPECS.age_year), book: { ...buildContext(SPECS.age_year).book, scopeKind } };
    const manifest = buildBookManifest({
      context,
      memoryIds: [],
      outlineRunId: 'golden-run',
      language: 'en',
      shareTokensByMemoryId: new Map(),
    });
    expect(manifest.scope.kind).toBe(expected);
  });
});
