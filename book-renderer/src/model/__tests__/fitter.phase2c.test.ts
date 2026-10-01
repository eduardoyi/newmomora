import { describe, expect, it } from 'vitest';
import {
  CHAPTER_MAX_ASSETS_PER_MEMORY,
  capManifestAssetsForChapterMode,
  fitBook,
  planChapterDemotions,
  shownAssetIndexes,
} from '../fitter';
import { auditBookDocument, summarizeAssetCoverage } from '../audit';
import { applyPreFit, slotKey } from '../edits';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import type { BookDocument, BookPage, ManifestMemory, OutlineElement, PhotoSlotContent } from '../types';

/**
 * Memory Book — Everything Phase 2c (chapter mode only): balance across ALL
 * demotable memories (ordinary + Tier C), the 2-assets-per-memory photo cap,
 * and the compact firsts section. Year / calendar / legacy books are pinned
 * by fitter.golden.test.ts and must not move.
 */

const CH1 = { ageYear: 1, startMonth: '2021-02', endMonth: '2022-02' };
const CH2 = { ageYear: 2, startMonth: '2022-03', endMonth: '2023-02' };
const CH3 = { ageYear: 3, startMonth: '2023-03', endMonth: '2024-02' };
const chapterEl = (meta: typeof CH1): OutlineElement =>
  makeElement({ id: `chapter:${meta.ageYear}`, kind: 'chapter', title: `Year ${meta.ageYear}`, subtitle: 'sub', chapter: meta });

const photo = (date: string, engagement = 0): ManifestMemory => makeMemory({ date, engagement, assets: [makeAsset({ aspectRatio: 1 })] });
const captioned = (date: string, text: string, engagement = 0): ManifestMemory =>
  makeMemory({ date, engagement, text, assets: [makeAsset({ aspectRatio: 1 })] });

const photoSlots = (page: BookPage): PhotoSlotContent[] => page.slots.filter((s) => s.kind === 'photo').map((s) => s.content as PhotoSlotContent);
const allPhotoSlots = (doc: BookDocument): PhotoSlotContent[] => doc.pages.flatMap(photoSlots);
const assetFilesOf = (doc: BookDocument, memoryId: string): string[] =>
  allPhotoSlots(doc)
    .filter((s) => s.memoryId === memoryId)
    .map((s) => s.assetFile);

/** `n` memories in `sectionCount` backbone sections of one chapter, ids `<prefix>-<i>`; `build(i)` makes memory i. */
function chapterBlock(
  meta: typeof CH1,
  prefix: string,
  n: number,
  build: (date: string, i: number) => ManifestMemory,
  sectionCount = 4,
) {
  const memories: Record<string, ManifestMemory> = {};
  const sections: string[][] = Array.from({ length: sectionCount }, () => []);
  const baseYear = Number(meta.startMonth.slice(0, 4));
  const months = [3, 4, 5, 6, 7, 8, 9, 10].slice(0, sectionCount);
  for (let i = 0; i < n; i++) {
    const s = i % sectionCount;
    const id = `${prefix}-${String(i).padStart(3, '0')}`;
    memories[id] = build(`${baseYear}-${String(months[s]).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`, i);
    sections[s].push(id);
  }
  const elements: OutlineElement[] = [chapterEl(meta)];
  sections.forEach((ids, s) => {
    elements.push(makeElement({ id: `backbone:${prefix}-${s}`, kind: 'backbone', title: `${prefix}-${s}`, memoryIds: ids }));
  });
  return { memories, elements, ids: Object.keys(memories) };
}

// ---------------------------------------------------------------------------
// 1. Balance across ALL demotable memories (ordinary + Tier C)
// ---------------------------------------------------------------------------

