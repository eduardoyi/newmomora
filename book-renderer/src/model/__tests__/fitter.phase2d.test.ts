import { describe, expect, it } from 'vitest';
import { auditBookDocument } from '../audit';
import { applyPostFit } from '../edits';
import { birthdayTitleFor, fitBook, partitionQuoteRun } from '../fitter';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import { buildSyntheticEverythingBook } from './fixtures/syntheticEverythingBook';
import { buildSyntheticYearBook } from './fixtures/syntheticYearBook';
import type { BookDocument, BookOutline, BookPage, ManifestMemory, QuoteEntryContent } from '../types';

/**
 * Phase 2d known-defect fixes (docs/plans/memory-book-everything-phase2d.md
 * item 3 a-d, plus the fitter side of item 2's quote-collection redesign).
 * One describe per fix; the golden snapshots are deliberately NOT touched here.
 */

const violationsOf = (document: BookDocument, outline: BookOutline, manifest: Parameters<typeof auditBookDocument>[2], omitted: Iterable<string> = []) =>
  auditBookDocument(document, outline, manifest, { omittedMemoryIds: omitted });

const checks = (v: Array<{ check: string }>, check: string) => v.filter((x) => x.check === check);

// ---------------------------------------------------------------------------
// 3a. Tall solo beside a section header must not overlap the header's title
// ---------------------------------------------------------------------------

