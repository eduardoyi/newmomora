import {
  GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH,
  normalizeGalleryCaptionLocale,
  searchGalleryCaptionLocales,
  validateGalleryCaptionInstructions,
} from '@/constants/gallery-caption-locales';

describe('gallery caption locale registry', () => {
  it('preserves regional variants as explicit canonical BCP 47 choices', () => {
    expect(normalizeGalleryCaptionLocale('en-GB')).toBe('en-GB');
    expect(normalizeGalleryCaptionLocale('EN-us')).toBe('en-US');
    expect(normalizeGalleryCaptionLocale('pt-br')).toBe('pt-BR');
    expect(normalizeGalleryCaptionLocale('pt-PT')).toBe('pt-PT');
    expect(normalizeGalleryCaptionLocale('fr-CA')).toBe('fr-CA');
    expect(normalizeGalleryCaptionLocale('x-private')).toBeNull();
  });

  it('searches labels and canonical tags', () => {
    expect(searchGalleryCaptionLocales('pt-BR').map((option) => option.tag)).toContain('pt-BR');
    expect(searchGalleryCaptionLocales('Portuguese').map((option) => option.tag)).toContain('pt-PT');
  });

  it('gives regional variants visibly distinct language-and-region labels', () => {
    const options = searchGalleryCaptionLocales('');
    const labels = ['en-GB', 'en-US', 'pt-BR', 'pt-PT'].map((tag) => {
      const option = options.find((candidate) => candidate.tag === tag);
      return option?.englishLabel;
    });
    expect(new Set(labels).size).toBe(4);
    expect(labels.every((label) => label?.includes('('))).toBe(true);
  });

  it('bounds custom instructions and rejects unsafe control characters', () => {
    expect(validateGalleryCaptionInstructions('warm, understated')).toBeNull();
    expect(validateGalleryCaptionInstructions('x'.repeat(GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH + 1))).toMatch(/500/);
    expect(validateGalleryCaptionInstructions('hello\u0000there')).toMatch(/control/i);
  });
});
