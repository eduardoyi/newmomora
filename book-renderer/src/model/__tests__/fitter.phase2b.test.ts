import { describe, expect, it } from 'vitest';
import { fitBook, planChapterDemotions } from '../fitter';
import { auditBookDocument } from '../audit';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import { buildSyntheticYearBook } from './fixtures/syntheticYearBook';
import { buildSyntheticEverythingBook } from './fixtures/syntheticEverythingBook';
import type { AudioNoteContent, BookDocument, BookOutline, BookPage, ManifestMemory, OutlineElement, PhotoSlotContent, QuoteEntryContent, TextSlotContent } from '../types';

/**
 * Memory Book — Everything Phase 2b (dogfood round 1 fixes), renderer model
 * cluster — docs/plans/memory-book-everything-phase2b.md. Fixes 1/2/5 apply to
 * ALL books (bugs); A/B/C/6 and the quote pooling are chapter-mode only.
 */

const photoSlots = (page: BookPage): PhotoSlotContent[] => page.slots.filter((s) => s.kind === 'photo').map((s) => s.content as PhotoSlotContent);
const allPhotoSlots = (doc: BookDocument): PhotoSlotContent[] => doc.pages.flatMap(photoSlots);
const assetFilesOf = (doc: BookDocument, memoryId: string): string[] =>
  allPhotoSlots(doc)
    .filter((s) => s.memoryId === memoryId)
    .map((s) => s.assetFile);

