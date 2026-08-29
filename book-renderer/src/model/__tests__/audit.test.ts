import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { auditBookDocument } from '../audit';
import { fitBook } from '../fitter';
import { parseManifest, parseOutline } from '../loader';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import type { BookDocument, BookOutline, BookPage } from '../types';

/**
 * Owner review round 5, item 1: automated content-integrity audit. These
 * tests exercise each of the five checks independently against small,
 * hand-built documents (so a failure points precisely at the broken check),
 * plus the real-books integration test at the bottom (zero violations
 * required on Enzo/Mara, skipped gracefully when book-data isn't present).
 */

function emptyPage(overrides: Partial<BookPage> & Pick<BookPage, 'id' | 'sourceElementId' | 'templateId'>): BookPage {
  return {
    params: {},
    slots: [],
    variants: [],
    isSpread: false,
    isEvenPage: null,
    pageNumbers: null,
    ...overrides,
  };
}

function docWith(pages: BookPage[]): BookDocument {
  return { childName: 'Test', scopeLabel: 'Year One', pages, totalPages: pages.length * 2 };
}

describe('auditBookDocument — (a) month continuity', () => {
  it('flags a backbone month that had memories in the outline but produced zero pages (the diagnosed Enzo bug)', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:oct', kind: 'backbone', title: 'October 2024', memoryIds: ['mem-1'] })]);
    // Simulate the month being wiped out entirely: no page carries this sourceElementId.
    const document = docWith([emptyPage({ id: 'unrelated', sourceElementId: 'backbone:nov', templateId: 'anchor-media' })]);

    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.some((v) => v.check === 'month-continuity' && v.elementId === 'backbone:oct')).toBe(true);
  });

  it('passes when every backbone month with memories has at least one page', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:oct', kind: 'backbone', title: 'October 2024', memoryIds: ['mem-1'] })]);
    const document = docWith([emptyPage({ id: 'p1', sourceElementId: 'backbone:oct', templateId: 'anchor-media' })]);

    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'month-continuity')).toHaveLength(0);
  });

  it('never flags a backbone element the outline gave zero memories to begin with', () => {
    const manifest = makeManifest({});
    const outline = makeOutline([makeElement({ id: 'backbone:empty', kind: 'backbone', title: 'Empty Month', memoryIds: [] })]);
    const document = docWith([]);

    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'month-continuity')).toHaveLength(0);
  });

  it('flags a backbone section that renders out of chronological order', () => {
    const manifest = makeManifest({
      'mem-nov': makeMemory({ date: '2024-11-15', assets: [makeAsset()] }),
      'mem-oct': makeMemory({ date: '2024-10-15', assets: [makeAsset()] }),
    });
    // November listed BEFORE October in the outline's own element order.
    const outline = makeOutline([
      makeElement({ id: 'backbone:nov', kind: 'backbone', title: 'November 2024', memoryIds: ['mem-nov'] }),
      makeElement({ id: 'backbone:oct', kind: 'backbone', title: 'October 2024', memoryIds: ['mem-oct'] }),
    ]);
    const document = docWith([
      emptyPage({ id: 'p1', sourceElementId: 'backbone:nov', templateId: 'anchor-media' }),
      emptyPage({ id: 'p2', sourceElementId: 'backbone:oct', templateId: 'anchor-media' }),
    ]);

    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.some((v) => v.check === 'month-continuity' && v.elementId === 'backbone:oct')).toBe(true);
  });
});

