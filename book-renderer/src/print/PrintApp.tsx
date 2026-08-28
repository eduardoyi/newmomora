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
 * a matching html/body box, and — for a spread — a crop to one printable
 * half) on top of it. It never re-implements layout.
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
  /** Physical size (mm) of the html/body box + `@page` rule this specific render must produce. */
  widthMm: number;
  heightMm: number;
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

/** A spread half's own printable box: bleed on its outer edge only, none at the gutter — mirrors PageFrame/mm.ts's SPREAD_WIDTH_MM = 2*pageSizeMm + 2*bleedMm math (the two halves' widths sum back to exactly that). */
const SPREAD_HALF_WIDTH_MM = PHYSICAL.pageSizeMm + PHYSICAL.bleedMm;

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

        let widthMm: number;
        let heightMm: number;
        let resolvedHalf: 'left' | 'right' | null = null;

        if (kind === 'cover') {
          const spineMmResolved = Number((page.params as { spineMm?: number }).spineMm ?? 0);
          widthMm = PHYSICAL.pageSizeMm * 2 + spineMmResolved + PHYSICAL.bleedMm * 2;
          heightMm = PHYSICAL.pageSizeMm + PHYSICAL.bleedMm * 2;
        } else if (page.isSpread) {
          if (half !== 'left' && half !== 'right') {
            throw new Error(`page ${pageIndex} (${page.templateId}) is a spread — half=left|right is required`);
          }
          resolvedHalf = half;
          widthMm = SPREAD_HALF_WIDTH_MM;
          heightMm = SPREAD_HEIGHT_MM;
        } else {
          widthMm = FULL_PAGE_MM;
          heightMm = FULL_PAGE_MM;
        }

        setState({ status: 'ready', target: { page: page!, manifest, widthMm, heightMm, half: resolvedHalf } });
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
    const { widthMm, heightMm } = state.target;
    const style = document.createElement('style');
    style.textContent = `
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      html, body {
        margin: 0; padding: 0;
        width: ${widthMm}mm; height: ${heightMm}mm;
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

  const { page, manifest, widthMm, heightMm, half: resolvedHalf } = state.target;
  const bookSlug = readParams().slug as string;

  const content =
    resolvedHalf === null ? (
      <TemplateRenderer page={page} manifest={manifest} bookSlug={bookSlug} showGuides={false} />
    ) : (
      // Crop one printable half out of the full spread render. The spread
      // template renders itself at its own natural SPREAD_WIDTH_MM (426mm)
      // — everything inside it (cqw type sizes, the gutter guide, slot
      // positions) is computed relative to THAT width via PageFrame's own
      // container-query sizing (see mm.ts's `mmToPctWidth`/`ptCqw`), so the
      // spread must be laid out at its full width and then visually cropped
      // to the requested half, never re-rendered at the half's own width
      // (which would silently rescale every cqw-based measurement).
      <div style={{ position: 'relative', width: `${widthMm}mm`, height: `${heightMm}mm`, overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: resolvedHalf === 'right' ? `-${widthMm}mm` : 0,
            width: `${SPREAD_WIDTH_MM}mm`,
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
