import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
  applyPreFit,
  applyPostFit,
  slotKey,
  COVER_SLOT_KEY,
  type MemoryBookEditsShape,
  type ImageEditRecord,
  type TextEditRecord,
  type FocalPointEditRecord,
} from '../edits';
import { fitBook } from '../fitter';
import { parseManifest, parseOutline } from '../loader';
import { makeAsset, makeElement, makeManifest, makeMemory, makeOutline } from './fixtures/build';
import type { BookDocument, BookOutline, BookPage, PhotoSlotContent } from '../types';
import type { FooterIndexEntry } from '../../templates/common/FooterIndex.types';

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
  return { childName: 'Test', scopeLabel: 'Year One', pages, totalPages: pages.length };
}

/**
 * Small builders for the wrapped record shapes `save_edit`
 * (supabase/functions/memory-book-edits/index.ts) actually stores — see
 * `edits.ts`'s own doc comment on why they're not a shared import. `slot`/
 * `target` duplicate the map key the record is stored under; this module
 * (and its tests) treat the map key as authoritative, so the value passed
 * here doesn't have to match the key it ends up stored under to prove
 * behavior — it's just here for type conformance with the real contract.
 */
function textEdit(value: string, target = 'unused'): TextEditRecord {
  return { target, value };
}
function imageEdit(overrides: Omit<ImageEditRecord, 'slot'> & Partial<Pick<ImageEditRecord, 'slot'>>): ImageEditRecord {
  return { slot: 'unused', ...overrides };
}
function focalPointEdit(x: number, y: number): FocalPointEditRecord {
  return { slot: 'unused', x, y };
}

