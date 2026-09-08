import { fitBook } from '../../src/model/fitter';
import { applyPostFit, applyPreFit } from '../../src/model/edits';
import type { BookDocument, BookManifest, BookOutline, BookPage, LayoutGap, PageCapacityReport } from '../../src/model/types';
import type { MemoryBookEditsShape, SkippedEdit } from '../../src/model/edits';

/**
 * The Node-side "no Chrome" half of the print pipeline (memory-book-5c
 * plan, Step 2c) — extracted so it can be called on its own, cheaply
 * (milliseconds, no Puppeteer/browser), for a future `/fit` render-worker op
 * (Decision 2) as well as by `renderBookPdfs()` (which needs the exact same
 * page list/count before it ever launches a browser). Runs the SAME edits
 * chain the print entry runs in-browser (`applyPreFit` -> `fitBook` ->
 * `applyPostFit`, mirroring `useEditableBook.ts`'s `buildDocument` order —
 * see `src/print/PrintApp.tsx`'s own header comment) so a page count
 * computed here and a render produced by `renderBookPdfs()` can never
 * disagree.
 *
 * "THE page count" (plan Decision 2, defined once): the SUBMITTED-INTERIOR
 * count — after the cover-wrap page and the front-matter-verso blank are
 * dropped (neither is submitted to Prodigi as an interior page — see the
 * `jobs` construction below), and after asserting the result is contiguous
 * from 1 and even (Prodigi's inner-pages file must have an even count).
 * This is the number that feeds the quote, the spine-width lookup, and the
 * Prodigi order alike — computed identically whether called standalone
 * (the future `/fit` op) or as part of a full render.
 */

export interface RenderJob {
  /** Sequence position in the final interior PDF (1-based, matches the fitter's own printed page numbers). */
  physicalPageNumber: number;
  /** Index into `document.pages`. */
  pageIndex: number;
  half: 'left' | 'right' | null;
  templateId: string;
}

export interface FitBookForPrintInput {
  outline: BookOutline;
  manifest: BookManifest;
  /** Defaults to `{}` (no edits) — a plain fit, same as the print entry's SLUG mode. */
  edits?: MemoryBookEditsShape;
  /** Forwarded to `fitBook`'s `FitOptions.spineMm` — required by the CLI/render-worker callers (a real Prodigi-quoted width), but left optional here so the fitter's own default applies for a caller that only wants the page count (spine width doesn't affect interior pagination, only the cover-wrap page's own width). */
  spineMm?: number;
}

export interface FitBookForPrintResult {
  /** The fitted + edited document (post applyPostFit) — what the print entry itself renders each page/half from. */
  document: BookDocument;
  /** The manifest AFTER applyPreFit — what `document`'s slot content (assetFile, etc.) is actually meaningful against (see `PrintApp.tsx`'s identical `editedManifest` usage). */
  editedManifest: BookManifest;
  /** THE page count — see this module's header comment. */
  pageCount: number;
  coverPage: BookPage;
  /** Every interior render job (cover + front-matter-verso blank excluded), sorted by `physicalPageNumber` ascending (1..pageCount, contiguous). */
  jobs: RenderJob[];
  frontMatterVersoPageId: string;
  /** Edit-application orphans (image/text/focal-point) — ids/kinds only, never memory content. */
  skipped: SkippedEdit[];
  /** Raw `fitBook` capacity/gap reporting (unaffected by applyPostFit, which never touches pagination) — surfaced for the same diagnostics the CLI has always printed. */
  capacity: PageCapacityReport;
  gaps: LayoutGap[];
}

const FRONT_MATTER_VERSO_REASON = 'front-matter-verso';

