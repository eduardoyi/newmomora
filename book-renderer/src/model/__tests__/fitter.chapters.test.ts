import { describe, expect, it } from 'vitest';
import { ENABLE_TIER_C_CAPTIONED_DEMOTION, fitBook, planChapterDemotions } from '../fitter';
import { auditBookDocument } from '../audit';
import { applyPostFit } from '../edits';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import { buildSyntheticYearBook } from './fixtures/syntheticYearBook';
import { buildSyntheticEverythingBook } from './fixtures/syntheticEverythingBook';
import type { BookOutline, ManifestMemory, OutlineElement } from '../types';

/**
 * Multi-year (Everything) chapter mode — docs/plans/memory-book-everything-phase2.md
 * 2.2 (renderer side: the `chapter` element) and 2.3 (proportional per-chapter
 * page-cap budgeting, time-spread tie-break, plan + prefix search, Tier C).
 */

// Three age-year chapters of a child born 2021-02-10 (month-aligned).
const CH1 = { ageYear: 1, startMonth: '2021-02', endMonth: '2022-02' };
const CH2 = { ageYear: 2, startMonth: '2022-03', endMonth: '2023-02' };
const CH3 = { ageYear: 3, startMonth: '2023-03', endMonth: '2024-02' };

function chapterElement(meta: { ageYear: number; startMonth: string; endMonth: string }, subtitle = 'February 2021 – February 2022'): OutlineElement {
  return makeElement({
    id: `chapter:${meta.ageYear}`,
    kind: 'chapter',
    title: `Year ${meta.ageYear}`,
    subtitle,
    chapter: meta,
  });
}

const photo = (date: string, engagement = 0): ManifestMemory => makeMemory({ date, engagement, assets: [makeAsset({ aspectRatio: 1 })] });
const captioned = (date: string, text: string, engagement = 0): ManifestMemory =>
  makeMemory({ date, engagement, text, assets: [makeAsset({ aspectRatio: 1 })] });

/** One backbone element per (chapter, month): `counts[m]` photo-only memories each, ids `<prefix>-<month>-<i>`. */
function monthlyBook(
  chapterMeta: typeof CH1,
  months: string[],
  counts: number[],
  build: (date: string, indexInMonth: number, id: string) => ManifestMemory = (date) => photo(date),
  idPrefix = `c${chapterMeta.ageYear}`,
) {
  const memories: Record<string, ManifestMemory> = {};
  const elements: OutlineElement[] = [chapterElement(chapterMeta)];
  months.forEach((month, mi) => {
    const ids: string[] = [];
    for (let i = 0; i < counts[mi]; i++) {
      const id = `${idPrefix}-${month}-${String(i).padStart(2, '0')}`;
      memories[id] = build(`${month}-${String(1 + (i % 27)).padStart(2, '0')}`, i, id);
      ids.push(id);
    }
    elements.push(makeElement({ id: `backbone:${month}`, kind: 'backbone', title: month, memoryIds: ids }));
  });
  return { memories, elements };
}

function threeChapterBook(counts: [number, number, number], build?: Parameters<typeof monthlyBook>[3]) {
  const split = (n: number): number[] => [Math.ceil(n / 3), Math.ceil((n - Math.ceil(n / 3)) / 2), n - Math.ceil(n / 3) - Math.ceil((n - Math.ceil(n / 3)) / 2)];
  const a = monthlyBook(CH1, ['2021-04', '2021-07', '2021-10'], split(counts[0]), build);
  const b = monthlyBook(CH2, ['2022-04', '2022-07', '2022-10'], split(counts[1]), build);
  const c = monthlyBook(CH3, ['2023-04', '2023-07', '2023-10'], split(counts[2]), build);
  const manifest = makeManifest({ ...a.memories, ...b.memories, ...c.memories }, {
    scope: { kind: 'everything', label: 'Everything', start: '2021-02-10', end: '2024-02-28' },
    child: { id: 'child-1', name: 'Nova', dateOfBirth: '2021-02-10' },
  });
  const outline = makeOutline([...a.elements, ...b.elements, ...c.elements], { scope: { type: 'everything' } });
  return { manifest, outline, ids: [Object.keys(a.memories), Object.keys(b.memories), Object.keys(c.memories)] };
}

function omittedPerChapter(omitted: string[], ids: string[][]): number[] {
  const set = new Set(omitted);
  return ids.map((chapterIds) => chapterIds.filter((id) => set.has(id)).length);
}

