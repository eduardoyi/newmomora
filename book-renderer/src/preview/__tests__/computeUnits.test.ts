import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { computeUnits, buildSyntheticClosingPartner } from '../App';
import { fitBook } from '../../model/fitter';
import { parseManifest, parseOutline } from '../../model/loader';
import type { BookOutline, BookPage } from '../../model/types';

/**
 * Polish-round item 2 regression tests: (a) the front-matter blank +
 * dedication pair, physically left+right but both OUTSIDE `numberPages`'s
 * counted sequence (`isEvenPage: null`); (b) the book's final left-handed
 * page (`closing`, or the `parity:closing-total` blank after it) gets a
 * synthetic display-only right-hand partner.
 */

function page(overrides: Partial<BookPage>): BookPage {
  return {
    id: 'p',
    sourceElementId: 'src',
    templateId: 'flex-grid',
    params: {},
    slots: [],
    variants: [],
    isSpread: false,
    isEvenPage: null,
    pageNumbers: null,
    ...overrides,
  };
}

describe('computeUnits — front-matter blank + dedication (item 2a)', () => {
  it('pairs the front-matter-verso blank with the dedication that follows it, even though numberPages leaves both isEvenPage: null', () => {
    const blank = page({ id: 'title:blank', sourceElementId: 'title', templateId: 'blank', blankReason: 'front-matter-verso', isEvenPage: null, pageNumbers: null });
    const dedication = page({ id: 'title', sourceElementId: 'title', templateId: 'dedication', isEvenPage: false, pageNumbers: [1] });
    const nextContent = page({ id: 'content-1', sourceElementId: 'seg-1', isEvenPage: true, pageNumbers: [2] });

    const units = computeUnits([blank, dedication, nextContent]);

    expect(units[0].rawIndices).toEqual([0, 1]);
    expect(units[0].syntheticRightBlank).toBeFalsy();
  });

  it('does NOT pair the front-matter blank with anything other than a dedication page (defensive — should never happen in practice)', () => {
    const blank = page({ id: 'title:blank', sourceElementId: 'title', templateId: 'blank', blankReason: 'front-matter-verso', isEvenPage: null, pageNumbers: null });
    const somethingElse = page({ id: 'x', sourceElementId: 'x', templateId: 'flex-grid', isEvenPage: false, pageNumbers: [1] });

    const units = computeUnits([blank, somethingElse]);

    expect(units[0].rawIndices).toEqual([0]);
    expect(units[1].rawIndices).toEqual([1]);
  });
});

describe('computeUnits — closing page synthetic right-hand partner (item 2b)', () => {
  it('gives the final page a synthetic blank partner when it lands left-handed (even) and alone', () => {
    const priorContent = page({ id: 'c-1', sourceElementId: 'seg', isEvenPage: false, pageNumbers: [3] });
    const closing = page({ id: 'closing', sourceElementId: 'closing', templateId: 'closing', isEvenPage: true, pageNumbers: [4] });

    const units = computeUnits([priorContent, closing]);
    const lastUnit = units[units.length - 1];

    expect(lastUnit.rawIndices).toEqual([1]);
    expect(lastUnit.syntheticRightBlank).toBe(true);

    const partner = buildSyntheticClosingPartner(closing);
    expect(partner.templateId).toBe('blank');
    expect(partner.isEvenPage).toBe(false);
    expect(partner.pageNumbers).toBeNull();
    expect(partner.id).not.toBe(closing.id);
  });

  it('does NOT add a synthetic partner when the real parity:closing-total blank already exists and is itself the last (even) page', () => {
    const closing = page({ id: 'closing', sourceElementId: 'closing', templateId: 'closing', isEvenPage: false, pageNumbers: [3] });
    const parityBlank = page({ id: 'closing:even-page-blank', sourceElementId: 'closing', templateId: 'blank', blankReason: 'parity:closing-total', isEvenPage: true, pageNumbers: [4] });

    const units = computeUnits([closing, parityBlank]);
    const lastUnit = units[units.length - 1];

    // The real parity blank is itself the trailing left-handed lone page —
    // it gets the synthetic partner instead of `closing` (which stood alone
    // as an ordinary odd/right page, correctly, one unit earlier).
    expect(units[0].rawIndices).toEqual([0]);
    expect(units[0].syntheticRightBlank).toBeFalsy();
    expect(lastUnit.rawIndices).toEqual([1]);
    expect(lastUnit.syntheticRightBlank).toBe(true);
  });

  it('does NOT add a synthetic partner when the final page is right-handed (odd) with nothing after it', () => {
    const closing = page({ id: 'closing', sourceElementId: 'closing', templateId: 'closing', isEvenPage: false, pageNumbers: [3] });
    const units = computeUnits([closing]);
    expect(units[0].syntheticRightBlank).toBeFalsy();
  });

  it('never applies to a spread or cover-wrap final page', () => {
    const cover = page({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', isEvenPage: null, pageNumbers: null });
    const units = computeUnits([cover]);
    expect(units[0].syntheticRightBlank).toBeFalsy();
  });
});

describe('computeUnits — real book-data fixture (the "fitted enzo fixture")', () => {
  const BOOK_DATA_DIR = resolve(process.cwd(), 'book-data');
  const manifestPath = resolve(BOOK_DATA_DIR, 'enzo-year-one', 'manifest.json');
  const outlinePath = resolve(BOOK_DATA_DIR, 'enzo-year-one', 'book.outline.json');
  const available = existsSync(manifestPath) && existsSync(outlinePath);
  const runner = available ? it : it.skip;

  runner('pairs the real front-matter blank + dedication, and gives the real final left-handed page a synthetic partner', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const outline: BookOutline = parseOutline(JSON.parse(readFileSync(outlinePath, 'utf8')));
    const { document } = fitBook(outline, manifest);

    const units = computeUnits(document.pages);

    const blankIdx = document.pages.findIndex((p) => p.templateId === 'blank' && p.blankReason === 'front-matter-verso');
    const dedicationIdx = document.pages.findIndex((p) => p.templateId === 'dedication');
    expect(blankIdx).toBeGreaterThanOrEqual(0);
    expect(dedicationIdx).toBe(blankIdx + 1);
    const frontMatterUnit = units.find((u) => u.rawIndices[0] === blankIdx);
    expect(frontMatterUnit?.rawIndices).toEqual([blankIdx, dedicationIdx]);

    const lastUnit = units[units.length - 1];
    const lastPage = document.pages[lastUnit.rawIndices[lastUnit.rawIndices.length - 1]];
    expect(['closing', 'blank']).toContain(lastPage.templateId);
    if (lastPage.isEvenPage === true) {
      expect(lastUnit.syntheticRightBlank).toBe(true);
    }
  });
});