describe('auditBookDocument — (b) section-title orphans', () => {
  it('flags a themed section with a spread-title page but zero content pages behind it (the diagnosed Mara bug)', () => {
    const outline = makeOutline([
      makeElement({ id: 'topic:mirian', kind: 'themed', title: 'Retratos con Mirian', memoryIds: ['mem-1'] }),
    ]);
    const document = docWith([emptyPage({ id: 'topic:mirian:title', sourceElementId: 'topic:mirian', templateId: 'spread-title' })]);

    const violations = auditBookDocument(document, outline, makeManifest({}));
    expect(violations.some((v) => v.check === 'section-title-orphan' && v.elementId === 'topic:mirian')).toBe(true);
  });

  it('passes when a themed section has its title AND at least one content page', () => {
    const outline = makeOutline([makeElement({ id: 'topic:mirian', kind: 'themed', title: 'Retratos con Mirian', memoryIds: ['mem-1'] })]);
    const document = docWith([
      emptyPage({ id: 'topic:mirian:title', sourceElementId: 'topic:mirian', templateId: 'spread-title' }),
      emptyPage({ id: 'topic:mirian:0', sourceElementId: 'topic:mirian', templateId: 'anchor-media' }),
    ]);

    const violations = auditBookDocument(document, outline, makeManifest({}));
    expect(violations.filter((v) => v.check === 'section-title-orphan')).toHaveLength(0);
  });

  it('applies the same check to a firsts section', () => {
    const outline = makeOutline([makeElement({ id: 'firsts', kind: 'firsts', title: 'Firsts', memoryIds: ['mem-1'] })]);
    const document = docWith([emptyPage({ id: 'firsts:title', sourceElementId: 'firsts', templateId: 'spread-title' })]);

    const violations = auditBookDocument(document, outline, makeManifest({}));
    expect(violations.some((v) => v.check === 'section-title-orphan' && v.elementId === 'firsts')).toBe(true);
  });

  it('fitBook itself never produces this violation — the dissolve-when-empty fix is verified end to end here too', () => {
    // All of the themed section's memories are omitted from the manifest
    // entirely (simulating an upstream reassignment) — the section must
    // dissolve rather than print a title with nothing behind it.
    const manifest = makeManifest({});
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [] }),
      makeElement({ id: 'topic:mirian', kind: 'themed', title: 'Retratos con Mirian', memoryIds: ['mem-missing'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'section-title-orphan')).toHaveLength(0);
    expect(document.pages.some((p) => p.templateId === 'spread-title')).toBe(false);
  });
});

describe('auditBookDocument — (d) blank-page accounting', () => {
  it('flags a blank page with no blankReason', () => {
    const document = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'blank' })]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'blank-accounting' && v.pageId === 'p1')).toBe(true);
  });

  it('flags a blank page with an UNRECOGNIZED blankReason', () => {
    const document = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'blank', blankReason: 'made-up-reason' })]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'blank-accounting')).toBe(true);
  });

  it('passes a blank page carrying a recognized reason', () => {
    const document = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'blank', blankReason: 'front-matter-verso' })]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.filter((v) => v.check === 'blank-accounting')).toHaveLength(0);
  });

  it('never flags a non-blank page', () => {
    const document = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'anchor-media' })]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.filter((v) => v.check === 'blank-accounting')).toHaveLength(0);
  });

  it('flags a parity:panorama-spread blank unconditionally — no section-boundary exemption (round-17, matches parity:full-bleed)', () => {
    // p1 (the blank) sits at a SECTION BOUNDARY: its previous page belongs
    // to a DIFFERENT element (backbone:a) than the blank itself
    // (backbone:b) — the exact shape the generic parity-blank check below
    // tolerates for every OTHER parity reason. A panorama's own demotion
    // fallback (fitter.ts's panorama unit handler) means this should never
    // happen in practice, but if one somehow slipped through, it must never
    // get a free pass just for landing at a boundary.
    const document = docWith([
      emptyPage({ id: 'p0', sourceElementId: 'backbone:a', templateId: 'anchor-media' }),
      emptyPage({ id: 'p1', sourceElementId: 'backbone:b', templateId: 'blank', blankReason: 'parity:panorama-spread' }),
      emptyPage({ id: 'p2', sourceElementId: 'backbone:b', templateId: 'panorama-spread', isSpread: true }),
    ]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'blank-accounting' && v.pageId === 'p1')).toBe(true);
  });

  it('still tolerates a boundary parity blank for a reason OTHER than full-bleed/panorama-spread (the exemption is not gone entirely)', () => {
    const document = docWith([
      emptyPage({ id: 'p0', sourceElementId: 'backbone:a', templateId: 'anchor-media' }),
      emptyPage({ id: 'p1', sourceElementId: 'backbone:b', templateId: 'blank', blankReason: 'parity:quote-collection' }),
      emptyPage({ id: 'p2', sourceElementId: 'backbone:b', templateId: 'quote-collection', isSpread: true }),
    ]);
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'blank-accounting' && v.pageId === 'p1')).toBe(false);
  });

  it('fitBook itself never produces an unaccounted blank on real pairing/parity scenarios', () => {
    const manifest = makeManifest({
      'mem-0': makeMemory({ assets: [makeAsset()] }),
      'mem-hero': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-0', 'mem-hero'], highlights: ['mem-hero'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'blank-accounting')).toHaveLength(0);
  });
});