export function fitBookForPrint(input: FitBookForPrintInput): FitBookForPrintResult {
  const edits = input.edits ?? {};

  // The edits chain (Step 2a/2c) — applyPreFit before fitBook, applyPostFit
  // after, identical order to useEditableBook.ts's buildDocument and to
  // PrintApp.tsx's in-browser render. `edits` is `{}` for a plain/unedited
  // fit (both stages are then pure deep-clone no-ops).
  const pre = applyPreFit(input.outline, input.manifest, edits);
  const fit = fitBook(pre.outline, pre.manifest, input.spineMm !== undefined ? { spineMm: input.spineMm } : {});
  const post = applyPostFit(fit.document, edits);
  const document_ = post.document;

  const coverPage = document_.pages.find((p) => p.templateId === 'cover-wrap');
  if (!coverPage) {
    throw new Error('fitBookForPrint: no cover-wrap page in the fitted document — cannot render a cover');
  }

  // Round-22 (carried from render-pdf.mts): the fitter's own front-matter-
  // verso blank (the deliberately blank page facing the dedication) is
  // never submitted to Prodigi — their own separate-file API setup inserts
  // an inside-front-cover blank of its OWN, automatically, ahead of the
  // inner-pages file's first page (see docs/plans/prodigi-order-spec.md).
  // Every OTHER blank the fitter emits stays (a real content-flow page).
  let frontMatterVersoPage: BookPage | null = null;
  const jobs: RenderJob[] = [];

  document_.pages.forEach((page, pageIndex) => {
    if (page.templateId === 'cover-wrap') return; // handled separately, not part of the interior sequence
    if (page.templateId === 'blank' && page.blankReason === FRONT_MATTER_VERSO_REASON) {
      frontMatterVersoPage = page; // never printed — see doc comment above
      return;
    }
    if (page.isSpread) {
      const [leftNum, rightNum] = page.pageNumbers ?? [];
      if (leftNum === undefined || rightNum === undefined) {
        throw new Error(`fitBookForPrint: spread page ${page.id} (index ${pageIndex}) has no pageNumbers — fitter numbering bug`);
      }
      jobs.push({ physicalPageNumber: leftNum, pageIndex, half: 'left', templateId: page.templateId });
      jobs.push({ physicalPageNumber: rightNum, pageIndex, half: 'right', templateId: page.templateId });
    } else {
      const [num] = page.pageNumbers ?? [];
      if (num === undefined) {
        throw new Error(`fitBookForPrint: page ${page.id} (index ${pageIndex}) has no pageNumbers — fitter numbering bug`);
      }
      jobs.push({ physicalPageNumber: num, pageIndex, half: null, templateId: page.templateId });
    }
  });

  if (!frontMatterVersoPage) {
    throw new Error('fitBookForPrint: FATAL — no front-matter-verso blank found in the fitted document; expected exactly one (see buildDedicationPages in fitter.ts)');
  }

  jobs.sort((a, b) => a.physicalPageNumber - b.physicalPageNumber);

  // Fail loudly rather than silently ship a short/long/gappy interior PDF —
  // validated against the render jobs' OWN pageNumbers (contiguous, 1-based;
  // cover and front-matter-verso blank already excluded above), then cross-
  // checked against document.totalPages (round-22: the two must agree
  // exactly now, no +-1 adjustment).
  const expectedNumbers = jobs.map((j) => j.physicalPageNumber);
  const contiguousFrom1 = expectedNumbers.every((n, i) => n === i + 1);
  if (!contiguousFrom1) {
    throw new Error(`fitBookForPrint: FATAL — render job page numbers aren't contiguous starting at 1: ${JSON.stringify(expectedNumbers)}`);
  }
  if (jobs.length !== document_.totalPages) {
    throw new Error(
      `fitBookForPrint: FATAL — ${jobs.length} interior render jobs, but fitBook's totalPages (${document_.totalPages}) doesn't match — numbering assumption no longer holds`,
    );
  }

  const pageCount = jobs.length;
  if (pageCount % 2 !== 0) {
    throw new Error(`fitBookForPrint: FATAL — interior PDF has ${pageCount} pages (odd); Prodigi's inner-pages file must have an even page count`);
  }

  return {
    document: document_,
    editedManifest: pre.manifest,
    pageCount,
    coverPage,
    jobs,
    frontMatterVersoPageId: (frontMatterVersoPage as BookPage).id,
    skipped: [...pre.skipped, ...post.skipped],
    capacity: fit.capacity,
    gaps: fit.gaps,
  };
}