describe('planChapterDemotions — Phase 2c balance over ordinary + Tier C', () => {
  /**
   * 10 / 50 / 100 memories (the 10/30/60 shape, scaled so one memory is <= 2 points of keep-rate).
   * Chapter 2: 15 ordinary (photo-only) + 35 captioned (Tier C). Chapter 3: 20 ordinary + 80 captioned:
   * the later chapters' ordinary pools are SMALL and their Tier C pools LARGE — the real-book skew.
   */
  function skewedBook() {
    const a = chapterBlock(CH1, 'a', 10, (d) => photo(d));
    const b = chapterBlock(CH2, 'b', 50, (d, i) => (i < 15 ? photo(d) : captioned(d, `caption b${i}`)));
    const c = chapterBlock(CH3, 'c', 100, (d, i) => (i < 20 ? photo(d) : captioned(d, `caption c${i}`)));
    const manifest = makeManifest({ ...a.memories, ...b.memories, ...c.memories });
    const outline = makeOutline([...a.elements, ...b.elements, ...c.elements]);
    return { manifest, outline, ids: [a.ids, b.ids, c.ids] };
  }

  it('keep-rates of the cuttable chapters stay within 2 points at every prefix (until the floors are reached)', () => {
    const { manifest, outline, ids } = skewedBook();
    const plan = planChapterDemotions(outline, manifest);
    const totals = ids.map((x) => x.length);
    const omitted = [0, 0, 0];
    let checked = 0;
    for (const d of plan) {
      omitted[d.chapterIndex]++;
      const rates = omitted.map((o, c) => (totals[c] - o) / totals[c]);
      // While both chapters 2 and 3 are still above their floor (12 kept), they track each other.
      if (totals[1] - omitted[1] > 12 && totals[2] - omitted[2] > 12) {
        expect(Math.abs(rates[1] - rates[2])).toBeLessThanOrEqual(0.02 + 1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(80); // the property was exercised across ~all cuts, not vacuously
    // The 10-memory chapter sits at its floor (=10) and is untouched until every other level is spent.
    expect(plan.slice(0, 120).some((d) => d.chapterIndex === 0)).toBe(false);
  });

  it('Tier C is taken from the chapter that is ahead on keep-rate even though another chapter still has ordinary candidates', () => {
    const { manifest, outline, ids } = skewedBook();
    const plan = planChapterDemotions(outline, manifest);
    // Chapter 3 owns only 20 ordinary memories but must give up ~2x as many as chapter 2 (100 vs 50 memories):
    // the extra cuts MUST come from its Tier C pool while chapter 2 still has ordinary cuttables left.
    const firstC = plan.findIndex((d) => d.tier === 'C' && d.chapterIndex === 2);
    expect(firstC).toBeGreaterThan(-1);
    const ordinaryLeftInCh2 = plan.slice(firstC).filter((d) => d.chapterIndex === 1 && d.tier !== 'C').length;
    expect(ordinaryLeftInCh2).toBeGreaterThan(0);
    // ... and ordinary memories are always taken before Tier C inside the same chapter at a given level.
    const ch3 = plan.filter((d) => d.chapterIndex === 2);
    expect(ch3[0].tier).toBe('A');
    expect(ids[2].length).toBe(100);
  });

  it('chapter floors are never violated while any chapter still has a candidate above its floor (B1 no longer runs before Tier C)', () => {
    // Chapter 1: 20 ordinary photos. Chapter 2: 20 captioned photos (all Tier C). Sections of 4-5: section floors never bind first.
    const a = chapterBlock(CH1, 'a', 20, (d) => photo(d), 4);
    const b = chapterBlock(CH2, 'b', 20, (d, i) => captioned(d, `caption ${i}`), 4);
    const c = chapterBlock(CH3, 'c', 30, (d, i) => (i % 2 === 0 ? photo(d) : captioned(d, `caption ${i}`)), 4);
    const manifest = makeManifest({ ...a.memories, ...b.memories, ...c.memories });
    const outline = makeOutline([...a.elements, ...b.elements, ...c.elements]);
    const plan = planChapterDemotions(outline, manifest);
    const totals = [20, 20, 30];
    const floors = totals.map((t) => Math.min(t, 12));
    const remaining = [...totals];
    for (const d of plan) {
      const before = [...remaining];
      remaining[d.chapterIndex]--;
      if (remaining[d.chapterIndex] < floors[d.chapterIndex]) {
        // The first cut that goes below a floor may only happen once EVERY chapter is already at its floor.
        expect(before.every((r, c) => r <= floors[c])).toBe(true);
        break;
      }
    }
    // Sanity: the plan did continue past the floors (everything demotable is eventually listed).
    expect(plan.length).toBeGreaterThan(totals.reduce((s, t, c) => s + t - floors[c], 0));
  });

  it('counts FIRSTS members in their own chapter total (never demoted, but kept: they dilute its keep-rate and count toward its floor)', () => {
    // Chapter 1 has 12 backbone photos + 8 firsts (20 memories, floor 12): 8 cuts respect the floor. Counting only the
    // 12 backbone memories (total 12, floor 12) there would be no above-floor cut at all.
    const a = chapterBlock(CH1, 'a', 12, (d) => photo(d), 3);
    const b = chapterBlock(CH2, 'b', 40, (d) => photo(d), 4);
    const firstsMemories: Record<string, ManifestMemory> = {};
    const firstsIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      firstsIds.push(`f-${i}`);
      firstsMemories[`f-${i}`] = makeMemory({ date: `2021-0${3 + (i % 5)}-${10 + i}`, assets: [makeAsset({ aspectRatio: 1 })], milestones: [{ id: `m${i}`, name: 'First', detail: '', status: 'confirmed' }] });
    }
    const manifest = makeManifest({ ...a.memories, ...b.memories, ...firstsMemories });
    const outline = makeOutline([...a.elements, ...b.elements, makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: firstsIds })]);
    const plan = planChapterDemotions(outline, manifest);
    expect(plan.some((d) => firstsIds.includes(d.id))).toBe(false); // never planned
    const ch1 = plan.filter((d) => d.chapterIndex === 0);
    expect(ch1.slice(0, 8).every((d) => d.tier === 'A')).toBe(true);
    // Chapter 1 (20 incl. firsts) and chapter 2 (40) are cut proportionally: when chapter 1's 8th cut lands, chapter 2 has lost ~16.
    const eighth = plan.indexOf(ch1[7]);
    const ch2Before = plan.slice(0, eighth).filter((d) => d.chapterIndex === 1).length;
    expect(ch2Before).toBeGreaterThanOrEqual(15);
    expect(ch2Before).toBeLessThanOrEqual(17);
    // ... and chapter 1 does not give up another memory at the same level once its floor (12 kept) is reached.
    expect(ch1.filter((d) => d.tier === 'A')).toHaveLength(8);
  });

  it('with the plan-order switch the whole ordinary pool still goes before any Tier C (documented measuring mode)', () => {
    const a = chapterBlock(CH1, 'a', 30, (d) => photo(d));
    const b = chapterBlock(CH2, 'b', 30, (d, i) => (i < 6 ? photo(d) : captioned(d, `caption ${i}`)));
    const manifest = makeManifest({ ...a.memories, ...b.memories });
    const outline = makeOutline([...a.elements, ...b.elements]);
    const literal = planChapterDemotions(outline, manifest, { tierCAfterB2: true });
    const firstC = literal.findIndex((d) => d.tier === 'C');
    expect(firstC).toBeGreaterThan(0);
    expect(literal.slice(0, firstC).every((d) => d.tier !== 'C')).toBe(true);
    expect(literal.slice(firstC).every((d) => d.tier === 'C')).toBe(true);
    // The default (balanced) order reaches Tier C earlier than the literal one.
    const balanced = planChapterDemotions(outline, manifest);
    expect(balanced.findIndex((d) => d.tier === 'C')).toBeLessThan(firstC);
  });
});

