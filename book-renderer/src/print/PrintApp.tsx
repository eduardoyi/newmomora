import { useEffect, useMemo, useState } from 'react';
import { parseManifest, parseOutline, setAssetUrlProvider } from '../model/loader';
import { fitBook } from '../model/fitter';
import { applyPostFit, applyPreFit } from '../model/edits';
import { PHYSICAL } from '../model/types';
import type { BookManifest, BookPage } from '../model/types';
import { TemplateRenderer } from '../templates';
import { FULL_PAGE_MM, SPREAD_WIDTH_MM, SPREAD_HEIGHT_MM } from '../templates/mm';
import { normalizeEditsShapeForClient } from '../web/book/normalizeEdits';
import { assertPrintFontsLoaded } from './fonts/expectedFaces';

/**
 * The print pipeline's one-page-per-load renderer (scripts/render-pdf.mts
 * drives Puppeteer over this, once per physical PDF page). Same architecture
 * promise as the preview: `TemplateRenderer` is the SAME component tree the
 * interactive preview (`src/preview/App.tsx`) uses — this file only adds the
 * exact-physical-size scaffolding a PDF capture needs (a `@page` CSS rule +
 * a matching html/body box, plus a crop-to-trim window) on top of it. It
 * never re-implements layout.
 *
 * Round-22 (Prodigi's real layflat file spec, per the downloaded print
 * guide — docs/plans/prodigi-order-spec.md): Prodigi's system "automatically
 * generate[s]" bleed and cut marks on its own end — a submitted content page
 * "should be the same size as the book size" (210x210mm trim, NO bleed), and
 * the wraparound cover file is `2*210 + spineMm` wide, also with no bleed.
 * The templates/design-canvas model is untouched (every template still
 * renders its own natural 216mm-bleed single-page canvas, 426mm-bleed spread
 * canvas, or bleed-inclusive cover canvas — see templates/mm.ts) — this file
 * is the ONE place that then CROPS that natural render down to the exact
 * trim box Prodigi wants, by rendering the template at its natural size
 * inside an absolutely-positioned box shifted up/left by exactly the bleed
 * amount, inside an `overflow: hidden` window sized to the trim box. A
 * spread's two halves each crop to their own 210x210mm trim (no bleed
 * anywhere, including the outer edge that used to carry it) — same idea,
 * just also picking which half of the spread's natural width to show.
 *
 * URL contract (query string), read once at mount:
 *   ?slug=<bookSlug>                       required in SLUG mode (mutually exclusive with `attempt`)
 *   &attempt=<attemptId>                   required in ATTEMPT mode (mutually exclusive with `slug`) —
 *                                           see "Data source modes" below
 *   &kind=page|cover                       default "page"
 *   &pageIndex=<n>                         required when kind=page — index into fitBook's `document.pages`
 *   &half=left|right                       required when the targeted page is a spread (isSpread), ignored otherwise
 *   &spineMm=<n>                           optional — forwarded to fitBook's FitOptions.spineMm (cover width)
 *
 * Data source modes (memory-book-5c plan, Step 2a):
 *   SLUG mode (`?slug=<bookSlug>`, the original/default mode): fetches
 *   `/${slug}/manifest.json` and `/${slug}/book.outline.json` (served as
 *   static files — see vite.config.ts's `publicDir: 'book-data'`). No edits
 *   are fetched — `edits` is always `{}` in this mode. Every asset URL
 *   resolves via `loader.ts`'s default `staticAssetUrl` (`/${slug}/${file}`).
 *
 *   ATTEMPT mode (`?attempt=<attemptId>`, new): fetches
 *   `/attempt/<attemptId>/manifest.json`, `/attempt/<attemptId>/outline.json`,
 *   and `/attempt/<attemptId>/edits.json` instead — the memory-book-5c plan's
 *   render worker (Decision 3, a separate step) serves these three from the
 *   in-flight render request's own payload, on a loopback-only listener; a
 *   plain vite static-file stub (fixtures under `book-data/attempt/<id>/`)
 *   works identically for local/CI verification, since both are just static
 *   JSON GETs relative to the served origin. `edits.json` is parsed with the
 *   same `normalizeEditsShapeForClient` the web preview uses, so a missing/
 *   malformed category degrades to "no edits of that kind" rather than
 *   throwing. Asset URLs use `attemptAssetUrl` (below): a `file` that is
 *   already an absolute `http(s)://` URL (the render worker's own R2
 *   presigned GET — Decision 3's "existing setAssetUrlProvider pattern
 *   covers image URLs") passes through unchanged; anything else resolves
 *   relative to `/attempt/<attemptId>/<file>` (mirrors `staticAssetUrl`'s
 *   shape, and is what a local static-file stub serves fixture assets at).
 *
 *   Both modes run the IDENTICAL edits chain — `applyPreFit` (image
 *   substitution) before `fitBook`, `applyPostFit` (text/focal-point) after
 *   — mirroring `src/web/book/useEditableBook.ts`'s `buildDocument` order
 *   exactly. In slug mode `edits` is always `{}`, so both stages are pure
 *   deep-clone no-ops and the fitted output is byte-identical to the
 *   pre-edits-chain pipeline (proven by the print raster regression
 *   instrument on an unedited book — see the plan's Step 2a verification).
 *
 * Readiness contract the render script polls for:
 *   - success: an element matching `[data-print-ready="true"]` exists once
 *     the target page/half is resolved, sized, mounted, AND (Step 2b) every
 *     vendored print font has been explicitly loaded and confirmed
 *     (`assertPrintFontsLoaded` — see `fonts/expectedFaces.ts`; it force-
 *     loads each expected face via the `FontFace` API rather than relying
 *     on the page's own content to lazily trigger `@font-face` loading, so
 *     it can safely run BEFORE the target content ever mounts, no phase
 *     ordering needed). The script still separately awaits
 *     `document.fonts.ready` and every `<img>`'s decode before capturing —
 *     this flag only proves the RIGHT content, fonts included, is in the DOM.
 *   - failure: an element matching `[data-print-error]` (the error message) when
 *     the slug/attempt/page/kind combination couldn't be resolved, OR a
 *     vendored font failed to load — the script must treat this as a hard
 *     failure, never capture it as a blank/error page.
 */