function photoContent(overrides: Partial<PhotoSlotContent> & Pick<PhotoSlotContent, 'memoryId' | 'assetFile'>): PhotoSlotContent {
  return {
    kind: 'photo',
    assetWidth: 2400,
    assetHeight: 1600,
    assetAspectRatio: 1.5,
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyPreFit — ordinary image replace
// ---------------------------------------------------------------------------

describe('applyPreFit — image replace substitution', () => {
  const replacement: ImageEditRecord = imageEdit({
    mediaId: 'media-2',
    file: 'assets/replacement.jpg',
    originalFile: 'assets/replacement-original.jpg',
    aspectRatio: 1.2,
    originalWidth: 4000,
    originalHeight: 3333,
  });

  it('overwrites the target asset file/aspectRatio/original dimensions, in place, on the correct memory', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/original.jpg', aspectRatio: 1.5 })] }),
      'mem-2': makeMemory({ assets: [makeAsset({ file: 'assets/untouched.jpg' })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1', 'mem-2'] })]);
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/original.jpg')]: replacement } };

    const { manifest: next, skipped } = applyPreFit(outline, manifest, edits);

    expect(skipped).toEqual([]);
    const asset = next.memories['mem-1'].assets[0];
    expect(asset.file).toBe('assets/replacement.jpg');
    expect(asset.aspectRatio).toBe(1.2);
    expect(asset.originalWidth).toBe(4000);
    expect(asset.originalHeight).toBe(3333);
    // CRITICAL (memory-book-5c plan round-2 review): an edited photo's
    // manifest entry must retain print-res originalFile — otherwise every
    // edited slot would silently print at preview resolution.
    expect(asset.originalFile).toBe('assets/replacement-original.jpg');
    // The untouched memory's asset must be byte-for-byte unchanged.
    expect(next.memories['mem-2'].assets[0].file).toBe('assets/untouched.jpg');
    // The input manifest itself must never be mutated (pure function).
    expect(manifest.memories['mem-1'].assets[0].file).toBe('assets/original.jpg');
    // Slot identity (owner-hit duplicate-replace bug, 2026-09-09): the
    // substituted asset carries its PRISTINE file so the UI's
    // `resolveEditableSlotKey` recovers the stable edit key exactly, even
    // when the replacement photo also natively exists elsewhere in the
    // book. Unedited assets never carry it.
    expect(asset.editedFromFile).toBe('assets/original.jpg');
    expect(next.memories['mem-2'].assets[0].editedFromFile).toBeUndefined();
  });

  it('never fabricates width/height when the original could not be measured — a tiny sentinel at the right aspect ratio fails every trust gate closed', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/original.jpg' })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const unmeasured: ImageEditRecord = { ...replacement, originalWidth: undefined, originalHeight: undefined };
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/original.jpg')]: unmeasured } };

    const { manifest: next } = applyPreFit(outline, manifest, edits);
    const asset = next.memories['mem-1'].assets[0];
    expect(asset.originalWidth).toBeNull();
    expect(asset.originalHeight).toBeNull();
    // Small enough to fail every real trust gate in fitter.ts (smallest is
    // the 2000px cover-photo floor) yet still at the replacement's own
    // aspect ratio.
    expect(asset.width).toBeLessThan(2000);
    expect(asset.width / asset.height).toBeCloseTo(1.2, 5);
  });

  it('reports an orphan when the slot key names a memory no longer in the manifest', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-gone', 'assets/x.jpg')]: replacement } };

    const { skipped } = applyPreFit(outline, manifest, edits);
    expect(skipped).toEqual([{ kind: 'image', key: 'mem-gone:assets/x.jpg', reason: expect.any(String) }]);
  });

  it('reports an orphan when the slot key names an asset file no longer on that memory', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/current.jpg' })] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/stale.jpg')]: replacement } };

    const { skipped } = applyPreFit(outline, manifest, edits);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].kind).toBe('image');
  });

  it('reports an orphan for a malformed (colon-less) key instead of throwing', () => {
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset()] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const edits: MemoryBookEditsShape = { images: { 'not-a-real-key': replacement } };

    const { skipped } = applyPreFit(outline, manifest, edits);
    expect(skipped).toEqual([{ kind: 'image', key: 'not-a-real-key', reason: expect.any(String) }]);
  });

  it('video slots are locked — an imageReplace targeting a video-poster asset orphans instead of substituting (owner-approved follow-up round, item 4)', () => {
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/video-poster.jpg', kind: 'video-poster' })] }),
    });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/video-poster.jpg')]: replacement } };

    const { manifest: next, skipped } = applyPreFit(outline, manifest, edits);

    expect(skipped).toEqual([{ kind: 'image', key: 'mem-1:assets/video-poster.jpg', reason: expect.any(String) }]);
    // Untouched: still the original video-poster asset, never substituted —
    // this is the "self-heal" case for a stale edit saved before the v1 UI
    // restriction existed (or one crafted directly against the Edge
    // Function): `substituteAsset` never runs, so the asset stays byte-for-
    // byte its pristine self, `kind` included.
    expect(next.memories['mem-1'].assets[0]).toEqual(manifest.memories['mem-1'].assets[0]);
    expect(next.memories['mem-1'].assets[0].kind).toBe('video-poster');
  });

  it('is idempotent — applying the SAME edits to the SAME pristine (unedited) outline/manifest twice yields byte-identical results', () => {
    // The real call pattern (every render starts from the freshly exported
    // outline/manifest + the saved edits row, never from a previously
    // edited manifest) — pure-function determinism, not chained
    // re-application. Chaining a content-addressed image-replace edit onto
    // its OWN already-substituted output is a different, expected case:
    // the slot key names the ORIGINAL file, which no longer exists once
    // substituted, so a second chained pass correctly orphans instead
    // (proving stable keys really do orphan cleanly, not silently
    // no-op/double-apply).
    const manifest = makeManifest({ 'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/original.jpg' })] }) });
    const outline = makeOutline([makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'] })]);
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/original.jpg')]: replacement } };

    const first = applyPreFit(outline, manifest, edits);
    const second = applyPreFit(outline, manifest, edits);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.outline).toEqual(first.outline);
    expect(second.skipped).toEqual([]);

    // The chained case: re-applying the same edits to the already-edited
    // output correctly orphans (the original file key it targets is gone).
    const chained = applyPreFit(first.outline, first.manifest, edits);
    expect(chained.skipped).toEqual([
      { kind: 'image', key: 'mem-1:assets/original.jpg', reason: expect.any(String) },
    ]);
    // ...and, being a no-op skip, leaves the already-substituted asset untouched.
    expect(chained.manifest.memories['mem-1'].assets[0]).toEqual(first.manifest.memories['mem-1'].assets[0]);
  });
});