// ---------------------------------------------------------------------------
// 2. Photo cap: at most 2 assets per memory (first + middle), chapter mode only
// ---------------------------------------------------------------------------

describe('chapter-mode photo cap (<= 2 assets per memory, spread-out pick)', () => {
  it('shownAssetIndexes: n <= 2 all; otherwise first + middle, in original order', () => {
    const idx = (n: number) => shownAssetIndexes(Array.from({ length: n }, () => makeAsset()));
    expect(CHAPTER_MAX_ASSETS_PER_MEMORY).toBe(2);
    expect(idx(0)).toEqual([]);
    expect(idx(1)).toEqual([0]);
    expect(idx(2)).toEqual([0, 1]);
    expect(idx(3)).toEqual([0, 1]);
    expect(idx(4)).toEqual([0, 2]);
    expect(idx(5)).toEqual([0, 2]);
    expect(idx(6)).toEqual([0, 3]);
    expect(idx(9)).toEqual([0, 4]);
  });

  /** A two-chapter book (chapter mode) whose chapter-1 section holds the given memories. */
  function chapterBook(memories: Record<string, ManifestMemory>) {
    const ids = Object.keys(memories);
    const manifest = makeManifest({ ...memories, other: photo('2022-06-01') });
    const outline = makeOutline([
      chapterEl(CH1),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June', memoryIds: ids }),
      chapterEl(CH2),
      makeElement({ id: 'backbone:2022-06', kind: 'backbone', title: 'June', memoryIds: ['other'] }),
    ]);
    return { manifest, outline };
  }
  const assets = (n: number) => Array.from({ length: n }, () => makeAsset({ aspectRatio: 1 }));

  it('a 6-asset memory shows assets [0, 3]; a 3-asset memory shows [0, 1]; 1-2 asset memories are untouched', () => {
    const six = assets(6);
    const three = assets(3);
    const two = assets(2);
    const one = assets(1);
    const { manifest, outline } = chapterBook({
      six: makeMemory({ date: '2021-06-01', assets: six }),
      three: makeMemory({ date: '2021-06-02', assets: three }),
      two: makeMemory({ date: '2021-06-03', assets: two }),
      one: makeMemory({ date: '2021-06-04', assets: one }),
    });
    const { document } = fitBook(outline, manifest);
    expect(assetFilesOf(document, 'six').sort()).toEqual([six[0].file, six[3].file].sort());
    expect(assetFilesOf(document, 'three').sort()).toEqual([three[0].file, three[1].file].sort());
    expect(assetFilesOf(document, 'two').sort()).toEqual(two.map((a) => a.file).sort());
    expect(assetFilesOf(document, 'one')).toEqual([one[0].file]);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('a book WITHOUT chapter mode still prints every asset (the cap is chapter-only)', () => {
    const six = assets(6);
    const manifest = makeManifest({ six: makeMemory({ date: '2021-06-01', assets: six }) });
    const outline = makeOutline([makeElement({ id: 'backbone:2021-06', kind: 'backbone', memoryIds: ['six'] })]);
    const { document } = fitBook(outline, manifest);
    expect(assetFilesOf(document, 'six').sort()).toEqual(six.map((a) => a.file).sort());
    // ... and a LONE chapter element is not chapter mode either.
    const lone = makeOutline([chapterEl(CH1), makeElement({ id: 'backbone:2021-06', kind: 'backbone', memoryIds: ['six'] })]);
    expect(assetFilesOf(fitBook(lone, manifest).document, 'six')).toHaveLength(6);
  });

  it('a user-chosen (edited) asset is always one of the shown ones; the first asset keeps the other slot', () => {
    const six = assets(6);
    const { manifest, outline } = chapterBook({ six: makeMemory({ date: '2021-06-01', assets: six }) });
    const replacement = { file: 'assets/replacement.jpg', originalFile: 'originals/replacement.jpg', aspectRatio: 1, originalWidth: 3000, originalHeight: 3000 };
    // Replace asset 4 (NOT in the spread pick [0, 3]).
    const pre = applyPreFit(outline, manifest, { images: { [slotKey('six', six[4].file)]: { slot: 'unused', mediaId: 'm', ...replacement } } });
    expect(pre.skipped).toEqual([]);
    const { document } = fitBook(pre.outline, pre.manifest);
    const slots = allPhotoSlots(document).filter((s) => s.memoryId === 'six');
    expect(slots.map((s) => s.assetFile).sort()).toEqual([six[0].file, replacement.file].sort());
    const edited = slots.find((s) => s.assetFile === replacement.file)!;
    expect(edited.editedFromFile).toBe(six[4].file); // identity of the edit key is preserved
    // The audit / coverage see it as shown + rendered, nothing lost.
    const coverage = summarizeAssetCoverage(document, pre.outline, pre.manifest, []);
    expect(coverage.assetsLost).toBe(0);

    // An edit on an asset that is ALREADY in the spread pick changes nothing about which slots show.
    const pre2 = applyPreFit(outline, manifest, { images: { [slotKey('six', six[3].file)]: { slot: 'unused', mediaId: 'm', ...replacement } } });
    const shown2 = allPhotoSlots(fitBook(pre2.outline, pre2.manifest).document).filter((s) => s.memoryId === 'six');
    expect(shown2.map((s) => s.assetFile).sort()).toEqual([six[0].file, replacement.file].sort());
    expect(shown2.find((s) => s.assetFile === replacement.file)!.editedFromFile).toBe(six[3].file);
  });

  it('two edited assets: the first two (in order) win over the spread pick', () => {
    const six = assets(6);
    const marked = six.map((a, i) => (i === 1 || i === 5 ? { ...a, editedFromFile: `orig-${i}.jpg` } : a));
    expect(shownAssetIndexes(marked)).toEqual([1, 5]);
    const manifest = makeManifest({ m: makeMemory({ assets: marked }) });
    expect(capManifestAssetsForChapterMode(manifest).memories.m.assets).toEqual([marked[1], marked[5]]);
    // memoized + a manifest with nothing to cap is returned as-is
    expect(capManifestAssetsForChapterMode(manifest)).toBe(capManifestAssetsForChapterMode(manifest));
    const small = makeManifest({ m: makeMemory({ assets: assets(2) }) });
    expect(capManifestAssetsForChapterMode(small)).toBe(small);
  });

  it('panorama / full-bleed take one of the SHOWN assets; the other shown asset follows as an ordinary page', () => {
    const wide = makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 4000 });
    const rest = assets(5);
    const all = [wide, ...rest];
    const memories: Record<string, ManifestMemory> = {
      a: makeMemory({ date: '2021-06-01', assets: [makeAsset()] }),
      pano: makeMemory({ date: '2021-06-02', text: 'Hike.', assets: all }),
      b: makeMemory({ date: '2021-06-03', assets: [makeAsset()] }),
    };
    const manifest = makeManifest({ ...memories, other: photo('2022-06-01') });
    const outline = makeOutline(
      [
        chapterEl(CH1),
        makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June', memoryIds: ['a', 'pano', 'b'] }),
        chapterEl(CH2),
        makeElement({ id: 'backbone:2022-06', kind: 'backbone', title: 'June', memoryIds: ['other'] }),
      ],
      { panoramaCandidates: ['pano'] },
    );
    const { document } = fitBook(outline, manifest);
    const spread = document.pages.find((p) => p.templateId === 'panorama-spread')!;
    expect(spread).toBeDefined();
    const shown = [all[0].file, all[3].file]; // 6 assets -> [0, 3]
    expect(photoSlots(spread).map((s) => s.assetFile)).toEqual([all[0].file]);
    expect(assetFilesOf(document, 'pano').sort()).toEqual(shown.sort());
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('page cost reflects the cap: 12 six-asset memories fit 20 pages without omission, but not uncapped', () => {
    const memories: Record<string, ManifestMemory> = {};
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      ids.push(`m${i}`);
      memories[`m${i}`] = makeMemory({ date: `2021-0${3 + (i % 6)}-${10 + i}`, assets: assets(6) });
    }
    const manifest = makeManifest({ ...memories, other: photo('2022-06-01') });
    const outline = makeOutline([
      chapterEl(CH1),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June', memoryIds: ids }),
      chapterEl(CH2),
      makeElement({ id: 'backbone:2022-06', kind: 'backbone', title: 'June', memoryIds: ['other'] }),
    ]);
    const result = fitBook(outline, manifest, { maxPages: 20 });
    expect(result.capacity.overCap).toBe(false);
    expect(result.capacity.omittedMemoryIds).toEqual([]);
    for (const id of ids) expect(assetFilesOf(result.document, id)).toHaveLength(2);
    // The same memories without chapter mode (no cap) cost more than 20 pages, so the legacy loop has to omit some.
    const lone = makeOutline([makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June', memoryIds: ids })]);
    const uncapped = fitBook(lone, manifest, { maxPages: 20 });
    expect(uncapped.capacity.omittedMemoryIds.length).toBeGreaterThan(0);
  });

  it('audio memories are unaffected; media-memory-without-media still passes (>= 1 shown); coverage separates hidden-by-cap from loss', () => {
    const memories: Record<string, ManifestMemory> = {
      six: makeMemory({ date: '2021-06-01', assets: assets(6) }),
      five: makeMemory({ date: '2021-06-02', assets: assets(5) }),
      audio: makeMemory({ date: '2021-06-03', type: 'audio', text: 'Giggles.', assets: [], shareToken: 'tok' }),
    };
    const { manifest, outline } = chapterBook(memories);
    const result = fitBook(outline, manifest);
    expect(result.document.pages.some((p) => p.templateId === 'audio-note')).toBe(true);
    expect(auditBookDocument(result.document, outline, manifest, { omittedMemoryIds: [] }).filter((v) => v.check === 'media-memory-without-media')).toEqual([]);
    const coverage = summarizeAssetCoverage(result.document, outline, manifest, []);
    expect(coverage).toMatchObject({ assetsKept: 12, assetsShown: 5, hiddenByCap: 7, assetsRendered: 5, assetsLost: 0 });
    // A book with chapter mode off reports no hidden assets.
    const plain = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['six'] })]);
    const plainFit = fitBook(plain, manifest);
    expect(summarizeAssetCoverage(plainFit.document, plain, manifest, [])).toMatchObject({ hiddenByCap: 0, assetsLost: 0 });
  });
});

