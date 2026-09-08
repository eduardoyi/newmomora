import type { ExpectedFace } from './expectedFaces';

/**
 * The built (Vite-hashed) URL of ONE representative vendored file per
 * expected face — the `latin` subset woff2 (see `fonts.css`; `latin-ext`
 * exists too but is produced by the exact same build step, so proving
 * `latin` loads is enough evidence the vendoring itself didn't break).
 * `new URL('./file.woff2', import.meta.url)` is Vite's documented static-
 * analysis pattern for asset URLs: each literal must stay a literal (no
 * template/variable path) for Vite to find, hash, and copy the file into
 * the build — that's why this is 15 explicit entries rather than a
 * computed loop.
 *
 * Used by `expectedFaces.ts`'s `assertPrintFontsLoaded` to EXPLICITLY
 * construct + load a `FontFace` per expected combo, rather than relying on
 * the CSS `@font-face` rules in `fonts.css` ever getting lazily triggered.
 * That distinction matters: a browser only starts loading a CSS-declared
 * `@font-face` once something on the PAINTED page actually renders text in
 * that exact (family, weight, style) — and any single print page/half/cover
 * only ever uses a handful of the 15 vendored combos, never all of them. A
 * `document.fonts.check()` sweep run against a single page's DOM would
 * therefore report most combos as "not loaded" even when vendoring is
 * completely healthy — a false positive this module avoids by loading every
 * combo itself, unconditionally, independent of what the current page uses.
 */
const FACE_URL_ENTRIES: Array<[ExpectedFace, string]> = [
  [{ family: 'Newsreader', weight: 300, style: 'normal' }, new URL('./Newsreader-300-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 400, style: 'normal' }, new URL('./Newsreader-400-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 500, style: 'normal' }, new URL('./Newsreader-500-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 600, style: 'normal' }, new URL('./Newsreader-600-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 300, style: 'italic' }, new URL('./Newsreader-300Italic-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 400, style: 'italic' }, new URL('./Newsreader-400Italic-latin.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 500, style: 'italic' }, new URL('./Newsreader-500Italic-latin.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 400, style: 'normal' }, new URL('./PlusJakartaSans-400-latin.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 500, style: 'normal' }, new URL('./PlusJakartaSans-500-latin.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 600, style: 'normal' }, new URL('./PlusJakartaSans-600-latin.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 700, style: 'normal' }, new URL('./PlusJakartaSans-700-latin.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 400, style: 'normal' }, new URL('./Caveat-400-latin.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 500, style: 'normal' }, new URL('./Caveat-500-latin.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 600, style: 'normal' }, new URL('./Caveat-600-latin.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 700, style: 'normal' }, new URL('./Caveat-700-latin.woff2', import.meta.url).href],
];

export function faceKey(face: ExpectedFace): string {
  return `${face.family}|${face.weight}|${face.style}`;
}

export const FACE_URLS: ReadonlyMap<string, string> = new Map(FACE_URL_ENTRIES.map(([face, url]) => [faceKey(face), url]));
