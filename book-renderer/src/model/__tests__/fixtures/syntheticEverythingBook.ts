/**
 * Deterministic, seeded, SYNTHETIC multi-year ("Everything") book builder for
 * the chapter-mode fitter tests (docs/plans/memory-book-everything-phase2.md
 * 2.2 / 2.3 / 2.8). ~600 memories over a 5-year window, one `chapter` outline
 * element per age-year (month-aligned: the month of the Nth birthday is the
 * LAST month of chapter N), shaped like what the Everything worker publishes.
 *
 * Hard rules (same as `syntheticYearBook.ts`):
 *   - DETERMINISTIC: seeded mulberry32 PRNG is the only source of variation.
 *   - SYNTHETIC ONLY: lorem-style text, fake names. Never real data.
 *   - Do not edit the recipe once tests assert against its numbers; add a new
 *     builder/seed instead.
 *
 * Kind mix (approximate, close to the real dogfood Everything books): ~78%
 * of memories have photos/video (48% photo-only, 8% video, 22% captioned
 * photo), ~17% are illustrated, the rest text-only/audio. Engagement is
 * non-zero on ~20% of memories. 23 memories carry a milestone (6 of them in
 * the capped Firsts section, 17 stay in the backbone, protected from cuts).
 */
import type {
  BookManifest,
  BookOutline,
  ManifestAsset,
  ManifestMemory,
  ManifestPortrait,
  OutlineElement,
} from '../../types';

export interface SyntheticEverythingOptions {
  language?: 'es' | 'en';
  /** Total memories (default 600). */
  memoryCount?: number;
  seed?: number;
  /**
   * Phase 2b shape: backbone sections are FIXED 3-month blocks cut from each
   * chapter's first month (a 13-month chapter -> 3,3,3,3,1; the trailing
   * 1-month block is the birthday month) — what the Everything worker emits
   * now. Default `false` keeps the original merge-until-3-printable shape
   * (many 1-month sections) every pre-2b assertion was written against.
   */
  quarterSections?: boolean;
}

export interface SyntheticChapter {
  ageYear: number;
  startMonth: string;
  endMonth: string;
}

export interface SyntheticEverythingBook {
  outline: BookOutline;
  manifest: BookManifest;
  chapters: SyntheticChapter[];
  /** Memory ids per chapter index (every generated memory, whatever element holds it). */
  memoryIdsByChapter: string[][];
}

const DOB = '2021-02-10';
const CHAPTER_COUNT = 5;
/** Share of all memories per chapter (first years are denser — the real data's shape). */
const CHAPTER_SHARE = [0.3, 0.24, 0.2, 0.14, 0.12];

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
const randInt = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const pad2 = (n: number) => String(n).padStart(2, '0');