/** Every place a memory's caption can print: text slots, quote entries, footer-index notes. Photo-slot `caption` fields are not rendered text. */
function captionOccurrences(doc: BookDocument, caption: string): number {
  let count = 0;
  for (const page of doc.pages) {
    for (const slot of page.slots) {
      if (slot.kind === 'text' && (slot.content as TextSlotContent).text === caption) count++;
      if (slot.kind === 'quote-entry' && (slot.content as QuoteEntryContent).text === caption) count++;
    }
    const footer = (page.params.footerIndex ?? []) as Array<{ note: string | null }>;
    count += footer.filter((e) => e.note === caption).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Fix 1 — no caption without its media (pairing never merges long-text solos)
// ---------------------------------------------------------------------------

describe('fix 1: a long-text photo memory never pairs onto a text-page that drops both memories\' media', () => {
  const LONG = 'A long story about the whole afternoon at the lake. '.repeat(7).trim(); // ~360 chars > PHOTO_STORY_MAX

  it('pairing level 3 (forced by a 1-page cap) keeps the photo AND the neighbouring video', () => {
    const manifest = makeManifest({
      'mem-photo': makeMemory({ date: '2024-06-01', text: LONG, assets: [makeAsset({ aspectRatio: 1.5 })] }),
      'mem-video': makeMemory({ date: '2024-06-02', type: 'video', text: 'Splashing around.', assets: [makeAsset({ aspectRatio: 1.78, kind: 'video-poster' })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-photo', 'mem-video'] })]);
    const result = fitBook(outline, manifest, { maxPages: 1 });
    expect(result.capacity.pairingLevelUsed).toBe(3);
    expect(assetFilesOf(result.document, 'mem-photo')).toHaveLength(1);
    expect(assetFilesOf(result.document, 'mem-video')).toHaveLength(1);
    // No page prints both memories' captions without any photo.
    for (const page of result.document.pages) {
      if (page.templateId !== 'text-page') continue;
      const memoryIds = new Set(page.slots.map((s) => (s.content as { memoryId?: string }).memoryId));
      expect(memoryIds.size).toBeLessThanOrEqual(1);
    }
    expect(auditBookDocument(result.document, outline, manifest, { omittedMemoryIds: result.capacity.omittedMemoryIds }).filter((v) => v.check === 'media-memory-without-media')).toEqual([]);
  });

  it('short-caption solos still pair at level 3 (nothing else about pairing changed)', () => {
    const manifest = makeManifest({
      a: makeMemory({ date: '2024-06-01', text: 'Short one.', assets: [makeAsset({ aspectRatio: 1.5 })] }),
      b: makeMemory({ date: '2024-06-02', text: 'Short two.', assets: [makeAsset({ aspectRatio: 1.5 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['a', 'b'] })]);
    const result = fitBook(outline, manifest, { maxPages: 1 });
    expect(result.capacity.pairingLevelUsed).toBe(3);
    expect(result.document.pages.filter((p) => p.templateId === 'anchor-media' && photoSlots(p).length === 2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — panorama / full-bleed units take ONE asset; the rest print normally
// ---------------------------------------------------------------------------

describe('fix 2: a wide-first multi-asset memory keeps every asset', () => {
  const wide = (extra: Partial<Parameters<typeof makeAsset>[0]> = {}) => makeAsset({ width: 4000, height: 2000, aspectRatio: 2, originalWidth: 4000, ...extra });

  it('normal panorama path: panorama-spread takes asset 0, the other assets follow as ordinary pages, the caption prints once', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({
        text: 'Whole-family hike caption.',
        assets: [wide(), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1.5 })],
      }),
      'mem-b': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-pano', 'mem-b'] })], { panoramaCandidates: ['mem-pano'] });
    const { document, gaps } = fitBook(outline, manifest);
    expect(gaps).toHaveLength(0);
    const spreads = document.pages.filter((p) => p.templateId === 'panorama-spread');
    expect(spreads).toHaveLength(1);
    expect(photoSlots(spreads[0]).map((s) => s.assetFile)).toEqual([manifest.memories['mem-pano'].assets[0].file]);
    // All four assets of the memory print, exactly once each.
    expect(assetFilesOf(document, 'mem-pano').sort()).toEqual(manifest.memories['mem-pano'].assets.map((a) => a.file).sort());
    // Caption/text exactly once (it lives with the panorama's credit line, as before).
    expect(captionOccurrences(document, 'Whole-family hike caption.')).toBe(1);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('Enzo p7 shape: a section that is ONE five-asset wide-first memory, arriving on odd parity, prints all five photos (no empty page, no blank)', () => {
    // Before the fix the panorama unit was the section's only unit, so the parity ladder fell to the
    // demote rung, which dumped all 5 assets on one anchor-media page (it draws 1-2) -> an empty page.
    // Now the memory's other four assets are a movable continuation the reorder pass uses to land the spread.
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({
        text: 'Five photos, one story.',
        assets: [wide(), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1 }), makeAsset({ aspectRatio: 1.5 }), makeAsset({ aspectRatio: 1.5 })],
      }),
      'mem-after': makeMemory({ assets: [makeAsset()] }), // the panorama's credit line lands on the next content page
    });
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
        makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-pano'] }),
        makeElement({ id: 'backbone:c', kind: 'backbone', memoryIds: ['mem-after'] }),
      ],
      { panoramaCandidates: ['mem-pano'] },
    );
    const { document } = fitBook(outline, manifest);
    expect(document.pages.filter((p) => p.templateId === 'blank')).toHaveLength(0);
    expect(assetFilesOf(document, 'mem-pano').sort()).toEqual(manifest.memories['mem-pano'].assets.map((a) => a.file).sort());
    for (const page of document.pages.filter((p) => p.templateId === 'anchor-media')) expect(photoSlots(page).length).toBeLessThanOrEqual(2);
    expect(captionOccurrences(document, 'Five photos, one story.')).toBe(1);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('the demote rung (still reachable when the reorder pass cannot help) builds from the chosen asset only', () => {
    // A single-asset panorama: no continuation exists, nothing to reorder or swap with -> the original round-17 rung (c).
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({ text: 'Solo wide.', assets: [wide()] }),
    });
    const outline = makeOutline(
      [
        makeElement({ id: 'backbone:a', kind: 'backbone', memoryIds: ['mem-a'] }),
        makeElement({ id: 'backbone:b', kind: 'backbone', memoryIds: ['mem-pano'] }),
      ],
      { panoramaCandidates: ['mem-pano'] },
    );
    const { document } = fitBook(outline, manifest);
    const demoted = document.pages.find((p) => p.id.endsWith(':panorama:demoted'))!;
    expect(demoted.templateId).toBe('anchor-media');
    expect(photoSlots(demoted).map((s) => s.assetFile)).toEqual([manifest.memories['mem-pano'].assets[0].file]);
    expect(captionOccurrences(document, 'Solo wide.')).toBe(1);
  });

  it('a single-asset panorama is untouched (no continuation group is invented)', () => {
    const manifest = makeManifest({
      'mem-a': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({ assets: [wide()] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-a', 'mem-pano'] })], { panoramaCandidates: ['mem-pano'] });
    const { document } = fitBook(outline, manifest);
    expect(assetFilesOf(document, 'mem-pano')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — audio QR: no fabricated short code
// ---------------------------------------------------------------------------

describe('fix 5: audio-note slots carry no placeholder short code', () => {
  it('the slot content is memoryId/date/shareToken only', () => {
    const manifest = makeManifest({ 'mem-audio': makeMemory({ type: 'audio', text: 'Giggles in the bath.', assets: [], shareToken: 'tok-1' }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-audio'] })]);
    const { document } = fitBook(outline, manifest);
    const audio = document.pages.flatMap((p) => p.slots).find((s) => s.kind === 'audio-note')!;
    const content = audio.content as AudioNoteContent;
    expect(Object.keys(content).sort()).toEqual(['date', 'kind', 'memoryId', 'shareToken']);
    expect(content.shareToken).toBe('tok-1');
  });
});

// ---------------------------------------------------------------------------
// Chapter-mode helpers
// ---------------------------------------------------------------------------

const CH1 = { ageYear: 1, startMonth: '2021-02', endMonth: '2022-02' };
const CH2 = { ageYear: 2, startMonth: '2022-03', endMonth: '2023-02' };
const chapterEl = (meta: typeof CH1): OutlineElement =>
  makeElement({ id: `chapter:${meta.ageYear}`, kind: 'chapter', title: `Year ${meta.ageYear}`, subtitle: 'sub', chapter: meta });
const photo = (date: string, engagement = 0): ManifestMemory => makeMemory({ date, engagement, assets: [makeAsset({ aspectRatio: 1 })] });
const oneLiner = (date: string, text = 'Said "gato" today.'): ManifestMemory => makeMemory({ date, type: 'text_only', text, assets: [] });

/** A section element with ids `<id>-<i>` over the given months (cycled). */
function section(id: string, months: string[], count: number, build: (date: string, i: number) => ManifestMemory = (d) => photo(d)) {
  const memories: Record<string, ManifestMemory> = {};
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const memId = `${id}-${String(i).padStart(2, '0')}`;
    memories[memId] = build(`${months[i % months.length]}-${String(1 + i).padStart(2, '0')}`, i);
    ids.push(memId);
  }
  return { memories, element: makeElement({ id, kind: 'backbone', title: id, memoryIds: ids }), ids };
}

// ---------------------------------------------------------------------------
// Fix A — per-SECTION floors (chapter mode); fix 6 — themed floor
// ---------------------------------------------------------------------------

describe('fix A: chapter-mode floors are per section (3-month block), not per calendar month', () => {
  it('a 3-month section keeps min(total, 2) memories through the full-floor level, not 2 per month', () => {
    // Phase 2c: the ladder is level-based. Two chapters of 7 sections x 3 memories (21 memories, chapter floor 12):
    // L1 (full section floor 2 + chapter floor) cuts every section 3 -> 2 first — a chapter's L1 candidates come
    // before its L2 ones (section floor 1) — and a per-month floor would have protected 6 of 9 per section instead.
    const sectionsFor = (year: number, prefix: string) =>
      [3, 4, 5, 6, 7, 8, 9].map((m) => section(`backbone:${prefix}-${m}`, [`${year}-${String(m).padStart(2, '0')}`], 3));
    const sections1 = sectionsFor(2021, 'a');
    const sections2 = sectionsFor(2022, 'b');
    const manifest = makeManifest(Object.assign({}, ...sections1.map((x) => x.memories), ...sections2.map((x) => x.memories)));
    const outline = makeOutline([chapterEl(CH1), ...sections1.map((x) => x.element), chapterEl(CH2), ...sections2.map((x) => x.element)]);
    const plan = planChapterDemotions(outline, manifest);
    for (const sections of [sections1, sections2]) {
      const ids = new Set(sections.flatMap((x) => x.ids));
      const cuts = plan.filter((d) => ids.has(d.id));
      // The chapter's first 7 cuts take exactly one memory from each of its 7 sections (3 -> 2 everywhere) ...
      expect(new Set(cuts.slice(0, 7).map((d) => d.elementId)).size).toBe(7);
      // ... then it goes on to the floor-1 level (chapter floor 12 of 21 => 2 more memories) ...
      expect(cuts.slice(7, 9).every((d) => d.tier === 'A')).toBe(true);
      // ... and the remaining cuts (chapter floor relaxed, then section floor 0) come strictly after.
      expect(cuts.slice(9).every((d) => d.tier === 'B1' || d.tier === 'B2')).toBe(true);
      expect(cuts.slice(9).some((d) => d.tier === 'B2')).toBe(true);
    }
    // The floor-0 stage (a section vanishes) is the very last thing in the plan.
    const lastB1 = plan.map((d) => d.tier).lastIndexOf('B1');
    const firstB2 = plan.findIndex((d) => d.tier === 'B2');
    expect(firstB2).toBeGreaterThan(lastB1);
  });

  it('time-spread tie-break is per section: the section with the larger remaining fraction is cut first on equal rank', () => {
    const big = section('backbone:2022-04_2022-06', ['2022-04', '2022-05', '2022-06'], 9);
    const small = section('backbone:2022-07_2022-09', ['2022-07', '2022-08', '2022-09'], 4);
    const first = section('backbone:2021-04_2021-06', ['2021-04'], 4);
    const manifest = makeManifest({ ...first.memories, ...big.memories, ...small.memories });
    const outline = makeOutline([chapterEl(CH1), first.element, chapterEl(CH2), big.element, small.element]);
    const plan = planChapterDemotions(outline, manifest).filter((d) => d.chapterIndex === 1);
    expect(plan[0].elementId).toBe('backbone:2022-04_2022-06'); // fraction tie (1.0) -> larger remaining count
    expect(plan[1].elementId).toBe('backbone:2022-07_2022-09'); // big fell to 8/9 < small 4/4
  });
});

describe('fix 6: themed spreads hold a floor of min(total, 3) until floors are relaxed, and dissolve below 2 kept', () => {
  function themedBook() {
    const q1 = section('backbone:2021-04_2021-06', ['2021-04', '2021-05', '2021-06'], 8);
    const themedMemories: Record<string, ManifestMemory> = {};
    const themedIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      themedIds.push(`th-${i}`);
      themedMemories[`th-${i}`] = photo(`2021-05-${String(10 + i).padStart(2, '0')}`);
    }
    const q2 = section('backbone:2022-04_2022-06', ['2022-04', '2022-05', '2022-06'], 8);
    const manifest = makeManifest({ ...q1.memories, ...themedMemories, ...q2.memories });
    const themed = makeElement({ id: 'topic:park', kind: 'themed', title: 'Park days', memoryIds: themedIds, spreadType: 'topic', titleMode: 'descriptive' });
    const outline = makeOutline([chapterEl(CH1), q1.element, themed, chapterEl(CH2), q2.element]);
    return { manifest, outline, themedIds };
  }

  it('planner: a themed element keeps 3 through the floor-respecting stages (backbone sections keep 2)', () => {
    const { manifest, outline, themedIds } = themedBook();
    const plan = planChapterDemotions(outline, manifest);
    // Chapter 1 holds 14 memories (floor 12), so exactly 2 cuts respect the chapter floor — both at the FULL
    // section-floor level (L1: themed keeps 3, backbone keeps 2) before any L2 (floor 1) cut is considered.
    const chapter1 = plan.filter((d) => d.chapterIndex === 0);
    const full = chapter1.slice(0, 2);
    expect(full.every((d) => d.tier === 'A')).toBe(true);
    expect(6 - full.filter((d) => themedIds.includes(d.id)).length).toBeGreaterThanOrEqual(3);
    expect(8 - full.filter((d) => d.elementId === 'backbone:2021-04_2021-06').length).toBeGreaterThanOrEqual(2);
    // Past the chapter floor (relaxed levels) the themed element is cut like any other section, down to its own floor of 1 first.
    const relaxed = chapter1.slice(2);
    expect(relaxed.every((d) => d.tier === 'B1' || d.tier === 'B2')).toBe(true);
  });

  it('chapter mode: a themed element with fewer than 2 kept memories dissolves its title page but still prints the memory', () => {
    const q1 = section('backbone:2021-04_2021-06', ['2021-04', '2021-05', '2021-06'], 3);
    const q2 = section('backbone:2022-04_2022-06', ['2022-04', '2022-05', '2022-06'], 3);
    const manifest = makeManifest({ ...q1.memories, ...q2.memories, lone: photo('2021-05-20'), duo1: photo('2022-05-20'), duo2: photo('2022-05-21') });
    const loneThemed = makeElement({ id: 'topic:lone', kind: 'themed', title: 'Lonely', memoryIds: ['lone'], spreadType: 'topic', titleMode: 'descriptive' });
    const duoThemed = makeElement({ id: 'topic:duo', kind: 'themed', title: 'Duo', memoryIds: ['duo1', 'duo2'], spreadType: 'topic', titleMode: 'descriptive' });
    const outline = makeOutline([chapterEl(CH1), q1.element, loneThemed, chapterEl(CH2), q2.element, duoThemed]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.id === 'topic:lone:title')).toBe(false);
    expect(allPhotoSlots(document).some((s) => s.memoryId === 'lone')).toBe(true);
    expect(document.pages.some((p) => p.id === 'topic:duo:title')).toBe(true);
    // Gated on chapter mode: the same lone themed element keeps its title in a book without chapters.
    const legacy: BookOutline = { ...outline, elements: outline.elements.filter((e) => e.kind !== 'chapter') };
    expect(fitBook(legacy, manifest).document.pages.some((p) => p.id === 'topic:lone:title')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix B — text-only memories are Tier C candidates (chapter mode)
// ---------------------------------------------------------------------------

describe('fix B: one-liners are demoted before a section empties', () => {
  function textBook() {
    const q1 = section('backbone:2021-04_2021-06', ['2021-04', '2021-05', '2021-06'], 6, (d, i) => (i < 2 ? photo(d) : oneLiner(d, ['a', 'bb', 'cccc', 'dddddd'][i - 2].repeat(5))));
    const q2 = section('backbone:2022-04_2022-06', ['2022-04', '2022-05', '2022-06'], 2);
    const manifest = makeManifest({ ...q1.memories, ...q2.memories });
    const outline = makeOutline([chapterEl(CH1), q1.element, chapterEl(CH2), q2.element]);
    return { manifest, outline, q1, q2 };
  }

  it('text-only memories join the Tier C pool, shortest text first, after the ordinary pools', () => {
    const { manifest, outline, q1 } = textBook();
    const plan = planChapterDemotions(outline, manifest);
    const textOrder = plan.filter((d) => d.kind === 'text');
    expect(textOrder.every((d) => d.tier === 'C')).toBe(true);
    expect(textOrder.map((d) => d.id)).toEqual(['backbone:2021-04_2021-06-02', 'backbone:2021-04_2021-06-03', 'backbone:2021-04_2021-06-04', 'backbone:2021-04_2021-06-05']);
    // The ordinary photo cuts above the section floor come first; the tier-C one-liners never run before them.
    const firstText = plan.findIndex((d) => d.kind === 'text');
    expect(plan.slice(0, firstText).every((d) => d.kind !== 'text')).toBe(true);
    expect(q1.ids.length).toBe(6);
  });

  it('protected text-only memories are never planned: milestone holders, quote-title sources, heroes', () => {
    const q1 = section('backbone:2021-04_2021-06', ['2021-04'], 5, (d, i) => oneLiner(d, `note number ${i}`));
    const q2 = section('backbone:2022-04_2022-06', ['2022-04'], 3);
    const memories = { ...q1.memories, ...q2.memories };
    memories[q1.ids[0]].milestones = [{ id: 'first-word', name: 'First word', detail: '' }];
    q1.element.titleSourceMemoryId = q1.ids[1];
    const manifest = makeManifest(memories);
    const outline = makeOutline([chapterEl(CH1), q1.element, chapterEl(CH2), q2.element], { heroCandidates: [q1.ids[2]] });
    const planned = new Set(planChapterDemotions(outline, manifest).map((d) => d.id));
    for (const id of q1.ids.slice(0, 3)) expect(planned.has(id)).toBe(false);
    expect(planned.has(q1.ids[3])).toBe(true);
  });

  it('never applies without chapters (legacy loop: text is sacred)', () => {
    const { manifest, outline } = textBook();
    const legacy: BookOutline = { ...outline, elements: outline.elements.filter((e) => e.kind !== 'chapter') };
    const result = fitBook(legacy, manifest, { maxPages: 1 });
    expect(result.capacity.omittedMemoryIds.every((id) => manifest.memories[id].assets.length > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix C — refill
// ---------------------------------------------------------------------------

describe('fix C: chapter-mode refill reaches the cap when the shortest fitting prefix lands below it', () => {
  // A deterministic panorama-rich two-chapter book (found by search): page count is NOT monotone in
  // the omission prefix (parity blanks, panorama quota/ladder cliffs), so the bisected prefix lands
  // under the cap and only restoring omitted memories (reverse plan order) reaches it.
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function cliffBook(seed: number) {
    const r = rng(seed);
    const memories: Record<string, ManifestMemory> = {};
    const elements: OutlineElement[] = [];
    const pano: string[] = [];
    [CH1, CH2].forEach((chapter, ci) => {
      elements.push(chapterEl(chapter));
      const months = ci === 0 ? ['2021-04', '2021-07', '2021-10'] : ['2022-04', '2022-07', '2022-10'];
      months.forEach((m, mi) => {
        const n = 4 + Math.floor(r() * 8);
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const id = `c${ci}m${mi}-${String(i).padStart(2, '0')}`;
          const wide = r() < 0.18;
          const aspect = wide ? 2 : [0.75, 1, 1.33, 1.5][Math.floor(r() * 4)];
          memories[id] = makeMemory({
            date: `${m}-${String(1 + i).padStart(2, '0')}`,
            engagement: Math.floor(r() * 3),
            assets: [makeAsset({ width: wide ? 4000 : 2400, height: wide ? 2000 : 1600, aspectRatio: aspect })],
          });
          if (wide) pano.push(id);
          ids.push(id);
        }
        elements.push(makeElement({ id: `backbone:${m}`, kind: 'backbone', title: m, memoryIds: ids }));
      });
    });
    return { manifest: makeManifest(memories), outline: makeOutline(elements, { panoramaCandidates: pano }) };
  }

  it('restores omitted memories (reverse plan order) until the cap is hit exactly, within the attempt budget', () => {
    const { manifest, outline } = cliffBook(3);
    const plan = planChapterDemotions(outline, manifest);
    let fits = 0;
    const result = fitBook(outline, manifest, { maxPages: 36, onRunFit: () => fits++ });
    expect(result.capacity.overCap).toBe(false);
    expect(result.document.totalPages).toBe(36);
    const omitted = result.capacity.omittedMemoryIds;
    // Not a plain plan prefix any more: at least one planned omission was put back.
    const isPrefix = omitted.every((id, i) => plan[i]?.id === id);
    expect(isPrefix).toBe(false);
    // Every omission is still a planned one, in plan order, with one gap each.
    const planIds = plan.map((d) => d.id);
    expect(omitted.every((id) => planIds.includes(id))).toBe(true);
    expect(omitted.map((id) => planIds.indexOf(id))).toEqual([...omitted.map((id) => planIds.indexOf(id))].sort((a, b) => a - b));
    expect(result.gaps.filter((g) => g.reason.startsWith('Omitted (')).map((g) => g.memoryIds[0])).toEqual(omitted);
    // Bounded: prefix search (~log n) + at most 40 refill attempts.
    expect(fits).toBeLessThanOrEqual(60);
  });

  it('is deterministic and never exceeds the cap', () => {
    const { manifest, outline } = cliffBook(17);
    const a = fitBook(outline, manifest, { maxPages: 36 });
    const b = fitBook(outline, manifest, { maxPages: 36 });
    expect(b).toEqual(a);
    expect(a.document.totalPages).toBeLessThanOrEqual(36);
  });

  it('does nothing when the prefix search already lands exactly on the cap, or the book fits uncapped (one fit)', () => {
    const { manifest, outline } = cliffBook(3);
    let fits = 0;
    const result = fitBook(outline, manifest, { onRunFit: () => fits++ });
    expect(result.capacity.omittedMemoryIds).toEqual([]);
    expect(fits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pooling (fix 4)
// ---------------------------------------------------------------------------

describe('fix 4: per-chapter quote pooling (chapter mode)', () => {
  function pooledBook(chapter1Quotes: number, chapter2Quotes: number) {
    const mk = (prefix: string, months: string[], quotes: number) => {
      const photos = section(`backbone:${prefix}-a`, months, 2);
      const second = section(`backbone:${prefix}-b`, months.map((m) => m.replace(/-0[1-9]$/, '-12')), 2);
      const memories: Record<string, ManifestMemory> = { ...photos.memories, ...second.memories };
      const quoteIds: string[] = [];
      for (let i = 0; i < quotes; i++) {
        const id = `${prefix}-q${i}`;
        // Spread the one-liners across both sections of the chapter.
        memories[id] = oneLiner(`${months[0]}-${String(20 + i).padStart(2, '0')}`, `Short line ${prefix} ${i}.`);
        quoteIds.push(id);
        (i % 2 === 0 ? photos.element : second.element).memoryIds.push(id);
      }
      return { memories, elements: [photos.element, second.element], quoteIds };
    };
    const c1 = mk('c1', ['2021-04', '2021-05'], chapter1Quotes);
    const c2 = mk('c2', ['2022-04', '2022-05'], chapter2Quotes);
    const manifest = makeManifest({ ...c1.memories, ...c2.memories });
    const outline = makeOutline([chapterEl(CH1), ...c1.elements, chapterEl(CH2), ...c2.elements]);
    return { manifest, outline, c1, c2 };
  }

  const quoteEntryIds = (page: BookPage) => page.slots.filter((s) => s.kind === 'quote-entry').map((s) => (s.content as QuoteEntryContent).memoryId);

  it('>= 3 eligible in a chapter (spread over sections): ONE quote-collection after the chapter\'s last backbone section; fewer than 3: left in place', () => {
    const { manifest, outline, c1, c2 } = pooledBook(5, 2);
    const { document } = fitBook(outline, manifest);
    const collections = document.pages.filter((p) => p.templateId === 'quote-collection');
    expect(collections).toHaveLength(1);
    // Phase 2d: a pooled collection is emitted under its own stable `<chapter id>:quotes`
    // element id (so `sectionTitle:` edits target it, never the host backbone section).
    expect(collections[0].sourceElementId).toBe('chapter:1:quotes');
    expect(collections[0].isSpread).toBe(true); // 5 entries: 4-6 stay a spread
    expect(quoteEntryIds(collections[0]).sort()).toEqual([...c1.quoteIds].sort());
    // It prints after that section's own pages and before the next chapter opener.
    const idx = document.pages.indexOf(collections[0]);
    expect(document.pages.slice(0, idx).some((p) => p.sourceElementId === 'backbone:c1-b')).toBe(true);
    expect(document.pages.slice(idx + 1).some((p) => p.sourceElementId === 'chapter:2')).toBe(true);
    // Pooled memories no longer appear in their sections; chapter 2's two stay as ordinary text pages.
    const textMemoryIds = document.pages.flatMap((p) => p.slots.filter((s) => s.kind === 'text').map((s) => (s.content as TextSlotContent).memoryId));
    for (const id of c1.quoteIds) expect(textMemoryIds).not.toContain(id);
    for (const id of c2.quoteIds) expect(textMemoryIds).toContain(id);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] })).toEqual([]);
  });

  it('a long pool splits with partitionQuoteRun (7 -> a 4-entry spread + a 3-entry single page), all under the chapter\'s pooled-quotes element id', () => {
    const { manifest, outline, c1 } = pooledBook(7, 0);
    const { document } = fitBook(outline, manifest);
    const collections = document.pages.filter((p) => p.templateId === 'quote-collection');
    expect(collections.map((p) => quoteEntryIds(p).length)).toEqual([4, 3]);
    expect(collections.map((p) => p.isSpread)).toEqual([true, false]);
    expect(collections.every((p) => p.sourceElementId === 'chapter:1:quotes')).toBe(true);
    expect(new Set(collections.flatMap(quoteEntryIds))).toEqual(new Set(c1.quoteIds));
    // Distinct page ids (the pseudo-section id namespace never collides with the section's own pages).
    expect(new Set(document.pages.map((p) => p.id)).size).toBe(document.pages.length);
  });

  it('never pools without chapter mode (legacy per-element splice only: no collection mixes two sections)', () => {
    const { manifest, outline, c1 } = pooledBook(5, 2);
    const legacy: BookOutline = { ...outline, elements: outline.elements.filter((e) => e.kind !== 'chapter') };
    const { document } = fitBook(legacy, manifest);
    for (const page of document.pages.filter((p) => p.templateId === 'quote-collection')) {
      const ids = quoteEntryIds(page);
      const sections = new Set(ids.map((id) => (c1.quoteIds.indexOf(id) % 2 === 0 ? 'a' : 'b')));
      expect(sections.size).toBe(1);
    }
  });

  it('a section whose memories were ALL pooled is not reported as erased by the month-continuity audit', () => {
    const only = section('backbone:2021-04_2021-06', ['2021-04'], 3, (d) => oneLiner(d));
    const other = section('backbone:2021-07_2021-09', ['2021-07'], 2);
    const c2 = section('backbone:2022-04_2022-06', ['2022-04'], 2);
    const manifest = makeManifest({ ...only.memories, ...other.memories, ...c2.memories });
    const outline = makeOutline([chapterEl(CH1), only.element, other.element, chapterEl(CH2), c2.element]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.sourceElementId === 'backbone:2021-04_2021-06' && p.templateId !== 'quote-collection')).toBe(false);
    expect(auditBookDocument(document, outline, manifest, { omittedMemoryIds: [] }).filter((v) => v.check === 'month-continuity')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fix 7 — the three audit checks
// ---------------------------------------------------------------------------

function emptyPage(overrides: Partial<BookPage> & Pick<BookPage, 'id' | 'sourceElementId' | 'templateId'>): BookPage {
  return { params: {}, slots: [], variants: [], isSpread: false, isEvenPage: null, pageNumbers: null, ...overrides };
}
const photoSlot = (memoryId: string, file: string, id = `s-${file}`) => ({
  id,
  kind: 'photo' as const,
  content: {
    kind: 'photo',
    assetFile: file,
    editedFromFile: null,
    assetWidth: 100,
    assetHeight: 100,
    assetAspectRatio: 1,
    memoryId,
    date: '2024-06-01',
    caption: null,
    hero: false,
    qr: false,
    shareToken: null,
    taggedMembers: [],
    milestones: [],
    targetAspect: 1,
    looseFit: false,
    index: 1,
    cropBand: null,
    focalPoint: null,
  } as PhotoSlotContent,
});
const textSlot = (memoryId: string, text: string) => ({ id: `t-${memoryId}`, kind: 'text' as const, content: { kind: 'text', text, memoryId, date: '2024-06-01' } as TextSlotContent });
const docWith = (pages: BookPage[]): BookDocument => ({ childName: 'T', scopeLabel: 'S', pages, totalPages: pages.length * 2 });

describe('fix 7: audit checks (media-memory-without-media / unrenderable-slots / title-then-empty)', () => {
  const manifest = makeManifest({
    m1: makeMemory({ text: 'Caption', assets: [makeAsset()] }),
    m2: makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset(), makeAsset(), makeAsset()] }),
  });
  const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['m1', 'm2'] })]);

  it('media-memory-without-media fires when a memory with assets prints only its caption (the Mara p79 shape)', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'backbone:x', templateId: 'text-page', slots: [textSlot('m1', 'Caption')] })]);
    const v = auditBookDocument(doc, outline, manifest).filter((x) => x.check === 'media-memory-without-media');
    expect(v.map((x) => x.message.includes('m1'))).toEqual([true]);
  });

  it('...and, given the omission list, when a kept memory vanished entirely; an omitted one is fine', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'backbone:x', templateId: 'anchor-media', slots: [photoSlot('m1', 'a.jpg')] })]);
    expect(auditBookDocument(doc, outline, manifest).filter((x) => x.check === 'media-memory-without-media')).toEqual([]);
    expect(auditBookDocument(doc, outline, manifest, { omittedMemoryIds: [] }).filter((x) => x.check === 'media-memory-without-media').map((x) => x.message.includes('m2'))).toEqual([true]);
    expect(auditBookDocument(doc, outline, manifest, { omittedMemoryIds: ['m2'] }).filter((x) => x.check === 'media-memory-without-media')).toEqual([]);
  });

  it('unrenderable-slots fires for anchor-media with 3+ photo slots and for photo slots on a text-only template', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((f) => photoSlot('m2', `${f}.jpg`));
    const doc = docWith([
      emptyPage({ id: 'anchor5', sourceElementId: 'backbone:x', templateId: 'anchor-media', slots: five }),
      emptyPage({ id: 'anchor2', sourceElementId: 'backbone:x', templateId: 'anchor-media', slots: five.slice(0, 2) }),
      emptyPage({ id: 'grid4', sourceElementId: 'backbone:x', templateId: 'flex-grid', slots: five.slice(0, 4) }),
      emptyPage({ id: 'text-with-photo', sourceElementId: 'backbone:x', templateId: 'text-page', slots: [textSlot('m1', 'Caption'), photoSlot('m1', 'x.jpg', 'sx')] }),
    ]);
    const v = auditBookDocument(doc, outline, manifest).filter((x) => x.check === 'unrenderable-slots');
    expect(v.map((x) => x.pageId).sort()).toEqual(['anchor5', 'text-with-photo']);
  });

  it('title-then-empty fires for a title facing a blank or a page that draws nothing; not for a title facing real content', () => {
    const title = (id: string) => emptyPage({ id, sourceElementId: 'chapter:1', templateId: 'spread-title' });
    const five = ['a', 'b', 'c', 'd', 'e'].map((f) => photoSlot('m2', `${f}.jpg`));
    const doc = docWith([
      title('t-blank'),
      emptyPage({ id: 'b1', sourceElementId: 'x', templateId: 'blank', blankReason: 'parity:full-bleed' }),
      title('t-undrawn'),
      emptyPage({ id: 'u1', sourceElementId: 'x', templateId: 'anchor-media', slots: five }), // the Enzo p6 -> p7 shape
      title('t-ok'),
      emptyPage({ id: 'ok1', sourceElementId: 'x', templateId: 'anchor-media', slots: [photoSlot('m1', 'ok.jpg')] }),
      title('t-text'),
      emptyPage({ id: 'ok2', sourceElementId: 'x', templateId: 'text-page', slots: [textSlot('m1', 'Hello')] }),
    ]);
    const v = auditBookDocument(doc, outline, manifest).filter((x) => x.check === 'title-then-empty');
    expect(v.map((x) => x.pageId)).toEqual(['t-blank', 't-undrawn']);
  });

  it('crop-loss check honours the user-chosen waiver (a swapped-in photo is never crop-policed, like the fitter\'s gate)', () => {
    const wideSlot = photoSlot('m1', 'w.jpg');
    (wideSlot.content as PhotoSlotContent).assetAspectRatio = 2.2;
    const edited = photoSlot('m1', 'e.jpg');
    (edited.content as PhotoSlotContent).assetAspectRatio = 2.2;
    (edited.content as PhotoSlotContent).editedFromFile = 'orig.jpg';
    const doc = docWith([
      emptyPage({ id: 'auto', sourceElementId: 'backbone:x', templateId: 'full-bleed', slots: [wideSlot] }),
      emptyPage({ id: 'chosen', sourceElementId: 'backbone:x', templateId: 'full-bleed', slots: [edited] }),
    ]);
    expect(auditBookDocument(doc, outline, manifest).filter((x) => x.check === 'crop-loss').map((x) => x.pageId)).toEqual(['auto']);
  });

  it('none of the three fire on the synthetic year books or on the synthetic Everything book (post-fix)', () => {
    const NEW_CHECKS = new Set(['media-memory-without-media', 'unrenderable-slots', 'title-then-empty']);
    const books = [
      ...(['age-year', 'calendar-year', 'custom'] as const).map((scopeKind) => buildSyntheticYearBook({ scopeKind, language: 'en' })),
      buildSyntheticEverythingBook({ quarterSections: true }),
    ];
    for (const { outline: o, manifest: m } of books) {
      for (const maxPages of [undefined, 200]) {
        const result = fitBook(o, m, maxPages === undefined ? {} : { maxPages });
        const violations = auditBookDocument(result.document, o, m, { omittedMemoryIds: result.capacity.omittedMemoryIds });
        expect(violations.filter((x) => NEW_CHECKS.has(x.check))).toEqual([]);
      }
    }
  });
});
