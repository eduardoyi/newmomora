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

/**
 * Curated presentation subset for the locale PICKER only (2026-08-10 product
 * decision -- see docs/design/gallery-import/README.md). The full
 * `galleryCaptionLocaleTags` above (241 tags) was overwhelming to scroll --
 * device testing showed users passing Abkhaz/Afar/Akan before reaching
 * anything they'd actually pick. This ~40-60-entry list is what the picker's
 * "All languages" section and search show by default.
 *
 * This is presentation-only and changes nothing about what is ACCEPTED:
 * - `normalizeGalleryCaptionLocale` still validates against the full
 *   `supportedLocaleTagSet` (all 241 tags), unchanged below.
 * - The Edge Function (`supabase/functions/_shared/gallery-import.ts`,
 *   `updateGalleryCaptionSettings`) validates the language as a BCP-47-shaped
 *   string via regex, not against this list at all -- it was never coupled
 *   to this file's tag set to begin with.
 * - A family whose saved language falls outside this curated list (set
 *   before this change, or by a future non-picker path) keeps resolving to
 *   its correct human-readable name: callers must look it up via
 *   `getGalleryCaptionLocaleOptions()` (the FULL list), not
 *   `getCuratedGalleryCaptionLocaleOptions()`, for the "Current" row and the
 *   settings-screen summary label. See `gallery-import-caption-settings.tsx`.
 *
 * Regional variants are included only for languages where the split
 * genuinely matters (matches en/es/pt/fr/de's existing "regional variants
 * matter" framing); other majors keep a single generic entry. `zh-CN`/`zh-TW`
 * stand in for simplified/traditional script the way the registry already
 * expresses Chinese (no `zh-Hans`/`zh-Hant` tags exist in this registry).
 */
export const curatedGalleryCaptionLocaleTags = [
  'en-US', 'en-GB', 'en-AU', 'en-CA', 'en-IE',
  'es-ES', 'es-MX', 'es-CO', 'es-AR', 'es-CL',
  'pt-PT', 'pt-BR',
  'fr-FR', 'fr-CA',
  'de-DE', 'de-AT', 'de-CH',
  'zh-CN', 'zh-TW',
  'it', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'cs', 'sk', 'hu', 'ro', 'el', 'tr',
  'ru', 'uk', 'ar', 'he', 'hi', 'bn', 'ta', 'ur', 'id', 'ms', 'vi', 'th', 'fil',
  'ja', 'ko', 'ca',
] as const;

export interface GalleryCaptionLocaleOption {
  tag: GalleryCaptionLocaleTag;
  englishLabel: string;
  localizedLabel: string;
  nativeLabel: string;
  searchText: string;
}

/**
 * Hand-authored English + native (autonym) name for every tag in
 * `galleryCaptionLocaleTags` -- the SOURCE OF TRUTH for `englishLabel` and
 * `nativeLabel` below.
 *
 * This exists because `Intl.DisplayNames` is NOT a reliable source for these
 * on-device: Momora runs on Hermes (Expo SDK 56's default JS engine), and
 * this app ships no bundled full-ICU data (no `android/ios` native
 * overrides, no `expo-localization`/Hermes ICU config in app.json). Hermes's
 * built-in `Intl.DisplayNames` implements the API surface but, without full
 * ICU locale data, silently falls back to returning the input code instead
 * of throwing -- so `new Intl.DisplayNames(['en'],{type:'language'}).of('es')`
 * can resolve to `"es"` rather than `"Spanish"` on-device, even though the
 * exact same call returns the real name under Jest (Node ships full ICU),
 * which is why unit tests didn't catch this. Confirmed via device testing:
 * the locale picker rendered raw codes ("aa · aa", "es (CO) · es-CO")
 * instead of names. See docs/design/gallery-import/README.md.
 *
 * `Intl.DisplayNames` is used ONLY as an optional enhancement for
 * `localizedLabel` (a non-English display-locale variant nothing in the UI
 * currently reads) via `enhancedDisplayName` below -- never for
 * `englishLabel`/`nativeLabel`, and never trusted without the
 * "did it just echo the input back" guard.
 */
