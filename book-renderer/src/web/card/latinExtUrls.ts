import { faceKey } from '../../print/fonts/faceUrls';
import type { ExpectedFace } from '../../print/fonts/expectedFaces';

/**
 * The `latin-ext` subset of each vendored print face. The print page declares BOTH subsets in `fonts.css` (the browser picks per character via
 * `unicode-range`); the shop loads faces from JS, so it registers both too, otherwise a rare character (a Polish or Turkish name, say) would
 * fall back to a system font in the editor but not in the PDF. `new URL(literal, import.meta.url)` must stay literal for Vite to find and hash the file.
 */
const ENTRIES: Array<[ExpectedFace, string]> = [
  [{ family: 'Newsreader', weight: 300, style: 'normal' }, new URL('../../print/fonts/Newsreader-300-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 400, style: 'normal' }, new URL('../../print/fonts/Newsreader-400-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 500, style: 'normal' }, new URL('../../print/fonts/Newsreader-500-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 600, style: 'normal' }, new URL('../../print/fonts/Newsreader-600-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 300, style: 'italic' }, new URL('../../print/fonts/Newsreader-300Italic-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 400, style: 'italic' }, new URL('../../print/fonts/Newsreader-400Italic-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Newsreader', weight: 500, style: 'italic' }, new URL('../../print/fonts/Newsreader-500Italic-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 400, style: 'normal' }, new URL('../../print/fonts/PlusJakartaSans-400-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 500, style: 'normal' }, new URL('../../print/fonts/PlusJakartaSans-500-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 600, style: 'normal' }, new URL('../../print/fonts/PlusJakartaSans-600-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Plus Jakarta Sans', weight: 700, style: 'normal' }, new URL('../../print/fonts/PlusJakartaSans-700-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 400, style: 'normal' }, new URL('../../print/fonts/Caveat-400-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 500, style: 'normal' }, new URL('../../print/fonts/Caveat-500-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 600, style: 'normal' }, new URL('../../print/fonts/Caveat-600-latin-ext.woff2', import.meta.url).href],
  [{ family: 'Caveat', weight: 700, style: 'normal' }, new URL('../../print/fonts/Caveat-700-latin-ext.woff2', import.meta.url).href],
];

export const LATIN_EXT_FACE_URLS: ReadonlyMap<string, string> = new Map(ENTRIES.map(([face, url]) => [faceKey(face), url]));
