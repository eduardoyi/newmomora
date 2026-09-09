import { describe, it, expect } from 'vitest';
import { computeReflowResult, isFullBleedTemplate } from '../reflowNotice';
import { slotKey, COVER_SLOT_KEY } from '../../../model/edits';
import type { BookPage, LayoutSlot, PhotoSlotContent, TemplateId } from '../../../model/types';

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

function page(id: string, templateId: TemplateId, slots: LayoutSlot[], params: Record<string, unknown> = {}): BookPage {
  return {
    id,
    sourceElementId: id,
    templateId,
    params,
    slots,
    variants: [],
    isSpread: false,
    isEvenPage: null,
    pageNumbers: null,
  };
}

describe('isFullBleedTemplate', () => {
  it('is true for full-bleed and panorama-spread, false for everything else', () => {
    expect(isFullBleedTemplate('full-bleed')).toBe(true);
    expect(isFullBleedTemplate('panorama-spread')).toBe(true);
    expect(isFullBleedTemplate('flex-grid')).toBe(false);
    expect(isFullBleedTemplate('photo-story')).toBe(false);
  });
});

describe('computeReflowResult', () => {
  it('demoted: true when the slot was full-bleed before and is an ordinary template after', () => {
    const key = slotKey('mem-1', 'a.jpg');
    const before = [page('p1', 'full-bleed', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const after = [page('p1', 'flex-grid', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const result = computeReflowResult(before, after, key);
    expect(result.demoted).toBe(true);
    expect(result.rawIndex).toBe(0);
  });

  it('demoted: false when the slot stays full-bleed on both sides', () => {
    const key = slotKey('mem-1', 'a.jpg');
    const before = [page('p1', 'full-bleed', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const after = [page('p1', 'full-bleed', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const result = computeReflowResult(before, after, key);
    expect(result.demoted).toBe(false);
  });

  it('demoted: false when the slot was never full-bleed to begin with', () => {
    const key = slotKey('mem-1', 'a.jpg');
    const before = [page('p1', 'flex-grid', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const after = [page('p1', 'flex-grid', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const result = computeReflowResult(before, after, key);
    expect(result.demoted).toBe(false);
  });

  it('finds the slot on its NEW page when the edit moved it elsewhere in the document, and still flags the demotion', () => {
    const key = slotKey('mem-1', 'a.jpg');
    const before = [
      page('p1', 'full-bleed', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })]),
      page('p2', 'flex-grid', []),
    ];
    const after = [
      page('p1', 'flex-grid', []),
      page('p2', 'flex-grid', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })]),
    ];
    const result = computeReflowResult(before, after, key);
    expect(result.rawIndex).toBe(1); // navigates to the NEW page, not the old one
    expect(result.demoted).toBe(true); // was full-bleed before, an ordinary template (wherever it landed) after
  });

  it('the cover slot resolves to the cover-wrap page, which is never full-bleed', () => {
    const before = [page('cover', 'cover-wrap', [], { assetFile: 'cover.jpg' })];
    const after = [page('cover', 'cover-wrap', [], { assetFile: 'new-cover.jpg' })];
    const result = computeReflowResult(before, after, COVER_SLOT_KEY);
    expect(result.rawIndex).toBe(0);
    expect(result.demoted).toBe(false);
  });

  it('rawIndex is null when the slot orphaned and no longer renders anywhere', () => {
    const key = slotKey('mem-1', 'a.jpg');
    const before = [page('p1', 'full-bleed', [photoSlot({ memoryId: 'mem-1', assetFile: 'a.jpg' })])];
    const after = [page('p1', 'flex-grid', [])];
    const result = computeReflowResult(before, after, key);
    expect(result.rawIndex).toBeNull();
    // No AFTER page to compare against -- can't claim a demotion happened
    // on a page that no longer exists.
    expect(result.demoted).toBe(false);
  });
});
