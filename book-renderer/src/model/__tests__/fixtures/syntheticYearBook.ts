/**
 * WP-0 characterization fixture: a deterministic, seeded, SYNTHETIC
 * ~300-memory year-book document builder, producing `{ outline, manifest }`
 * in the exact shapes `fitBook` consumes (see `model/types.ts`,
 * `model/loader.ts` parseOutline/parseManifest) and mirroring what the
 * memory-book worker's `runOutlineStage` + `buildBookManifest` publish
 * (cloudflare/memory-book-worker/src/{outline,manifest,reading-order}.ts).
 *
 * Purpose: freeze TODAY's fitter behaviour (see
 * docs/plans/memory-book-everything-phase2.md "2.8 Tests and integrity
 * audit", WP-0) before any Phase 2 change lands. The real dogfood books are
 * private and the repo's other fixtures hold ~10 memories, so cap demotion,
 * pairing levels, month floors, panorama/full-bleed pacing etc. are never
 * exercised at realistic scale by anything else.
 *
 * Hard rules for this file:
 *   - DETERMINISTIC: a seeded PRNG (mulberry32) is the only source of
 *     variation. No Math.random, no Date.now, no `new Date()` without an
 *     argument. Same call -> byte-identical output, forever.
 *   - SYNTHETIC ONLY: lorem-style text, fake names. Never real data.
 *   - DO NOT "improve" the generation recipe once the golden snapshots have
 *     been committed: changing it changes every snapshot. New scenarios get
 *     NEW builders/seeds, they never edit this recipe.
 */
import type {
  BookManifest,
  BookOutline,
  ManifestAsset,
  ManifestMemory,
  ManifestMilestone,
  ManifestPortrait,
  OutlineElement,
} from '../../types';

export type SyntheticScopeKind = 'age-year' | 'calendar-year' | 'custom';

export interface SyntheticYearBookOptions {
  scopeKind: SyntheticScopeKind;
  /** Journal language; defaults to 'en'. */
  language?: 'es' | 'en';
  /** Total memories before backbone assembly; defaults to 300. */
  memoryCount?: number;
  /** PRNG seed; defaults to a per-scope-kind constant. */
  seed?: number;
}

export interface SyntheticYearBook {
  outline: BookOutline;
  manifest: BookManifest;
}

// ---------------------------------------------------------------------------
// Seeded PRNG + helpers
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, well-known, fully deterministic 32-bit PRNG. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

const randInt = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];