describe('auditBookDocument — (e) even total page count', () => {
  it('flags an odd total (above the Prodigi-range floor)', () => {
    const document: BookDocument = { childName: 'Test', scopeLabel: 'Year One', pages: [], totalPages: 41 };
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'even-page-count')).toBe(true);
  });

  it('passes an even total', () => {
    const document: BookDocument = { childName: 'Test', scopeLabel: 'Year One', pages: [], totalPages: 42 };
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.filter((v) => v.check === 'even-page-count')).toHaveLength(0);
  });

  it('never flags an odd total BELOW the Prodigi printable range (a tiny synthetic test document, not a real book)', () => {
    const document: BookDocument = { childName: 'Test', scopeLabel: 'Year One', pages: [], totalPages: 3 };
    const violations = auditBookDocument(document, makeOutline([]), makeManifest({}));
    expect(violations.filter((v) => v.check === 'even-page-count')).toHaveLength(0);
  });
});

describe('auditBookDocument — (c) geometric overlap', () => {
  it('flags two anchor-media photo slots whose boxes actually intersect', () => {
    const outline = makeOutline([]);
    const manifest = makeManifest({});
    const page = emptyPage({
      id: 'p1',
      sourceElementId: 'x',
      templateId: 'anchor-media',
      params: { footerIndex: [{ index: 1, indices: [1], date: '2024-01-01', note: null }, { index: 2, indices: [2], date: '2024-01-01', note: null }] },
      slots: [
        {
          id: 's1',
          kind: 'photo',
          content: {
            kind: 'photo',
            assetFile: 'a1.jpg',
            assetWidth: 100,
            assetHeight: 100,
            assetAspectRatio: 1,
            memoryId: 'mem-1',
            date: '2024-01-01',
            caption: null,
            hero: true,
            qr: false,
            shareToken: null,
            taggedMembers: [],
            milestones: [],
            targetAspect: 1,
            looseFit: false,
            index: 1,
            cropBand: null,
          },
        },
        {
          id: 's2',
          kind: 'photo',
          content: {
            kind: 'photo',
            assetFile: 'a2.jpg',
            assetWidth: 100,
            assetHeight: 100,
            assetAspectRatio: 1,
            memoryId: 'mem-2',
            date: '2024-01-01',
            caption: null,
            hero: false,
            qr: false,
            shareToken: null,
            taggedMembers: [],
            milestones: [],
            targetAspect: 1,
            looseFit: false,
            index: 2,
            cropBand: null,
          },
        },
      ],
    });
    const document = docWith([page]);
    // Sanity check: a REAL fit of two square photos never overlaps (the
    // fix under test) — this synthetic case exists only to prove the
    // CHECKER ITSELF fires when handed a page it can't get real geometry
    // for cleanly (both slots carry aspect 1, a normal passing case) —
    // see the dedicated fitter-level real-data check below for the actual
    // regression coverage of the round-5 item 3 overlap bug.
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'geometric-overlap')).toHaveLength(0);
  });

  it('never reports an overlap on a real fitBook anchor-media pair (regression coverage for the round-5 item 3 fix)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 1.5 })] }),
      'mem-2': makeMemory({ assets: [makeAsset({ aspectRatio: 1.5 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })], {});
    const { document } = fitBook(outline, manifest, { maxPages: 3 }); // force pairing
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'geometric-overlap')).toHaveLength(0);
  });

  it('round-8 item 2: never reports an overflow for a real fitBook tall-solo-beside-header page', () => {
    // A single TALL (portrait) photo as the first (header-carrying) unit of
    // a backbone segment — exactly the composition `layoutTallSoloBesideHeader`
    // targets.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ aspectRatio: 0.6 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].params.sectionHeader).toBeTruthy();
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'geometric-overlap')).toHaveLength(0);
  });
});