const GALLERY_CAPTION_LOCALE_NAMES: Record<string, { readonly en: string; readonly native: string }> = {
  aa: { en: 'Afar', native: 'Afaraf' },
  ab: { en: 'Abkhaz', native: 'аҧсуа бызшәа' },
  ae: { en: 'Avestan', native: 'avesta' },
  af: { en: 'Afrikaans', native: 'Afrikaans' },
  ak: { en: 'Akan', native: 'Akan' },
  am: { en: 'Amharic', native: 'አማርኛ' },
  an: { en: 'Aragonese', native: 'aragonés' },
  ar: { en: 'Arabic', native: 'العربية' },
  as: { en: 'Assamese', native: 'অসমীয়া' },
  av: { en: 'Avaric', native: 'авар мацӀ' },
  ay: { en: 'Aymara', native: 'aymar aru' },
  az: { en: 'Azerbaijani', native: 'azərbaycan dili' },
  ba: { en: 'Bashkir', native: 'башҡорт теле' },
  be: { en: 'Belarusian', native: 'беларуская мова' },
  bg: { en: 'Bulgarian', native: 'български език' },
  bh: { en: 'Bihari', native: 'भोजपुरी' },
  bi: { en: 'Bislama', native: 'Bislama' },
  bm: { en: 'Bambara', native: 'bamanankan' },
  bn: { en: 'Bengali', native: 'বাংলা' },
  bo: { en: 'Tibetan', native: 'བོད་ཡིག' },
  br: { en: 'Breton', native: 'brezhoneg' },
  bs: { en: 'Bosnian', native: 'bosanski' },
  ca: { en: 'Catalan', native: 'català' },
  ce: { en: 'Chechen', native: 'нохчийн мотт' },
  ch: { en: 'Chamorro', native: 'Chamoru' },
  co: { en: 'Corsican', native: 'corsu' },
  cr: { en: 'Cree', native: 'ᓀᐦᐃᔭᐍᐏᐣ' },
  cs: { en: 'Czech', native: 'čeština' },
  cu: { en: 'Church Slavic', native: 'ѩзыкъ словѣньскъ' },
  cv: { en: 'Chuvash', native: 'чӑваш чӗлхи' },
  cy: { en: 'Welsh', native: 'Cymraeg' },
  da: { en: 'Danish', native: 'dansk' },
  de: { en: 'German', native: 'Deutsch' },
  dv: { en: 'Divehi', native: 'ދިވެހި' },
  dz: { en: 'Dzongkha', native: 'རྫོང་ཁ' },
  ee: { en: 'Ewe', native: 'Eʋegbe' },
  el: { en: 'Greek', native: 'Ελληνικά' },
  en: { en: 'English', native: 'English' },
  eo: { en: 'Esperanto', native: 'Esperanto' },
  es: { en: 'Spanish', native: 'español' },
  et: { en: 'Estonian', native: 'eesti' },
  eu: { en: 'Basque', native: 'euskara' },
  fa: { en: 'Persian', native: 'فارسی' },
  ff: { en: 'Fulah', native: 'Fulfulde' },
  fi: { en: 'Finnish', native: 'suomi' },
  fj: { en: 'Fijian', native: 'vosa Vakaviti' },
  fo: { en: 'Faroese', native: 'føroyskt' },
  fr: { en: 'French', native: 'français' },
  fy: { en: 'Western Frisian', native: 'Frysk' },
  ga: { en: 'Irish', native: 'Gaeilge' },
  gd: { en: 'Scottish Gaelic', native: 'Gàidhlig' },
  gl: { en: 'Galician', native: 'galego' },
  gn: { en: 'Guarani', native: "Avañe'ẽ" },
  gu: { en: 'Gujarati', native: 'ગુજરાતી' },
  gv: { en: 'Manx', native: 'Gaelg' },
  ha: { en: 'Hausa', native: 'Hausa' },
  he: { en: 'Hebrew', native: 'עברית' },
  hi: { en: 'Hindi', native: 'हिन्दी' },
  ho: { en: 'Hiri Motu', native: 'Hiri Motu' },
  hr: { en: 'Croatian', native: 'hrvatski' },
  ht: { en: 'Haitian Creole', native: 'Kreyòl ayisyen' },
  hu: { en: 'Hungarian', native: 'magyar' },
  hy: { en: 'Armenian', native: 'Հայերեն' },
  hz: { en: 'Herero', native: 'Otjiherero' },
  ia: { en: 'Interlingua', native: 'Interlingua' },
  id: { en: 'Indonesian', native: 'Bahasa Indonesia' },
  ie: { en: 'Interlingue', native: 'Interlingue' },
  ig: { en: 'Igbo', native: 'Asụsụ Igbo' },
  ii: { en: 'Sichuan Yi', native: 'Nuosuhxop' },
  ik: { en: 'Inupiaq', native: 'Iñupiaq' },
  io: { en: 'Ido', native: 'Ido' },
  is: { en: 'Icelandic', native: 'íslenska' },
  it: { en: 'Italian', native: 'italiano' },
  iu: { en: 'Inuktitut', native: 'ᐃᓄᒃᑎᑐᑦ' },
  ja: { en: 'Japanese', native: '日本語' },
  jv: { en: 'Javanese', native: 'basa Jawa' },
  ka: { en: 'Georgian', native: 'ქართული' },
  kg: { en: 'Kongo', native: 'Kikongo' },
  ki: { en: 'Kikuyu', native: 'Gĩkũyũ' },
  kj: { en: 'Kuanyama', native: 'Kuanyama' },
  kk: { en: 'Kazakh', native: 'қазақ тілі' },
  kl: { en: 'Kalaallisut', native: 'kalaallisut' },
  km: { en: 'Khmer', native: 'ខ្មែរ' },
  kn: { en: 'Kannada', native: 'ಕನ್ನಡ' },
  ko: { en: 'Korean', native: '한국어' },
  kr: { en: 'Kanuri', native: 'Kanuri' },
  ks: { en: 'Kashmiri', native: 'कॉशुर' },
  ku: { en: 'Kurdish', native: 'Kurdî' },
  kv: { en: 'Komi', native: 'коми кыв' },
  kw: { en: 'Cornish', native: 'Kernewek' },
  ky: { en: 'Kyrgyz', native: 'Кыргызча' },
  la: { en: 'Latin', native: 'lingua latina' },
  lb: { en: 'Luxembourgish', native: 'Lëtzebuergesch' },
  lg: { en: 'Ganda', native: 'Luganda' },
  li: { en: 'Limburgish', native: 'Limburgs' },
  ln: { en: 'Lingala', native: 'Lingála' },
  lo: { en: 'Lao', native: 'ພາສາລາວ' },
  lt: { en: 'Lithuanian', native: 'lietuvių kalba' },
  lu: { en: 'Luba-Katanga', native: 'Kiluba' },
  lv: { en: 'Latvian', native: 'latviešu valoda' },
  mg: { en: 'Malagasy', native: 'fiteny malagasy' },
  mh: { en: 'Marshallese', native: 'Kajin M̧ajeļ' },
  mi: { en: 'Maori', native: 'te reo Māori' },
  mk: { en: 'Macedonian', native: 'македонски јазик' },
  ml: { en: 'Malayalam', native: 'മലയാളം' },
  mn: { en: 'Mongolian', native: 'Монгол хэл' },
  mr: { en: 'Marathi', native: 'मराठी' },
  ms: { en: 'Malay', native: 'Bahasa Melayu' },
  mt: { en: 'Maltese', native: 'Malti' },
  my: { en: 'Burmese', native: 'ဗမာစာ' },
  na: { en: 'Nauru', native: 'Dorerin Naoero' },
  nb: { en: 'Norwegian Bokmål', native: 'Norsk Bokmål' },
  nd: { en: 'North Ndebele', native: 'isiNdebele' },
  ne: { en: 'Nepali', native: 'नेपाली' },
  ng: { en: 'Ndonga', native: 'Owambo' },
  nl: { en: 'Dutch', native: 'Nederlands' },
  nn: { en: 'Norwegian Nynorsk', native: 'Norsk Nynorsk' },
  no: { en: 'Norwegian', native: 'Norsk' },
  nr: { en: 'South Ndebele', native: 'isiNdebele' },
  nv: { en: 'Navajo', native: 'Diné bizaad' },
  ny: { en: 'Chichewa', native: 'chiCheŵa' },
  oc: { en: 'Occitan', native: 'occitan' },
  oj: { en: 'Ojibwe', native: 'ᐊᓂᔑᓈᐯᒧᐎᓐ' },
  om: { en: 'Oromo', native: 'Afaan Oromoo' },
  or: { en: 'Odia', native: 'ଓଡ଼ିଆ' },
  os: { en: 'Ossetian', native: 'ирон æвзаг' },
  pa: { en: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  pi: { en: 'Pali', native: 'पाऴि' },
  pl: { en: 'Polish', native: 'język polski' },
  ps: { en: 'Pashto', native: 'پښتو' },
  pt: { en: 'Portuguese', native: 'português' },
  qu: { en: 'Quechua', native: 'Runa Simi' },
  rm: { en: 'Romansh', native: 'rumantsch grischun' },
  rn: { en: 'Kirundi', native: 'Ikirundi' },
  ro: { en: 'Romanian', native: 'română' },
  ru: { en: 'Russian', native: 'русский' },
  rw: { en: 'Kinyarwanda', native: 'Ikinyarwanda' },
  sa: { en: 'Sanskrit', native: 'संस्कृतम्' },
  sc: { en: 'Sardinian', native: 'sardu' },
  sd: { en: 'Sindhi', native: 'सिन्धी' },
  se: { en: 'Northern Sami', native: 'Davvisámegiella' },
  sg: { en: 'Sango', native: 'yângâ tî sängö' },
  si: { en: 'Sinhala', native: 'සිංහල' },
  sk: { en: 'Slovak', native: 'slovenčina' },
  sl: { en: 'Slovenian', native: 'slovenski jezik' },
  sm: { en: 'Samoan', native: "gagana fa'a Samoa" },
  sn: { en: 'Shona', native: 'chiShona' },
  so: { en: 'Somali', native: 'Soomaaliga' },
  sq: { en: 'Albanian', native: 'Shqip' },
  sr: { en: 'Serbian', native: 'српски' },
  ss: { en: 'Swati', native: 'SiSwati' },
  st: { en: 'Southern Sotho', native: 'Sesotho' },
  su: { en: 'Sundanese', native: 'Basa Sunda' },
  sv: { en: 'Swedish', native: 'svenska' },
  sw: { en: 'Swahili', native: 'Kiswahili' },
  ta: { en: 'Tamil', native: 'தமிழ்' },
  te: { en: 'Telugu', native: 'తెలుగు' },
  tg: { en: 'Tajik', native: 'тоҷикӣ' },
  th: { en: 'Thai', native: 'ไทย' },
  ti: { en: 'Tigrinya', native: 'ትግርኛ' },
  tk: { en: 'Turkmen', native: 'Türkmençe' },
  tl: { en: 'Tagalog', native: 'Wikang Tagalog' },
  tn: { en: 'Tswana', native: 'Setswana' },
  to: { en: 'Tongan', native: 'faka Tonga' },
  tr: { en: 'Turkish', native: 'Türkçe' },
  ts: { en: 'Tsonga', native: 'Xitsonga' },
  tt: { en: 'Tatar', native: 'татар теле' },
  tw: { en: 'Twi', native: 'Twi' },
  ty: { en: 'Tahitian', native: 'Reo Tahiti' },
  ug: { en: 'Uyghur', native: 'ئۇيغۇرچە' },
  uk: { en: 'Ukrainian', native: 'Українська' },
  ur: { en: 'Urdu', native: 'اردو' },
  uz: { en: 'Uzbek', native: "O'zbekcha" },
  ve: { en: 'Venda', native: 'Tshivenḓa' },
  vi: { en: 'Vietnamese', native: 'Tiếng Việt' },
  vo: { en: 'Volapük', native: 'Volapük' },
  wa: { en: 'Walloon', native: 'walon' },
  wo: { en: 'Wolof', native: 'Wolof' },
  xh: { en: 'Xhosa', native: 'isiXhosa' },
  yi: { en: 'Yiddish', native: 'ייִדיש' },
  yo: { en: 'Yoruba', native: 'Yorùbá' },
  za: { en: 'Zhuang', native: 'Vahcuengh' },
  zh: { en: 'Chinese', native: '中文' },
  zu: { en: 'Zulu', native: 'isiZulu' },
  fil: { en: 'Filipino', native: 'Filipino' },
  'ar-EG': { en: 'Arabic (Egypt)', native: 'العربية (مصر)' },
  'ar-SA': { en: 'Arabic (Saudi Arabia)', native: 'العربية (السعودية)' },
  'bn-BD': { en: 'Bengali (Bangladesh)', native: 'বাংলা (বাংলাদেশ)' },
  'bn-IN': { en: 'Bengali (India)', native: 'বাংলা (ভারত)' },
  'bs-BA': { en: 'Bosnian (Bosnia & Herzegovina)', native: 'bosanski (Bosna i Hercegovina)' },
  'ca-ES': { en: 'Catalan (Spain)', native: 'català (Espanya)' },
  'de-AT': { en: 'German (Austria)', native: 'Deutsch (Österreich)' },
  'de-CH': { en: 'German (Switzerland)', native: 'Deutsch (Schweiz)' },
  'de-DE': { en: 'German (Germany)', native: 'Deutsch (Deutschland)' },
  'el-GR': { en: 'Greek (Greece)', native: 'Ελληνικά (Ελλάδα)' },
  'en-AU': { en: 'English (Australia)', native: 'English (Australia)' },
  'en-CA': { en: 'English (Canada)', native: 'English (Canada)' },
  'en-GB': { en: 'English (United Kingdom)', native: 'English (United Kingdom)' },
  'en-IE': { en: 'English (Ireland)', native: 'English (Ireland)' },
  'en-IN': { en: 'English (India)', native: 'English (India)' },
  'en-NZ': { en: 'English (New Zealand)', native: 'English (New Zealand)' },
  'en-US': { en: 'English (United States)', native: 'English (United States)' },
  'en-ZA': { en: 'English (South Africa)', native: 'English (South Africa)' },
  'es-AR': { en: 'Spanish (Argentina)', native: 'español (Argentina)' },
  'es-CL': { en: 'Spanish (Chile)', native: 'español (Chile)' },
  'es-CO': { en: 'Spanish (Colombia)', native: 'español (Colombia)' },
  'es-ES': { en: 'Spanish (Spain)', native: 'español (España)' },
  'es-MX': { en: 'Spanish (Mexico)', native: 'español (México)' },
  'es-PE': { en: 'Spanish (Peru)', native: 'español (Perú)' },
  'es-US': { en: 'Spanish (United States)', native: 'español (Estados Unidos)' },
  'fr-BE': { en: 'French (Belgium)', native: 'français (Belgique)' },
  'fr-CA': { en: 'French (Canada)', native: 'français (Canada)' },
  'fr-CH': { en: 'French (Switzerland)', native: 'français (Suisse)' },
  'fr-FR': { en: 'French (France)', native: 'français (France)' },
  'fr-LU': { en: 'French (Luxembourg)', native: 'français (Luxembourg)' },
  'hi-IN': { en: 'Hindi (India)', native: 'हिन्दी (भारत)' },
  'id-ID': { en: 'Indonesian (Indonesia)', native: 'Bahasa Indonesia (Indonesia)' },
  'it-CH': { en: 'Italian (Switzerland)', native: 'italiano (Svizzera)' },
  'it-IT': { en: 'Italian (Italy)', native: 'italiano (Italia)' },
  'ja-JP': { en: 'Japanese (Japan)', native: '日本語 (日本)' },
  'ko-KR': { en: 'Korean (South Korea)', native: '한국어 (대한민국)' },
  'ms-MY': { en: 'Malay (Malaysia)', native: 'Bahasa Melayu (Malaysia)' },
  'nl-BE': { en: 'Dutch (Belgium)', native: 'Nederlands (België)' },
  'nl-NL': { en: 'Dutch (Netherlands)', native: 'Nederlands (Nederland)' },
  'no-NO': { en: 'Norwegian (Norway)', native: 'norsk (Norge)' },
  'pl-PL': { en: 'Polish (Poland)', native: 'polski (Polska)' },
  'ru-RU': { en: 'Russian (Russia)', native: 'русский (Россия)' },
  'pt-AO': { en: 'Portuguese (Angola)', native: 'português (Angola)' },
  'pt-BR': { en: 'Portuguese (Brazil)', native: 'português (Brasil)' },
  'pt-PT': { en: 'Portuguese (Portugal)', native: 'português (Portugal)' },
  'ro-RO': { en: 'Romanian (Romania)', native: 'română (România)' },
  'sr-Cyrl-RS': { en: 'Serbian, Cyrillic (Serbia)', native: 'српски, ћирилица (Србија)' },
  'sr-Latn-RS': { en: 'Serbian, Latin (Serbia)', native: 'srpski, latinica (Srbija)' },
  'sw-KE': { en: 'Swahili (Kenya)', native: 'Kiswahili (Kenya)' },
  'sw-TZ': { en: 'Swahili (Tanzania)', native: 'Kiswahili (Tanzania)' },
  'uz-Cyrl-UZ': { en: 'Uzbek, Cyrillic (Uzbekistan)', native: 'ўзбекча, кирилл (Ўзбекистон)' },
  'uz-Latn-UZ': { en: "Uzbek, Latin (Uzbekistan)", native: "o'zbekcha, lotin (O'zbekiston)" },
  'zh-CN': { en: 'Chinese, Simplified (China)', native: '中文，简体 (中国)' },
  'zh-HK': { en: 'Chinese (Hong Kong)', native: '中文 (香港)' },
  'zh-SG': { en: 'Chinese, Simplified (Singapore)', native: '中文，简体 (新加坡)' },
  'zh-TW': { en: 'Chinese, Traditional (Taiwan)', native: '中文，繁體 (台灣)' },
};

/**
 * Best-effort runtime enhancement, layered OVER the static table above --
 * never trusted alone. Guards against the exact Hermes failure mode this
 * file exists to work around: an ICU-less `Intl.DisplayNames` that
 * implements the API surface but silently echoes the input code back
 * instead of throwing. Treating "gave back exactly what was asked" as "did
 * not resolve a name" makes that failure mode indistinguishable from a
 * thrown error, so both fall through to the caller's static fallback.
 */
function enhancedDisplayName(locale: string, displayLocale: string, type: 'language' | 'region' | 'script'): string | null {
  try {
    const result = new Intl.DisplayNames([displayLocale], { type }).of(locale);
    if (!result || result.trim().toLocaleLowerCase() === locale.trim().toLocaleLowerCase()) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Non-English display-locale variant of `englishLabel` -- nothing in the UI
 * currently reads this field, so it is a pure enhancement: real
 * `Intl.DisplayNames` output when the runtime actually supports it, the
 * static English label (never a bare code) otherwise.
 */
function localizedDisplayName(tag: string, displayLocale: string): string {
  if (displayLocale === 'en') return GALLERY_CAPTION_LOCALE_NAMES[tag]?.en ?? tag;
  const [language, scriptOrRegion, maybeRegion] = tag.split('-');
  const languageLabel = enhancedDisplayName(language, displayLocale, 'language');
  if (!languageLabel) return GALLERY_CAPTION_LOCALE_NAMES[tag]?.en ?? tag;
  const script = maybeRegion ? scriptOrRegion : undefined;
  const region = maybeRegion ?? (scriptOrRegion?.length === 2 || /^\d{3}$/.test(scriptOrRegion ?? '')
    ? scriptOrRegion
    : undefined);
  const qualifiers = [
    script ? enhancedDisplayName(script, displayLocale, 'script') ?? script : null,
    region ? enhancedDisplayName(region, displayLocale, 'region') ?? region : null,
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
    const names = GALLERY_CAPTION_LOCALE_NAMES[tag];
    const englishLabel = names?.en ?? tag;
    const nativeLabel = names?.native ?? tag;
    const localizedLabel = localizedDisplayName(tag, displayLocale);
    return {
      tag,
      englishLabel,
      localizedLabel,
      nativeLabel,
      searchText: `${tag} ${englishLabel} ${localizedLabel} ${nativeLabel}`.toLocaleLowerCase(),
    };
  });
}

/**
 * The picker's actual list -- `curatedGalleryCaptionLocaleTags` (see that
 * const's comment for the full compatibility guarantee). Callers that need
 * to resolve a specific already-saved tag (which may fall outside this
 * curated list) must use `getGalleryCaptionLocaleOptions()` instead; this
 * function is presentation-only.
 */
export function getCuratedGalleryCaptionLocaleOptions(
  displayLocale = 'en',
): GalleryCaptionLocaleOption[] {
  const curatedSet = new Set<string>(curatedGalleryCaptionLocaleTags);
  return getGalleryCaptionLocaleOptions(displayLocale).filter((option) => curatedSet.has(option.tag));
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

/**
 * Human-readable label for a locale row/summary -- native name prominent,
 * English label a parenthetical (e.g. "español (Spanish)"), collapsed to a
 * single label when the two are identical strings (English itself, or a
 * region spelled out the same way in both directories, e.g. "en-GB"). Never
 * surfaces the bare BCP-47 tag -- see docs/design/gallery-import/README.md's
 * "Caption language/instruction settings" clarification.
 *
 * Regional variants (tags with a `-`) use the English label alone: both
 * `nativeLabel` and `englishLabel` already embed their own region qualifier
 * in `GALLERY_CAPTION_LOCALE_NAMES` above, so combining them would double up
 * the parenthetical -- e.g. "português (Brasil) (Portuguese (Brazil))"
 * instead of the clear, unambiguous "Portuguese (Brazil)".
 */
export function formatGalleryCaptionLocaleLabel(option: GalleryCaptionLocaleOption): string {
  if (option.tag.includes('-')) {
    return option.englishLabel;
  }
  if (option.nativeLabel.trim().toLocaleLowerCase() === option.englishLabel.trim().toLocaleLowerCase()) {
    return option.englishLabel;
  }
  return `${option.nativeLabel} (${option.englishLabel})`;
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