// ---------------------------------------------------------------------------
// applyPreFit — cover photo
// ---------------------------------------------------------------------------

describe('applyPreFit — cover photo edit', () => {
  const coverPhoto: ImageEditRecord = imageEdit({
    mediaId: 'media-9',
    file: 'assets/chosen-cover.jpg',
    originalFile: 'assets/chosen-cover-original.jpg',
    aspectRatio: 0.9,
    originalWidth: 3200,
    originalHeight: 3556,
  });

  it('makes buildCoverPages pick the edited photo through its own real coverCandidates precedence', () => {
    // No qualifying photo anywhere in the manifest — an unedited fit would
    // land 'minimal' voice (no cover photo at all).
    const manifest = makeManifest({});
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })]);
    const edits: MemoryBookEditsShape = { images: { [COVER_SLOT_KEY]: coverPhoto } };

    const { outline: nextOutline, manifest: nextManifest } = applyPreFit(outline, manifest, edits);
    const { document } = fitBook(nextOutline, nextManifest);
    expect(document.pages[0].templateId).toBe('cover-wrap');
    expect(document.pages[0].params.voice).toBe('mixed');
    expect(document.pages[0].params.assetFile).toBe('assets/chosen-cover.jpg');
    // CRITICAL (memory-book-5c plan round-2 review): the synthetic cover
    // asset applyCoverImageEdit builds must carry originalFile too, same as
    // an ordinary substituteAsset edit.
    const coverAsset = nextManifest.memories['__cover-edit__'].assets[0];
    expect(coverAsset.originalFile).toBe('assets/chosen-cover-original.jpg');
  });

  it('is idempotent — applying twice never grows outline.coverCandidates', () => {
    const manifest = makeManifest({});
    const outline = makeOutline([makeElement({ id: 'cover', kind: 'cover' })], { coverCandidates: ['mem-ai-nominee'] });
    const edits: MemoryBookEditsShape = { images: { [COVER_SLOT_KEY]: coverPhoto } };

    const once = applyPreFit(outline, manifest, edits);
    const twice = applyPreFit(once.outline, once.manifest, edits);
    expect(twice.outline.coverCandidates).toEqual(once.outline.coverCandidates);
    expect(once.outline.coverCandidates?.[0]).toBe('__cover-edit__');
    // The AI's own nominee is preserved as a fallback, just deprioritized.
    expect(once.outline.coverCandidates).toContain('mem-ai-nominee');
  });
});

// ---------------------------------------------------------------------------
// applyPreFit — dimension-driven demotion (the "reflow is real and honest" property)
// ---------------------------------------------------------------------------

