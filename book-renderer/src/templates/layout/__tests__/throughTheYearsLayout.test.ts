import { describe, expect, it } from 'vitest';
import {
  layoutTtyItem,
  ttyOuterLayoutFor,
  ttyItemAbsoluteRect,
  ttyChildAbsoluteRect,
  TTY_SOURCE_WIDTH_FRACTION,
} from '../throughTheYearsLayout';
import { SAFE_INSET_MM, SPREAD_WIDTH_MM, SPREAD_HEIGHT_MM, canvasPxToTrimMm } from '../../mm';

/**
 * Round-21 print-safety fix — regression coverage for the shared pure
 * geometry `templates/ThroughTheYears.tsx` (the render) and
 * `model/audit.ts`'s `through-the-years` check both consume.
 */

const SAFE_X_MIN = SAFE_INSET_MM;
const SAFE_X_MAX = SPREAD_WIDTH_MM - SAFE_INSET_MM;
const SAFE_Y_MIN = SAFE_INSET_MM;
const SAFE_Y_MAX = SPREAD_HEIGHT_MM - SAFE_INSET_MM;

function rectsIntersect(a: { xMm: number; yMm: number; wMm: number; hMm: number }, b: typeof a): boolean {
  return a.xMm < b.xMm + b.wMm && a.xMm + a.wMm > b.xMm && a.yMm < b.yMm + b.hMm && a.yMm + a.hMm > b.yMm;
}

describe('layoutTtyItem — internal geometry', () => {
  it('the portrait is a square spanning the item\'s own full width, anchored at the item\'s own top-left', () => {
    const layout = layoutTtyItem(80, true);
    expect(layout.portrait).toEqual({ leftMm: 0, topMm: 0, widthMm: 80, heightMm: 80 });
  });

  it('the source thumb is a square at TTY_SOURCE_WIDTH_FRACTION of the item width, below the portrait with a positive gap', () => {
    const layout = layoutTtyItem(80, true);
    expect(layout.thumb).not.toBeNull();
    expect(layout.thumb!.widthMm).toBeCloseTo(80 * TTY_SOURCE_WIDTH_FRACTION, 6);
    expect(layout.thumb!.heightMm).toBeCloseTo(layout.thumb!.widthMm, 6); // square
    expect(layout.thumb!.leftMm).toBe(0);
    expect(layout.thumb!.topMm).toBeGreaterThan(layout.portrait.topMm + layout.portrait.heightMm);
  });

  it('the thumb is `null` when the portrait has no source photo, and the labels block falls back to the item\'s own left edge', () => {
    const withThumb = layoutTtyItem(80, true);
    const withoutThumb = layoutTtyItem(80, false);
    expect(withoutThumb.thumb).toBeNull();
    expect(withoutThumb.labels.leftMm).toBe(0);
    // Same vertical start either way — only the horizontal origin changes.
    expect(withoutThumb.labels.topMm).toBeCloseTo(withThumb.labels.topMm, 6);
  });

  it('the labels block sits to the right of the thumb (with a positive gap) when a thumb is present, and never overlaps the portrait', () => {
    const layout = layoutTtyItem(80, true);
    expect(layout.labels.leftMm).toBeGreaterThan(layout.thumb!.leftMm + layout.thumb!.widthMm);
    expect(layout.labels.topMm).toBeGreaterThanOrEqual(layout.portrait.topMm + layout.portrait.heightMm);
  });

  it('the item\'s own total height accounts for the taller of the thumb/labels row — never clips either', () => {
    // A narrow item: TTY_SOURCE_WIDTH_FRACTION of its width makes for a
    // short/thin thumb, shorter than the two-line label block — the
    // computed item height must still extend to cover the labels, not just
    // the (shorter) thumb.
    const narrow = layoutTtyItem(20, true);
    const rowBottom = Math.max(
      narrow.thumb!.topMm + narrow.thumb!.heightMm,
      narrow.labels.topMm + narrow.labels.heightMm,
    );
    expect(narrow.itemHeightMm).toBeGreaterThanOrEqual(rowBottom - 1e-6);
  });

  it('is a pure function of its own inputs — same width/hasThumb always produces the same rects', () => {
    const a = layoutTtyItem(73.5, true);
    const b = layoutTtyItem(73.5, true);
    expect(a).toEqual(b);
  });
});

describe('ttyOuterLayoutFor — per-count outer position table', () => {
  it('every reachable count (1, 2, 3 — the only sizes `partitionPortraits` ever produces) has an entry for every index it will be called with', () => {
    for (const count of [1, 2, 3]) {
      for (let i = 0; i < count; i++) {
        const outer = ttyOuterLayoutFor(count, i);
        expect(outer.widthPx).toBeGreaterThan(0);
      }
    }
  });

  it('a 2-portrait spread splits one item per page (owner review round 5, item 8 — regression: used to double up on the left page)', () => {
    const first = ttyOuterLayoutFor(2, 0);
    const second = ttyOuterLayoutFor(2, 1);
    // 840 canvas px = the page-1/page-2 boundary on the 1680px spread canvas.
    expect(first.leftPx).toBeLessThan(840);
    expect(second.leftPx).toBeGreaterThanOrEqual(840);
  });
});

describe('through-the-years geometry — every reachable table entry stays inside the spread\'s safe box (round-21)', () => {
  for (const count of [1, 2, 3]) {
    for (let i = 0; i < count; i++) {
      it(`count=${count} index=${i}: portrait, thumb, and labels all fit`, () => {
        const outer = ttyOuterLayoutFor(count, i);
        const itemWidthMm = canvasPxToTrimMm(outer.widthPx);
        const item = layoutTtyItem(itemWidthMm, true);
        const itemAbs = ttyItemAbsoluteRect(outer, item.itemHeightMm);

        const checkContained = (rect: { xMm: number; yMm: number; wMm: number; hMm: number }) => {
          expect(rect.xMm).toBeGreaterThanOrEqual(SAFE_X_MIN - 1e-6);
          expect(rect.xMm + rect.wMm).toBeLessThanOrEqual(SAFE_X_MAX + 1e-6);
          expect(rect.yMm).toBeGreaterThanOrEqual(SAFE_Y_MIN - 1e-6);
          expect(rect.yMm + rect.hMm).toBeLessThanOrEqual(SAFE_Y_MAX + 1e-6);
        };

        checkContained(ttyChildAbsoluteRect(itemAbs, item.portrait));
        checkContained(ttyChildAbsoluteRect(itemAbs, item.thumb!));
        checkContained(ttyChildAbsoluteRect(itemAbs, item.labels));

        // No overlap between the label block and the portrait box.
        expect(
          rectsIntersect(ttyChildAbsoluteRect(itemAbs, item.portrait), ttyChildAbsoluteRect(itemAbs, item.labels)),
        ).toBe(false);
      });
    }
  }
});
