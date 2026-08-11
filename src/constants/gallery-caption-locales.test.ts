import {
  GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH,
  curatedGalleryCaptionLocaleTags,
  formatGalleryCaptionLocaleLabel,
  galleryCaptionLocaleTags,
  getCuratedGalleryCaptionLocaleOptions,
  getGalleryCaptionLocaleOptions,
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

  it('gives every registry tag a real English and native name -- never a bare code echoed back', () => {
    const options = getGalleryCaptionLocaleOptions();
    expect(options).toHaveLength(galleryCaptionLocaleTags.length);
    for (const option of options) {
      expect(option.englishLabel.toLocaleLowerCase()).not.toBe(option.tag.toLocaleLowerCase());
      expect(option.nativeLabel.toLocaleLowerCase()).not.toBe(option.tag.toLocaleLowerCase());
      expect(option.englishLabel.trim().length).toBeGreaterThan(0);
      expect(option.nativeLabel.trim().length).toBeGreaterThan(0);
      expect(formatGalleryCaptionLocaleLabel(option).toLocaleLowerCase()).not.toBe(option.tag.toLocaleLowerCase());
    }
  });

  it('never surfaces the two device-confirmed bug tags ("aa", "es-CO") as bare codes', () => {
    const options = getGalleryCaptionLocaleOptions();
    const aa = options.find((option) => option.tag === 'aa');
    const esCO = options.find((option) => option.tag === 'es-CO');
    expect(aa?.englishLabel).toBe('Afar');
    expect(aa?.nativeLabel).toBe('Afaraf');
    expect(esCO?.englishLabel).toBe('Spanish (Colombia)');
    expect(esCO?.nativeLabel).toBe('español (Colombia)');
    expect(esCO && formatGalleryCaptionLocaleLabel(esCO)).toBe('Spanish (Colombia)');
  });

  it('rebuilds searchText from the static names, so language/country/native search all resolve', () => {
    expect(searchGalleryCaptionLocales('Esp').map((option) => option.tag)).toEqual(
      expect.arrayContaining(['es', 'es-CO', 'es-MX', 'es-ES']),
    );
    expect(searchGalleryCaptionLocales('español').map((option) => option.tag)).toEqual(
      expect.arrayContaining(['es', 'es-CO']),
    );
    expect(searchGalleryCaptionLocales('Colombia').map((option) => option.tag)).toEqual(['es-CO']);
    expect(searchGalleryCaptionLocales('spanish').map((option) => option.tag)).toEqual(
      expect.arrayContaining(['es', 'es-CO', 'es-MX']),
    );
  });

  describe('on a Hermes-like runtime with no working Intl.DisplayNames', () => {
    // Regression trap for the actual on-device bug: Jest runs under Node,
    // which ships full ICU, so `Intl.DisplayNames` "just works" there even
    // when the code under test depends on it -- that's exactly why the
    // original implementation's tests passed while the app showed bare
    // codes ("aa · aa", "es (CO) · es-CO") on-device. These simulate the two
    // ways Hermes degrades: the constructor missing entirely, and the
    // constructor present but echoing the input back instead of resolving a
    // name (Hermes's documented ICU-less fallback). Labels must stay
    // human-readable either way, because they now come from the static
    // GALLERY_CAPTION_LOCALE_NAMES table, not runtime ICU.
    const originalDisplayNames = Intl.DisplayNames;

    afterEach(() => {
      Intl.DisplayNames = originalDisplayNames;
    });

    it('still resolves human-readable names when Intl.DisplayNames is missing entirely', () => {
      // @ts-expect-error -- simulating an engine that never defined it
      delete Intl.DisplayNames;
      const options = getGalleryCaptionLocaleOptions();
      const aa = options.find((option) => option.tag === 'aa');
      const esCO = options.find((option) => option.tag === 'es-CO');
      expect(aa?.englishLabel).toBe('Afar');
      expect(esCO?.englishLabel).toBe('Spanish (Colombia)');
      expect(esCO?.nativeLabel).toBe('español (Colombia)');
      expect(searchGalleryCaptionLocales('Colombia').map((option) => option.tag)).toEqual(['es-CO']);
    });

    it('still resolves human-readable names when Intl.DisplayNames silently echoes the input code back', () => {
      class IdentityDisplayNames {
        of(code: string) {
          return code;
        }
      }
      // @ts-expect-error -- simulating Hermes's ICU-less identity fallback
      Intl.DisplayNames = IdentityDisplayNames;
      const options = getGalleryCaptionLocaleOptions('es-CO');
      const aa = options.find((option) => option.tag === 'aa');
      const esCO = options.find((option) => option.tag === 'es-CO');
      expect(aa?.englishLabel).toBe('Afar');
      expect(aa?.nativeLabel).toBe('Afaraf');
      expect(esCO?.englishLabel).toBe('Spanish (Colombia)');
      expect(esCO?.nativeLabel).toBe('español (Colombia)');
      // localizedLabel is the only field that ever asks Intl for anything --
      // with a degraded/identity Intl it must fall back to the static
      // English label, never a bare "es-CO" tag.
      expect(esCO?.localizedLabel).toBe('Spanish (Colombia)');
      expect(searchGalleryCaptionLocales('español').map((option) => option.tag)).toEqual(
        expect.arrayContaining(['es', 'es-CO']),
      );
    });
  });

  describe('curated picker subset (2026-08-10 product decision: trim the 241-entry list)', () => {
    it('lands the curated list in the intended ~40-60 entry range, well under the full registry', () => {
      expect(curatedGalleryCaptionLocaleTags.length).toBeGreaterThanOrEqual(40);
      expect(curatedGalleryCaptionLocaleTags.length).toBeLessThanOrEqual(60);
      expect(curatedGalleryCaptionLocaleTags.length).toBeLessThan(galleryCaptionLocaleTags.length);
    });

    it('has no duplicate tags and every tag is a real, valid registry entry', () => {
      expect(new Set(curatedGalleryCaptionLocaleTags).size).toBe(curatedGalleryCaptionLocaleTags.length);
      for (const tag of curatedGalleryCaptionLocaleTags) {
        expect(galleryCaptionLocaleTags).toContain(tag);
      }
    });

    it('gives every curated entry the same real human-readable names as the full registry', () => {
      const curated = getCuratedGalleryCaptionLocaleOptions();
      expect(curated).toHaveLength(curatedGalleryCaptionLocaleTags.length);
      const full = getGalleryCaptionLocaleOptions();
      for (const option of curated) {
        const fullOption = full.find((candidate) => candidate.tag === option.tag);
        expect(fullOption).toBeDefined();
        expect(option.englishLabel).toBe(fullOption?.englishLabel);
        expect(option.nativeLabel).toBe(fullOption?.nativeLabel);
      }
    });

    it('excludes the long tail (e.g. Abkhaz/Afar/Akan) that made the old list overwhelming to scroll', () => {
      const curatedTags = new Set(curatedGalleryCaptionLocaleTags);
      expect(curatedTags.has('aa')).toBe(false); // Afar
      expect(curatedTags.has('ab')).toBe(false); // Abkhaz
      expect(curatedTags.has('ak')).toBe(false); // Akan
    });

    it('keeps validating tags OUTSIDE the curated list -- trimming the picker never narrows what is accepted', () => {
      // A family whose saved language predates the curation, or was set by
      // any future non-picker path, must keep validating successfully.
      expect(normalizeGalleryCaptionLocale('aa')).toBe('aa');
      expect(normalizeGalleryCaptionLocale('ee')).toBe('ee');
      expect(normalizeGalleryCaptionLocale('sw-KE')).toBe('sw-KE');
    });

    it('still resolves a real human-readable label for a saved language outside the curated list', () => {
      // This is what the settings screen and the picker's "Current" section
      // must use for an out-of-curation saved language -- never the bare tag.
      const full = getGalleryCaptionLocaleOptions();
      const afar = full.find((option) => option.tag === 'aa');
      expect(afar?.englishLabel).toBe('Afar');
      expect(afar?.nativeLabel).toBe('Afaraf');
      expect(formatGalleryCaptionLocaleLabel(afar!)).toBe('Afaraf (Afar)');
    });
  });
});