describe('applyPreFit — image-pre-fit substitution demotes a page whose replacement fails the trust gate', () => {
  it('a full-bleed hero demotes to a different template once replaced with an undersized photo', () => {
    // Exact recipe fitter.test.ts uses for its own "trusted full-bleed hero" case.
    const manifest = makeManifest({
      'mem-1': makeMemory({ assets: [makeAsset({ file: 'assets/hero.jpg', width: 3000, height: 3000, aspectRatio: 1 })] }),
    });
    const outline = makeOutline([
      makeElement({ id: 'backbone:x', kind: 'backbone', memoryIds: ['mem-1'], highlights: ['mem-1'] }),
    ]);

    const before = fitBook(outline, manifest);
    expect(before.document.pages[0].templateId).toBe('full-bleed');

    const tooSmall: ImageEditRecord = imageEdit({
      mediaId: 'media-3',
      file: 'assets/hero-replacement.jpg',
      originalFile: 'assets/hero-replacement-original.jpg',
      aspectRatio: 1,
      originalWidth: 200,
      originalHeight: 200,
    });
    const edits: MemoryBookEditsShape = { images: { [slotKey('mem-1', 'assets/hero.jpg')]: tooSmall } };
    const { outline: nextOutline, manifest: nextManifest, skipped } = applyPreFit(outline, manifest, edits);
    expect(skipped).toEqual([]);

    const after = fitBook(nextOutline, nextManifest);
    // Never suppressed: the memory still appears in the book, just not full-bleed.
    expect(after.document.pages.some((p) => p.templateId === 'full-bleed')).toBe(false);
    expect(after.gaps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPostFit — text edits
// ---------------------------------------------------------------------------

describe('applyPostFit — text edits', () => {
  it('overrides the dedication body', () => {
    const doc = docWith([emptyPage({ id: 'title', sourceElementId: 'title', templateId: 'dedication', params: { body: 'Original.' } })]);
    const { document, skipped } = applyPostFit(doc, { text: { dedication: textEdit('Edited dedication.') } });
    expect(document.pages[0].params.body).toBe('Edited dedication.');
    expect(skipped).toEqual([]);
  });

  it('overrides the back-cover line', () => {
    const doc = docWith([emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', params: { backCoverLine: 'Original.' } })]);
    const { document } = applyPostFit(doc, { text: { backCover: textEdit('Edited back cover.') } });
    expect(document.pages[0].params.backCoverLine).toBe('Edited back cover.');
  });

  it('overrides the closing line (Closing.tsx renders params.closingLine — see its own doc comment)', () => {
    const doc = docWith([emptyPage({ id: 'closing', sourceElementId: 'closing', templateId: 'closing', params: {} })]);
    const { document } = applyPostFit(doc, { text: { closing: textEdit('Edited closing line.') } });
    expect(document.pages[0].params.closingLine).toBe('Edited closing line.');
  });

  it('overrides both the spread-title page and a same-element sectionHeader in lockstep', () => {
    const doc = docWith([
      emptyPage({
        id: 'topic:x:title',
        sourceElementId: 'topic:x',
        templateId: 'spread-title',
        params: { title: 'Original Title', kicker: 'Original Kicker' },
      }),
      emptyPage({
        id: 'topic:x:p1',
        sourceElementId: 'topic:x',
        templateId: 'anchor-media',
        params: { sectionHeader: { title: 'Original Title', kicker: 'Original Kicker', special: false } },
      }),
    ]);
    const { document, skipped } = applyPostFit(doc, {
      text: { 'sectionTitle:topic:x': textEdit('New Title'), 'eyebrow:topic:x': textEdit('New Kicker') },
    });
    expect(document.pages[0].params.title).toBe('New Title');
    expect(document.pages[0].params.kicker).toBe('New Kicker');
    expect((document.pages[1].params.sectionHeader as { title: string }).title).toBe('New Title');
    expect((document.pages[1].params.sectionHeader as { kicker: string }).kicker).toBe('New Kicker');
    expect(skipped).toEqual([]);
  });

  it('overrides a caption both on the photo slot and its footer-index line', () => {
    const doc = docWith([
      emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'anchor-media',
        slots: [
          {
            id: 's1',
            kind: 'photo',
            content: photoContent({ memoryId: 'mem-1', assetFile: 'assets/a.jpg', index: 1, caption: 'Old caption.' }),
          },
        ],
        params: {
          footerIndex: [{ index: 1, indices: [1], date: '2024-06-01', note: 'Old caption.' } satisfies FooterIndexEntry],
        },
      }),
    ]);
    const { document } = applyPostFit(doc, { text: { 'caption:mem-1': textEdit('New caption.') } });
    const slotContent = document.pages[0].slots[0].content as PhotoSlotContent;
    expect(slotContent.caption).toBe('New caption.');
    const footerIndex = document.pages[0].params.footerIndex as FooterIndexEntry[];
    expect(footerIndex[0].note).toBe('New caption.');
  });

  it('reports an orphan for an unrecognized target shape', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'anchor-media' })]);
    const { skipped } = applyPostFit(doc, { text: { 'not-a-real-target': textEdit('x') } });
    expect(skipped).toEqual([{ kind: 'text', key: 'not-a-real-target', reason: expect.any(String) }]);
  });

  it('reports an orphan when a target refers to an element/memory no longer in the document', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'anchor-media' })]);
    const { skipped } = applyPostFit(doc, {
      text: { 'sectionTitle:gone-element': textEdit('x'), 'caption:gone-memory': textEdit('y'), dedication: textEdit('z') },
    });
    expect(skipped.map((s) => s.key).sort()).toEqual(['caption:gone-memory', 'dedication', 'sectionTitle:gone-element']);
    expect(skipped.every((s) => s.kind === 'text')).toBe(true);
  });

  it('is idempotent — applying the same text edits twice changes nothing further', () => {
    const doc = docWith([
      emptyPage({ id: 'title', sourceElementId: 'title', templateId: 'dedication', params: { body: 'Original.' } }),
    ]);
    const edits: MemoryBookEditsShape = { text: { dedication: textEdit('Edited.') } };
    const once = applyPostFit(doc, edits);
    const twice = applyPostFit(once.document, edits);
    expect(twice.document).toEqual(once.document);
  });
});

