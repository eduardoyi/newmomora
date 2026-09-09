import { describe, expect, it } from 'vitest';
import { computeTextFields, computeEditablePhotoSlots } from '../editableFields';
import { COVER_SLOT_KEY, slotKey } from '../../../model/edits';
import { makeManifest } from '../../../model/__tests__/fixtures/build';
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

/**
 * `computeTextFields`'s `furniture:<key>` fields (owner-approved follow-up
 * round) — the overlay's ONLY source of what to show as each popover's
 * starting value, so these must track the real templates' own fallback
 * logic (`Dedication.tsx`/`ThroughTheYears.tsx`) exactly: an unsaved
 * furniture field's `value` is the LIVE furniture default (language-aware),
 * never blank, and a saved override wins once present in `params`.
 */
describe('computeTextFields — furniture:<key> fields', () => {
  it('defaults furniture:coverName/coverTagline from the cover-wrap page params, language-independent', () => {
    const manifest = makeManifest({}, { language: 'en' });
    const cover = page({ templateId: 'cover-wrap', params: { childName: 'Mia', backCoverLine: 'A year of firsts.' } });
    const fields = computeTextFields([cover], manifest);
    expect(fields.find((f) => f.target === 'furniture:coverName')?.value).toBe('Mia');
    expect(fields.find((f) => f.target === 'furniture:coverTagline')?.value).toBe('A year of firsts.');
  });

  it('defaults furniture:coverTagline to empty string when no backCoverLine is set yet', () => {
    const manifest = makeManifest({});
    const cover = page({ templateId: 'cover-wrap', params: { childName: 'Mia' } });
    const fields = computeTextFields([cover], manifest);
    expect(fields.find((f) => f.target === 'furniture:coverTagline')?.value).toBe('');
  });

  it('defaults furniture:dedicationSalutation/dedicationSignoff to the language-appropriate furniture copy when unset', () => {
    const enManifest = makeManifest({}, { language: 'en' });
    const esManifest = makeManifest({}, { language: 'es' });
    const dedication = page({ templateId: 'dedication', params: { childName: 'Mia' } });

    const enFields = computeTextFields([dedication], enManifest);
    expect(enFields.find((f) => f.target === 'furniture:dedicationSalutation')?.value).toBe('For Mia,');
    expect(enFields.find((f) => f.target === 'furniture:dedicationSignoff')?.value).toBe('Written with love, day by day');

    const esFields = computeTextFields([dedication], esManifest);
    expect(esFields.find((f) => f.target === 'furniture:dedicationSalutation')?.value).toBe('Para Mia,');
    expect(esFields.find((f) => f.target === 'furniture:dedicationSignoff')?.value).toBe('Escrito con amor, día a día');
  });

  it('prefers a saved params override over the furniture default for dedication fields', () => {
    const manifest = makeManifest({}, { language: 'en' });
    const dedication = page({
      templateId: 'dedication',
      params: { childName: 'Mia', greeting: 'Dear Mia,', signature: 'With all our love' },
    });
    const fields = computeTextFields([dedication], manifest);
    expect(fields.find((f) => f.target === 'furniture:dedicationSalutation')?.value).toBe('Dear Mia,');
    expect(fields.find((f) => f.target === 'furniture:dedicationSignoff')?.value).toBe('With all our love');
  });

  it('defaults furniture:ttyKicker/ttyTitle to the language-appropriate furniture copy when unset, title joined by newline', () => {
    const manifest = makeManifest({}, { language: 'en' });
    const tty = page({ templateId: 'through-the-years', params: {} });
    const fields = computeTextFields([tty], manifest);
    expect(fields.find((f) => f.target === 'furniture:ttyKicker')?.value).toBe('through the years');
    expect(fields.find((f) => f.target === 'furniture:ttyTitle')?.value).toBe('How you changed\nin twelve months');
  });

  it('does not emit furniture fields for pages whose templateId does not match', () => {
    const manifest = makeManifest({});
    const fields = computeTextFields([page({ templateId: 'anchor-media' })], manifest);
    expect(fields.filter((f) => f.target.startsWith('furniture:'))).toEqual([]);
  });

  it('defaults furniture:closingTitle to the language-appropriate furniture headline when unset, and prefers a saved override (owner-approved follow-up round, item 5)', () => {
    const enManifest = makeManifest({}, { language: 'en' });
    const esManifest = makeManifest({}, { language: 'es' });
    const closing = page({ templateId: 'closing', params: {} });

    const enFields = computeTextFields([closing], enManifest);
    expect(enFields.find((f) => f.target === 'furniture:closingTitle')?.value).toBe('See you next year.');

    const esFields = computeTextFields([closing], esManifest);
    expect(esFields.find((f) => f.target === 'furniture:closingTitle')?.value).toBe('Hasta el año que viene.');

    const overridden = page({ templateId: 'closing', params: { closingTitle: 'Until next time.' } });
    const overriddenFields = computeTextFields([overridden], enManifest);
    expect(overriddenFields.find((f) => f.target === 'furniture:closingTitle')?.value).toBe('Until next time.');
  });
});

function photoSlot(overrides: Partial<PhotoSlotContent> & Pick<PhotoSlotContent, 'memoryId' | 'assetFile'>): {
  id: string;
  kind: 'photo';
  content: PhotoSlotContent;
} {
  return {
    id: overrides.memoryId,
    kind: 'photo',
    content: {
      kind: 'photo',
      assetWidth: 100,
      assetHeight: 100,
      assetAspectRatio: 1,
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

describe('computeEditablePhotoSlots — isVideoPoster (owner-approved follow-up round, item 4)', () => {
  it('marks an ordinary photo slot isVideoPoster: false', () => {
    const p = page({
      templateId: 'anchor-media',
      slots: [photoSlot({ memoryId: 'mem-1', assetFile: 'assets/a.jpg', qr: false })],
    });
    const slots = computeEditablePhotoSlots([p]);
    expect(slots).toHaveLength(1);
    expect(slots[0].isVideoPoster).toBe(false);
  });

  it('marks a video-poster-backed slot (content.qr === true) isVideoPoster: true', () => {
    const p = page({
      templateId: 'anchor-media',
      slots: [photoSlot({ memoryId: 'mem-1', assetFile: 'assets/video-poster.jpg', qr: true })],
    });
    const slots = computeEditablePhotoSlots([p]);
    expect(slots).toHaveLength(1);
    expect(slots[0].isVideoPoster).toBe(true);
  });

  it('the cover slot is never isVideoPoster (buildCoverPages only ever nominates a photo)', () => {
    const p = page({ templateId: 'cover-wrap', params: { assetFile: 'assets/cover.jpg' } });
    const slots = computeEditablePhotoSlots([p]);
    expect(slots).toEqual([{ key: COVER_SLOT_KEY, memoryId: null, assetFile: 'assets/cover.jpg', isCover: true, isVideoPoster: false }]);
  });

  it('de-duplicates by key, keeping the first-seen slot (including its isVideoPoster flag)', () => {
    const p = page({
      templateId: 'anchor-media',
      slots: [
        photoSlot({ memoryId: 'mem-1', assetFile: 'assets/a.jpg', qr: true }),
        photoSlot({ memoryId: 'mem-1', assetFile: 'assets/a.jpg', qr: true }),
      ],
    });
    const slots = computeEditablePhotoSlots([p]);
    expect(slots).toEqual([{ key: slotKey('mem-1', 'assets/a.jpg'), memoryId: 'mem-1', assetFile: 'assets/a.jpg', isCover: false, isVideoPoster: true }]);
  });
});