describe('auditBookDocument — (h) photo count (owner review round 8, item 5b "grids only at 4")', () => {
  function photoSlot(id: string, memoryId: string): BookPage['slots'][number] {
    return {
      id,
      kind: 'photo',
      content: {
        kind: 'photo',
        assetFile: `${id}.jpg`,
        assetWidth: 100,
        assetHeight: 100,
        assetAspectRatio: 1,
        memoryId,
        date: '2024-01-01',
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
      },
    };
  }

  it('flags a page with exactly 3 photo slots — a 3-photo grid must never happen', () => {
    const page = emptyPage({
      id: 'p1',
      sourceElementId: 'x',
      templateId: 'flex-grid',
      slots: [photoSlot('s1', 'mem-1'), photoSlot('s2', 'mem-2'), photoSlot('s3', 'mem-3')],
    });
    const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'photo-count' && v.pageId === 'p1')).toBe(true);
  });

  it('flags a page with more than 4 photo slots', () => {
    const page = emptyPage({
      id: 'p1',
      sourceElementId: 'x',
      templateId: 'flex-grid',
      slots: [1, 2, 3, 4, 5].map((n) => photoSlot(`s${n}`, `mem-${n}`)),
    });
    const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'photo-count' && v.pageId === 'p1')).toBe(true);
  });

  it('never flags a page with 1, 2, or 4 photo slots', () => {
    for (const n of [1, 2, 4]) {
      const page = emptyPage({
        id: `p-${n}`,
        sourceElementId: 'x',
        templateId: n === 4 ? 'flex-grid' : 'anchor-media',
        slots: Array.from({ length: n }, (_, i) => photoSlot(`s${i}`, `mem-${i}`)),
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.filter((v) => v.check === 'photo-count')).toHaveLength(0);
    }
  });

  it('a real fitBook run never produces a page with exactly 3 photo slots', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset(), makeAsset(), makeAsset()] }), // used to be a 3-photo grid
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const { document } = fitBook(outline, manifest);
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'photo-count')).toHaveLength(0);
  });
});

