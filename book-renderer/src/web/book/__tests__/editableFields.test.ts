import { describe, expect, it } from 'vitest';
import { computeTextFields } from '../editableFields';
import { makeManifest } from '../../../model/__tests__/fixtures/build';
import type { BookPage } from '../../../model/types';

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
});
