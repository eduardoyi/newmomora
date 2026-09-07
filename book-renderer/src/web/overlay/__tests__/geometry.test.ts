import { describe, expect, it } from 'vitest';
import { photoSelectorPlanForPage, resolveTextAnchor, footerEntryIndexForMemory, PHOTO_TILE_SELECTOR, FULL_BLEED_IMG_SELECTOR, PANORAMA_IMG_SELECTOR, COVER_PHOTO_SELECTOR } from '../geometry';
import type { BookPage, PhotoSlotContent } from '../../../model/types';

function page(overrides: Partial<BookPage>): BookPage {
  return {
    id: 'p',
    sourceElementId: 'seg-1',
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

function photoSlot(overrides: Partial<PhotoSlotContent>): { id: string; kind: 'photo'; content: PhotoSlotContent } {
  return {
    id: overrides.memoryId ?? 'slot',
    kind: 'photo',
    content: {
      kind: 'photo',
      assetFile: 'assets/a.jpg',
      assetWidth: 100,
      assetHeight: 100,
      assetAspectRatio: 1,
      memoryId: 'mem-1',
      date: '2024-01-01',
      caption: null,
      hero: false,
      qr: false,
      shareToken: null,
      taggedMembers: [],
      milestones: [],
      targetAspect: 1,
      looseFit: false,
      index: null,
      cropBand: null,
      focalPoint: null,
      ...overrides,
    },
  };
}

describe('photoSelectorPlanForPage', () => {
  it('uses the shared PhotoTile selector, per-slot, for flex-grid/anchor-media/photo-story', () => {
    for (const templateId of ['flex-grid', 'anchor-media', 'photo-story'] as const) {
      expect(photoSelectorPlanForPage(page({ templateId }))).toEqual({ selector: PHOTO_TILE_SELECTOR, perSlot: true });
    }
  });

  it('uses the dedicated single-node selector for full-bleed/panorama/cover, not perSlot', () => {
    expect(photoSelectorPlanForPage(page({ templateId: 'full-bleed' }))).toEqual({ selector: FULL_BLEED_IMG_SELECTOR, perSlot: false });
    expect(photoSelectorPlanForPage(page({ templateId: 'panorama-spread' }))).toEqual({ selector: PANORAMA_IMG_SELECTOR, perSlot: false });
    expect(photoSelectorPlanForPage(page({ templateId: 'cover-wrap' }))).toEqual({ selector: COVER_PHOTO_SELECTOR, perSlot: false });
  });

  it('returns null for a template with no editable photo affordance', () => {
    expect(photoSelectorPlanForPage(page({ templateId: 'dedication' }))).toBeNull();
    expect(photoSelectorPlanForPage(page({ templateId: 'closing' }))).toBeNull();
    expect(photoSelectorPlanForPage(page({ templateId: 'firsts' }))).toBeNull();
  });
});

describe('resolveTextAnchor', () => {
  it('resolves dedication on a dedication page, with a fallback to the greeting', () => {
    const plan = resolveTextAnchor(page({ templateId: 'dedication' }), 'dedication');
    expect(plan).toEqual({ strategy: 'selector', selector: '.dedication__body', fallbackSelector: '.dedication__greeting', approximate: true });
  });

  it('returns null when the target/page combination does not match (e.g. dedication target on a different page)', () => {
    expect(resolveTextAnchor(page({ templateId: 'flex-grid' }), 'dedication')).toBeNull();
  });

  it('resolves closing and backCover the same way', () => {
    expect(resolveTextAnchor(page({ templateId: 'closing' }), 'closing')).toEqual({
      strategy: 'selector',
      selector: '.closing__count',
      fallbackSelector: '.closing__headline',
      approximate: true,
    });
    expect(resolveTextAnchor(page({ templateId: 'cover-wrap' }), 'backCover')).toEqual({
      strategy: 'selector',
      selector: '.cover-wrap__colophon-line',
      fallbackSelector: '.cover-wrap__colophon',
      approximate: true,
    });
  });

  it('resolves sectionTitle/eyebrow on a spread-title page via className selectors', () => {
    const spreadTitlePage = page({ templateId: 'spread-title', sourceElementId: 'seg-9' });
    expect(resolveTextAnchor(spreadTitlePage, 'sectionTitle:seg-9')).toEqual({
      strategy: 'selector',
      selector: '.spread-title__descriptive, .spread-title__quote',
      approximate: false,
    });
    expect(resolveTextAnchor(spreadTitlePage, 'eyebrow:seg-9')).toEqual({
      strategy: 'selector',
      selector: '.spread-title__kicker',
      fallbackSelector: '.spread-title__descriptive, .spread-title__quote',
      approximate: true,
    });
  });

  it('resolves sectionTitle/eyebrow structurally on a page carrying params.sectionHeader', () => {
    const gridPage = page({ templateId: 'flex-grid', sourceElementId: 'seg-9', params: { sectionHeader: { title: 'Marzo', kicker: null, special: false } } });
    expect(resolveTextAnchor(gridPage, 'sectionTitle:seg-9')).toEqual({ strategy: 'section-title' });
    expect(resolveTextAnchor(gridPage, 'eyebrow:seg-9')).toEqual({ strategy: 'section-kicker' });
  });

  it('returns null for a sectionTitle/eyebrow target whose elementId does not match this page', () => {
    const gridPage = page({ templateId: 'flex-grid', sourceElementId: 'seg-9', params: { sectionHeader: { title: 'Marzo', kicker: null, special: false } } });
    expect(resolveTextAnchor(gridPage, 'sectionTitle:seg-OTHER')).toBeNull();
  });

  it('resolves a caption target to its footer-row entry index', () => {
    const p = page({
      templateId: 'flex-grid',
      slots: [photoSlot({ memoryId: 'mem-a', index: 2 })],
      params: {
        footerIndex: [
          { index: 1, indices: [1], date: '2024-01-01', note: null, qr: false },
          { index: 2, indices: [2], date: '2024-01-02', note: null, qr: false },
        ],
      },
    });
    expect(resolveTextAnchor(p, 'caption:mem-a')).toEqual({ strategy: 'footer-row', entryIndex: 1 });
  });

  it('returns null for a caption target whose memory has no numbered slot on this page', () => {
    const p = page({ templateId: 'flex-grid', slots: [photoSlot({ memoryId: 'mem-a', index: null })] });
    expect(resolveTextAnchor(p, 'caption:mem-a')).toBeNull();
  });

  it('returns null for an unrecognized target', () => {
    expect(resolveTextAnchor(page({}), 'somethingUnknown')).toBeNull();
  });

  describe('furniture:<key> targets', () => {
    it('resolves furniture:coverName and furniture:coverTagline on a cover-wrap page', () => {
      const coverPage = page({ templateId: 'cover-wrap' });
      expect(resolveTextAnchor(coverPage, 'furniture:coverName')).toEqual({
        strategy: 'selector',
        selector: '.cover-wrap__name',
        approximate: false,
      });
      expect(resolveTextAnchor(coverPage, 'furniture:coverTagline')).toEqual({
        strategy: 'selector',
        selector: '.cover-wrap__colophon-line',
        fallbackSelector: '.cover-wrap__colophon',
        approximate: true,
      });
    });

    it('resolves furniture:dedicationSalutation and furniture:dedicationSignoff on a dedication page', () => {
      const dedicationPage = page({ templateId: 'dedication' });
      expect(resolveTextAnchor(dedicationPage, 'furniture:dedicationSalutation')).toEqual({
        strategy: 'selector',
        selector: '.dedication__greeting',
        approximate: false,
      });
      expect(resolveTextAnchor(dedicationPage, 'furniture:dedicationSignoff')).toEqual({
        strategy: 'selector',
        selector: '.dedication__signature',
        approximate: false,
      });
    });

    it('resolves furniture:ttyKicker and furniture:ttyTitle structurally on a through-the-years page', () => {
      const ttyPage = page({ templateId: 'through-the-years' });
      expect(resolveTextAnchor(ttyPage, 'furniture:ttyKicker')).toEqual({ strategy: 'tty-kicker' });
      expect(resolveTextAnchor(ttyPage, 'furniture:ttyTitle')).toEqual({ strategy: 'tty-title' });
    });

    it('resolves furniture:closingTitle on a closing page', () => {
      const closingPage = page({ templateId: 'closing' });
      expect(resolveTextAnchor(closingPage, 'furniture:closingTitle')).toEqual({
        strategy: 'selector',
        selector: '.closing__headline',
        approximate: false,
      });
    });

    it('returns null for a furniture target on the wrong page shape', () => {
      expect(resolveTextAnchor(page({ templateId: 'flex-grid' }), 'furniture:coverName')).toBeNull();
      expect(resolveTextAnchor(page({ templateId: 'cover-wrap' }), 'furniture:ttyKicker')).toBeNull();
      expect(resolveTextAnchor(page({ templateId: 'cover-wrap' }), 'furniture:closingTitle')).toBeNull();
    });

    it('returns null for a furniture key outside the allowlist', () => {
      expect(resolveTextAnchor(page({ templateId: 'cover-wrap' }), 'furniture:notAllowlisted')).toBeNull();
    });
  });
});

describe('footerEntryIndexForMemory', () => {
  it('finds a consolidated multi-numeral row by any of its indices', () => {
    const p = page({
      slots: [photoSlot({ memoryId: 'mem-a', index: 1 }), photoSlot({ memoryId: 'mem-b', index: 2 })],
      params: {
        footerIndex: [{ index: 1, indices: [1, 2], date: '2024-01-01', note: null, qr: false }],
      },
    });
    expect(footerEntryIndexForMemory(p, 'mem-a')).toBe(0);
    expect(footerEntryIndexForMemory(p, 'mem-b')).toBe(0);
  });

  it('returns null when footerIndex is absent or malformed', () => {
    expect(footerEntryIndexForMemory(page({ slots: [photoSlot({ memoryId: 'mem-a', index: 1 })] }), 'mem-a')).toBeNull();
  });
});