// ---------------------------------------------------------------------------
// 3. Compact firsts (chapter mode)
// ---------------------------------------------------------------------------

describe('chapter-mode compact firsts', () => {
  const illustrated = (date: string, text: string): ManifestMemory =>
    makeMemory({
      date,
      type: 'text_illustration',
      text,
      assets: [],
      milestones: [{ id: 'first-steps', name: 'First steps', detail: '', status: 'confirmed' }],
      illustration: { file: `illustrations/${date}.png`, width: 1024, height: 1024, aspectRatio: 1 },
    });
  const firstsPhoto = (date: string, text: string, aspect = 1.5): ManifestMemory =>
    makeMemory({
      date,
      text,
      assets: [makeAsset({ aspectRatio: aspect })],
      milestones: [{ id: 'first-smile', name: 'First smile', detail: '', status: 'confirmed' }],
    });

  /** Two chapters + a firsts section with the given members (in order), then a closing. */
  function firstsBook(members: ManifestMemory[], withChapters = true) {
    const memories: Record<string, ManifestMemory> = { a: photo('2021-06-01'), b: photo('2022-06-01') };
    const ids: string[] = [];
    members.forEach((m, i) => {
      const id = `first-${i}`;
      memories[id] = m;
      ids.push(id);
    });
    const manifest = makeManifest(memories);
    const outline = makeOutline([
      ...(withChapters ? [chapterEl(CH1)] : []),
      makeElement({ id: 'backbone:2021-06', kind: 'backbone', title: 'June', memoryIds: ['a'] }),
      ...(withChapters ? [chapterEl(CH2)] : []),
      makeElement({ id: 'backbone:2022-06', kind: 'backbone', title: 'June', memoryIds: ['b'] }),
      makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ids }),
      makeElement({ id: 'closing', kind: 'closing', title: 'Closing' }),
    ]);
    const { document } = fitBook(outline, manifest);
    const pages = document.pages.filter((p) => p.sourceElementId === 'firsts');
    return { document, pages, outline, manifest, ids };
  }
  const pageCount = (pages: BookPage[]) => pages.reduce((n, p) => n + (p.pageNumbers?.length ?? 1), 0);
  const memoryIdsOn = (pages: BookPage[]) =>
    pages.flatMap((p) => p.slots.map((s) => (s.content as { memoryId?: string }).memoryId)).filter((id): id is string => Boolean(id));

  it('4 illustrated members: title + two digest pages = 3 pages (was 5), every member printed once, no blank', () => {
    const { pages, document, ids, outline, manifest } = firstsBook([
      illustrated('2021-04-01', 'Primeros pasos.'),
      illustrated('2021-07-01', 'Primera palabra.'),
      illustrated('2021-09-01', 'Primer diente.'),
      illustrated('2021-11-01', 'Primer baño en el mar.'),
    ]);
    expect(pageCount(pages)).toBeLessThanOrEqual(3);
    expect(pages.map((p) => p.templateId)).toEqual(['spread-title', 'illustrated-digest', 'illustrated-digest']);
    expect(memoryIdsOn(pages).sort()).toEqual([...ids].sort());
    expect(document.pages.some((p) => p.templateId === 'blank' && p.sourceElementId === 'firsts')).toBe(false);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('6 illustrated members: title + three digest pages = 4 pages (was 7)', () => {
    const { pages, ids } = firstsBook(Array.from({ length: 6 }, (_, i) => illustrated(`2021-0${3 + i}-05`, `Primera vez número ${i}.`)));
    expect(pageCount(pages)).toBeLessThanOrEqual(4);
    expect(pages.filter((p) => p.templateId === 'illustrated-digest')).toHaveLength(3);
    expect(memoryIdsOn(pages).sort()).toEqual([...ids].sort());
  });

  it('2 illustrated + 2 photo members: title + one digest page + one anchor-media pair = 3 pages', () => {
    const { pages, ids } = firstsBook([
      illustrated('2021-04-01', 'Primeros pasos.'),
      firstsPhoto('2021-05-01', 'Primera sonrisa.'),
      illustrated('2021-07-01', 'Primera palabra.'),
      firstsPhoto('2021-08-01', 'Primer cumple.'),
    ]);
    expect(pageCount(pages)).toBeLessThanOrEqual(3);
    expect(pages.map((p) => p.templateId).sort()).toEqual(['anchor-media', 'illustrated-digest', 'spread-title']);
    const pair = pages.find((p) => p.templateId === 'anchor-media')!;
    expect(photoSlots(pair)).toHaveLength(2);
    expect(memoryIdsOn(pages).sort()).toEqual([...ids].sort());
  });

  it('4 photo members: title + two anchor-media pairs; 5-6 members of any mix fit <= 5 pages, all-illustrated and photo-pairs <= 4', () => {
    const photos = Array.from({ length: 4 }, (_, i) => firstsPhoto(`2021-0${4 + i}-02`, `Primera cosa ${i}.`));
    expect(pageCount(firstsBook(photos).pages)).toBeLessThanOrEqual(3);
    const six = Array.from({ length: 6 }, (_, i) => firstsPhoto(`2021-0${3 + i}-02`, `Primera cosa ${i}.`));
    expect(pageCount(firstsBook(six).pages)).toBeLessThanOrEqual(4);
  });

  it('documented limit: 3 illustrated + 1 photo needs 4 pages (no existing template composes a lone illustration with a photo)', () => {
    const { pages } = firstsBook([
      illustrated('2021-04-01', 'Primeros pasos.'),
      illustrated('2021-05-01', 'Primera palabra.'),
      firstsPhoto('2021-06-01', 'Primera sonrisa.', 0.5625),
      illustrated('2021-09-01', 'Primer diente.'),
    ]);
    expect(pageCount(pages)).toBe(4); // vs 5 before Phase 2c
    expect(pages.filter((p) => p.templateId === 'illustrated-digest')).toHaveLength(1);
  });

  it('units come back in chronological order of their first member', () => {
    const { pages } = firstsBook([
      illustrated('2021-04-01', 'uno'),
      illustrated('2021-05-01', 'dos'),
      firstsPhoto('2021-06-01', 'tres'),
      firstsPhoto('2021-07-01', 'cuatro'),
    ]);
    const order = pages.filter((p) => p.templateId !== 'spread-title').map((p) => p.templateId);
    expect(order).toEqual(['illustrated-digest', 'anchor-media']);
  });

  it('a long-text illustrated firsts memory is not digest-eligible: it keeps its own illustrated-story page(s)', () => {
    const long = illustrated('2021-05-01', 'x'.repeat(260));
    const { pages, ids } = firstsBook([illustrated('2021-04-01', 'corto'), long, illustrated('2021-06-01', 'otro corto')]);
    expect([...new Set(memoryIdsOn(pages))].sort()).toEqual([...ids].sort());
    expect(pages.some((p) => p.templateId === 'illustrated-digest')).toBe(true);
    expect(pages.some((p) => p.templateId === 'illustrated-story')).toBe(true);
  });

  it('outside chapter mode the firsts section is unchanged: title + one page per member', () => {
    const { pages } = firstsBook(
      [illustrated('2021-04-01', 'uno'), illustrated('2021-05-01', 'dos'), illustrated('2021-06-01', 'tres'), illustrated('2021-07-01', 'cuatro')],
      false,
    );
    expect(pages.map((p) => p.templateId)).toEqual(['spread-title', 'illustrated-story', 'illustrated-story', 'illustrated-story', 'illustrated-story']);
  });
});