// ---------------------------------------------------------------------------
// applyPostFit — furniture:<key> text edits
// ---------------------------------------------------------------------------

describe('applyPostFit — furniture:<key> text edits', () => {
  it('furniture:coverName overrides childName on the cover-wrap page (drives both spine and front title — same param, see WraparoundCover.tsx)', () => {
    const doc = docWith([
      emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', params: { childName: 'Original' } }),
    ]);
    const { document, skipped } = applyPostFit(doc, { text: { 'furniture:coverName': textEdit('Mia') } });
    expect(document.pages[0].params.childName).toBe('Mia');
    expect(skipped).toEqual([]);
  });

  it('furniture:coverTagline overrides the SAME backCoverLine field the legacy flat backCover target writes', () => {
    const doc = docWith([
      emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', params: { backCoverLine: 'Original.' } }),
    ]);
    const { document } = applyPostFit(doc, { text: { 'furniture:coverTagline': textEdit('New tagline.') } });
    expect(document.pages[0].params.backCoverLine).toBe('New tagline.');
  });

  it('furniture:dedicationSalutation and furniture:dedicationSignoff set params.greeting/params.signature independently of params.body', () => {
    const doc = docWith([
      emptyPage({ id: 'ded', sourceElementId: 'ded', templateId: 'dedication', params: { body: 'Untouched body.' } }),
    ]);
    const { document, skipped } = applyPostFit(doc, {
      text: {
        'furniture:dedicationSalutation': textEdit('Dear Mia,'),
        'furniture:dedicationSignoff': textEdit('With all our love'),
      },
    });
    expect(document.pages[0].params.greeting).toBe('Dear Mia,');
    expect(document.pages[0].params.signature).toBe('With all our love');
    expect(document.pages[0].params.body).toBe('Untouched body.');
    expect(skipped).toEqual([]);
  });

  it('furniture:scanInstruction sets params.scanInstruction on the dedication page, independently of hasScanMarks', () => {
    const doc = docWith([
      emptyPage({ id: 'ded', sourceElementId: 'ded', templateId: 'dedication', params: { hasScanMarks: false } }),
    ]);
    const { document, skipped } = applyPostFit(doc, {
      text: { 'furniture:scanInstruction': textEdit('Custom scan instruction.') },
    });
    expect(document.pages[0].params.scanInstruction).toBe('Custom scan instruction.');
    // The apply-time dispatch never touches the fitter-owned gate — a saved
    // override still round-trips even on a book with no scan marks today
    // (Dedication.tsx's own hasScanMarks check governs visibility).
    expect(document.pages[0].params.hasScanMarks).toBe(false);
    expect(skipped).toEqual([]);
  });

  it('furniture:ttyKicker and furniture:ttyTitle set params.ttyKicker/params.ttyTitle on the through-the-years page', () => {
    const doc = docWith([emptyPage({ id: 'tty', sourceElementId: 'tty', templateId: 'through-the-years', params: {} })]);
    const { document, skipped } = applyPostFit(doc, {
      text: {
        'furniture:ttyKicker': textEdit('a year in pictures'),
        'furniture:ttyTitle': textEdit('How you grew\nin one year'),
      },
    });
    expect(document.pages[0].params.ttyKicker).toBe('a year in pictures');
    expect(document.pages[0].params.ttyTitle).toBe('How you grew\nin one year');
    expect(skipped).toEqual([]);
  });

  it('furniture:closingTitle overrides the closing headline, independently of the closingLine (count) field (owner-approved follow-up round, item 5)', () => {
    const doc = docWith([
      emptyPage({ id: 'closing', sourceElementId: 'closing', templateId: 'closing', params: { closingLine: 'Untouched count line.' } }),
    ]);
    const { document, skipped } = applyPostFit(doc, { text: { 'furniture:closingTitle': textEdit('Hasta pronto.') } });
    expect(document.pages[0].params.closingTitle).toBe('Hasta pronto.');
    expect(document.pages[0].params.closingLine).toBe('Untouched count line.');
    expect(skipped).toEqual([]);
  });

  it('reports an orphan for a furniture target outside the allowlist (never reaches applyFurnitureTextEdit)', () => {
    const doc = docWith([emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap' })]);
    const { skipped } = applyPostFit(doc, { text: { 'furniture:notAllowlisted': textEdit('x') } });
    expect(skipped).toEqual([{ kind: 'text', key: 'furniture:notAllowlisted', reason: expect.any(String) }]);
  });

  it('reports an orphan when a furniture target names a page shape that is not in the document', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'anchor-media' })]);
    const { skipped } = applyPostFit(doc, { text: { 'furniture:ttyKicker': textEdit('x') } });
    expect(skipped).toEqual([{ kind: 'text', key: 'furniture:ttyKicker', reason: expect.any(String) }]);
  });

  it('year range stays derived/non-editable — no furniture key ever touches params.yearRangeLabel', () => {
    const doc = docWith([
      emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', params: { yearRangeLabel: 'Year One' } }),
    ]);
    const { document } = applyPostFit(doc, {
      text: { 'furniture:coverName': textEdit('Mia'), 'furniture:coverTagline': textEdit('Tagline.') },
    });
    expect(document.pages[0].params.yearRangeLabel).toBe('Year One');
  });
});

