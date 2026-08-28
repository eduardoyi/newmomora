import { describe, expect, it } from 'vitest';
import { layoutFlexGrid, type FlexGridInput } from '../flexGridLayout';
import { MIN_IMAGE_SIDE_MM } from '../../mm';

const SAFE_BOX_MM = 190; // matches templates/mm.ts SAFE_BOX_MM

function rectsIntersect(a: { xMm: number; yMm: number; wMm: number; hMm: number }, b: typeof a): boolean {
  return a.xMm < b.xMm + b.wMm && a.xMm + a.wMm > b.xMm && a.yMm < b.yMm + b.hMm && a.yMm + a.hMm > b.yMm;
}

describe('layoutFlexGrid — round-8 item 5b ("grids only at 4")', () => {
  it('a 4-photo set (the only count flex-grid ever legitimately receives) lays out 2-per-row: every cell spans HALF the width, never a full row', () => {
    const items: FlexGridInput[] = [
      { aspect: 1.5, hero: false },
      { aspect: 1, hero: false },
      { aspect: 0.8, hero: false },
      { aspect: 1.5, hero: false },
    ];
    const rects = layoutFlexGrid(items, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(rects).toHaveLength(4);
    for (const r of rects) {
      // colSpanFor(n=4) always returns 3 of 6 columns — roughly half the
      // width (92.5mm of 190mm, net of the shared gutter) — never the full
      // 190mm a single cramped row would use.
      expect(r.wMm).toBeLessThan(SAFE_BOX_MM * 0.6);
      expect(r.wMm).toBeGreaterThan(SAFE_BOX_MM * 0.4);
    }
    // Exactly two distinct x-starts are used (a left column and a right
    // column) — confirms 2-per-row, not a single-column stack of 4.
    const distinctX = new Set(rects.map((r) => Math.round(r.xMm)));
    expect(distinctX.size).toBe(2);
  });

  it('a 4-photo grid fills the canvas VERTICALLY as two shelves, not one cramped row (owner round-7 item 1c, preserved) — the second shelf starts meaningfully below the first', () => {
    const items: FlexGridInput[] = [
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
    ];
    const rects = layoutFlexGrid(items, SAFE_BOX_MM, SAFE_BOX_MM);
    const yValues = rects.map((r) => r.yMm).sort((a, b) => a - b);
    // Two low values (first shelf) and two meaningfully higher values
    // (second shelf) — never all four sharing one shelf level.
    expect(yValues[2] - yValues[0]).toBeGreaterThan(20);
  });

  it('a hero-flagged item in a 4-photo grid still claims 4 of 6 columns, wider than its non-hero siblings', () => {
    const items: FlexGridInput[] = [
      { aspect: 1.5, hero: true },
      { aspect: 1, hero: false },
      { aspect: 0.8, hero: false },
      { aspect: 1.5, hero: false },
    ];
    const rects = layoutFlexGrid(items, SAFE_BOX_MM, SAFE_BOX_MM);
    expect(rects[0].wMm).toBeGreaterThan(rects[1].wMm);
  });

  it('no two cells intersect, for a 4-photo grid at a squeezed (header-reduced) content height', () => {
    const items: FlexGridInput[] = [
      { aspect: 1.5, hero: false },
      { aspect: 1, hero: false },
      { aspect: 0.8, hero: false },
      { aspect: 1.3, hero: false },
    ];
    const headerReducedHeight = SAFE_BOX_MM - 40 - 22; // matches templates/mm.ts SECTION_HEADER_RESERVE_MM + FOOTER_RESERVE_MM
    const rects = layoutFlexGrid(items, SAFE_BOX_MM, headerReducedHeight);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsIntersect(rects[i], rects[j])).toBe(false);
      }
    }
  });

  it('every cell clears the shared MIN_IMAGE_SIDE_MM floor on its short side at an ordinary (unsqueezed) content height', () => {
    const items: FlexGridInput[] = [
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
      { aspect: 1.5, hero: false },
    ];
    const rects = layoutFlexGrid(items, SAFE_BOX_MM, SAFE_BOX_MM);
    for (const r of rects) {
      expect(Math.min(r.wMm, r.hMm)).toBeGreaterThanOrEqual(MIN_IMAGE_SIDE_MM - 1e-6);
    }
  });
});