/** uuid-v4-shaped id from the PRNG (real memory ids are random uuids, so id order is NOT date order). */
function makeUuid(rng: Rng): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rng() * 4)]}${hex(3)}-${hex(12)}`;
}

const LOREM_WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo ' +
  'consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint ' +
  'occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'
).split(' ');

/** Lorem-style sentence(s) of roughly `targetChars` characters (never exceeding by more than one word). */
function loremText(rng: Rng, targetChars: number): string {
  let out = '';
  let sentenceLeft = randInt(rng, 5, 11);
  let startOfSentence = true;
  while (out.length < targetChars) {
    let word = pick(rng, LOREM_WORDS);
    if (startOfSentence) word = word.charAt(0).toUpperCase() + word.slice(1);
    out += (out.length > 0 ? ' ' : '') + word;
    startOfSentence = false;
    sentenceLeft -= 1;
    if (sentenceLeft === 0) {
      out += '.';
      sentenceLeft = randInt(rng, 5, 11);
      startOfSentence = true;
    }
  }
  return out.endsWith('.') ? out : `${out}.`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};
const utcMs = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Same formatting as cloudflare/memory-book-worker/src/backbone.ts `formatMonthRangeLabel` (the fitter's `localizeMonthLabel` parses exactly this shape). */
function formatMonthRangeLabel(monthKeys: string[]): string {
  const first = monthKeys[0];
  const last = monthKeys[monthKeys.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  if (first === last) return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fy === ly) return `${MONTH_NAMES[fm - 1]}–${MONTH_NAMES[lm - 1]} ${fy}`;
  return `${MONTH_NAMES[fm - 1]} ${fy} – ${MONTH_NAMES[lm - 1]} ${ly}`;
}

// ---------------------------------------------------------------------------
// Scope configuration
// ---------------------------------------------------------------------------

interface ScopeConfig {
  kind: SyntheticScopeKind;
  seed: number;
  childId: string;
  childName: string;
  dateOfBirth: string;
  /** Half-open window, like the worker's context. */
  windowStart: string;
  windowEndExclusive: string;
  label: string;
  /** Outline `scope` as the worker publishes it: `{ type }` only. */
  outlineScope: BookOutline['scope'];
}

const SCOPES: Record<SyntheticScopeKind, ScopeConfig> = {
  // Age-year 2 of a child born 2023-02-10: window = [2024-02-10, 2025-02-10).
  'age-year': {
    kind: 'age-year',
    seed: 0xa11e0001,
    childId: 'child-synthetic-0001',
    childName: 'Nova',
    dateOfBirth: '2023-02-10',
    windowStart: '2024-02-10',
    windowEndExclusive: '2025-02-10',
    label: 'Year Two',
    outlineScope: { type: 'age-year' },
  },
  'calendar-year': {
    kind: 'calendar-year',
    seed: 0xca1e0002,
    childId: 'child-synthetic-0002',
    childName: 'Nova',
    dateOfBirth: '2022-07-19',
    windowStart: '2024-01-01',
    windowEndExclusive: '2025-01-01',
    label: '2024',
    outlineScope: { type: 'calendar-year' },
  },
  // Legacy `custom` (pre-D3 Everything / custom_range): multi-year window, no chapters.
  custom: {
    kind: 'custom',
    seed: 0xc0510003,
    childId: 'child-synthetic-0003',
    childName: 'Nova',
    dateOfBirth: '2022-07-19',
    windowStart: '2023-07-01',
    windowEndExclusive: '2025-01-01',
    label: 'Everything',
    outlineScope: { type: 'custom' },
  },
};

// ---------------------------------------------------------------------------
// Memory generation
// ---------------------------------------------------------------------------

type MemoryRole =
  | 'photo-only'
  | 'video'
  | 'captioned-photo'
  | 'illustrated'
  | 'text-only'
  | 'audio';

/** Cumulative-weight table: ~62% photo-only, 10% video, 8% captioned photo, 10% illustrated, 8% text, 2% audio. Photo/video-heavy on purpose — those are the only kinds the page-cap demotion pool can cut, so the squeezed-cap golden exercises real demotion rather than exhaustion. */
const ROLE_TABLE: Array<[MemoryRole, number]> = [
  ['photo-only', 0.62],
  ['video', 0.72],
  ['captioned-photo', 0.8],
  ['illustrated', 0.9],
  ['text-only', 0.98],
  ['audio', 1],
];

const FAMILY_NAMES = ['Nova', 'Parent One', 'Parent Two', 'Grandma Three', 'Cousin Four'] as const;

// Real catalog ids (supabase/functions/_shared/memory-milestones.ts) so milestone localization paths are exercised.
const FIRSTS_MILESTONE_IDS = [
  'first-smile', 'rolls-over', 'sits-up', 'crawling', 'first-steps', 'walking', 'running',
  'first-word', 'first-sentence', 'says-own-name', 'first-solid-food', 'first-laugh', 'climbing', 'first-jump',
] as const;

const PHOTO_ASPECTS = [0.75, 0.75, 1, 1, 1.33, 1.33, 1.5, 1.5, 1.78] as const;

interface DraftMemory {
  id: string;
  role: MemoryRole;
  memory: ManifestMemory;
  /** 0-based position the memory was generated at — only used for stable, PRNG-independent tie handling. */
  index: number;
}

function buildAsset(rng: Rng, memoryId: string, slot: number, kind: 'photo' | 'video-poster', aspect: number): ManifestAsset {
  // Preview export: long edge 1280px (like the worker). Originals measured at ~3x for photos.
  const width = aspect >= 1 ? 1280 : Math.round(1280 * aspect);
  const height = aspect >= 1 ? Math.round(1280 / aspect) : 1280;
  const asset: ManifestAsset = {
    file: `assets/${memoryId}-${slot}.jpg`,
    width,
    height,
    aspectRatio: aspect,
    kind,
    durationMs: kind === 'video-poster' ? randInt(rng, 4000, 45000) : null,
  };
  if (kind === 'photo') {
    const longEdge = randInt(rng, 3200, 4600);
    asset.originalWidth = aspect >= 1 ? longEdge : Math.round(longEdge * aspect);
    asset.originalHeight = aspect >= 1 ? Math.round(longEdge / aspect) : longEdge;
    asset.originalFile = `assets/orig-${memoryId}-${slot}.jpg`;
  }
  return asset;
}

function generateMemories(rng: Rng, cfg: ScopeConfig, count: number): DraftMemory[] {
  // Month weights: roughly even with jitter, plus two deliberately sparse months (exercise merged backbone segments + month floors).
  const startMs = utcMs(cfg.windowStart);
  const endMs = utcMs(cfg.windowEndExclusive);
  const monthKeys: string[] = [];
  for (let cursor = new Date(startMs); cursor.getTime() < endMs; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    monthKeys.push(`${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}`);
  }
  const sparseIndexes = new Set([Math.floor(monthKeys.length * 0.3), Math.floor(monthKeys.length * 0.62)]);
  const weights = monthKeys.map((_, i) => (sparseIndexes.has(i) ? 0.04 : 0.6 + rng() * 0.8));
  const weightTotal = weights.reduce((a, b) => a + b, 0);

  const drafts: DraftMemory[] = [];
  for (let index = 0; index < count; index++) {
    // Month pick by weight.
    let roll = rng() * weightTotal;
    let monthIdx = 0;
    for (; monthIdx < weights.length - 1; monthIdx++) {
      roll -= weights[monthIdx];
      if (roll <= 0) break;
    }
    const [my, mm] = monthKeys[monthIdx].split('-').map(Number);
    // Clamp the day into the window (edge months are partial).
    let dayMs = Date.UTC(my, mm - 1, randInt(rng, 1, 28));
    if (dayMs < startMs) dayMs = startMs + randInt(rng, 0, 3) * DAY_MS;
    if (dayMs >= endMs) dayMs = endMs - (1 + randInt(rng, 0, 3)) * DAY_MS;
    const date = isoDate(dayMs);

    const id = makeUuid(rng);
    const roleRoll = rng();
    const role = ROLE_TABLE.find(([, cumulative]) => roleRoll <= cumulative)![0];

    const tagged = rng() < 0.7
      ? [{ name: FAMILY_NAMES[0], isChild: true }, ...(rng() < 0.4 ? [{ name: pick(rng, FAMILY_NAMES.slice(1)), isChild: false }] : [])]
      : [];
    const engagement = rng() < 0.55 ? 0 : randInt(rng, 1, 12);

    const memory: ManifestMemory = {
      date,
      type: 'media',
      text: null,
      emotion: rng() < 0.35 ? pick(rng, ['joy', 'funny', 'tender', 'calm']) : null,
      topics: rng() < 0.6 ? [pick(rng, ['beach', 'park-playground', 'mealtime', 'friends', 'travel', 'bath'])] : [],
      milestones: [],
      engagement,
      taggedMembers: tagged,
      assets: [],
      illustration: null,
      shareToken: null,
    };

    switch (role) {
      case 'photo-only': {
        memory.type = 'media';
        const photoCount = rng() < 0.12 ? randInt(rng, 2, 5) : 1;
        for (let slot = 0; slot < photoCount; slot++) memory.assets.push(buildAsset(rng, id, slot, 'photo', pick(rng, PHOTO_ASPECTS)));
        break;
      }
      case 'video': {
        memory.type = 'media';
        memory.assets.push(buildAsset(rng, id, 0, 'video-poster', pick(rng, [1.78, 1.78, 0.56, 1.33])));
        memory.shareToken = `synthetic-token-${id.slice(0, 8)}`;
        break;
      }
      case 'captioned-photo': {
        memory.type = 'media';
        const long = rng() < 0.12;
        memory.text = loremText(rng, long ? randInt(rng, 280, 420) : randInt(rng, 24, 200));
        const photoCount = rng() < 0.1 ? randInt(rng, 2, 4) : 1;
        for (let slot = 0; slot < photoCount; slot++) memory.assets.push(buildAsset(rng, id, slot, 'photo', pick(rng, PHOTO_ASPECTS)));
        break;
      }
      case 'illustrated': {
        memory.type = 'text_illustration';
        const longText = rng() < 0.25;
        memory.text = loremText(rng, longText ? randInt(rng, 300, 700) : randInt(rng, 40, 220));
        // 80% near-square art (digest-eligible when text is short), 20% off-aspect (never digest-eligible).
        const aspect = rng() < 0.8 ? 1 : pick(rng, [0.75, 1.33]);
        memory.illustration = {
          file: `assets/illo-${id}.webp`,
          width: aspect >= 1 ? 1024 : Math.round(1024 * aspect),
          height: aspect >= 1 ? Math.round(1024 / aspect) : 1024,
          aspectRatio: aspect,
        };
        break;
      }
      case 'text-only': {
        memory.type = 'text_only';
        const veryLong = rng() < 0.06;
        const long = rng() < 0.3;
        memory.text = loremText(rng, veryLong ? randInt(rng, 1700, 2100) : long ? randInt(rng, 260, 900) : randInt(rng, 30, 200));
        break;
      }
      case 'audio': {
        memory.type = 'audio';
        memory.text = rng() < 0.5 ? loremText(rng, randInt(rng, 20, 120)) : null;
        memory.shareToken = `synthetic-token-${id.slice(0, 8)}`;
        break;
      }
    }
    drafts.push({ id, role, memory, index });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Outline assembly (mirrors the worker's reading order)
// ---------------------------------------------------------------------------

interface Segment {
  id: string;
  label: string;
  monthKeys: string[];
  memoryIds: string[];
}

/** Local copy of the worker's `buildBackboneSegments` rule (merge consecutive months until >= 3 printable; fold a trailing tail into the last segment). */
function buildSegments(drafts: DraftMemory[]): Segment[] {
  const byMonth = new Map<string, DraftMemory[]>();
  for (const d of drafts) {
    const key = d.memory.date.slice(0, 7);
    const list = byMonth.get(key) ?? [];
    list.push(d);
    byMonth.set(key, list);
  }
  const monthKeys = [...byMonth.keys()].sort();
  const segments: Segment[] = [];
  let pendingMonths: string[] = [];
  let pendingIds: string[] = [];
  let pendingPrintable = 0;
  const sortByDate = (list: DraftMemory[]) =>
    [...list].sort((a, b) => a.memory.date.localeCompare(b.memory.date) || a.id.localeCompare(b.id));
  for (const key of monthKeys) {
    const bucket = sortByDate(byMonth.get(key)!);
    pendingMonths.push(key);
    pendingIds.push(...bucket.map((m) => m.id));
    pendingPrintable += bucket.length;
    if (pendingPrintable >= 3) {
      segments.push({ id: pendingMonths.join('_'), label: formatMonthRangeLabel(pendingMonths), monthKeys: pendingMonths, memoryIds: pendingIds });
      pendingMonths = [];
      pendingIds = [];
      pendingPrintable = 0;
    }
  }
  if (pendingMonths.length > 0) {
    if (segments.length > 0) {
      const last = segments[segments.length - 1];
      last.monthKeys.push(...pendingMonths);
      last.memoryIds.push(...pendingIds);
      last.id = last.monthKeys.join('_');
      last.label = formatMonthRangeLabel(last.monthKeys);
    } else {
      segments.push({ id: pendingMonths.join('_'), label: formatMonthRangeLabel(pendingMonths), monthKeys: pendingMonths, memoryIds: pendingIds });
    }
  }
  return segments;
}

export function buildSyntheticYearBook(options: SyntheticYearBookOptions): SyntheticYearBook {
  const cfg = SCOPES[options.scopeKind];
  const language = options.language ?? 'en';
  const count = options.memoryCount ?? 300;
  const rng = makeRng(options.seed ?? cfg.seed);

  const drafts = generateMemories(rng, cfg, count);
  const byId = new Map(drafts.map((d) => [d.id, d]));

  // ── milestones: ~14 non-birthday "firsts" (80% with a photo), 2 birthday rows (stay in backbone) ──
  const firstsIds: string[] = [];
  const milestoneCandidates = drafts.filter((d) => d.role === 'photo-only' || d.role === 'captioned-photo' || d.role === 'text-only');
  for (let i = 0; i < FIRSTS_MILESTONE_IDS.length; i++) {
    const d = milestoneCandidates[Math.floor(rng() * milestoneCandidates.length)];
    if (d.memory.milestones.some((m) => m.id === FIRSTS_MILESTONE_IDS[i])) continue;
    if (firstsIds.length >= 12 && !firstsIds.includes(d.id)) continue;
    // Fit-time Firsts gate (2026-10-01): every other milestone is parent-
    // confirmed so the golden keeps Firsts coverage; the rest (lorem text,
    // no first-time language) are reassigned to their backbone month.
    const milestone: ManifestMilestone = {
      id: FIRSTS_MILESTONE_IDS[i], name: FIRSTS_MILESTONE_IDS[i].replace(/-/g, ' '), detail: '',
      ...(i % 2 === 0 ? { status: 'confirmed' } : {}),
    };
    d.memory.milestones.push(milestone);
    if (!firstsIds.includes(d.id)) firstsIds.push(d.id);
  }
  const birthdayDrafts = milestoneCandidates.filter((d) => d.memory.milestones.length === 0 && d.role !== 'text-only').slice(0, 2);
  birthdayDrafts.forEach((d, i) => {
    d.memory.milestones.push({ id: 'birthday', name: 'Birthday', detail: String(i + 1) });
  });
  const firstsIdSet = new Set(firstsIds);

  // ── segments (backbone) from every memory, then carve out themed + firsts (single placement) ──
  const segmentsAll = buildSegments(drafts);

  // Themed spreads: 4 spreads of 6-12 members drawn from non-milestone, non-firsts memories across the whole window.
  const themedPool = drafts.filter((d) => !firstsIdSet.has(d.id) && d.memory.milestones.length === 0);
  const themedSpec: Array<{ id: string; spreadType: 'topic' | 'people-pair' | 'emotion'; title: string; kicker: string | null; mode: 'quote' | 'descriptive' }> = [
    { id: 'topic:beach', spreadType: 'topic', title: 'A day at the beach', kicker: 'sun and sand', mode: 'descriptive' },
    { id: 'people:synthetic-grandma', spreadType: 'people-pair', title: 'With Grandma Three', kicker: null, mode: 'descriptive' },
    { id: 'emotion:funny', spreadType: 'emotion', title: '', kicker: null, mode: 'quote' },
    { id: 'topic:park-playground', spreadType: 'topic', title: 'Park days', kicker: 'swings and slides', mode: 'descriptive' },
  ];
  const themedMembers = new Map<string, string[]>();
  const taken = new Set<string>();
  for (const spec of themedSpec) {
    const members: string[] = [];
    const target = randInt(rng, 6, 12);
    let guard = 0;
    while (members.length < target && guard < 2000) {
      guard += 1;
      const d = themedPool[Math.floor(rng() * themedPool.length)];
      if (taken.has(d.id)) continue;
      taken.add(d.id);
      members.push(d.id);
    }
    members.sort((a, b) => byId.get(a)!.memory.date.localeCompare(byId.get(b)!.memory.date) || a.localeCompare(b));
    themedMembers.set(spec.id, members);
  }
  // The quote-mode spread needs a short, text-bearing source memory whose text the title lifts verbatim.
  let quoteSourceId: string | null = null;
  const quoteMembers = themedMembers.get('emotion:funny')!;
  for (const memberId of quoteMembers) {
    const text = byId.get(memberId)!.memory.text;
    if (text && text.length >= 12 && text.length <= 120) {
      quoteSourceId = memberId;
      break;
    }
  }
  if (!quoteSourceId) {
    // Guarantee a quote source: promote the first member to a short captioned memory (still synthetic).
    const first = byId.get(quoteMembers[0])!;
    first.memory.text = loremText(rng, 40);
    quoteSourceId = first.id;
  }
  const quoteTitle = byId.get(quoteSourceId)!.memory.text!.split(' ').slice(0, 5).join(' ').replace(/[.,]$/, '');

  const carved = new Set<string>([...taken, ...firstsIds]);
  const finalSegments: Segment[] = segmentsAll.map((s) => ({ ...s, memoryIds: s.memoryIds.filter((id) => !carved.has(id)) })).filter((s) => s.memoryIds.length > 0);

  // ── candidate lists (hero / cover / panorama) ──
  const photoDrafts = drafts.filter((d) => d.memory.assets.some((a) => a.kind === 'photo') && (d.role === 'photo-only' || d.role === 'captioned-photo'));
  const heroCandidates = photoDrafts.filter((d) => (d.memory.assets[0].originalWidth ?? 0) >= 3800).slice(0, 5).map((d) => d.id);
  const coverCandidates = photoDrafts.filter((d) => (d.memory.assets[0].originalWidth ?? 0) >= 3600 && d.memory.assets[0].aspectRatio >= 0.75).slice(10, 13).map((d) => d.id);
  // Panoramas: force 4 photo-only memories to a genuinely wide 2:1 asset at print-safe width.
  const panoramaCandidates: string[] = [];
  for (const d of drafts.filter((x) => x.role === 'photo-only' && x.memory.assets.length === 1).slice(20, 24)) {
    const asset = d.memory.assets[0];
    asset.aspectRatio = 2;
    asset.width = 1280;
    asset.height = 640;
    asset.originalWidth = 4400;
    asset.originalHeight = 2200;
    panoramaCandidates.push(d.id);
  }

  // ── backbone elements, with special titles for flagged (birth/birthday) months ──
  const flaggedMonths = new Map<string, string>();
  if (cfg.kind === 'age-year') {
    flaggedMonths.set(cfg.windowStart.slice(0, 7), 'The month you turned one');
    flaggedMonths.set(cfg.windowEndExclusive.slice(0, 7), 'The month you turned two');
  } else if (cfg.kind === 'custom') {
    flaggedMonths.set('2023-07', 'The month you turned one');
  }

  const heroSet = new Set(heroCandidates);
  const backboneElements: OutlineElement[] = finalSegments.map((segment) => {
    const special = segment.monthKeys.map((m) => flaggedMonths.get(m)).find((t) => t !== undefined);
    const highlights = segment.memoryIds
      .filter((id) => (byId.get(id)!.memory.assets.length > 0 || heroSet.has(id)) && byId.get(id)!.memory.engagement >= 6)
      .slice(0, 2);
    const rationale: Record<string, string> = {};
    for (const id of highlights) rationale[id] = 'Synthetic rationale for a highlighted memory.';
    return {
      id: `backbone:${segment.id}`,
      kind: 'backbone',
      title: special ?? segment.label,
      ...(special ? { subtitle: segment.label } : {}),
      memoryIds: segment.memoryIds,
      rationale,
      highlights,
    } satisfies OutlineElement;
  });

  // Themed spreads interleaved at fixed fractions of the backbone (never adjacent).
  const lastIndex = backboneElements.length - 1;
  const gapAfter = [Math.floor(lastIndex * 0.12), Math.floor(lastIndex * 0.38), Math.floor(lastIndex * 0.62), Math.floor(lastIndex * 0.88)];
  const themedElements: OutlineElement[] = themedSpec.map((spec) => {
    const rationale: Record<string, string> = {};
    for (const id of themedMembers.get(spec.id)!.slice(0, 2)) rationale[id] = 'Synthetic rationale.';
    const isQuote = spec.mode === 'quote';
    return {
      id: spec.id,
      kind: 'themed',
      title: isQuote ? quoteTitle : spec.title,
      memoryIds: themedMembers.get(spec.id)!,
      rationale,
      spreadType: spec.spreadType,
      titleMode: spec.mode,
      titleSourceMemoryId: isQuote ? quoteSourceId : null,
      ...(spec.kicker ? { kicker: spec.kicker } : {}),
    } satisfies OutlineElement;
  });

  const elements: OutlineElement[] = [
    { id: 'cover', kind: 'cover', title: 'Cover', memoryIds: [], rationale: {} },
    { id: 'title', kind: 'title', title: 'Title & dedication', memoryIds: [], rationale: {} },
    { id: 'through-the-years', kind: 'through-the-years', title: `Through the years -- ${cfg.childName}`, memoryIds: [], rationale: {} },
  ];
  // (no spread is anchored before the first segment in this recipe)
  backboneElements.forEach((element, index) => {
    elements.push(element);
    themedElements.forEach((themed, i) => {
      if (gapAfter[i] === index) elements.push(themed);
    });
  });
  const firstsSorted = [...firstsIds].sort((a, b) => byId.get(a)!.memory.date.localeCompare(byId.get(b)!.memory.date) || a.localeCompare(b));
  elements.push({
    id: 'firsts',
    kind: 'firsts',
    title: 'Big and small victories this year',
    memoryIds: firstsSorted,
    rationale: {},
    // Renderer-contract field (`OutlineElement.firstsEntries`). NB: the worker today emits `firstsWarmNames` instead, which the fitter does not read — see WP-0 report.
    firstsEntries: firstsSorted
      .filter((_, i) => i % 2 === 0)
      .map((id) => ({ memoryId: id, milestoneId: byId.get(id)!.memory.milestones[0].id, warmName: `You reached a synthetic milestone number ${(byId.get(id)!.index % 97) + 1}` })),
  });
  elements.push({ id: 'closing', kind: 'closing', title: 'Closing', memoryIds: [], rationale: {} });

  // ── manifest: every memory referenced by an element, hero/cover/panorama candidates included ──
  const referenced = new Set<string>();
  for (const el of elements) for (const id of el.memoryIds) referenced.add(id);
  for (const id of [...heroCandidates, ...coverCandidates, ...panoramaCandidates]) referenced.add(id);
  const memories: Record<string, ManifestMemory> = {};
  for (const d of drafts) {
    if (referenced.has(d.id)) memories[d.id] = d.memory;
  }

  // ── portraits: 6, evenly dated across the window ──
  const portraits: ManifestPortrait[] = [];
  const startMs = utcMs(cfg.windowStart);
  const endMs = utcMs(cfg.windowEndExclusive);
  for (let i = 0; i < 6; i++) {
    const date = isoDate(startMs + Math.floor(((endMs - startMs) * i) / 6));
    portraits.push({ file: `assets/portrait-${i}.webp`, sourceFile: `assets/portrait-src-${i}.jpg`, date, ageLabel: `Synthetic age label ${i}` });
  }

  const lastDay = isoDate(utcMs(cfg.windowEndExclusive) - DAY_MS);
  const manifest: BookManifest = {
    child: { id: cfg.childId, name: cfg.childName, dateOfBirth: cfg.dateOfBirth },
    scope: { kind: cfg.kind, label: cfg.label, start: cfg.windowStart, end: lastDay },
    generatedAt: '2026-01-01T00:00:00.000Z',
    outlineRun: 'synthetic-golden-run',
    memories,
    portraits,
    language,
  };

  const outline: BookOutline = {
    runId: 'synthetic-golden-run',
    child: { id: cfg.childId, name: cfg.childName },
    scope: cfg.outlineScope,
    window: { start: cfg.windowStart, endExclusive: cfg.windowEndExclusive, label: cfg.label },
    pageEstimate: referenced.size,
    pageBudget: 122,
    counts: { inWindow: drafts.length, eligible: drafts.length, taggedToChild: 0, untaggedInWindow: 0, excluded: 0 },
    elements,
    editorialNote: 'Synthetic editorial note.',
    integrity: {
      violations: [],
      reassignments: [],
      dissolvedSpreadIds: [],
      dissolvedBirthdayAges: [],
      movedToBackbone: [],
      droppedElements: [],
      excludedMemoryIds: [],
    },
    heroCandidates,
    coverCandidates,
    panoramaCandidates,
    dedication: 'Synthetic dedication body, no salutation. Lorem ipsum dolor sit amet.',
    backCoverLine: 'A synthetic line for the back cover.',
  };

  return { outline, manifest };
}
