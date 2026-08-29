import { useEffect, useMemo, useState } from 'react';
import { parseManifest, parseOutline } from '../model/loader';
import { fitBook } from '../model/fitter';
import { PHYSICAL } from '../model/types';
import type { BookManifest, BookPage } from '../model/types';
import { TemplateRenderer } from '../templates';
import { FULL_PAGE_MM, SPREAD_WIDTH_MM, SPREAD_HEIGHT_MM } from '../templates/mm';

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
 *   ?slug=<bookSlug>                       required
 *   &kind=page|cover                       default "page"
 *   &pageIndex=<n>                         required when kind=page — index into fitBook's `document.pages`
 *   &half=left|right                       required when the targeted page is a spread (isSpread), ignored otherwise
 *   &spineMm=<n>                           optional — forwarded to fitBook's FitOptions.spineMm (cover width)
 *
 * Readiness contract the render script polls for:
 *   - success: an element matching `[data-print-ready="true"]` exists once
 *     the target page/half is resolved, sized, and mounted. The script still
 *     separately awaits `document.fonts.ready` and every `<img>`'s decode
 *     before capturing — this flag only proves the RIGHT content is in the DOM.
 *   - failure: an element matching `[data-print-error]` (the error message) when
 *     the slug/page/kind combination couldn't be resolved — the script must
 *     treat this as a hard failure, never capture it as a blank/error page.
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
  const kind = (params.get('kind') ?? 'page') as 'page' | 'cover';
  const pageIndexRaw = params.get('pageIndex');
  const pageIndex = pageIndexRaw !== null ? Number(pageIndexRaw) : null;
  const half = params.get('half') as 'left' | 'right' | null;
  const spineMmRaw = params.get('spineMm');
  const spineMm = spineMmRaw !== null ? Number(spineMmRaw) : undefined;
  return { slug, kind, pageIndex, half, spineMm };
}

/** Every submitted content page (single or one spread half) is exactly the book's trim size — no bleed (round-22: Prodigi generates bleed/cut-marks itself). */
const TRIM_MM = PHYSICAL.pageSizeMm;
/** Bleed hidden off each edge of the template's natural canvas to reach the trim box. */
const BLEED_MM = PHYSICAL.bleedMm;

export function PrintApp() {
  const { slug, kind, pageIndex, half, spineMm } = useMemo(readParams, []);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    if (!slug) {
      setState({ status: 'error', message: 'missing required query param: slug' });
      return;
    }
    let cancelled = false;

    Promise.all([
      fetch(`/${slug}/manifest.json`).then((r) => {
        if (!r.ok) throw new Error(`manifest.json fetch failed: ${r.status}`);
        return r.json();
      }),
      fetch(`/${slug}/book.outline.json`).then((r) => {
        if (!r.ok) throw new Error(`book.outline.json fetch failed: ${r.status}`);
        return r.json();
      }),
    ])
      .then(([manifestRaw, outlineRaw]) => {
        if (cancelled) return;
        const manifest = parseManifest(manifestRaw);
        const outline = parseOutline(outlineRaw);
        // Same fitBook call the preview makes (useBookData.ts) — the ONE
        // deterministic source of the document, computed identically here.
        // spineMm is forwarded so a caller sweeping cover renders at a
        // real Prodigi-quoted spine width gets a cover-wrap page whose
        // `params.spineMm` (and therefore this file's own cover box size)
        // actually reflects it.
        const fit = fitBook(outline, manifest, spineMm !== undefined ? { spineMm } : {});
        const pages = fit.document.pages;

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

        setState({
          status: 'ready',
          target: { page: page!, manifest, outputWidthMm, outputHeightMm, naturalWidthMm, naturalHeightMm, cropLeftMm, cropTopMm, half: resolvedHalf },
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
      });

    return () => {
      cancelled = true;
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
  const bookSlug = readParams().slug as string;

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