// ---------------------------------------------------------------------------
// 2.2 — the chapter page
// ---------------------------------------------------------------------------

describe('fitBook — chapter element renders an ordinary spread-title page', () => {
  function twoChapterBook(language: 'es' | 'en') {
    const manifest = makeManifest(
      { a: photo('2021-06-01'), b: photo('2022-06-01') },
      { language },
    );
    const outline = makeOutline([
      chapterElement(CH1, 'February 2021 – February 2022'),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June 2021', memoryIds: ['a'] }),
      chapterElement(CH2, 'March–June 2022'),
      makeElement({ id: 'backbone:2022-06', kind: 'backbone', title: 'June 2022', memoryIds: ['b'] }),
    ]);
    return { manifest, outline };
  }

  it('es: kicker/title come from chapter furniture and the subtitle is localized', () => {
    const { manifest, outline } = twoChapterBook('es');
    const { document } = fitBook(outline, manifest);
    const titles = document.pages.filter((p) => p.templateId === 'spread-title');
    expect(titles.map((p) => p.sourceElementId)).toEqual(['chapter:1', 'chapter:2']);
    expect(titles[0].id).toBe('chapter:1:title');
    expect(titles[0].params).toMatchObject({
      kicker: 'capítulo uno',
      title: 'Tu primer año',
      subtitle: 'febrero 2021 – febrero 2022',
      titleMode: 'descriptive',
    });
    expect(titles[1].params).toMatchObject({ kicker: 'capítulo dos', title: 'Tu segundo año', subtitle: 'marzo–junio 2022' });
  });

  it('en: "chapter one" / "Year One" (the worker\'s English fallback title is NOT used)', () => {
    const { manifest, outline } = twoChapterBook('en');
    outline.elements[0].title = 'Some stale fallback';
    const { document } = fitBook(outline, manifest);
    const first = document.pages.find((p) => p.templateId === 'spread-title')!;
    expect(first.params).toMatchObject({ kicker: 'chapter one', title: 'Year One', subtitle: 'February 2021 – February 2022', titleMode: 'descriptive' });
  });

  it('sits in reading order before its first section, and is followed by content', () => {
    const { manifest, outline } = twoChapterBook('en');
    const { document } = fitBook(outline, manifest);
    expect(document.pages.map((p) => p.sourceElementId)).toEqual(['chapter:1', 'backbone:2021-06', 'chapter:2', 'backbone:2022-06']);
    expect(auditBookDocument(document, outline, manifest)).toEqual([]);
  });

  it('sectionTitle:<id> and eyebrow:<id> edits apply to a chapter title page like any spread-title', () => {
    const { manifest, outline } = twoChapterBook('en');
    const { document } = fitBook(outline, manifest);
    const { document: edited, skipped } = applyPostFit(document, {
      text: {
        'sectionTitle:chapter:1': { target: 'sectionTitle:chapter:1', value: 'The first lap' },
        'eyebrow:chapter:1': { target: 'eyebrow:chapter:1', value: 'before walking' },
      },
    } as never);
    expect(skipped).toEqual([]);
    const page = edited.pages.find((p) => p.id === 'chapter:1:title')!;
    expect(page.params.title).toBe('The first lap');
    expect(page.params.kicker).toBe('before walking');
  });

  it('dissolves a chapter whose sections retain no content (no orphan title page)', () => {
    const manifest = makeManifest({ a: photo('2021-06-01'), c: photo('2023-06-01') });
    const outline = makeOutline([
      chapterElement(CH1),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', memoryIds: ['a'] }),
      chapterElement(CH2),
      makeElement({ id: 'backbone:2022-06', kind: 'backbone', memoryIds: [] }), // emptied upstream
      chapterElement(CH3),
      makeElement({ id: 'backbone:2023-06', kind: 'backbone', memoryIds: ['c'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.map((p) => p.sourceElementId)).toEqual(['chapter:1', 'backbone:2021-06', 'chapter:3', 'backbone:2023-06']);
    expect(auditBookDocument(document, outline, manifest).filter((v) => v.check === 'section-title-orphan')).toEqual([]);
  });

  it('dissolves a TRAILING chapter with nothing behind it before the closing', () => {
    const manifest = makeManifest({ a: photo('2021-06-01') });
    const outline = makeOutline([
      chapterElement(CH1),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', memoryIds: ['a'] }),
      chapterElement(CH2),
      makeElement({ id: 'closing', kind: 'closing', title: 'Closing' }),
    ]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.sourceElementId === 'chapter:2')).toBe(false);
    expect(document.pages.some((p) => p.templateId === 'closing')).toBe(true);
    expect(auditBookDocument(document, outline, manifest).filter((v) => v.check === 'section-title-orphan')).toEqual([]);
  });

  it('a page-cap squeeze that empties chapters dissolves their titles instead of orphaning them', () => {
    const { manifest, outline } = threeChapterBook([30, 3, 30]);
    const { document, capacity } = fitBook(outline, manifest, { maxPages: 2 });
    // Photo-only pools are cut nearly to nothing (floors yield last): at most one chapter keeps content, the rest dissolve.
    expect(capacity.omittedMemoryIds.length).toBeGreaterThanOrEqual(60);
    expect(document.pages.filter((p) => p.templateId === 'spread-title').length).toBeLessThanOrEqual(1);
    expect(auditBookDocument(document, outline, manifest).filter((v) => v.check === 'section-title-orphan')).toEqual([]);
    // A milder squeeze keeps every non-empty chapter's title.
    const mild = fitBook(outline, manifest, { maxPages: 12 });
    expect(mild.document.pages.filter((p) => p.templateId === 'spread-title')).toHaveLength(3);
  });

  it('parity: chapter titles add no forced blank — they follow themed spread-title behaviour', () => {
    const { manifest, outline } = twoChapterBook('en');
    const { document } = fitBook(outline, manifest);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toEqual([]);
  });
});

describe('fitBook — a lone chapter element is ignored (chapter mode needs >= 2)', () => {
  it('lays out identically to the same outline without it, including under cap demotion', () => {
    const { outline, manifest } = buildSyntheticYearBook({ scopeKind: 'age-year' });
    const withChapter: BookOutline = {
      ...outline,
      elements: [
        ...outline.elements.slice(0, 3),
        chapterElement({ ageYear: 2, startMonth: '2024-02', endMonth: '2025-02' }),
        ...outline.elements.slice(3),
      ],
    };
    for (const maxPages of [undefined, 150]) {
      const options = maxPages === undefined ? {} : { maxPages };
      const base = fitBook(outline, manifest, options);
      const lone = fitBook(withChapter, manifest, options);
      expect(lone.capacity).toEqual(base.capacity);
      expect(lone.document).toEqual(base.document);
      expect(lone.gaps).toEqual(base.gaps);
    }
    expect(fitBook(outline, manifest).capacity.omittedMemoryIds.length).toBeGreaterThan(0); // the default cap really did bite
  });

  it('a chapter element without month bounds does not count toward chapter mode', () => {
    const { outline, manifest } = buildSyntheticYearBook({ scopeKind: 'age-year' });
    const bad = { id: 'chapter:1', kind: 'chapter', title: 'x', memoryIds: [], rationale: {} } as OutlineElement;
    const withTwo: BookOutline = { ...outline, elements: [outline.elements[0], bad, { ...bad, id: 'chapter:2' }, ...outline.elements.slice(1)] };
    const base = fitBook(outline, manifest);
    const result = fitBook(withTwo, manifest);
    expect(result.capacity.omittedMemoryIds).toEqual(base.capacity.omittedMemoryIds);
    expect(result.document.pages.map((p) => p.id)).toEqual(base.document.pages.map((p) => p.id));
  });
});

// ---------------------------------------------------------------------------
// 2.3 — chapter-mode budgeting (plan)
// ---------------------------------------------------------------------------

describe('planChapterDemotions — proportional budget across chapters', () => {
  it('10/30/60 equal-engagement memories: omissions are proportional (+-1) and the 10-memory chapter stays at its floor', () => {
    const { manifest, outline, ids } = threeChapterBook([10, 30, 60]);
    const plan = planChapterDemotions(outline, manifest);
    // Every chapter-A step (floors honoured) first.
    const prefix = plan.filter((d) => d.tier === 'A');
    expect(prefix.length).toBeGreaterThan(40);
    // Up to the point where chapter 2 reaches its own floor (12 kept of 30 -> 18 cuts, ~54 total at equal keep-rate).
    for (const k of [15, 30, 45, 50]) {
      const counts = omittedPerChapter(plan.slice(0, k).map((d) => d.id), ids);
      expect(counts[0]).toBe(0); // chapter 1: floor = min(10, 12) = 10 -> untouchable while any chapter is above its floor
      const share2 = (counts[1] + counts[2]) * (30 / 90);
      expect(Math.abs(counts[1] - share2)).toBeLessThanOrEqual(1);
      expect(Math.abs(counts[2] - (counts[1] + counts[2]) * (60 / 90))).toBeLessThanOrEqual(1);
    }
  });

  it('floors: chapter A-tier steps never take a chapter below min(total, 12) kept', () => {
    const { manifest, outline, ids } = threeChapterBook([20, 30, 60]);
    const plan = planChapterDemotions(outline, manifest);
    const tierA = plan.filter((d) => d.tier === 'A').map((d) => d.id);
    const counts = omittedPerChapter(tierA, ids);
    ids.forEach((chapterIds, c) => expect(chapterIds.length - counts[c]).toBeGreaterThanOrEqual(Math.min(chapterIds.length, 12)));
    // ...and the next tiers keep going until the pools are empty.
    expect(plan.length).toBeGreaterThan(tierA.length);
  });

  it('all-zero engagement inside a chapter: omissions spread across months instead of cutting the earliest first', () => {
    // Chapter 1 is a throwaway so chapter mode is on; chapter 2 has 6 months x 8 identical-rank memories.
    const months = ['2022-03', '2022-04', '2022-05', '2022-06', '2022-07', '2022-08'];
    const a = monthlyBook(CH1, ['2021-04'], [4]);
    const b = monthlyBook(CH2, months, months.map(() => 8));
    const manifest = makeManifest({ ...a.memories, ...b.memories });
    const outline = makeOutline([...a.elements, ...b.elements]);
    const plan = planChapterDemotions(outline, manifest);
    const firstSixteen = plan.slice(0, 16);
    const perMonth = months.map((m) => firstSixteen.filter((d) => d.id.startsWith(`c2-${m}`)).length);
    expect(Math.max(...perMonth) - Math.min(...perMonth)).toBeLessThanOrEqual(1);
    // Date-ordered (earliest-first) behaviour would have emptied the first two months entirely.
    expect(perMonth[0]).toBeLessThan(6);
  });

  it('time-spread tie-break: highest remaining fraction, then highest remaining count, then id ascending', () => {
    // Chapter 2: month X has 4 memories, month Y has 8 (both fraction 1.0 initially) -> Y's count wins first.
    const a = monthlyBook(CH1, ['2021-04'], [4]);
    const b = monthlyBook(CH2, ['2022-04', '2022-05'], [4, 8]);
    const manifest = makeManifest({ ...a.memories, ...b.memories });
    const outline = makeOutline([...a.elements, ...b.elements]);
    const plan = planChapterDemotions(outline, manifest).filter((d) => d.chapterIndex === 1);
    expect(plan[0].id.startsWith('c2-2022-05')).toBe(true); // bigger month first on a fraction tie
    expect(plan[1].id.startsWith('c2-2022-04')).toBe(true); // Y fell to 7/8 < X 4/4
    // Same fraction and count -> memory id ascending.
    const equal = monthlyBook(CH2, ['2022-04', '2022-05'], [4, 4]);
    const manifest2 = makeManifest({ ...a.memories, ...equal.memories });
    const outline2 = makeOutline([...a.elements, ...equal.elements]);
    const plan2 = planChapterDemotions(outline2, manifest2).filter((d) => d.chapterIndex === 1);
    expect(plan2[0].id).toBe('c2-2022-04-00');
  });

  it('months outside every chapter clamp to the first / last chapter', () => {
    const a = monthlyBook(CH1, ['2021-04'], [6]);
    const b = monthlyBook(CH2, ['2022-04'], [6]);
    const manifest = makeManifest({
      ...a.memories,
      ...b.memories,
      early: photo('2020-12-05'),
      late: photo('2030-01-05'),
    });
    const outline = makeOutline([
      ...a.elements,
      ...b.elements,
      makeElement({ id: 'backbone:2020-12', kind: 'backbone', memoryIds: ['early'] }),
      makeElement({ id: 'backbone:2030-01', kind: 'backbone', memoryIds: ['late'] }),
    ]);
    const byId = new Map(planChapterDemotions(outline, manifest).map((d) => [d.id, d]));
    expect(byId.get('early')?.chapterIndex).toBe(0);
    expect(byId.get('late')?.chapterIndex).toBe(1);
  });

  it('protects hero/panorama nominees, milestone holders and quote-title sources; never plans firsts', () => {
    const a = monthlyBook(CH1, ['2021-04'], [8]);
    const b = monthlyBook(CH2, ['2022-04'], [8]);
    const memories = { ...a.memories, ...b.memories };
    memories['c1-2021-04-00'] = captioned('2021-04-01', 'hero caption');
    memories['c1-2021-04-01'] = captioned('2021-04-02', 'milestone caption');
    memories['c1-2021-04-01'].milestones = [{ id: 'first-steps', name: 'First steps', detail: '' }];
    memories['c1-2021-04-02'] = captioned('2021-04-03', 'quote source');
    const manifest = makeManifest(memories);
    const outline = makeOutline([...a.elements, ...b.elements], { heroCandidates: ['c1-2021-04-00'] });
    outline.elements[1].titleSourceMemoryId = 'c1-2021-04-02';
    const planned = new Set(planChapterDemotions(outline, manifest).map((d) => d.id));
    for (const protectedId of ['c1-2021-04-00', 'c1-2021-04-01', 'c1-2021-04-02']) expect(planned.has(protectedId)).toBe(false);
  });

  it('is empty without two chapter elements', () => {
    const { manifest, outline } = threeChapterBook([10, 30, 60]);
    const lone: BookOutline = { ...outline, elements: outline.elements.filter((e) => e.id !== 'chapter:2' && e.id !== 'chapter:3') };
    expect(planChapterDemotions(lone, manifest)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2.3 — Tier C (captioned photo/video demotion, last resort, chapter mode only)
// ---------------------------------------------------------------------------

describe('chapter-mode Tier C (captioned photo/video demotion)', () => {
  it('is enabled by default', () => {
    expect(ENABLE_TIER_C_CAPTIONED_DEMOTION).toBe(true);
  });

  /** Chapter 1: month X (photo-only + sacred text), month Z (photo-only pair + text), chapter 2: month Y (all captioned). */
  function tierOrderingBook() {
    const text = (date: string) => makeMemory({ date, type: 'text_only', text: 'A short note from the parent.' });
    const memories: Record<string, ManifestMemory> = {
      'x-p1': photo('2021-04-01'),
      'x-t1': text('2021-04-02'),
      'x-t2': text('2021-04-03'),
      'z-p1': photo('2021-07-01'),
      'z-p2': photo('2021-07-02'),
      'z-t1': text('2021-07-03'),
      'y-c1': captioned('2022-04-01', 'one'),
      'y-c2': captioned('2022-04-02', 'two'),
      'y-c3': captioned('2022-04-03', 'three'),
      'y-t1': text('2022-04-04'),
    };
    const manifest = makeManifest(memories);
    const outline = makeOutline([
      chapterElement(CH1),
      makeElement({ id: 'backbone:2021-04', kind: 'backbone', memoryIds: ['x-p1', 'x-t1', 'x-t2'] }),
      makeElement({ id: 'backbone:2021-07', kind: 'backbone', memoryIds: ['z-p1', 'z-p2', 'z-t1'] }),
      chapterElement(CH2),
      makeElement({ id: 'backbone:2022-04', kind: 'backbone', memoryIds: ['y-c1', 'y-c2', 'y-c3', 'y-t1'] }),
    ]);
    return { manifest, outline };
  }

  it('takes part in the keep-rate balance (Phase 2c): a chapter whose ordinary pool is empty keeps being cut from Tier C while the other chapter is cut from its ordinary pool', () => {
    const { manifest, outline } = tierOrderingBook();
    const plan = planChapterDemotions(outline, manifest);
    // Both chapters hold <= 12 memories, so their chapter floors equal their totals: the balanced levels are
    // empty from the start and every step is chosen at the relaxed level (section floor 1) over BOTH pools,
    // by chapter keep-rate. Before Phase 2c the whole ordinary pool (x-p1, z-p1, z-p2) went first and chapter 2
    // (caption-only) stayed untouched until chapter 1 was exhausted.
    expect(plan.map((d) => `${d.id}:${d.tier}`)).toEqual([
      'x-p1:B1', // ch1 6/6 vs ch2 4/4: tie -> larger chapter; ordinary before Tier C inside it
      'y-c1:C', // ch1 is now at 5/6, ch2 (4/4) leads: its only pool is Tier C
      'z-p1:B1',
      'y-c2:C',
      'z-p2:B1', // section z goes 3 -> 2 -> 1 (the relaxed level's floor)
      'x-t1:C', // ch1 3/6 == ch2 2/4: larger chapter first; its ordinary pool is empty -> Tier C
      'y-c3:C',
      'x-t2:C',
      'y-t1:C',
      'z-t1:C',
    ]);
    // The two chapters stay within one memory of each other's keep-rate at every prefix until a chapter is exhausted.
    const chapterOf = (id: string) => (id.startsWith('y') ? 1 : 0);
    const totals = [6, 4];
    const omitted = [0, 0];
    for (const d of plan.slice(0, 6)) {
      omitted[chapterOf(d.id)]++;
      const rates = omitted.map((o, c) => (totals[c] - o) / totals[c]);
      expect(Math.abs(rates[0] - rates[1])).toBeLessThanOrEqual(1 / 4 + 1e-9);
    }
  });

  it("the measuring switch (tierCAfterB2) restores the literal 'ordinary pool first, Tier C only once it is empty' order", () => {
    const { manifest, outline } = tierOrderingBook();
    const literal = planChapterDemotions(outline, manifest, { tierCAfterB2: true });
    expect(literal.map((d) => `${d.id}:${d.tier}`)).toEqual([
      'x-p1:B1',
      'z-p1:B1',
      'z-p2:B1', // the whole ordinary pool first ...
      'y-c1:C', // ... then Tier C, balanced by keep-rate over the same ladder
      'y-c2:C',
      'x-t1:C',
      'y-c3:C',
      'x-t2:C',
      'y-t1:C',
      'z-t1:C',
    ]);
  });

  it('ranks by engagement, then shorter text first', () => {
    const memories: Record<string, ManifestMemory> = {
      a1: photo('2021-04-01'),
      a2: photo('2021-04-02'),
      'long-0': captioned('2022-04-01', 'a rather long caption '.repeat(5), 0),
      'short-0': captioned('2022-04-02', 'tiny', 0),
      'mid-0': captioned('2022-04-03', 'a medium caption here', 0),
      'short-9': captioned('2022-04-04', 'tiny', 9),
    };
    const manifest = makeManifest(memories);
    const outline = makeOutline([
      chapterElement(CH1),
      makeElement({ id: 'backbone:2021-04', kind: 'backbone', memoryIds: ['a1', 'a2'] }),
      chapterElement(CH2),
      makeElement({ id: 'backbone:2022-04', kind: 'backbone', memoryIds: ['long-0', 'short-0', 'mid-0', 'short-9'] }),
    ]);
    const cOrder = planChapterDemotions(outline, manifest).filter((d) => d.tier === 'C').map((d) => d.id);
    expect(cOrder).toEqual(['short-0', 'mid-0', 'long-0', 'short-9']);
  });

  it('fitBook with the flag off: the same caption-heavy book is returned over the cap, nothing demoted', () => {
    const build = (date: string, i: number) => captioned(date, `caption number ${i}`);
    const { manifest, outline } = threeChapterBook([60, 60, 60], build);
    const withC = fitBook(outline, manifest, { maxPages: 60 });
    expect(withC.capacity.overCap).toBe(false);
    expect(withC.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    expect(withC.gaps.filter((g) => g.reason.startsWith('Omitted (captioned ')).length).toBe(withC.capacity.omittedMemoryIds.length);

    const without = fitBook(outline, manifest, { maxPages: 60, tierCCaptionedDemotion: false });
    expect(without.capacity.overCap).toBe(true);
    expect(without.capacity.omittedMemoryIds).toEqual([]);
    expect(planChapterDemotions(outline, manifest, { tierC: false })).toEqual([]);
  });

  it('is never used when the ordinary pools already reach the cap', () => {
    const { manifest, outline } = threeChapterBook([30, 30, 30]); // all photo-only: nothing captioned to cut
    const result = fitBook(outline, manifest, { maxPages: 25 });
    expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    expect(result.gaps.some((g) => g.reason.includes('captioned'))).toBe(false);
  });

  it('never applies to a book without chapters (legacy loop untouched: captioned memories are never cut)', () => {
    const build = (date: string, i: number) => captioned(date, `caption number ${i}`);
    const { manifest, outline } = threeChapterBook([60, 60, 60], build);
    const legacy: BookOutline = { ...outline, elements: outline.elements.filter((e) => e.kind !== 'chapter') };
    const result = fitBook(legacy, manifest, { maxPages: 60 });
    expect(result.capacity.overCap).toBe(true);
    expect(result.capacity.omittedMemoryIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2.3 — fitBook plan/prefix search
// ---------------------------------------------------------------------------

describe('fitBook — chapter mode prefix search', () => {
  it('omittedMemoryIds is a prefix of planChapterDemotions, one chapter-aware gap per omission', () => {
    const { manifest, outline } = threeChapterBook([20, 40, 80]);
    const result = fitBook(outline, manifest, { maxPages: 40 });
    const plan = planChapterDemotions(outline, manifest);
    const k = result.capacity.omittedMemoryIds.length;
    expect(k).toBeGreaterThan(0);
    expect(result.capacity.omittedMemoryIds).toEqual(plan.slice(0, k).map((d) => d.id));
    const omissionGaps = result.gaps.filter((g) => g.reason.startsWith('Omitted ('));
    expect(omissionGaps).toHaveLength(k);
    expect(omissionGaps.every((g) => /chapter [123],/.test(g.reason) && g.memoryIds.length === 1)).toBe(true);
    expect(result.capacity.overCap).toBe(false);
    expect(result.document.totalPages).toBeLessThanOrEqual(40);
  });

  it('uses the shortest prefix that fits (one fewer omission would be over the cap)', () => {
    const { manifest, outline } = threeChapterBook([20, 40, 80]);
    const cap = 40;
    const result = fitBook(outline, manifest, { maxPages: cap });
    const k = result.capacity.omittedMemoryIds.length;
    const plan = planChapterDemotions(outline, manifest);
    // Re-fit with a cap one page lower: it needs at least as many omissions.
    const tighter = fitBook(outline, manifest, { maxPages: result.document.totalPages - 1 });
    expect(tighter.capacity.omittedMemoryIds.length).toBeGreaterThanOrEqual(k);
    expect(plan.length).toBeGreaterThanOrEqual(k);
  });

  it('exhausted plan: returns the full list as overCap, like the legacy loop', () => {
    // Every month keeps one sacred (milestone) text-only memory, so the pools run dry while still over the cap.
    const sacred = (date: string) => makeMemory({ date, type: 'text_only', text: 'A short note.', milestones: [{ id: 'first-steps', name: 'First steps', detail: '' }] });
    const { manifest, outline } = threeChapterBook([20, 40, 80], (date, i) => (i === 0 ? sacred(date) : photo(date)));
    const result = fitBook(outline, manifest, { maxPages: 3 });
    expect(result.capacity.overCap).toBe(true);
    expect(result.capacity.omittedMemoryIds).toEqual(planChapterDemotions(outline, manifest).map((d) => d.id));
  });

  it('under the cap: no omissions and exactly one fit (chapter pages still render)', () => {
    const { manifest, outline } = threeChapterBook([6, 6, 6]);
    let fits = 0;
    const result = fitBook(outline, manifest, { onRunFit: () => fits++ });
    expect(result.capacity.omittedMemoryIds).toEqual([]);
    expect(fits).toBe(1);
    expect(result.document.pages.filter((p) => p.templateId === 'spread-title')).toHaveLength(3);
  });

  it('is deterministic', () => {
    const { manifest, outline } = threeChapterBook([20, 40, 80]);
    const a = fitBook(outline, manifest, { maxPages: 40 });
    const b = fitBook(outline, manifest, { maxPages: 40 });
    expect(b).toEqual(a);
  });

  it('equal keep-rates at fit level: per-chapter omitted share tracks chapter size (10/30/60, floor on the small chapter)', () => {
    const { manifest, outline, ids } = threeChapterBook([10, 30, 60]);
    const result = fitBook(outline, manifest, { maxPages: 45 });
    expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
    const counts = omittedPerChapter(result.capacity.omittedMemoryIds, ids);
    expect(counts[0]).toBe(0);
    const total = counts[1] + counts[2];
    expect(Math.abs(counts[1] - total / 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(counts[2] - (2 * total) / 3)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2.8 — the ~600-memory, 5-chapter Everything fixture
// ---------------------------------------------------------------------------

describe('synthetic Everything book (600 memories, 5 chapters, quarter sections)', () => {
  // Phase 2b: the worker now emits fixed 3-month backbone blocks, so the main
  // fixture uses that shape (the old merge-until-3-printable monthly shape
  // meant ~46 sections whose floors alone ate the budget — finding A).
  const book = buildSyntheticEverythingBook({ quarterSections: true });
  const { outline, manifest, memoryIdsByChapter } = book;
  let fits = 0;
  const result = fitBook(outline, manifest, { onRunFit: () => fits++ });
  const omitted = new Set(result.capacity.omittedMemoryIds);

  it('the fixture has the intended shape', () => {
    expect(memoryIdsByChapter.map((ids) => ids.length)).toEqual([180, 144, 120, 84, 72]);
    expect(outline.elements.filter((e) => e.kind === 'chapter')).toHaveLength(5);
    const all = Object.values(manifest.memories);
    expect(all.length).toBeGreaterThanOrEqual(595);
    const withMedia = all.filter((m) => m.assets.length > 0).length / all.length;
    const illustrated = all.filter((m) => m.illustration).length / all.length;
    expect(withMedia).toBeGreaterThan(0.72);
    expect(withMedia).toBeLessThan(0.86);
    expect(illustrated).toBeGreaterThan(0.12);
    expect(illustrated).toBeLessThan(0.22);
    expect(all.filter((m) => m.milestones.length > 0)).toHaveLength(23);
    const engaged = all.filter((m) => m.engagement > 0).length / all.length;
    expect(engaged).toBeGreaterThan(0.12);
    expect(engaged).toBeLessThan(0.28);
  });

  it('fits within the 122-page cap with a clean integrity audit', () => {
    expect(result.capacity.overCap).toBe(false);
    expect(result.document.totalPages).toBeLessThanOrEqual(122);
    expect(result.document.totalPages % 2).toBe(0);
    expect(auditBookDocument(result.document, outline, manifest)).toEqual([]);
  });

  it('every chapter keeps at least its floor and its title page', () => {
    memoryIdsByChapter.forEach((ids, c) => {
      const kept = ids.filter((id) => !omitted.has(id)).length;
      expect(kept).toBeGreaterThanOrEqual(Math.min(ids.length, 12));
      expect(result.document.pages.some((p) => p.id === `chapter:${c + 1}:title`)).toBe(true);
    });
  });

  it('keep-rates stay close across chapters (month floors and protected memories bound how close)', () => {
    const rates = memoryIdsByChapter.map((ids) => 1 - ids.filter((id) => omitted.has(id)).length / ids.length);
    expect(Math.max(...rates) - Math.min(...rates)).toBeLessThanOrEqual(0.1);
  });

  it('needs ~log(n) fits, not one per omission', () => {
    expect(result.capacity.omittedMemoryIds.length).toBeGreaterThan(300);
    expect(fits).toBeLessThanOrEqual(25);
  });

  it('one chapter-aware gap per omission; omissions are a plan prefix', () => {
    const omissionGaps = result.gaps.filter((g) => g.reason.startsWith('Omitted ('));
    expect(omissionGaps).toHaveLength(omitted.size);
    expect(omissionGaps.every((g) => /chapter [1-5],/.test(g.reason))).toBe(true);
    const plan = planChapterDemotions(outline, manifest);
    expect(result.capacity.omittedMemoryIds).toEqual(plan.slice(0, omitted.size).map((d) => d.id));
  });

  it('Tier C is what makes the realistic caption-heavy mix fit: without it the ordinary pools run out over the cap', () => {
    let noCFits = 0;
    const noC = fitBook(outline, manifest, { tierCCaptionedDemotion: false, onRunFit: () => noCFits++ });
    expect(noC.capacity.overCap).toBe(true);
    expect(noC.document.totalPages).toBeGreaterThan(122);
    expect(noC.gaps.some((g) => g.reason.includes('captioned'))).toBe(false);
    // With the flag on, captioned memories are among the omissions — and only ever the unprotected ones.
    const captionedOmitted = [...omitted].filter((id) => manifest.memories[id]?.text && manifest.memories[id].assets.length > 0 && !manifest.memories[id].illustration);
    expect(captionedOmitted.length).toBeGreaterThan(0);
    for (const id of captionedOmitted) {
      expect(manifest.memories[id].milestones).toHaveLength(0);
      expect(outline.heroCandidates ?? []).not.toContain(id);
      expect(outline.panoramaCandidates ?? []).not.toContain(id);
    }
  });

  it('es books render Spanish chapter furniture and still fit and audit clean', () => {
    const es = buildSyntheticEverythingBook({ language: 'es', quarterSections: true });
    const r = fitBook(es.outline, es.manifest);
    expect(r.capacity.overCap).toBe(false);
    expect(auditBookDocument(r.document, es.outline, es.manifest)).toEqual([]);
    const chapterPages = r.document.pages.filter((p) => /^chapter:\d+:title$/.test(p.id));
    expect(chapterPages.map((p) => p.params.title)).toEqual(['Tu primer año', 'Tu segundo año', 'Tu tercer año', 'Tu cuarto año', 'Tu quinto año']);
    expect(chapterPages.map((p) => p.params.kicker)).toEqual(['capítulo uno', 'capítulo dos', 'capítulo tres', 'capítulo cuatro', 'capítulo cinco']);
  });
});
