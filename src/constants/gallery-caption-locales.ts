/**
 * Versioned shared allowlist. The Edge Function must import/generate from this
 * source (or its checked-in generated JSON) rather than keep a second manual
 * validation list. Tags deliberately include common regional variants instead
 * of collapsing parents into an ambiguous generic language choice.
 */
export const GALLERY_CAPTION_LOCALE_REGISTRY_VERSION = '2026-08-09' as const;

// ISO 639-1 coverage, with `fil` retained as a practical BCP 47 choice. A
// registry generated from this source is shared with Edge validation.
const LANGUAGE_TAGS = `
  aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy
  da de dv dz ee el en eo es et eu fa ff fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz
  ia id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln lo
  lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps
  pt qu rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti tk tl tn
  to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu fil
`.trim().split(/\s+/) as readonly string[];

const REGIONAL_TAGS = [
  'ar-EG', 'ar-SA', 'bn-BD', 'bn-IN', 'bs-BA', 'ca-ES', 'de-AT', 'de-CH', 'de-DE', 'el-GR',
  'en-AU', 'en-CA', 'en-GB', 'en-IE', 'en-IN', 'en-NZ', 'en-US', 'en-ZA',
  'es-AR', 'es-CL', 'es-CO', 'es-ES', 'es-MX', 'es-PE', 'es-US',
  'fr-BE', 'fr-CA', 'fr-CH', 'fr-FR', 'fr-LU', 'hi-IN', 'id-ID', 'it-CH', 'it-IT', 'ja-JP',
  'ko-KR', 'ms-MY', 'nl-BE', 'nl-NL', 'no-NO', 'pl-PL', 'ru-RU',
  'pt-AO', 'pt-BR', 'pt-PT', 'ro-RO', 'sr-Cyrl-RS', 'sr-Latn-RS', 'sw-KE', 'sw-TZ',
  'uz-Cyrl-UZ', 'uz-Latn-UZ', 'zh-CN', 'zh-HK', 'zh-SG', 'zh-TW',
] as const;

export const galleryCaptionLocaleTags = [...LANGUAGE_TAGS, ...REGIONAL_TAGS] as const;
export type GalleryCaptionLocaleTag = string;

const supportedLocaleTagSet = new Set<string>(galleryCaptionLocaleTags);

export interface GalleryCaptionLocaleOption {
  tag: GalleryCaptionLocaleTag;
  englishLabel: string;
  localizedLabel: string;
  nativeLabel: string;
  searchText: string;
}

function displayName(locale: string, displayLocale: string): string {
  try {
    return new Intl.DisplayNames([displayLocale], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function regionAwareDisplayName(tag: string, displayLocale: string): string {
  const [language, scriptOrRegion, maybeRegion] = tag.split('-');
  const languageLabel = displayName(language, displayLocale);
  const script = maybeRegion ? scriptOrRegion : undefined;
  const region = maybeRegion ?? (scriptOrRegion?.length === 2 || /^\d{3}$/.test(scriptOrRegion ?? '')
    ? scriptOrRegion
    : undefined);
  const qualifiers = [
    script ? (() => {
      try { return new Intl.DisplayNames([displayLocale], { type: 'script' }).of(script); } catch { return script; }
    })() : null,
    region ? (() => {
      try { return new Intl.DisplayNames([displayLocale], { type: 'region' }).of(region); } catch { return region; }
    })() : null,
  ].filter((value): value is string => Boolean(value));
  return qualifiers.length > 0 ? `${languageLabel} (${qualifiers.join(', ')})` : languageLabel;
}

/** Canonicalizes without accepting a tag that the server would reject. */
export function normalizeGalleryCaptionLocale(value: string): GalleryCaptionLocaleTag | null {
  try {
    const normalized = Intl.getCanonicalLocales(value.trim())[0];
    return normalized && supportedLocaleTagSet.has(normalized)
      ? normalized as GalleryCaptionLocaleTag
      : null;
  } catch {
    return null;
  }
}

export function getGalleryCaptionLocaleOptions(
  displayLocale = 'en',
): GalleryCaptionLocaleOption[] {
  return galleryCaptionLocaleTags.map((tag) => {
    const englishLabel = regionAwareDisplayName(tag, 'en');
    const localizedLabel = regionAwareDisplayName(tag, displayLocale);
    const nativeLabel = regionAwareDisplayName(tag, tag);
    return {
      tag,
      englishLabel,
      localizedLabel,
      nativeLabel,
      searchText: `${tag} ${englishLabel} ${localizedLabel} ${nativeLabel}`.toLocaleLowerCase(),
    };
  });
}

export function searchGalleryCaptionLocales(
  query: string,
  displayLocale = 'en',
): GalleryCaptionLocaleOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const options = getGalleryCaptionLocaleOptions(displayLocale);
  if (!normalizedQuery) return options;
  return options.filter((option) => option.searchText.includes(normalizedQuery));
}

export const GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH = 500;

export function validateGalleryCaptionInstructions(value: string): string | null {
  if (value.length > GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH) {
    return `Caption instructions must be ${GALLERY_CAPTION_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`;
  }
  // Control characters are a transport/logging risk, not useful writing.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    return 'Caption instructions contain unsupported control characters.';
  }
  return null;
}