interface PrintTarget {
  page: BookPage;
  manifest: BookManifest;
  /**
   * Final PDF page box (mm) — the `@page` rule, the html/body box, and the
   * outer crop window all use this. Always the TRIM size (no bleed): Prodigi
   * adds bleed/cut-marks itself, so shipping bleed here is exactly the
   * "216x216 instead of 210x210" mistake that got the first order rejected.
   */
  outputWidthMm: number;
  outputHeightMm: number;
  /**
   * The template's own natural (bleed-inclusive) rendered size — UNCHANGED
   * design/canvas model (FULL_PAGE_MM/SPREAD_WIDTH_MM/SPREAD_HEIGHT_MM, or
   * the cover's own back+spine+front+bleed box). The inner div is sized to
   * exactly this so every cqw-based measurement inside the template computes
   * against the same width it always has.
   */
  naturalWidthMm: number;
  naturalHeightMm: number;
  /**
   * How far (mm) the natural canvas's own top-left corner sits outside the
   * output crop window on each axis — i.e. how much bleed (or, for a
   * spread's right half, bleed + one whole trim page) to hide. The inner div
   * is shifted by `-cropLeftMm`/`-cropTopMm` so the window shows exactly the
   * trim box.
   */
  cropLeftMm: number;
  cropTopMm: number;
  /** Set only when rendering one printable half of a genuine spread template — see `SpreadHalf` below. */
  half: 'left' | 'right' | null;
}

type LoadState = { status: 'loading' } | { status: 'ready'; target: PrintTarget } | { status: 'error'; message: string };

