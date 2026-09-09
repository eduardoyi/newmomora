import { describe, it, expect } from 'vitest';
import { computeDuplicateAssetOccurrences, nextOtherOccurrence } from '../duplicateAssets';
import type { BookPage, LayoutSlot, PhotoSlotContent } from '../../../model/types';

function photoContent(overrides: Partial<PhotoSlotContent>): PhotoSlotContent {
  return {
    kind: 'photo',
    assetFile: 'assets/a.jpg',
    assetWidth: 1200,
    assetHeight: 900,
    assetAspectRatio: 4 / 3,
    memoryId: 'mem-1',
    date: '2026-01-01',
    caption: null,
    hero: false,
    qr: false,
    shareToken: null,
    taggedMembers: [],
    milestones: [],
    targetAspect: 4 / 3,
    looseFit: false,
    index: null,
    cropBand: null,
    focalPoint: null,
    ...overrides,
  } as PhotoSlotContent;
}

function photoSlot(overrides: Partial<PhotoSlotContent>): LayoutSlot {
  return { id: `slot-${Math.random()}`, kind: 'photo', content: photoContent(overrides) };
}

function page(id: string, slots: LayoutSlot[], overrides: Partial<BookPage> = {}): BookPage {
  return {
    id,
    sourceElementId: id,
    templateId: 'flex-grid',
    params: {},
    slots,
    variants: [],
    isSpread: false,
    isEvenPage: null,
    pageNumbers: null,
    ...overrides,
  };
}

describe('computeDuplicateAssetOccurrences', () => {
  it('returns nothing for a document with no repeated asset files', () => {
    const pages = [
      page('p1', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })]),
      page('p2', [photoSlot({ memoryId: 'mem-2', assetFile: 'b.jpg' })]),
    ];
    expect(computeDuplicateAssetOccurrences(pages).size).toBe(0);
  });

  it('finds an asset file that occupies 2+ slots across different pages, in document order', () => {
    const pages = [
      page('p1', [photoSlot({ memoryId: 'mem-1', assetFile: 'shared.jpg' })]),
      page('p2', [photoSlot({ memoryId: 'mem-2', assetFile: 'other.jpg' })]),
      page('p3', [photoSlot({ memoryId: 'mem-3', assetFile: 'shared.jpg' })]),
    ];
    const occurrences = computeDuplicateAssetOccurrences(pages);
    expect(occurrences.has('shared.jpg')).toBe(true);
    expect(occurrences.has('other.jpg')).toBe(false); // only 1 occurrence
    const list = occurrences.get('shared.jpg')!;
    expect(list.map((o) => o.pageIndex)).toEqual([0, 2]);
  });

  it('excludes the cover photo -- only PhotoSlotContent slots count', () => {
    const pages = [
      page('cover', [], { templateId: 'cover-wrap', params: { assetFile: 'shared.jpg' } }),
      page('p1', [photoSlot({ memoryId: 'mem-1', assetFile: 'shared.jpg' })]),
    ];
    // Only ONE PhotoSlotContent occurrence of shared.jpg -- the cover's own
    // copy is deliberately not counted, so this must NOT be flagged as a
    // duplicate even though the file appears twice in the book overall.
    expect(computeDuplicateAssetOccurrences(pages).has('shared.jpg')).toBe(false);
  });

  it('two occurrences on the SAME page both count (a badge on each, pointing elsewhere if possible)', () => {
    const pages = [
      page('p1', [
        photoSlot({ memoryId: 'mem-1', assetFile: 'shared.jpg' }),
        photoSlot({ memoryId: 'mem-2', assetFile: 'shared.jpg' }),
      ]),
    ];
    const list = computeDuplicateAssetOccurrences(pages).get('shared.jpg');
    expect(list).toHaveLength(2);
  });
});

describe('nextOtherOccurrence', () => {
  const occurrences = [
    { pageId: 'p1', pageIndex: 0, slotKey: 'mem-1::a.jpg' },
    { pageId: 'p3', pageIndex: 2, slotKey: 'mem-3::a.jpg' },
    { pageId: 'p5', pageIndex: 4, slotKey: 'mem-5::a.jpg' },
  ];

  it('jumps to the next occurrence in document order', () => {
    expect(nextOtherOccurrence(occurrences, 'p1', 'mem-1::a.jpg')).toEqual(occurrences[1]);
  });

  it('wraps around from the last occurrence back to the first', () => {
    expect(nextOtherOccurrence(occurrences, 'p5', 'mem-5::a.jpg')).toEqual(occurrences[0]);
  });

  it('falls back to treating index 0 as "current" when the given page/slot is not found in the list, so it advances to occurrence 1', () => {
    expect(nextOtherOccurrence(occurrences, 'unknown-page', 'unknown-slot')).toEqual(occurrences[1]);
  });

  it('skips past any further occurrence still on the SAME page', () => {
    const sameFirstPage = [
      { pageId: 'p1', pageIndex: 0, slotKey: 'a' },
      { pageId: 'p1', pageIndex: 0, slotKey: 'b' },
      { pageId: 'p2', pageIndex: 1, slotKey: 'c' },
    ];
    expect(nextOtherOccurrence(sameFirstPage, 'p1', 'a')).toEqual(sameFirstPage[2]);
  });

  it('returns null when every occurrence lives on the current page', () => {
    const allSamePage = [
      { pageId: 'p1', pageIndex: 0, slotKey: 'a' },
      { pageId: 'p1', pageIndex: 0, slotKey: 'b' },
    ];
    expect(nextOtherOccurrence(allSamePage, 'p1', 'a')).toBeNull();
  });
});
