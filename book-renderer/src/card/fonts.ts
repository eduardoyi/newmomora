import type { FontSpec } from './textFit';

/**
 * The font families the card components set text in, injected so the web shop
 * can use aliased families (`MomoraCard Newsreader`, ...) that never collide
 * with the book pages' Google faces, while the print app keeps today's names
 * (the default) and so its output is untouched.
 *
 * `CardFontFamilies` maps each logical face (the `FontSpec` families the fit
 * measures with) to the CSS family NAME registered in the page. The same map
 * drives both the canvas measuring (`measure.ts`) and the rendered CSS stacks
 * (`CardFront`/`CardBack`), so what is measured is what is drawn.
 */
export type CardFontFamilies = Record<FontSpec['family'], string>;

/** Today's names: what `fonts.css` declares and the print app uses. */
export const DEFAULT_CARD_FONTS: CardFontFamilies = {
  Newsreader: 'Newsreader',
  'Plus Jakarta Sans': 'Plus Jakarta Sans',
  Caveat: 'Caveat',
};

export interface CardFontStacks {
  serif: string;
  sans: string;
  script: string;
}

/** CSS `font-family` values (with the same fallbacks the components always had). */
export function cardFontStacks(families: CardFontFamilies = DEFAULT_CARD_FONTS): CardFontStacks {
  return {
    serif: `'${families.Newsreader}', Georgia, serif`,
    sans: `'${families['Plus Jakarta Sans']}', -apple-system, sans-serif`,
    script: `'${families.Caveat}', cursive`,
  };
}
