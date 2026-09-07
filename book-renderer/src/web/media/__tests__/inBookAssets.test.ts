import { describe, expect, it } from 'vitest';
import { collectInBookAssets, isAssetInBook } from '../inBookAssets';
import type { BookDocument, BookPage, PhotoSlotContent } from '../../../model/types';
import type { MemoryBookEditsShape } from '../../../model/edits';

function page(overrides: Partial<BookPage>): BookPage {
  return {
    id: 'p',
    sourceElementId: 'seg',
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

function photoSlot(assetFile: string): { id: string; kind: 'photo'; content: PhotoSlotContent } {
  return {
    id: assetFile,
    kind: 'photo',
    content: {
      kind: 'photo',
      assetFile,
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
    },
  };
}

function document(pages: BookPage[]): BookDocument {
  return { childName: 'Test', scopeLabel: 'Year One', pages, totalPages: pages.length };
}

describe('collectInBookAssets', () => {
  it('collects assetFile from every placed PhotoSlotContent slot', () => {
    const doc = document([page({ slots: [photoSlot('assets/a.jpg'), photoSlot('assets/b.jpg')] })]);
    const result = collectInBookAssets(doc, {});
    expect(result.assetFiles).toEqual(new Set(['assets/a.jpg', 'assets/b.jpg']));
    expect(result.mediaIds.size).toBe(0);
  });

  it('collects the cover-wrap page own assetFile', () => {
    const doc = document([page({ templateId: 'cover-wrap', params: { assetFile: 'assets/cover.jpg' } })]);
    expect(collectInBookAssets(doc, {}).assetFiles.has('assets/cover.jpg')).toBe(true);
  });

  it('ignores a cover-wrap page with no photo (minimal voice)', () => {
    const doc = document([page({ templateId: 'cover-wrap', params: { assetFile: null } })]);
    expect(collectInBookAssets(doc, {}).assetFiles.size).toBe(0);
  });

  it('collects mediaId from every images edit record, cover and slot alike', () => {
    const doc = document([page({})]);
    const edits: MemoryBookEditsShape = {
      images: {
        cover: { slot: 'cover', mediaId: 'media-cover', file: 'assets/x.jpg', originalFile: 'orig/x.jpg', aspectRatio: 1 },
        'mem-1:assets/orig.jpg': { slot: 'mem-1:assets/orig.jpg', mediaId: 'media-slot', file: 'assets/y.jpg', originalFile: 'orig/y.jpg', aspectRatio: 1 },
      },
    };
    const result = collectInBookAssets(doc, edits);
    expect(result.mediaIds).toEqual(new Set(['media-cover', 'media-slot']));
  });

  it('is honestly narrower than "every asset in the manifest" — only placed slots count, duplicates across pages collapse', () => {
    const doc = document([
      page({ id: 'p1', slots: [photoSlot('assets/a.jpg')] }),
      page({ id: 'p2', slots: [photoSlot('assets/a.jpg')] }), // same photo placed twice
    ]);
    expect(collectInBookAssets(doc, {}).assetFiles.size).toBe(1);
  });
});

describe('isAssetInBook', () => {
  it('matches by previewKey against assetFiles', () => {
    const inBook = { assetFiles: new Set(['assets/a.jpg']), mediaIds: new Set<string>() };
    expect(isAssetInBook(inBook, 'media-1', 'assets/a.jpg')).toBe(true);
    expect(isAssetInBook(inBook, 'media-1', 'assets/other.jpg')).toBe(false);
  });

  it('matches by mediaId against the edit-derived set, independent of previewKey', () => {
    const inBook = { assetFiles: new Set<string>(), mediaIds: new Set(['media-1']) };
    expect(isAssetInBook(inBook, 'media-1', 'assets/whatever.jpg')).toBe(true);
    expect(isAssetInBook(inBook, 'media-2', 'assets/whatever.jpg')).toBe(false);
  });
});