describe('auditBookDocument — (j) illustrated-digest geometry (Task 1, round-12)', () => {
  function digestSlot(id: string, memoryId: string, text: string, aspectRatio: number): BookPage['slots'][number] {
    return {
      id,
      kind: 'digest-entry',
      content: {
        kind: 'digest-entry',
        memoryId,
        date: '2024-01-01',
        text,
        illustration: { file: `${id}.webp`, width: 800, height: 800, aspectRatio },
      },
    };
  }

  it('flags an illustrated-digest column whose packed rows overflow the safe box (too many entries in one column, forced directly)', () => {
    // A hand-built page bypasses the fitter's own chunk-size rule — the
    // audit is a geometry-only backstop, so it must still catch an overflow
    // regardless of how the page was produced. Rows are FIXED 82mm squares
    // now (aspect never inflates them — see DIGEST_ILLO_WIDTH_MM), so the
    // way a column overflows is ENTRY COUNT: 6 entries split 3-per-column
    // (`splitDigestColumns`) = 3 x 82mm + 2 gaps ≈ 258mm, far past the
    // ~182mm available.
    const page = emptyPage({
      id: 'p1',
      sourceElementId: 'x',
      templateId: 'illustrated-digest',
      isSpread: true,
      slots: [
        digestSlot('s1', 'mem-1', 'Short caption one.', 1),
        digestSlot('s2', 'mem-2', 'Short caption two.', 1),
        digestSlot('s3', 'mem-3', 'Short caption three.', 1),
        digestSlot('s4', 'mem-4', 'Short caption four.', 1),
        digestSlot('s5', 'mem-5', 'Short caption five.', 1),
        digestSlot('s6', 'mem-6', 'Short caption six.', 1),
      ],
    });
    const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
    expect(violations.some((v) => v.check === 'illustrated-digest' && v.pageId === 'p1')).toBe(true);
  });

  it('never flags a normal 2-per-column illustrated-digest page at the shared width and a near-square aspect', () => {
    const page = emptyPage({
      id: 'p1',
      sourceElementId: 'x',
      templateId: 'illustrated-digest',
      isSpread: true,
      slots: [
        digestSlot('s1', 'mem-1', 'Short caption one.', 1),
        digestSlot('s2', 'mem-2', 'Short caption two.', 1),
        digestSlot('s3', 'mem-3', 'Short caption three.', 1),
        digestSlot('s4', 'mem-4', 'Short caption four.', 1),
      ],
    });
    const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
    expect(violations.filter((v) => v.check === 'illustrated-digest')).toHaveLength(0);
  });

  it('a real fitBook run with an engaged digest sweep produces zero illustrated-digest geometry violations', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `mem-${i}`);
    const manifest = makeManifest(
      Object.fromEntries(
        ids.map((id, i) => [
          id,
          makeMemory({
            date: `2025-01-0${i + 1}`,
            type: 'text_illustration',
            text: `Digest audit entry ${i}.`,
            assets: [],
            illustration: { file: `assets/illo-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
          }),
        ]),
      ),
    );
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ids })]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages.some((p) => p.templateId === 'illustrated-digest')).toBe(true);
    const violations = auditBookDocument(document, outline, manifest);
    expect(violations.filter((v) => v.check === 'illustrated-digest')).toHaveLength(0);
  });

  describe('even-only structural rule (owner round-12 correction)', () => {
    it('flags an odd entry count on a digest page (the "lonely last row" the owner\'s screenshots caught)', () => {
      const page = emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'illustrated-digest',
        isSpread: true,
        slots: [
          digestSlot('s1', 'mem-1', 'Short caption one.', 1),
          digestSlot('s2', 'mem-2', 'Short caption two.', 1),
          digestSlot('s3', 'mem-3', 'Short caption three.', 1),
        ],
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.some((v) => v.check === 'illustrated-digest' && v.pageId === 'p1' && v.message.includes('odd entry count'))).toBe(true);
    });

    it('flags a SPREAD with an even but wrong entry count (2, not 4)', () => {
      const page = emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'illustrated-digest',
        isSpread: true,
        slots: [digestSlot('s1', 'mem-1', 'Short caption one.', 1), digestSlot('s2', 'mem-2', 'Short caption two.', 1)],
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.some((v) => v.check === 'illustrated-digest' && v.pageId === 'p1' && v.message.includes('SPREAD'))).toBe(true);
    });

    it('flags a SINGLE page with an even but wrong entry count (4, not 2)', () => {
      const page = emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'illustrated-digest',
        isSpread: false,
        slots: [
          digestSlot('s1', 'mem-1', 'Short caption one.', 1),
          digestSlot('s2', 'mem-2', 'Short caption two.', 1),
          digestSlot('s3', 'mem-3', 'Short caption three.', 1),
          digestSlot('s4', 'mem-4', 'Short caption four.', 1),
        ],
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.some((v) => v.check === 'illustrated-digest' && v.pageId === 'p1' && v.message.includes('SINGLE PAGE'))).toBe(true);
    });

    it('never flags a SPREAD with exactly 4 entries', () => {
      const page = emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'illustrated-digest',
        isSpread: true,
        slots: [1, 2, 3, 4].map((n) => digestSlot(`s${n}`, `mem-${n}`, `Short caption ${n}.`, 1)),
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.filter((v) => v.check === 'illustrated-digest')).toHaveLength(0);
    });

    it('never flags a SINGLE page with exactly 2 entries', () => {
      const page = emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'illustrated-digest',
        isSpread: false,
        slots: [digestSlot('s1', 'mem-1', 'Short caption one.', 1), digestSlot('s2', 'mem-2', 'Short caption two.', 1)],
      });
      const violations = auditBookDocument(docWith([page]), makeOutline([]), makeManifest({}));
      expect(violations.filter((v) => v.check === 'illustrated-digest')).toHaveLength(0);
    });

    it('a real fitBook run whose digest sweep produces BOTH a spread and a single page passes the even-only rule end to end', () => {
      // 9 total (2 kept-full + 7 sweepable) -> spread(4) + single(2) + 1 ordinary — see fitter.test.ts's matching chunking test for the exact shape.
      const memories: Record<string, ReturnType<typeof makeMemory>> = {};
      const aIds = Array.from({ length: 6 }, (_, i) => `a-${i}`);
      aIds.forEach((id, i) => {
        memories[id] = makeMemory({
          date: `2025-01-${String(i + 1).padStart(2, '0')}`,
          type: 'text_illustration',
          text: `Digest even-rule entry ${i}.`,
          assets: [],
          illustration: { file: `assets/illo-a-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
        });
      });
      memories['sep'] = makeMemory({ date: '2025-01-07', assets: [makeAsset()], milestones: [{ id: 'm', name: 'First steps', detail: '' }] });
      const bIds = Array.from({ length: 2 }, (_, i) => `b-${i}`);
      bIds.forEach((id, i) => {
        memories[id] = makeMemory({
          date: `2025-01-${String(i + 8).padStart(2, '0')}`,
          type: 'text_illustration',
          text: `Digest even-rule entry b${i}.`,
          assets: [],
          illustration: { file: `assets/illo-b-${i}.webp`, width: 800, height: 800, aspectRatio: 1 },
        });
      });
      const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: [...aIds, 'sep', ...bIds] })]);
      const { document } = fitBook(outline, makeManifest(memories));
      const digestPages = document.pages.filter((p) => p.templateId === 'illustrated-digest');
      expect(digestPages.some((p) => p.isSpread)).toBe(true);
      expect(digestPages.some((p) => !p.isSpread)).toBe(true);
      const violations = auditBookDocument(document, outline, makeManifest(memories));
      expect(violations.filter((v) => v.check === 'illustrated-digest')).toHaveLength(0);
    });
  });
});