// ---------------------------------------------------------------------------
// applyPostFit — focal point edits
// ---------------------------------------------------------------------------

describe('applyPostFit — focal point edits', () => {
  it('sets focalPoint on the matching photo slot only', () => {
    const doc = docWith([
      emptyPage({
        id: 'p1',
        sourceElementId: 'x',
        templateId: 'anchor-media',
        slots: [
          { id: 's1', kind: 'photo', content: photoContent({ memoryId: 'mem-1', assetFile: 'assets/a.jpg' }) },
          { id: 's2', kind: 'photo', content: photoContent({ memoryId: 'mem-2', assetFile: 'assets/b.jpg' }) },
        ],
      }),
    ]);
    const { document, skipped } = applyPostFit(doc, {
      focalPoints: { [slotKey('mem-1', 'assets/a.jpg')]: focalPointEdit(0.3, 0.7) },
    });
    expect((document.pages[0].slots[0].content as PhotoSlotContent).focalPoint).toEqual({ x: 0.3, y: 0.7 });
    expect((document.pages[0].slots[1].content as PhotoSlotContent).focalPoint).toBeNull();
    expect(skipped).toEqual([]);
  });

  it('sets assetFocalPoint on the cover-wrap page for the cover key', () => {
    const doc = docWith([emptyPage({ id: 'cover', sourceElementId: 'cover', templateId: 'cover-wrap', params: {} })]);
    const { document } = applyPostFit(doc, { focalPoints: { [COVER_SLOT_KEY]: focalPointEdit(0.1, 0.9) } });
    expect(document.pages[0].params.assetFocalPoint).toEqual({ x: 0.1, y: 0.9 });
  });

  it('reports an orphan when no photo slot matches', () => {
    const doc = docWith([emptyPage({ id: 'p1', sourceElementId: 'x', templateId: 'anchor-media' })]);
    const { skipped } = applyPostFit(doc, { focalPoints: { [slotKey('gone', 'assets/gone.jpg')]: focalPointEdit(0.5, 0.5) } });
    expect(skipped).toEqual([{ kind: 'focalPoint', key: 'gone:assets/gone.jpg', reason: expect.any(String) }]);
  });
});

