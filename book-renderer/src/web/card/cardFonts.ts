import { DEFAULT_CARD_FONTS, type CardFontFamilies } from '../../card/fonts';
import { EXPECTED_PRINT_FACES, type ExpectedFace } from '../../print/fonts/expectedFaces';
import { faceKey, FACE_URLS } from '../../print/fonts/faceUrls';
import { LATIN_EXT_FACE_URLS } from './latinExtUrls';

/**
 * The card editor's fonts, registered under ALIASED families so they can never
 * collide with (or be shadowed by) the Google Fonts faces `web.html` loads for
 * the book pages: the shop passes `SHOP_CARD_FONTS` to the card measure and
 * components, and this loader registers exactly those names from the vendored
 * print files (the same files the printed card uses, so the editor and the PDF
 * share glyphs). Nothing here touches `document.fonts` entries it did not add.
 */

export const SHOP_CARD_FONTS: CardFontFamilies = {
  Newsreader: 'MomoraCard Newsreader',
  'Plus Jakarta Sans': 'MomoraCard Plus Jakarta Sans',
  Caveat: 'MomoraCard Caveat',
};

/** The `unicode-range`s `src/print/fonts/fonts.css` declares for the two subsets (kept identical so the editor and the PDF pick the same face per character). */
export const UNICODE_RANGE = {
  latin:
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext':
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
} as const;

export type FontSubset = keyof typeof UNICODE_RANGE;

export interface CardFaceDescriptor {
  subset: FontSubset;
  unicodeRange: string;
  /** The aliased family the face is registered under. */
  family: string;
  weight: ExpectedFace['weight'];
  style: ExpectedFace['style'];
  url: string;
}

/** Every face to register: each vendored print face in both subsets (latin + latin-ext), renamed through `families`. Throws if a vendored URL is missing. */
export function cardFaceDescriptors(families: CardFontFamilies = SHOP_CARD_FONTS): CardFaceDescriptor[] {
  const subsets: Array<[FontSubset, ReadonlyMap<string, string>]> = [
    ['latin', FACE_URLS],
    ['latin-ext', LATIN_EXT_FACE_URLS],
  ];
  return subsets.flatMap(([subset, urls]) =>
    EXPECTED_PRINT_FACES.map((face) => {
      const url = urls.get(faceKey(face));
      if (!url) throw new Error(`no vendored ${subset} URL for ${faceKey(face)}`);
      return { subset, unicodeRange: UNICODE_RANGE[subset], family: families[face.family], weight: face.weight, style: face.style, url };
    }),
  );
}

/** True when `families` renames every print default (so nothing it registers can shadow a book page face). */
export function isAliasedFamilySet(families: CardFontFamilies): boolean {
  return (Object.keys(DEFAULT_CARD_FONTS) as (keyof CardFontFamilies)[]).every((k) => families[k] !== DEFAULT_CARD_FONTS[k]);
}

let loading: Promise<void> | null = null;

/** Registers and loads every aliased face (once; a failure clears the memo so a retry can try again). */
export function registerCardFonts(families: CardFontFamilies = SHOP_CARD_FONTS): Promise<void> {
  if (!isAliasedFamilySet(families)) return Promise.reject(new Error('registerCardFonts needs aliased families'));
  if (!loading) {
    loading = (async () => {
      const faces = cardFaceDescriptors(families);
      const results = await Promise.allSettled(
        faces.map(async (face) => {
          const fontFace = new FontFace(face.family, `url(${face.url})`, { weight: String(face.weight), style: face.style, unicodeRange: face.unicodeRange });
          document.fonts.add(await fontFace.load());
        }),
      );
      const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${faces[i].family} ${faces[i].weight}${faces[i].style === 'italic' ? ' italic' : ''} ${faces[i].subset}`] : []));
      if (failed.length > 0) throw new Error(`card fonts failed to load: ${failed.join(', ')}`);
      // The canvas measure path needs the exact faces resolved too.
      await Promise.all(faces.map((f) => document.fonts.load(`${f.style} ${f.weight} 20px "${f.family}"`, 'Aa Ññ¡ Łą')));
    })().catch((e: unknown) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}