describe('3a: a tall solo photo never overlaps a wide section-header title', () => {
  // The real Enzo pages: a 3-month backbone ("julio–septiembre 2023", ~21+
  // chars) whose title is NON-wrapping yet wider than the 50% column the tall
  // image claims beside it.
  const tallBook = (title: string, aspect: number) => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ date: '2023-07-10', assets: [makeAsset({ aspectRatio: aspect, width: 1000, height: Math.round(1000 / aspect) })] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:2023-07_2023-08_2023-09', kind: 'backbone', title, subtitle: undefined, memoryIds: ['mem-1'] })]);
    return { manifest, outline };
  };

  it('July–September 2023 (21 chars) + a 9:16 portrait: audit reports no geometric overlap', () => {
    const { manifest, outline } = tallBook('July–September 2023', 0.5625);
    const { document, capacity } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('anchor-media');
    expect(document.pages[0].params.sectionHeader).toBeTruthy();
    expect(checks(violationsOf(document, outline, manifest, capacity.omittedMemoryIds), 'geometric-overlap')).toEqual([]);
  });

  it('a short title still gets the beside-header composition (the fix changes nothing where there was no overlap)', async () => {
    const { tallSoloCanSitBesideHeader } = await import('../../templates/layout/anchorMediaLayout');
    expect(tallSoloCanSitBesideHeader(190, 'May 2025', false, 0.5625)).toBe(true);
    expect(tallSoloCanSitBesideHeader(190, 'July–September 2023', false, 0.5625)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3b. `birthday` outline elements are laid out
// ---------------------------------------------------------------------------

describe('3b: birthday-N outline elements (year books) are laid out as a themed-style spread', () => {
  const birthdayBook = (language: 'es' | 'en' = 'en', age = 2) => {
    const manifest = makeManifest(
      {
        'mem-b1': makeMemory({ date: '2024-03-01', assets: [makeAsset()], text: 'Cake day.' }),
        'mem-b2': makeMemory({ date: '2024-03-01', assets: [makeAsset({ aspectRatio: 1 })] }),
        'mem-b3': makeMemory({ date: '2024-03-02', assets: [makeAsset({ aspectRatio: 0.8 })] }),
        'mem-m1': makeMemory({ date: '2024-05-01', assets: [makeAsset()] }),
      },
      { language },
    );
    const outline = makeOutline([
      makeElement({ id: 'through-the-years', kind: 'through-the-years', memoryIds: [] }),
      makeElement({ id: `birthday-${age}`, kind: 'birthday', title: `Birthday -- turns ${age}`, memoryIds: ['mem-b1', 'mem-b2', 'mem-b3'] }),
      makeElement({ id: 'backbone:2024-05', kind: 'backbone', title: 'May 2024', memoryIds: ['mem-m1'] }),
    ]);
    return { manifest, outline };
  };

  const printedMemoryIds = (document: BookDocument) =>
    new Set(document.pages.flatMap((p) => p.slots.map((s) => (s.content as { memoryId?: string | null }).memoryId).filter(Boolean)));

  it('prints every member behind a spread-title opener (en: "When you turned two")', () => {
    const { manifest, outline } = birthdayBook('en');
    const { document, capacity } = fitBook(outline, manifest);
    const pages = document.pages.filter((p) => p.sourceElementId === 'birthday-2');
    expect(pages[0].templateId).toBe('spread-title');
    expect(pages[0].params.title).toBe('When you turned two');
    expect(pages[0].params.kicker).toBe('birthday');
    expect(pages[0].params.momentCount).toBe(3);
    expect(pages.length).toBeGreaterThan(1);
    const printed = printedMemoryIds(document);
    for (const id of ['mem-b1', 'mem-b2', 'mem-b3', 'mem-m1']) expect(printed.has(id)).toBe(true);
    expect(violationsOf(document, outline, manifest, capacity.omittedMemoryIds)).toEqual([]);
  });

  it('localizes the title and kicker for a Spanish book ("Cuando cumpliste dos años", "cumpleaños")', () => {
    const { manifest, outline } = birthdayBook('es');
    const { document } = fitBook(outline, manifest);
    const title = document.pages.find((p) => p.sourceElementId === 'birthday-2' && p.templateId === 'spread-title')!;
    expect(title.params.title).toBe('Cuando cumpliste dos años');
    expect(title.params.kicker).toBe('cumpleaños');
  });

  it('title wording per age: period phrasing, singular "un año", digits past ten, real editorial titles kept verbatim', () => {
    const el = (id: string, title: string) => makeElement({ id, kind: 'birthday', title, memoryIds: [] });
    expect(birthdayTitleFor(el('birthday-1', 'Birthday -- turns 1'), 'es').title).toBe('Cuando cumpliste un año');
    expect(birthdayTitleFor(el('birthday-1', 'Birthday -- turns 1'), 'en').title).toBe('When you turned one');
    expect(birthdayTitleFor(el('birthday-11', 'Birthday -- turns 11'), 'es').title).toBe('Cuando cumpliste 11 años');
    expect(birthdayTitleFor(el('birthday-11', 'Birthday -- turns 11'), 'en').title).toBe('When you turned 11');
    expect(birthdayTitleFor(el('birthday-3', 'A day to remember'), 'en').title).toBe('A day to remember');
    // never the single-month "El mes en que cumpliste…" wording (a birthday section is not a month)
    expect(birthdayTitleFor(el('birthday-2', 'Birthday -- turns 2'), 'es').title).not.toMatch(/El mes en que/);
  });

  it('dissolves the opener when none of its members resolve (never a lone title page)', () => {
    const { manifest, outline } = birthdayBook('en');
    const ghost: BookOutline = {
      ...outline,
      elements: outline.elements.map((e) => (e.id === 'birthday-2' ? { ...e, memoryIds: ['missing-1', 'missing-2'] } : e)),
    };
    const { document } = fitBook(ghost, manifest);
    expect(document.pages.some((p) => p.sourceElementId === 'birthday-2')).toBe(false);
  });

  it('sectionTitle edits retitle the birthday opener (it is an ordinary spread-title page)', () => {
    const { manifest, outline } = birthdayBook('en');
    const { document } = fitBook(outline, manifest);
    const { document: edited, skipped } = applyPostFit(document, {
      text: { 'sectionTitle:birthday-2': { value: 'Two!', updatedAt: '2026-10-01T00:00:00Z' } },
    } as never);
    expect(skipped).toEqual([]);
    expect(edited.pages.find((p) => p.sourceElementId === 'birthday-2' && p.templateId === 'spread-title')!.params.title).toBe('Two!');
  });

  it('a long first illustrated story (needs an even landing) hoists the parity blank before the opener, never between title and content', () => {
    // Two single-photo sections push the opener onto an even page; both of its
    // members are long illustrated stories, each needing an even landing, so
    // nothing can be reordered to absorb the parity of the page after the title.
    // The one blank belongs BEFORE the title.
    const long = 'Un día muy largo en el parque. '.repeat(20); // ~620 chars
    const manifest = makeManifest({
      'mem-a': makeMemory({ date: '2024-01-05', assets: [makeAsset({ aspectRatio: 1 })] }),
      'mem-b': makeMemory({ date: '2024-02-05', assets: [makeAsset({ aspectRatio: 1 })] }),
      'mem-story': makeMemory({
        date: '2024-03-02',
        type: 'illustrated',
        text: long,
        assets: [],
        illustration: { file: 'assets/illo-1.png', width: 1024, height: 1024, aspectRatio: 1 },
      }),
      'mem-story2': makeMemory({
        date: '2024-03-03',
        type: 'illustrated',
        text: long,
        assets: [],
        illustration: { file: 'assets/illo-2.png', width: 1024, height: 1024, aspectRatio: 1 },
      }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-01', kind: 'backbone', title: 'January 2024', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:2024-02', kind: 'backbone', title: 'February 2024', memoryIds: ['mem-b'] }),
      makeElement({ id: 'birthday-1', kind: 'birthday', title: 'Birthday -- turns 1', memoryIds: ['mem-story', 'mem-story2'] }),
    ]);
    const { document, capacity } = fitBook(outline, manifest);
    const ids = document.pages.map((p) => p.id);
    const titleIdx = ids.indexOf('birthday-1:title');
    expect(titleIdx).toBeGreaterThan(-1);
    const next = document.pages[titleIdx + 1];
    expect(next.templateId).not.toBe('blank');
    // The parity blank was hoisted to just BEFORE the opener (same page count, same landings).
    expect(document.pages[titleIdx - 1].templateId).toBe('blank');
    expect(document.pages[titleIdx - 1].blankReason).toBe('parity:illustrated-split');
    expect(document.pages[titleIdx + 1].params.mode).toBe('text-only');
    expect(checks(violationsOf(document, outline, manifest, capacity.omittedMemoryIds), 'title-then-empty')).toEqual([]);
    expect(checks(violationsOf(document, outline, manifest, capacity.omittedMemoryIds), 'illustrated-stack-overflow')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3c. Firsts warm names: the worker's stored key
// ---------------------------------------------------------------------------

describe('3c (reverted in Phase 2e): AI `firstsWarmNames` are NEVER rendered', () => {
  const book = (extra: Record<string, unknown>) => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ text: 'mama said she rode without training wheels', assets: [makeAsset()] }),
      'mem-2': makeMemory({ text: 'first haircut today', assets: [makeAsset({ aspectRatio: 1 })], date: '2024-07-01' }),
    });
    const outline = makeOutline([makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1', 'mem-2'], ...extra })]);
    return { manifest, outline };
  };
  const notes = (document: BookDocument) =>
    document.pages.flatMap((p) => ((p.params.footerIndex as Array<{ note: string | null }> | undefined) ?? []).map((e) => e.note));

  it('ignores firstsWarmNames (worker shape) and prints the parent\'s own verbatim text instead', () => {
    const { manifest, outline } = book({
      firstsWarmNames: [
        { memoryId: 'mem-1', milestoneId: 'first-bike', warmName: 'Aprendiste a montar bicicleta sin pedales.' },
        { memoryId: 'mem-2', milestoneId: 'first-haircut', warmName: 'Tu primer corte de pelo.' },
      ],
    });
    const printed = notes(fitBook(outline, manifest).document);
    expect(printed.join(' ')).not.toContain('Aprendiste a montar bicicleta');
    expect(printed.join(' ')).not.toContain('Tu primer corte de pelo');
    expect(printed).toContain('mama said she rode without training wheels');
    expect(printed).toContain('first haircut today');
  });

  it('firstsWarmNames is also ignored when firstsEntries is present (only the contract key is read)', () => {
    const { manifest, outline } = book({
      firstsWarmNames: [{ memoryId: 'mem-1', milestoneId: 'x', warmName: 'From the worker key.' }],
      firstsEntries: [{ memoryId: 'mem-1', warmName: 'From the contract key.' }],
    });
    const printed = notes(fitBook(outline, manifest).document);
    expect(printed).not.toContain('From the worker key.');
  });
});

// ---------------------------------------------------------------------------
// 3d. illustrated-stack-overflow
// ---------------------------------------------------------------------------

describe('3d: a long illustrated story never renders as an overflowing single page', () => {
  const longStory = (date: string, chars = 627): ManifestMemory =>
    makeMemory({
      date,
      type: 'illustrated',
      text: 'Hoy fuimos al parque y pasó algo muy gracioso. '.repeat(Math.ceil(chars / 47)).slice(0, chars),
      assets: [],
      illustration: { file: `assets/illo-${date}.png`, width: 1024, height: 1024, aspectRatio: 1 },
    });

  it('a headed section whose first unit is a long story, when parity blocks the split, commits to the split (blank last) instead of overflowing', () => {
    // Section A is one photo -> page 2 (even); section B's long story would
    // land on page 3 (odd). A section start has nothing swappable, so the
    // split's even landing costs a parity blank (reason parity:illustrated-split).
    const manifest = makeManifest({
      'mem-a': makeMemory({ date: '2024-01-05', assets: [makeAsset({ aspectRatio: 1 })] }),
      'mem-long': longStory('2024-02-10'),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-01', kind: 'backbone', title: 'January 2024', memoryIds: ['mem-a'] }),
      makeElement({ id: 'backbone:2024-02', kind: 'backbone', title: 'February 2024', memoryIds: ['mem-long'] }),
    ]);
    const { document, capacity } = fitBook(outline, manifest);
    const stackPages = document.pages.filter((p) => p.templateId === 'illustrated-story');
    expect(stackPages.map((p) => p.params.mode)).toEqual(['text-only', 'illustration-only']);
    expect(document.pages.some((p) => p.blankReason === 'parity:illustrated-split')).toBe(true);
    expect(violationsOf(document, outline, manifest, capacity.omittedMemoryIds)).toEqual([]);
  });

  it('a story whose "both" render FITS keeps the old blank-free fall-through (a de-split page, no parity blank)', () => {
    // 330 chars (>= the 320 split threshold) with no section header: the stack fits, so
    // parity-blocked still renders ONE page rather than paying a blank.
    const manifest = makeManifest({
      'mem-a': makeMemory({ date: '2024-01-05', assets: [makeAsset({ aspectRatio: 1 })] }),
      'mem-mid': longStory('2024-02-10', 330),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:2024-01', kind: 'backbone', title: 'January 2024', memoryIds: ['mem-a'] }),
      makeElement({ id: 'themed:x', kind: 'themed', title: 'x', memoryIds: ['mem-mid'] }),
    ]);
    const { document, capacity } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.blankReason?.startsWith('parity:'))).toBe(false);
    expect(violationsOf(document, outline, manifest, capacity.omittedMemoryIds)).toEqual([]);
  });

  it('the synthetic Everything book (both section shapes) has zero illustrated-stack-overflow at the previously failing caps', () => {
    for (const quarterSections of [true, false]) {
      const { outline, manifest } = buildSyntheticEverythingBook({ quarterSections, language: 'en' });
      for (const cap of [100_000, 140, 130, 126, 122]) {
        const result = fitBook(outline, manifest, { maxPages: cap });
        const v = violationsOf(result.document, outline, manifest, result.capacity.omittedMemoryIds);
        expect(checks(v, 'illustrated-stack-overflow'), `quarter=${quarterSections} cap=${cap}`).toEqual([]);
        expect(checks(v, 'title-then-empty'), `quarter=${quarterSections} cap=${cap}`).toEqual([]);
        expect(checks(v, 'blank-accounting'), `quarter=${quarterSections} cap=${cap}`).toEqual([]);
      }
    }
  });

  it('the synthetic year/custom book squeezed below its pools (cap 90) is also clean', () => {
    const { outline, manifest } = buildSyntheticYearBook({ scopeKind: 'custom', language: 'en' });
    const result = fitBook(outline, manifest, { maxPages: 90 });
    expect(violationsOf(result.document, outline, manifest, result.capacity.omittedMemoryIds)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Quote collections (fitter side of the Phase 2d redesign)
// ---------------------------------------------------------------------------

describe('quote collections: 1-3 entries one page, 4-6 a spread', () => {
  const quoteBook = (n: number, language: 'es' | 'en' = 'en') => {
    const ids = Array.from({ length: n }, (_, i) => `mem-${i}`);
    const memories = Object.fromEntries(ids.map((id, i) => [id, makeMemory({ date: `2024-04-${String(i + 1).padStart(2, '0')}`, text: `Quote number ${i}.`, assets: [] })]));
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', title: 'x', memoryIds: ids })]);
    return { manifest: makeManifest(memories, { language }), outline };
  };
  const collections = (document: BookDocument): BookPage[] => document.pages.filter((p) => p.templateId === 'quote-collection');
  const entryCount = (page: BookPage) => page.slots.filter((s) => s.kind === 'quote-entry').length;

  it('partitionQuoteRun keeps its balanced 3-6 groups', () => {
    expect(partitionQuoteRun(3)).toEqual([3]);
    expect(partitionQuoteRun(6)).toEqual([6]);
    expect(partitionQuoteRun(7)).toEqual([4, 3]);
    expect(partitionQuoteRun(13)).toEqual([5, 4, 4]);
  });

  it.each([
    [3, false],
    [4, true],
    [5, true],
    [6, true],
  ])('a run of %i is ONE quote-collection with isSpread=%s', (n, spread) => {
    const { manifest, outline } = quoteBook(n);
    const cols = collections(fitBook(outline, manifest).document);
    expect(cols).toHaveLength(1);
    expect(entryCount(cols[0])).toBe(n);
    expect(cols[0].isSpread).toBe(spread);
    // Text stays verbatim and in chronological order.
    expect(cols[0].slots.map((s) => (s.content as QuoteEntryContent).text)).toEqual(Array.from({ length: n }, (_, i) => `Quote number ${i}.`));
  });

  it('a 7-run is a 4-entry spread plus a 3-entry single page', () => {
    const { manifest, outline } = quoteBook(7);
    const cols = collections(fitBook(outline, manifest).document);
    expect(cols.map((p) => [entryCount(p), p.isSpread])).toEqual([
      [4, true],
      [3, false],
    ]);
  });

  it('a single-page collection never pays a parity blank (it has no even-start requirement)', () => {
    // A leading photo section puts the 3-quote section on whatever parity; neither may produce a blank.
    for (const lead of [1, 2]) {
      const photos = Array.from({ length: lead }, (_, i) => `mem-p${i}`);
      const manifest = makeManifest({
        ...Object.fromEntries(photos.map((id, i) => [id, makeMemory({ date: `2024-0${i + 1}-05`, assets: [makeAsset({ aspectRatio: 1 })] })])),
        'q-0': makeMemory({ date: '2024-05-01', text: 'Quote A.', assets: [] }),
        'q-1': makeMemory({ date: '2024-05-02', text: 'Quote B.', assets: [] }),
        'q-2': makeMemory({ date: '2024-05-03', text: 'Quote C.', assets: [] }),
      });
      const outline = makeOutline([
        ...photos.map((id, i) => makeElement({ id: `backbone:p${i}`, kind: 'backbone', title: `p${i}`, memoryIds: [id] })),
        makeElement({ id: 'backbone:q', kind: 'backbone', title: 'q', memoryIds: ['q-0', 'q-1', 'q-2'] }),
      ]);
      const { document } = fitBook(outline, manifest);
      expect(document.pages.some((p) => p.templateId === 'blank' && p.blankReason === 'parity:quote-collection')).toBe(false);
      expect(collections(document)[0].isSpread).toBe(false);
    }
  });

  describe('chapter mode: pooled collections', () => {
    const chapter = (n: number, startMonth: string, endMonth: string) =>
      makeElement({ id: `chapter:${n}`, kind: 'chapter', title: `Year ${n}`, subtitle: 'sub', chapter: { ageYear: n, startMonth, endMonth } });
    const pooledBook = (quotes: number, language: 'es' | 'en') => {
      const memories: Record<string, ManifestMemory> = {};
      const photoIds = ['p1', 'p2', 'p3', 'p4'];
      photoIds.forEach((id, i) => (memories[id] = makeMemory({ date: `2021-0${i + 4}-02`, assets: [makeAsset({ aspectRatio: 1 })] })));
      memories.p5 = makeMemory({ date: '2022-04-02', assets: [makeAsset({ aspectRatio: 1 })] });
      const quoteIds = Array.from({ length: quotes }, (_, i) => {
        const id = `q${i}`;
        memories[id] = makeMemory({ date: `2021-04-${String(10 + i).padStart(2, '0')}`, type: 'text_only', text: `Dijo algo ${i}.`, assets: [] });
        return id;
      });
      const outline = makeOutline([
        chapter(1, '2021-02', '2022-02'),
        makeElement({ id: 'backbone:a', kind: 'backbone', title: 'a', memoryIds: ['p1', 'p2', ...quoteIds.filter((_, i) => i % 2 === 0)] }),
        makeElement({ id: 'backbone:b', kind: 'backbone', title: 'b', memoryIds: ['p3', 'p4', ...quoteIds.filter((_, i) => i % 2 === 1)] }),
        chapter(2, '2022-03', '2023-02'),
        makeElement({ id: 'backbone:c', kind: 'backbone', title: 'c', memoryIds: ['p5'] }),
      ]);
      return { manifest: makeManifest(memories, { language }), outline };
    };

    it('a pooled collection carries the localized title as params.quotesTitle (no sectionHeader) under a stable `<chapter id>:quotes` element id', () => {
      for (const [language, title] of [
        ['es', 'Cosas que dijiste'],
        ['en', 'Things you said'],
      ] as const) {
        const { manifest, outline } = pooledBook(4, language);
        const cols = collections(fitBook(outline, manifest).document);
        expect(cols).toHaveLength(1);
        expect(cols[0].sourceElementId).toBe('chapter:1:quotes');
        expect(cols[0].params.quotesTitle).toBe(title);
        expect(cols[0].params.sectionHeader).toBeUndefined();
        expect(cols[0].isSpread).toBe(true);
      }
    });

    it('a pooled single page (3 quotes) is not a spread', () => {
      const { manifest, outline } = pooledBook(3, 'en');
      const cols = collections(fitBook(outline, manifest).document);
      expect(cols).toHaveLength(1);
      expect(cols[0].isSpread).toBe(false);
    });

    it('`sectionTitle:<chapter id>:quotes` retitles the pooled collection (and nothing else); eyebrow edits are orphans', () => {
      const { manifest, outline } = pooledBook(4, 'en');
      const { document } = fitBook(outline, manifest);
      const { document: edited, skipped } = applyPostFit(document, {
        text: {
          'sectionTitle:chapter:1:quotes': { value: 'Funny things', updatedAt: '2026-10-01T00:00:00Z' },
          'eyebrow:chapter:1:quotes': { value: 'ignored', updatedAt: '2026-10-01T00:00:00Z' },
        },
      } as never);
      expect(collections(edited)[0].params.quotesTitle).toBe('Funny things');
      expect(skipped.map((s) => s.key)).toEqual(['eyebrow:chapter:1:quotes']);
      // The host backbone section's own header is untouched.
      const host = edited.pages.find((p) => p.sourceElementId === 'backbone:b' && p.params.sectionHeader)!;
      expect((host.params.sectionHeader as { title: string }).title).toBe('b');
    });

    it('audit stays clean and no quote text is lost', () => {
      const { manifest, outline } = pooledBook(5, 'en');
      const { document, capacity } = fitBook(outline, manifest);
      expect(violationsOf(document, outline, manifest, capacity.omittedMemoryIds)).toEqual([]);
      const printedText = new Set(document.pages.flatMap((p) => p.slots.filter((s) => s.kind === 'quote-entry').map((s) => (s.content as QuoteEntryContent).text)));
      expect(printedText.size).toBe(5);
    });
  });
});