function makeUuid(rng: Rng): string {
  const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(rng() * 4)]}${hex(3)}-${hex(12)}`;
}

const LOREM = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore ' +
  'magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo'
).split(' ');

function loremText(rng: Rng, targetChars: number): string {
  let out = '';
  while (out.length < targetChars) out += (out ? ' ' : '') + pick(rng, LOREM);
  return `${out.charAt(0).toUpperCase()}${out.slice(1)}.`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatMonthRangeLabel(monthKeys: string[]): string {
  const first = monthKeys[0];
  const last = monthKeys[monthKeys.length - 1];
  const [fy, fm] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  if (first === last) return `${MONTH_NAMES[fm - 1]} ${fy}`;
  if (fy === ly) return `${MONTH_NAMES[fm - 1]}–${MONTH_NAMES[lm - 1]} ${fy}`;
  return `${MONTH_NAMES[fm - 1]} ${fy} – ${MONTH_NAMES[lm - 1]} ${ly}`;
}

const NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** Chapter N: months from (month after chapter N-1's end) through the month of the Nth birthday, inclusive. */
export function syntheticChapters(): SyntheticChapter[] {
  const [dy, dm] = DOB.split('-').map(Number);
  const chapters: SyntheticChapter[] = [];
  let start = `${dy}-${pad2(dm)}`;
  for (let n = 1; n <= CHAPTER_COUNT; n++) {
    const end = `${dy + n}-${pad2(dm)}`;
    chapters.push({ ageYear: n, startMonth: start, endMonth: end });
    const nextIndex = (dy + n) * 12 + (dm - 1) + 1;
    start = `${Math.floor(nextIndex / 12)}-${pad2((nextIndex % 12) + 1)}`;
  }
  return chapters;
}

function monthsBetween(startMonth: string, endMonth: string): string[] {
  const out: string[] = [];
  let [y, m] = startMonth.split('-').map(Number);
  for (;;) {
    const key = `${y}-${pad2(m)}`;
    out.push(key);
    if (key === endMonth) return out;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
}

type Role = 'photo-only' | 'video' | 'captioned-photo' | 'illustrated' | 'text-only' | 'audio';
const ROLE_TABLE: Array<[Role, number]> = [
  ['photo-only', 0.52],
  ['video', 0.6],
  ['captioned-photo', 0.8],
  ['illustrated', 0.97],
  ['text-only', 0.99],
  ['audio', 1],
];
const PHOTO_ASPECTS = [0.75, 0.75, 1, 1, 1.33, 1.33, 1.5, 1.5, 1.78] as const;
const MILESTONE_IDS = [
  'first-smile', 'rolls-over', 'sits-up', 'crawling', 'first-steps', 'walking', 'running', 'first-word',
  'first-sentence', 'says-own-name', 'first-solid-food', 'first-laugh', 'climbing', 'first-jump', 'counts-to-ten',
  'rides-a-bike', 'first-day-of-school', 'writes-own-name', 'first-haircut', 'swims', 'ties-shoes', 'first-tooth', 'lost-first-tooth',
] as const;

function buildAsset(rng: Rng, memoryId: string, slot: number, kind: 'photo' | 'video-poster', aspect: number): ManifestAsset {
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

interface Draft {
  id: string;
  role: Role;
  chapterIndex: number;
  memory: ManifestMemory;
}

export function buildSyntheticEverythingBook(options: SyntheticEverythingOptions = {}): SyntheticEverythingBook {
  const language = options.language ?? 'en';
  const total = options.memoryCount ?? 600;
  const rng = makeRng(options.seed ?? 0xe7e27009);
  const chapters = syntheticChapters();
  const windowStart = DOB;
  const lastChapterEnd = chapters[chapters.length - 1].endMonth;

  // ── memories, chapter by chapter ──
  const drafts: Draft[] = [];
  const counts = CHAPTER_SHARE.map((share) => Math.round(total * share));
  counts[0] += total - counts.reduce((a, b) => a + b, 0);
  chapters.forEach((chapter, chapterIndex) => {
    const months = monthsBetween(chapter.startMonth, chapter.endMonth);
    const sparse = new Set([Math.floor(months.length * 0.35), Math.floor(months.length * 0.8)]);
    // Log-normal-ish month weights: a few busy months, many quiet ones (parents skip months).
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const weights = months.map((_, i) => (sparse.has(i) ? 0.05 : Math.exp(gauss() * 0.9)));
    const weightTotal = weights.reduce((a, b) => a + b, 0);
    for (let n = 0; n < counts[chapterIndex]; n++) {
      let roll = rng() * weightTotal;
      let mi = 0;
      for (; mi < weights.length - 1; mi++) {
        roll -= weights[mi];
        if (roll <= 0) break;
      }
      const month = months[mi];
      let day = randInt(rng, 1, 28);
      if (month === windowStart.slice(0, 7)) day = Math.max(day, 10);
      const date = `${month}-${pad2(day)}`;
      const id = makeUuid(rng);
      const roleRoll = rng();
      const role = ROLE_TABLE.find(([, cumulative]) => roleRoll <= cumulative)![0];
      const memory: ManifestMemory = {
        date,
        type: 'media',
        text: null,
        emotion: rng() < 0.3 ? pick(rng, ['joy', 'funny', 'tender', 'calm']) : null,
        topics: rng() < 0.5 ? [pick(rng, ['beach', 'park-playground', 'mealtime', 'friends', 'travel', 'bath'])] : [],
        milestones: [],
        engagement: rng() < 0.8 ? 0 : randInt(rng, 1, 12),
        taggedMembers: rng() < 0.7 ? [{ name: 'Nova', isChild: true }] : [],
        assets: [],
        illustration: null,
        shareToken: null,
      };
      switch (role) {
        case 'photo-only': {
          const photos = rng() < 0.1 ? randInt(rng, 2, 4) : 1;
          for (let slot = 0; slot < photos; slot++) memory.assets.push(buildAsset(rng, id, slot, 'photo', pick(rng, PHOTO_ASPECTS)));
          break;
        }
        case 'video':
          memory.assets.push(buildAsset(rng, id, 0, 'video-poster', pick(rng, [1.78, 1.78, 0.56, 1.33])));
          memory.shareToken = `synthetic-token-${id.slice(0, 8)}`;
          break;
        case 'captioned-photo':
          memory.text = loremText(rng, rng() < 0.08 ? randInt(rng, 280, 420) : randInt(rng, 24, 200));
          memory.assets.push(buildAsset(rng, id, 0, 'photo', pick(rng, PHOTO_ASPECTS)));
          break;
        case 'illustrated': {
          memory.type = 'text_illustration';
          memory.text = loremText(rng, rng() < 0.1 ? randInt(rng, 300, 700) : randInt(rng, 40, 220));
          const aspect = rng() < 0.9 ? 1 : pick(rng, [0.75, 1.33]);
          memory.illustration = {
            file: `assets/illo-${id}.webp`,
            width: aspect >= 1 ? 1024 : Math.round(1024 * aspect),
            height: aspect >= 1 ? Math.round(1024 / aspect) : 1024,
            aspectRatio: aspect,
          };
          break;
        }
        case 'text-only':
          memory.type = 'text_only';
          memory.text = loremText(rng, rng() < 0.15 ? randInt(rng, 260, 900) : randInt(rng, 30, 200));
          break;
        case 'audio':
          memory.type = 'audio';
          memory.text = rng() < 0.5 ? loremText(rng, randInt(rng, 20, 120)) : null;
          memory.shareToken = `synthetic-token-${id.slice(0, 8)}`;
          break;
      }
      drafts.push({ id, role, chapterIndex, memory });
    }
  });
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const byDate = (a: string, b: string) => byId.get(a)!.memory.date.localeCompare(byId.get(b)!.memory.date) || a.localeCompare(b);

  // ── milestones: 23 rows on 23 distinct memories; the first 6 (chronological among photo/captioned holders) form Firsts, the rest stay in the backbone ──
  const holderPool = drafts.filter((d) => d.role === 'photo-only' || d.role === 'captioned-photo');
  const holders: Draft[] = [];
  for (let i = 0; i < MILESTONE_IDS.length; i++) {
    const d = holderPool[Math.floor(rng() * holderPool.length)];
    if (d.memory.milestones.length > 0) {
      i -= 1;
      continue;
    }
    d.memory.milestones.push({ id: MILESTONE_IDS[i], name: MILESTONE_IDS[i].replace(/-/g, ' '), detail: '' });
    holders.push(d);
  }
  const firstsIds = holders
    .map((d) => d.id)
    .sort(byDate)
    .slice(0, 6);
  const firstsSet = new Set(firstsIds);

  // ── themed spreads: 6 (<=2 per chapter), members from non-milestone memories of that chapter ──
  const themedPlan: Array<{ id: string; chapterIndex: number; title: string; spreadType: 'topic' | 'people-pair' | 'emotion' }> = [
    { id: 'topic:beach', chapterIndex: 0, title: 'A day at the beach', spreadType: 'topic' },
    { id: 'people:synthetic-grandma', chapterIndex: 1, title: 'With Grandma Three', spreadType: 'people-pair' },
    { id: 'topic:park-playground', chapterIndex: 1, title: 'Park days', spreadType: 'topic' },
    { id: 'topic:travel', chapterIndex: 2, title: 'Away from home', spreadType: 'topic' },
    { id: 'emotion:funny', chapterIndex: 3, title: 'Silly moments', spreadType: 'emotion' },
    { id: 'topic:friends', chapterIndex: 4, title: 'With friends', spreadType: 'topic' },
  ];
  const taken = new Set<string>(firstsIds);
  const themedMembers = new Map<string, string[]>();
  for (const spec of themedPlan) {
    const pool = drafts.filter((d) => d.chapterIndex === spec.chapterIndex && d.memory.milestones.length === 0 && !taken.has(d.id));
    const members: string[] = [];
    const target = randInt(rng, 6, 10);
    let guard = 0;
    while (members.length < target && guard++ < 1000) {
      const d = pool[Math.floor(rng() * pool.length)];
      if (taken.has(d.id)) continue;
      taken.add(d.id);
      members.push(d.id);
    }
    themedMembers.set(spec.id, members.sort(byDate));
  }

  // ── backbone: per chapter, merge consecutive months until >=3 printable OR a 3-month span; never cross a chapter ──
  interface Segment {
    chapterIndex: number;
    monthKeys: string[];
    memoryIds: string[];
  }
  const segments: Segment[] = [];
  chapters.forEach((chapter, chapterIndex) => {
    let monthKeys: string[] = [];
    let ids: string[] = [];
    const flush = () => {
      if (monthKeys.length === 0) return;
      segments.push({ chapterIndex, monthKeys, memoryIds: ids });
      monthKeys = [];
      ids = [];
    };
    for (const month of monthsBetween(chapter.startMonth, chapter.endMonth)) {
      const members = drafts
        .filter((d) => d.chapterIndex === chapterIndex && d.memory.date.startsWith(month) && !taken.has(d.id))
        .map((d) => d.id)
        .sort(byDate);
      monthKeys.push(month);
      ids.push(...members);
      if (options.quarterSections ? monthKeys.length >= 3 : ids.length >= 3 || monthKeys.length >= 3) flush();
    }
    flush();
  });
  const liveSegments = segments.filter((s) => s.memoryIds.length > 0);

  // ── candidates ──
  const photoDrafts = drafts.filter((d) => (d.role === 'photo-only' || d.role === 'captioned-photo') && d.memory.milestones.length === 0 && !firstsSet.has(d.id));
  const wide = photoDrafts.filter((d) => (d.memory.assets[0].originalWidth ?? 0) >= 3800);
  const heroCandidates = wide.filter((_, i) => i % 9 === 0).slice(0, 8).map((d) => d.id);
  const coverCandidates = photoDrafts.filter((d) => (d.memory.assets[0].originalWidth ?? 0) >= 3600 && d.memory.assets[0].aspectRatio >= 0.75).slice(20, 23).map((d) => d.id);
  const panoramaCandidates: string[] = [];
  for (const d of drafts.filter((x) => x.role === 'photo-only' && x.memory.assets.length === 1 && !taken.has(x.id)).filter((_, i) => i % 40 === 0).slice(0, 6)) {
    const asset = d.memory.assets[0];
    asset.aspectRatio = 2;
    asset.width = 1280;
    asset.height = 640;
    asset.originalWidth = 4400;
    asset.originalHeight = 2200;
    panoramaCandidates.push(d.id);
  }

  // ── elements, in reading order ──
  const birthdayMonths = new Map(chapters.map((c) => [c.endMonth, c.ageYear]));
  const heroSet = new Set(heroCandidates);
  const backboneElement = (segment: Segment): OutlineElement => {
    const birthday = segment.monthKeys.map((m) => birthdayMonths.get(m)).find((n) => n !== undefined);
    const label = formatMonthRangeLabel(segment.monthKeys);
    const highlights = segment.memoryIds
      .filter((id) => (byId.get(id)!.memory.assets.length > 0 || heroSet.has(id)) && byId.get(id)!.memory.engagement >= 6)
      .slice(0, 2);
    return {
      id: `backbone:${segment.monthKeys.join('_')}`,
      kind: 'backbone',
      title: birthday ? `The month you turned ${NUMBER_WORDS[birthday].toLowerCase()}` : label,
      ...(birthday || segment.monthKeys.length > 1 ? { subtitle: label } : {}),
      memoryIds: segment.memoryIds,
      rationale: Object.fromEntries(highlights.map((id) => [id, 'Synthetic rationale.'])),
      highlights,
    };
  };

  const elements: OutlineElement[] = [
    { id: 'cover', kind: 'cover', title: 'Cover', memoryIds: [], rationale: {} },
    { id: 'title', kind: 'title', title: 'Title & dedication', memoryIds: [], rationale: {} },
    { id: 'through-the-years', kind: 'through-the-years', title: 'Through the years -- Nova', memoryIds: [], rationale: {} },
  ];
  chapters.forEach((chapter, chapterIndex) => {
    const own = liveSegments.filter((s) => s.chapterIndex === chapterIndex);
    const months = own.flatMap((s) => s.monthKeys);
    elements.push({
      id: `chapter:${chapter.ageYear}`,
      kind: 'chapter',
      title: `Year ${NUMBER_WORDS[chapter.ageYear]}`,
      subtitle: formatMonthRangeLabel([months[0], months[months.length - 1]]),
      memoryIds: [],
      rationale: {},
      chapter: { ageYear: chapter.ageYear, startMonth: chapter.startMonth, endMonth: chapter.endMonth },
    });
    const themedHere = themedPlan.filter((t) => t.chapterIndex === chapterIndex);
    own.forEach((segment, i) => {
      elements.push(backboneElement(segment));
      // Themed spreads after ~1/3 and ~2/3 of the chapter's segments (never adjacent).
      themedHere.forEach((spec, ti) => {
        const anchor = Math.floor((own.length * (ti + 1)) / (themedHere.length + 1));
        if (anchor === i) {
          elements.push({
            id: spec.id,
            kind: 'themed',
            title: spec.title,
            memoryIds: themedMembers.get(spec.id)!,
            rationale: {},
            spreadType: spec.spreadType,
            titleMode: 'descriptive',
            titleSourceMemoryId: null,
            kicker: 'synthetic kicker',
          });
        }
      });
    });
  });
  elements.push({ id: 'firsts', kind: 'firsts', title: 'Big and small victories', memoryIds: firstsIds, rationale: {} });
  elements.push({ id: 'closing', kind: 'closing', title: 'Closing', memoryIds: [], rationale: {} });

  // ── manifest: every memory an element references (+ candidates) ──
  const referenced = new Set<string>();
  for (const el of elements) for (const id of el.memoryIds) referenced.add(id);
  for (const id of [...heroCandidates, ...coverCandidates, ...panoramaCandidates]) referenced.add(id);
  const memories: Record<string, ManifestMemory> = {};
  for (const d of drafts) if (referenced.has(d.id)) memories[d.id] = d.memory;

  const portraits: ManifestPortrait[] = [];
  for (let i = 0; i < 6; i++) {
    const year = 2021 + i;
    portraits.push({ file: `assets/portrait-${i}.webp`, sourceFile: `assets/portrait-src-${i}.jpg`, date: `${year}-0${(i % 8) + 1}-15`, ageLabel: `Synthetic age ${i}` });
  }

  const manifest: BookManifest = {
    child: { id: 'child-synthetic-everything', name: 'Nova', dateOfBirth: DOB },
    scope: { kind: 'everything', label: 'Everything', start: windowStart, end: `${lastChapterEnd}-28` },
    generatedAt: '2026-01-01T00:00:00.000Z',
    outlineRun: 'synthetic-everything-run',
    memories,
    portraits,
    language,
  };
  const outline: BookOutline = {
    runId: 'synthetic-everything-run',
    child: { id: 'child-synthetic-everything', name: 'Nova' },
    scope: { type: 'everything' },
    window: { start: windowStart, endExclusive: `${lastChapterEnd}-29`, label: 'Everything' },
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

  const memoryIdsByChapter = chapters.map((_, ci) => drafts.filter((d) => d.chapterIndex === ci).map((d) => d.id));
  return { outline, manifest, chapters, memoryIdsByChapter };
}