// ---------------------------------------------------------------------------
// applyPostFit — no-reflow property, on a real fitted book (like audit.test.ts's
// real-books suite: zero violations required, skipped gracefully when
// book-data isn't present).
// ---------------------------------------------------------------------------

describe('applyPostFit — text edits never change the page count (real fixture)', () => {
  const BOOK_DATA_DIR = resolve(process.cwd(), 'book-data');
  const slug = 'enzo-year-one';
  const manifestPath = resolve(BOOK_DATA_DIR, slug, 'manifest.json');
  const outlinePath = resolve(BOOK_DATA_DIR, slug, 'book.outline.json');
  const available = existsSync(manifestPath) && existsSync(outlinePath);
  const runner = available ? it : it.skip;

  runner('same pages.length and totalPages before and after applying a representative set of text edits', () => {
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    const outline: BookOutline = parseOutline(JSON.parse(readFileSync(outlinePath, 'utf8')));
    const { document } = fitBook(outline, manifest);

    const themedElementId = outline.elements.find((e) => e.kind === 'themed')?.id;
    const firstPhotoMemoryId = document.pages
      .flatMap((p) => p.slots)
      .map((s) => s.content)
      .find((c): c is PhotoSlotContent => c.kind === 'photo')?.memoryId;
    expect(themedElementId).toBeTruthy();
    expect(firstPhotoMemoryId).toBeTruthy();

    const edits: MemoryBookEditsShape = {
      text: {
        dedication: textEdit('A new dedication, saved as an edit.'),
        backCover: textEdit('A new back-cover line.'),
        closing: textEdit('A new closing line.'),
        [`sectionTitle:${themedElementId}`]: textEdit('A new section title.'),
        [`eyebrow:${themedElementId}`]: textEdit('A new eyebrow.'),
        [`caption:${firstPhotoMemoryId}`]: textEdit('A new caption.'),
        'furniture:coverName': textEdit('A new cover name.'),
        'furniture:coverTagline': textEdit('A new cover tagline.'),
        'furniture:dedicationSalutation': textEdit('A new salutation.'),
        'furniture:dedicationSignoff': textEdit('A new signoff.'),
        'furniture:scanInstruction': textEdit('A new scan instruction.'),
        'furniture:ttyKicker': textEdit('A new kicker.'),
        'furniture:ttyTitle': textEdit('A new title\non two lines'),
        'furniture:closingTitle': textEdit('A new closing title.'),
      },
    };

    const beforePageCount = document.pages.length;
    const beforeTotalPages = document.totalPages;
    const { document: edited, skipped } = applyPostFit(document, edits);

    expect(edited.pages.length).toBe(beforePageCount);
    expect(edited.totalPages).toBe(beforeTotalPages);
    // Every edit above targets something that genuinely exists in this real
    // book — proves the no-reflow assertion isn't vacuously true because
    // every edit was silently orphaned.
    expect(skipped).toEqual([]);
  });
});