function readParams() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug');
  const attempt = params.get('attempt');
  const kind = (params.get('kind') ?? 'page') as 'page' | 'cover';
  const pageIndexRaw = params.get('pageIndex');
  const pageIndex = pageIndexRaw !== null ? Number(pageIndexRaw) : null;
  const half = params.get('half') as 'left' | 'right' | null;
  const spineMmRaw = params.get('spineMm');
  const spineMm = spineMmRaw !== null ? Number(spineMmRaw) : undefined;
  return { slug, attempt, kind, pageIndex, half, spineMm };
}

/** ATTEMPT mode's asset resolution (see this file's header comment,
 * "Data source modes"): an already-absolute URL (the future render worker's
 * own R2 presigned GET) passes through unchanged; anything else — an R2
 * object key, e.g. `assets/photo.jpg` — resolves relative to this attempt's
 * own data prefix, mirroring `loader.ts`'s `staticAssetUrl` shape. */
export function attemptAssetUrl(attemptId: string, file: string): string {
  if (/^https?:\/\//i.test(file)) return file;
  return `/attempt/${attemptId}/${file}`;
}

function fetchJson(url: string, label: string): Promise<unknown> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${label} fetch failed: ${r.status}`);
    return r.json();
  });
}

/** Every submitted content page (single or one spread half) is exactly the book's trim size — no bleed (round-22: Prodigi generates bleed/cut-marks itself). */
const TRIM_MM = PHYSICAL.pageSizeMm;
/** Bleed hidden off each edge of the template's natural canvas to reach the trim box. */
const BLEED_MM = PHYSICAL.bleedMm;

export function PrintApp() {
  const { slug, attempt, kind, pageIndex, half, spineMm } = useMemo(readParams, []);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // The identity threaded through as `TemplateProps.bookSlug` (only ever
  // used as `assetUrl`'s first arg — see loader.ts's `AssetUrlProvider`
  // type). ATTEMPT mode's provider (`attemptAssetUrl`) ignores it, but a
  // real string keeps the prop type honest either way.
  const bookSlug = slug ?? attempt ?? '';

  useEffect(() => {
    if (!slug && !attempt) {
      setState({ status: 'error', message: 'missing required query param: slug or attempt' });
      return;
    }
    if (slug && attempt) {
      setState({ status: 'error', message: 'slug and attempt are mutually exclusive query params' });
      return;
    }
    let cancelled = false;

    // Data source modes — see this file's header comment ("Data source
    // modes"). SLUG mode fetches the book's static export files and never
    // fetches edits (`edits` stays `{}`); ATTEMPT mode fetches all three
    // from this attempt's own data prefix.
    const dataPromise = attempt
      ? Promise.all([
          fetchJson(`/attempt/${attempt}/manifest.json`, 'manifest.json'),
          fetchJson(`/attempt/${attempt}/outline.json`, 'outline.json'),
          fetchJson(`/attempt/${attempt}/edits.json`, 'edits.json'),
        ])
      : Promise.all([
          fetchJson(`/${slug}/manifest.json`, 'manifest.json'),
          fetchJson(`/${slug}/book.outline.json`, 'book.outline.json'),
          Promise.resolve({}),
        ]);

    dataPromise
      .then(async ([manifestRaw, outlineRaw, editsRaw]) => {
        if (cancelled) return;
        const manifest = parseManifest(manifestRaw);
        const outline = parseOutline(outlineRaw);
        const edits = normalizeEditsShapeForClient(editsRaw);

        if (attempt) {
          setAssetUrlProvider((_bookSlug, file) => attemptAssetUrl(attempt, file));
        }

        // The edits chain (memory-book-5c plan, Step 2a) — mirrors
        // useEditableBook.ts's `buildDocument` order EXACTLY: applyPreFit
        // (image substitution, manifest/outline) before fitBook,
        // applyPostFit (text/focal-point, the fitted document) after. In
        // slug mode `edits` is always `{}`, so both stages are pure
        // deep-clone no-ops — the fitted output stays byte-identical to
        // the pre-edits-chain pipeline.
        //
        // Same fitBook call the preview makes (useBookData.ts) — the ONE
        // deterministic source of the document, computed identically here.
        // spineMm is forwarded so a caller sweeping cover renders at a
        // real Prodigi-quoted spine width gets a cover-wrap page whose
        // `params.spineMm` (and therefore this file's own cover box size)
        // actually reflects it.
        const pre = applyPreFit(outline, manifest, edits);
        const fit = fitBook(pre.outline, pre.manifest, spineMm !== undefined ? { spineMm } : {});
        const post = applyPostFit(fit.document, edits);
        // Rendered against the POST-applyPreFit manifest (`pre.manifest`),
        // same as the web preview (`useEditableBook.ts`'s `editedManifest`)
        // — an image-replace/cover edit substitutes directly into the
        // manifest's asset entries, and the fitted `page.slots[].content`
        // values (assetFile, etc.) are only meaningful against that edited
        // manifest, not the pristine one.
        const editedManifest = pre.manifest;
        const pages = post.document.pages;

        let page: BookPage | undefined;
        if (kind === 'cover') {
          page = pages.find((p) => p.templateId === 'cover-wrap');
          if (!page) throw new Error('no cover-wrap page in this book’s fitted document');
        } else {
          if (pageIndex === null || !Number.isInteger(pageIndex)) {
            throw new Error('missing/invalid required query param for kind=page: pageIndex');
          }
          page = pages[pageIndex];
          if (!page) throw new Error(`pageIndex ${pageIndex} out of range (document has ${pages.length} pages)`);
          if (page.templateId === 'cover-wrap') {
            throw new Error(`pageIndex ${pageIndex} is the cover-wrap page — request it with kind=cover instead`);
          }
        }

        // Every kind below is resolved to the SAME shape: the template's own
        // natural (bleed-inclusive) canvas size, unchanged, plus a crop
        // (outputWidthMm/outputHeightMm + cropLeftMm/cropTopMm) that hides
        // exactly the bleed Prodigi doesn't want submitted. cropTopMm is
        // always BLEED_MM (every canvas has the same top bleed); cropLeftMm
        // is BLEED_MM too, except for a spread's right half, which must skip
        // past the left half's whole trim width first.
        let naturalWidthMm: number;
        let naturalHeightMm: number;
        let outputWidthMm: number;
        let outputHeightMm: number;
        let cropLeftMm: number = BLEED_MM;
        const cropTopMm: number = BLEED_MM;
        let resolvedHalf: 'left' | 'right' | null = null;

        if (kind === 'cover') {
          const spineMmResolved = Number((page.params as { spineMm?: number }).spineMm ?? 0);
          naturalWidthMm = PHYSICAL.pageSizeMm * 2 + spineMmResolved + PHYSICAL.bleedMm * 2;
          naturalHeightMm = PHYSICAL.pageSizeMm + PHYSICAL.bleedMm * 2;
          outputWidthMm = naturalWidthMm - PHYSICAL.bleedMm * 2; // = 2*210 + spineMm, no bleed
          outputHeightMm = naturalHeightMm - PHYSICAL.bleedMm * 2; // = 210
        } else if (page.isSpread) {
          if (half !== 'left' && half !== 'right') {
            throw new Error(`page ${pageIndex} (${page.templateId}) is a spread — half=left|right is required`);
          }
          resolvedHalf = half;
          naturalWidthMm = SPREAD_WIDTH_MM;
          naturalHeightMm = SPREAD_HEIGHT_MM;
          outputWidthMm = TRIM_MM;
          outputHeightMm = TRIM_MM;
          // Left half's trim starts right after the left bleed (BLEED_MM);
          // right half's trim starts one whole trim page further in (past
          // the left half entirely — there's no bleed at the gutter to skip).
          cropLeftMm = half === 'right' ? BLEED_MM + TRIM_MM : BLEED_MM;
        } else {
          naturalWidthMm = FULL_PAGE_MM;
          naturalHeightMm = FULL_PAGE_MM;
          outputWidthMm = TRIM_MM;
          outputHeightMm = TRIM_MM;
        }

        // Step 2b hard-fail check: confirm every vendored print font is
        // actually loadable BEFORE ever exposing `data-print-ready` — see
        // `fonts/expectedFaces.ts`'s own doc comment for why this is an
        // explicit `FontFace` load rather than a `document.fonts.check()`
        // sweep (the latter false-positives on any face the CURRENT page
        // doesn't personally render text in). A failure here throws, caught
        // by this same `.then()`'s surrounding `.catch()` below, same as
        // any other resolution failure.
        await assertPrintFontsLoaded();
        if (cancelled) return;

        setState({
          status: 'ready',
          target: { page: page!, manifest: editedManifest, outputWidthMm, outputHeightMm, naturalWidthMm, naturalHeightMm, cropLeftMm, cropTopMm, half: resolvedHalf },
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      });

    return () => {
      cancelled = true;
      // Module-level provider state (loader.ts's `setAssetUrlProvider`) —
      // reset on unmount so a later slug-mode render (or a test re-mount)
      // never inherits a stale attempt-mode provider.
      if (attempt) setAssetUrlProvider(null);
    };
    // Query params are read once at mount (readParams uses useMemo with no
    // deps) — this print entry is loaded fresh per Puppeteer navigation, it
    // never needs to react to a URL change after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Physical-size scaffolding: a `@page` rule (what Puppeteer's
  // `page.pdf({ preferCSSPageSize: true })` reads for the output page box)
  // plus a matching html/body box, injected only once the target's exact
  // mm dimensions are known.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const { outputWidthMm, outputHeightMm } = state.target;
    const style = document.createElement('style');
    style.textContent = `
      @page { size: ${outputWidthMm}mm ${outputHeightMm}mm; margin: 0; }
      html, body {
        margin: 0; padding: 0;
        width: ${outputWidthMm}mm; height: ${outputHeightMm}mm;
        overflow: hidden;
        background: #fff;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, [state]);

  if (state.status === 'error') {
    return <div data-print-error={state.message}>{state.message}</div>;
  }
  if (state.status === 'loading') {
    return <div data-print-loading="true" />;
  }

  const { page, manifest, outputWidthMm, outputHeightMm, naturalWidthMm, naturalHeightMm, cropLeftMm, cropTopMm } = state.target;

  // One crop window for every kind (single page, spread half, cover): the
  // template renders itself at its own natural (bleed-inclusive) size —
  // unchanged, since everything inside it (cqw type sizes, the gutter guide,
  // slot positions, the wraparound cover's own xPct/yPct math) is computed
  // relative to THAT natural width via PageFrame's own container-query
  // sizing (see mm.ts's `mmToPctWidth`/`ptCqw` and WraparoundCover's
  // `explicitDimsMm`) — re-rendering at the trim width directly would
  // silently rescale every one of those measurements. Instead, the natural
  // render is positioned inside an `overflow: hidden` window sized to the
  // exact trim box, shifted up/left by exactly the bleed being hidden (plus,
  // for a spread's right half, one whole trim page to skip past the left
  // half). Both boxes get EXPLICIT width AND height — a known Chromium
  // print-capture bug class silently mis-sizes an absolutely-positioned box
  // that only has one dimension set explicitly.
  const content = (
    <div style={{ position: 'relative', width: `${outputWidthMm}mm`, height: `${outputHeightMm}mm`, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: `-${cropLeftMm}mm`,
          top: `-${cropTopMm}mm`,
          width: `${naturalWidthMm}mm`,
          height: `${naturalHeightMm}mm`,
        }}
      >
        <TemplateRenderer page={page} manifest={manifest} bookSlug={bookSlug} showGuides={false} />
      </div>
    </div>
  );

  return (
    <div data-print-ready="true" data-print-template={page.templateId} data-print-page-id={page.id}>
      {content}
    </div>
  );
}
