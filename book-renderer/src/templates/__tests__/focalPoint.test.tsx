import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fitBook } from '../../model/fitter';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from '../../model/__tests__/fixtures/build';
import { TemplateRenderer } from '../index';
import { PhotoTile } from '../common/PhotoTile';
import { objectPositionFor } from '../common/focalPoint';
import type { BookPage, PhotoSlotContent } from '../../model/types';

/**
 * Design Decision 9 (memory-book-5b plan) style-output coverage: absent a
 * focal-point edit, every wired template must render BYTE-IDENTICAL markup
 * to before this field existed (the template snapshot suite is the broad
 * guarantee of that); these tests are the narrow, explicit with/without
 * check the plan step calls for, plus the pure CSS-value helper itself.
 */
describe('objectPositionFor', () => {
  it('returns undefined for null/undefined (React omits an undefined style property entirely)', () => {
    expect(objectPositionFor(null)).toBeUndefined();
    expect(objectPositionFor(undefined)).toBeUndefined();
  });

  it('maps a 0-1 focal point to a percentage object-position', () => {
    expect(objectPositionFor({ x: 0.25, y: 0.75 })).toBe('25% 75%');
    expect(objectPositionFor({ x: 0, y: 1 })).toBe('0% 100%');
  });
});

function withPhotoFocalPoint(page: BookPage, focalPoint: { x: number; y: number } | null): BookPage {
  return {
    ...page,
    slots: page.slots.map((slot) =>
      slot.kind === 'photo' ? { ...slot, content: { ...(slot.content as PhotoSlotContent), focalPoint } } : slot,
    ),
  };
}

describe('PhotoTile — objectPosition wiring', () => {
  const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
  const baseContent: PhotoSlotContent = {
    kind: 'photo',
    assetFile: 'assets/a.jpg',
    assetWidth: 2400,
    assetHeight: 1600,
    assetAspectRatio: 1.5,
    memoryId: 'mem-1',
    date: '2024-06-01',
    caption: null,
    hero: false,
    qr: false,
    shareToken: null,
    taggedMembers: [],
    milestones: [],
    targetAspect: 1.5,
    looseFit: false,
    index: null,
    cropBand: null,
    focalPoint: null,
  };

  it('omits object-position entirely when focalPoint is absent (byte-identical to before this field existed)', () => {
    const html = renderToStaticMarkup(
      <PhotoTile content={baseContent} bookSlug="test-book" isSpread={false} language="en" />,
    );
    expect(html).not.toContain('object-position');
    expect(html).toContain('object-fit:cover');
  });

  it('wires a real focal point into object-position', () => {
    const html = renderToStaticMarkup(
      <PhotoTile content={{ ...baseContent, focalPoint: { x: 0.2, y: 0.9 } }} bookSlug="test-book" isSpread={false} language="en" />,
    );
    expect(html).toContain('object-position:20% 90%');
  });
});

describe('FullBleed — objectPosition wiring', () => {
  function fullBleedPage() {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ width: 3000, height: 3000, aspectRatio: 1 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('full-bleed');
    return { manifest, page: document.pages[0] };
  }

  it('omits object-position when the fitter never set a focal point', () => {
    const { manifest, page } = fullBleedPage();
    const html = renderToStaticMarkup(
      <TemplateRenderer page={page} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).not.toContain('object-position');
  });

  it('wires a saved focal point into object-position', () => {
    const { manifest, page } = fullBleedPage();
    const edited = withPhotoFocalPoint(page, { x: 0.6, y: 0.1 });
    const html = renderToStaticMarkup(
      <TemplateRenderer page={edited} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('object-position:60% 10%');
  });
});

describe('PanoramaSpread — objectPosition wiring', () => {
  function panoramaPage() {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset()] }),
      'mem-pano': makeMemory({ assets: [makeAsset({ width: 4000, height: 2000, aspectRatio: 2 })] }),
      'mem-2': makeMemory({ assets: [makeAsset()] }),
    });
    const outline = makeOutline(
      [makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-pano', 'mem-2'] })],
      { panoramaCandidates: ['mem-pano'] },
    );
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('panorama-spread');
    return { manifest, page: document.pages[0] };
  }

  it('falls back to the pre-existing cropBand-anchored center position when no focal point is set', () => {
    const { manifest, page } = panoramaPage();
    const html = renderToStaticMarkup(
      <TemplateRenderer page={page} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('object-position:center center');
  });

  it('a saved focal point overrides the cropBand anchor', () => {
    const { manifest, page } = panoramaPage();
    const edited = withPhotoFocalPoint(page, { x: 0.4, y: 0.5 });
    const html = renderToStaticMarkup(
      <TemplateRenderer page={edited} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('object-position:40% 50%');
    expect(html).not.toContain('object-position:center center');
  });
});

describe('WraparoundCover — cover-photo objectPosition wiring (Design Decision 9\'s params path)', () => {
  function coverPage() {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ kind: 'photo', width: 2400, aspectRatio: 0.9 })] }),
    });
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })], { heroCandidates: ['mem-1'] });
    const { document } = fitBook(outline, manifest);
    expect(document.pages[0].templateId).toBe('cover-wrap');
    return { manifest, page: document.pages[0] };
  }

  it('omits object-position on the cover photo when no focal point was ever saved', () => {
    const { manifest, page } = coverPage();
    const html = renderToStaticMarkup(
      <TemplateRenderer page={page} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).not.toContain('object-position');
  });

  it('wires a saved cover-photo focal point into object-position', () => {
    const { manifest, page } = coverPage();
    const edited = { ...page, params: { ...page.params, assetFocalPoint: { x: 0.1, y: 0.4 } } };
    const html = renderToStaticMarkup(
      <TemplateRenderer page={edited} manifest={manifest} bookSlug="test-book" showGuides={false} />,
    );
    expect(html).toContain('object-position:10% 40%');
  });
});
