/**
 * The exact set of vendored print faces (memory-book-5c plan, Step 2b) —
 * single source of truth shared by `fonts.css` (which declares an
 * `@font-face` for each) and `assertPrintFontsLoaded` (which hard-fails the
 * render if any of them didn't actually load). Mirrors `theme.ts`'s
 * `fonts.display`/`displayItalic`/`script` usage exactly: Newsreader normal
 * 300-600 + italic 300-500, Plus Jakarta Sans 400-700, Caveat 400-700 — the
 * same family/weight/style set `index.html`/`print.html`/`web.html`'s
 * Google Fonts CDN `<link>` requests today (see each file's own tag).
 */

import { faceKey, FACE_URLS } from './faceUrls';

export interface ExpectedFace {
  family: 'Newsreader' | 'Plus Jakarta Sans' | 'Caveat';
  weight: 300 | 400 | 500 | 600 | 700;
  style: 'normal' | 'italic';
}

export const EXPECTED_PRINT_FACES: readonly ExpectedFace[] = [
  { family: 'Newsreader', weight: 300, style: 'normal' },
  { family: 'Newsreader', weight: 400, style: 'normal' },
  { family: 'Newsreader', weight: 500, style: 'normal' },
  { family: 'Newsreader', weight: 600, style: 'normal' },
  { family: 'Newsreader', weight: 300, style: 'italic' },
  { family: 'Newsreader', weight: 400, style: 'italic' },
  { family: 'Newsreader', weight: 500, style: 'italic' },
  { family: 'Plus Jakarta Sans', weight: 400, style: 'normal' },
  { family: 'Plus Jakarta Sans', weight: 500, style: 'normal' },
  { family: 'Plus Jakarta Sans', weight: 600, style: 'normal' },
  { family: 'Plus Jakarta Sans', weight: 700, style: 'normal' },
  { family: 'Caveat', weight: 400, style: 'normal' },
  { family: 'Caveat', weight: 500, style: 'normal' },
  { family: 'Caveat', weight: 600, style: 'normal' },
  { family: 'Caveat', weight: 700, style: 'normal' },
];

/**
 * Hard-fail check (Step 2b): EXPLICITLY constructs + loads a `FontFace` per
 * expected combo (via `faceUrls.ts`'s Vite-hashed URLs) and adds each
 * successfully-loaded one to `document.fonts`, rather than relying on the
 * CSS `@font-face` rules in `fonts.css` (declarative, LAZY) ever getting
 * triggered. That distinction is load-bearing, not stylistic: a browser
 * only starts loading a CSS-declared `@font-face` once something on the
 * PAINTED page actually renders text in that exact (family, weight, style)
 * — and any single print page/half/cover only ever uses a handful of the
 * 15 vendored combos. An earlier version of this check used
 * `document.fonts.ready` + `document.fonts.check()` against whatever the
 * current page happened to render, which produced false-positive failures
 * for every combo the page didn't personally use (caught rendering
 * `enzo-year-three` page 4, which uses neither Newsreader 500/600 nor
 * Caveat at all). Explicit `FontFace.load()` per combo has no such
 * dependency on page content — it's a direct, deterministic proof the
 * vendored file exists, is reachable, and decodes as a valid font, in
 * EVERY print render regardless of which faces that particular page uses.
 *
 * Safe to call independent of DOM/content mount order (no lazy-loading
 * race to sequence around) — `PrintApp.tsx` awaits this once, as part of
 * building the document, before ever exposing `data-print-ready`.
 */
export async function assertPrintFontsLoaded(): Promise<void> {
  const results = await Promise.allSettled(
    EXPECTED_PRINT_FACES.map(async (face) => {
      const url = FACE_URLS.get(faceKey(face));
      if (!url) throw new Error(`no vendored URL registered for ${faceKey(face)} — faceUrls.ts and EXPECTED_PRINT_FACES have drifted`);
      const fontFace = new FontFace(face.family, `url(${url})`, { weight: String(face.weight), style: face.style });
      const loaded = await fontFace.load();
      document.fonts.add(loaded);
    }),
  );

  const missing = results
    .map((result, i) => (result.status === 'rejected' ? EXPECTED_PRINT_FACES[i] : null))
    .filter((face): face is ExpectedFace => face !== null);
  if (missing.length > 0) {
    const desc = missing.map((f) => `${f.family} ${f.weight}${f.style === 'italic' ? ' italic' : ''}`).join(', ');
    throw new Error(`print fonts failed to load (vendored files missing/broken): ${desc}`);
  }
}