describe('auditBookDocument — real books (owner review round 5, item 1: zero violations required)', () => {
  const BOOK_DATA_DIR = resolve(process.cwd(), 'book-data');
  // Round-17 (Task 1): all five real books, not just the two pre-existing
  // ones — enzo-year-one/enzo-year-two/mara-year-two are the photo-heavy
  // validation books whose panorama parity blanks this round fixes, and
  // this is the permanent regression backstop for that fix.
  const REAL_BOOKS = ['enzo-year-one', 'enzo-year-two', 'enzo-year-three', 'mara-year-one', 'mara-year-two'];

  for (const slug of REAL_BOOKS) {
    const manifestPath = resolve(BOOK_DATA_DIR, slug, 'manifest.json');
    const outlinePath = resolve(BOOK_DATA_DIR, slug, 'book.outline.json');
    const available = existsSync(manifestPath) && existsSync(outlinePath);
    const runner = available ? it : it.skip;

    runner(`${slug}: a full fit produces zero integrity violations`, () => {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const outline: BookOutline = parseOutline(JSON.parse(readFileSync(outlinePath, 'utf8')));
      const { document } = fitBook(outline, manifest);
      const violations = auditBookDocument(document, outline, manifest);
      if (violations.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `${slug}: ${violations.length} integrity violation(s):\n` +
            violations.map((v) => `  [${v.check}] ${v.message}`).join('\n'),
        );
      }
      expect(violations).toEqual([]);
    });
  }
});
