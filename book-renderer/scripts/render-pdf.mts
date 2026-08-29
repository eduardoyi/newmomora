import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer, { type Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { fitBook } from '../src/model/fitter';
import { parseManifest, parseOutline } from '../src/model/loader';
import { PHYSICAL } from '../src/model/types';
import type { BookPage } from '../src/model/types';

/**
 * Print pipeline (V3 Phase 2): builds the interior + wraparound-cover PDFs
 * for one book, via the SAME React templates the interactive preview
 * renders (`src/print/PrintApp.tsx` + `print.html`) — this script never
 * lays out a page itself, it only drives a headless browser over the
 * deterministic page list `fitBook` already produces, one physical PDF
 * page per navigation, and assembles the results in order.
 *
 * Architecture choice (documented per the phase-2 brief):
 *   `vite build` + `vite preview` (a real production static build), not
 *   `vite dev`. A production build is what the pipeline is actually
 *   shipping toward — no dev-only React warnings/HMR client, one
 *   deterministic bundle served as plain static files for every one of the
 *   ~120 navigations this script makes per book, rather than re-transforming
 *   modules on first request the way `vite dev` would for a cold cache.
 *
 * PDF method: Puppeteer's native `page.pdf({ preferCSSPageSize: true })`
 * reading an `@page { size: ... }` rule PrintApp.tsx injects once it knows
 * the exact physical box — round-22: always the TRIM size now (210x210mm
 * single page or spread half, or the cover's own back+spine+front box with
 * NO bleed), per Prodigi's real layflat file spec (their system generates
 * bleed/cut-marks itself — docs/plans/prodigi-order-spec.md). PrintApp.tsx
 * still renders each template at its own natural bleed-inclusive canvas
 * size and crops down to this trim box — not a screenshot-to-PDF
 * conversion, so there's no raster/DPI step to get wrong for a vector-safe
 * layout (text stays real text in the PDF).
 *
 * Usage:
 *   npm run book:pdf -- --slug <slug> --spine-mm <mm> [--out-dir <dir>]
 *                        [--port 4321] [--concurrency 4]
 *   (--spine-mm is required — query Prodigi's spine API for the real value
 *   per page count, see docs/plans/prodigi-order-spec.md §3; never guessed.)
 */

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const slug = args.slug;
if (!slug) {
  console.error('Usage: npm run book:pdf -- --slug <slug> --spine-mm <mm> [--out-dir <dir>] [--port 4321] [--concurrency 4]');
  process.exit(1);
}
// Round-22: required, not optional. The fitter's own DEFAULT_SPINE_MM (9mm)
// is a placeholder for local/preview use only — a real order's cover MUST
// use the exact width Prodigi's spine API quoted for this book's actual
// page count (see docs/plans/prodigi-order-spec.md §3; 28mm for both of our
// current 122-page candidates) or the cover ships mis-sized. Silently
// falling back here is exactly the class of mistake that got the first
// order rejected — fail loudly instead.
if (args['spine-mm'] === undefined) {
  console.error('Usage: npm run book:pdf -- --slug <slug> --spine-mm <mm> [--out-dir <dir>] [--port 4321] [--concurrency 4]');
  console.error('[render-pdf] --spine-mm is required — query Prodigi\'s /products/spine endpoint for this book\'s real page count, never guess/default it (see docs/plans/prodigi-order-spec.md §3).');
  process.exit(1);
}
const spineMm = Number(args['spine-mm']);
if (!Number.isFinite(spineMm) || spineMm <= 0) {
  console.error(`[render-pdf] --spine-mm must be a positive number, got: ${args['spine-mm']}`);
  process.exit(1);
}
const port = args.port !== undefined ? Number(args.port) : 4321;
const concurrency = args.concurrency !== undefined ? Number(args.concurrency) : 4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const bookDataDir = path.join(rootDir, 'book-data', slug);
const outDir = args['out-dir'] ? path.resolve(args['out-dir']) : path.join(bookDataDir, 'print');

// ---------------------------------------------------------------------------
// mm <-> pt (PDF points) — 1mm = 72/25.4 pt. Used only for validating what
// Puppeteer actually produced against what PrintApp.tsx asked the `@page`
// rule for; the physical mm math itself lives in templates/mm.ts.
// ---------------------------------------------------------------------------

const PT_PER_MM = 72 / 25.4;
function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}

// ---------------------------------------------------------------------------
// Step 1: fit the book (Node-side — no browser needed for this part; same
// pure fitBook the browser's PrintApp.tsx will independently call for the
// SAME slug/spineMm, so the two are guaranteed to agree on shape without
// this script having to serialize the whole document across the wire).
// ---------------------------------------------------------------------------

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const manifestPath = path.join(bookDataDir, 'manifest.json');
const outlinePath = path.join(bookDataDir, 'book.outline.json');
if (!fs.existsSync(manifestPath) || !fs.existsSync(outlinePath)) {
  console.error(`book-data/${slug}/ is missing manifest.json or book.outline.json`);
  process.exit(1);
}

const manifest = parseManifest(readJson(manifestPath));
const outline = parseOutline(readJson(outlinePath));
const fit = fitBook(outline, manifest, { spineMm });
const document_ = fit.document;

// Never print memory content — ids and counts only (project-wide rule).
// Round-22 renumbering: `totalPages` is the highest PRINTED folio number —
// neither the cover nor the front-matter-verso blank consumes one anymore
// (see `numberPages` in fitter.ts), so it already matches the interior PDF's
// real page count with no +-1 adjustment needed (contrast the old scheme,
// where numbering started at 2 and the blank WAS counted).
console.log(`[render-pdf] ${slug}: fitBook totalPages=${document_.totalPages} (highest printed folio; cover and front-matter-verso blank uncounted), ${document_.pages.length} page entries`);
console.log(
  `[render-pdf] ${slug}: capacity — cap ${fit.capacity.cap}, overCap ${fit.capacity.overCap}, pairingLevelUsed ${fit.capacity.pairingLevelUsed}, omitted ${fit.capacity.omittedMemoryIds.length}`,
);
if (fit.gaps.length > 0) {
  console.log(`[render-pdf] ${slug}: ${fit.gaps.length} layout gap(s) reported by the fitter (see the preview's Gaps panel for detail)`);
}

interface RenderJob {
  /** Sequence position in the final interior PDF (1-based, matches the fitter's own printed page numbers). */
  physicalPageNumber: number;
  pageIndex: number;
  half: 'left' | 'right' | null;
  templateId: string;
}

const coverPage = document_.pages.find((p) => p.templateId === 'cover-wrap');
if (!coverPage) {
  console.error(`[render-pdf] ${slug}: no cover-wrap page in the fitted document — cannot render a cover`);
  process.exit(1);
}

// Round-22: the fitter's own front-matter-verso blank (the deliberately
// blank page facing the dedication — see buildDedicationPages in fitter.ts)
// is never submitted to Prodigi. That page exists to make the APP PREVIEW's
// pagination read correctly (dedication lands on the right-hand page), but
// Prodigi's separate-file API setup (docs/plans/prodigi-order-spec.md
// §"Submission format") inserts an inside-front-cover blank of its OWN,
// automatically, ahead of the inner-pages file's first page — submitting
// ours too would duplicate it and shift every page after it by one, wrecking
// the exact left/right parity the fitter carefully computed (dedication
// would land on the WRONG side, and so would every spread after it). Every
// OTHER blank the fitter emits (mid-flow parity padding, the even-total
// closer) is a real content-flow page with no Prodigi-side equivalent and
// must stay. `numberPages` already reflects this: the front-matter-verso
// blank's own `pageNumbers` is `null`, exactly like the cover's, so it's
// skipped here the SAME way the cover is — never entering the interior job
// list to begin with, rather than being built then discarded.
const FRONT_MATTER_VERSO_REASON = 'front-matter-verso';
let frontMatterVersoPage: BookPage | null = null;

const jobs: RenderJob[] = [];
document_.pages.forEach((page: BookPage, pageIndex: number) => {
  if (page.templateId === 'cover-wrap') return; // handled separately, not part of the interior sequence
  if (page.templateId === 'blank' && page.blankReason === FRONT_MATTER_VERSO_REASON) {
    frontMatterVersoPage = page; // never printed — see doc comment above
    return;
  }
  if (page.isSpread) {
    const [leftNum, rightNum] = page.pageNumbers ?? [];
    if (leftNum === undefined || rightNum === undefined) {
      throw new Error(`spread page ${page.id} (index ${pageIndex}) has no pageNumbers — fitter numbering bug`);
    }
    jobs.push({ physicalPageNumber: leftNum, pageIndex, half: 'left', templateId: page.templateId });
    jobs.push({ physicalPageNumber: rightNum, pageIndex, half: 'right', templateId: page.templateId });
  } else {
    const [num] = page.pageNumbers ?? [];
    if (num === undefined) {
      throw new Error(`page ${page.id} (index ${pageIndex}) has no pageNumbers — fitter numbering bug`);
    }
    jobs.push({ physicalPageNumber: num, pageIndex, half: null, templateId: page.templateId });
  }
});

if (!frontMatterVersoPage) {
  console.error(`[render-pdf] ${slug}: FATAL — no front-matter-verso blank found in the fitted document; expected exactly one (see buildDedicationPages in fitter.ts)`);
  process.exit(1);
}
console.log(
  `[render-pdf] ${slug}: skipped front-matter-verso blank (id ${(frontMatterVersoPage as BookPage).id}, no printed folio) from interior PDF — Prodigi's system inserts this inside-front-cover blank automatically`,
);

jobs.sort((a, b) => a.physicalPageNumber - b.physicalPageNumber);

// Fail loudly, per the brief, rather than silently ship a short/long/gappy
// interior PDF. Validated against the render jobs' OWN `pageNumbers` data
// (contiguous, starting at 1 — round-22's physical-folio numbering: neither
// the cover nor the front-matter-verso blank consumes a printed number, see
// `numberPages` in fitter.ts, and both are already excluded from `jobs`
// above), not against `document.totalPages` directly as a separate check —
// though the two must agree exactly now (no +-1 adjustment for an "uncounted
// cover" the way the old scheme needed, since `totalPages` itself no longer
// counts the cover OR the blank).
const expectedNumbers = jobs.map((j) => j.physicalPageNumber);
const contiguousFrom1 = expectedNumbers.every((n, i) => n === i + 1);
if (!contiguousFrom1) {
  console.error(`[render-pdf] ${slug}: FATAL — render job page numbers aren't contiguous starting at 1: ${JSON.stringify(expectedNumbers)}`);
  process.exit(1);
}
if (jobs.length !== document_.totalPages) {
  console.error(
    `[render-pdf] ${slug}: FATAL — ${jobs.length} interior render jobs, but fitBook's totalPages (${document_.totalPages}) doesn't match — numbering assumption above no longer holds, stopping rather than guessing`,
  );
  process.exit(1);
}

const interiorPageCount = jobs.length;
if (interiorPageCount % 2 !== 0) {
  console.error(
    `[render-pdf] ${slug}: FATAL — interior PDF has ${interiorPageCount} pages (odd); Prodigi's inner-pages file must have an even page count`,
  );
  process.exit(1);
}
console.log(`[render-pdf] ${slug}: ${interiorPageCount} interior PDF pages will be produced (fitBook totalPages=${document_.totalPages}, cover and front-matter-verso blank uncounted)`);

// ---------------------------------------------------------------------------
// Step 2: production build (once — serves both index.html and print.html).
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });

console.log(`[render-pdf] ${slug}: building (vite build)…`);
const buildStart = Date.now();
const build = spawnSync('npx', ['vite', 'build'], { cwd: rootDir, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('[render-pdf] vite build failed');
  process.exit(1);
}
console.log(`[render-pdf] build done in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// Step 3: static preview server.
// ---------------------------------------------------------------------------

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`preview server did not become ready at ${url} within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const previewProc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let previewOutput = '';
previewProc.stdout?.on('data', (d) => (previewOutput += String(d)));
previewProc.stderr?.on('data', (d) => (previewOutput += String(d)));

const baseUrl = `http://localhost:${port}`;

async function cleanup(browser: Browser | null) {
  if (browser) await browser.close().catch(() => {});
  previewProc.kill();
}

try {
  await waitForServer(`${baseUrl}/index.html`, 20000);
} catch (e) {
  console.error('[render-pdf] preview server failed to start:', previewOutput);
  await cleanup(null);
  throw e;
}

// ---------------------------------------------------------------------------
// Step 4: Puppeteer — one PDF page per job, small worker pool.
// ---------------------------------------------------------------------------

interface RenderedPage {
  job: RenderJob;
  pdfBytes: Uint8Array;
  widthPt: number;
  heightPt: number;
}

function jobUrl(job: RenderJob | { kind: 'cover' }): string {
  if ('kind' in job) return `${baseUrl}/print.html?slug=${encodeURIComponent(slug!)}&spineMm=${spineMm}&kind=cover`;
  const half = job.half ? `&half=${job.half}` : '';
  return `${baseUrl}/print.html?slug=${encodeURIComponent(slug!)}&spineMm=${spineMm}&kind=page&pageIndex=${job.pageIndex}${half}`;
}

/** Navigates one print.html target, waits for real readiness (data-print-ready, fonts, decoded images), and captures its exact-size PDF page. */
async function renderOne(browser: Browser, url: string): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelector('[data-print-ready="true"]') !== null || document.querySelector('[data-print-error]') !== null,
      { timeout: 30000 },
    );
    const errorMessage = await page.evaluate(() => document.querySelector('[data-print-error]')?.getAttribute('data-print-error') ?? null);
    if (errorMessage) {
      throw new Error(`print render error at ${url}: ${errorMessage}`);
    }
    // Fonts loaded (Newsreader/Plus Jakarta Sans/Caveat, network-loaded —
    // see print.html's own caveat note) and every <img> decoded, before
    // capture — required so text metrics and photos are final, not
    // mid-swap/blank.
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(
        imgs.map((img) => (img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode().catch(() => undefined))),
      );
    });
    const pdfBytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    return pdfBytes;
  } finally {
    await page.close();
  }
}

/** Tiny fixed-size worker pool — this script's whole job list is a few hundred entries at most, no need for a queueing library. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const browser = await puppeteer.launch({ headless: true });

let rendered: RenderedPage[];
let coverBytes: Uint8Array;
const renderStart = Date.now();
try {
  console.log(`[render-pdf] ${slug}: rendering ${jobs.length} interior page(s) at concurrency ${concurrency}…`);
  const pdfBuffers = await mapWithConcurrency(jobs, concurrency, async (job) => {
    const bytes = await renderOne(browser, jobUrl(job));
    return { job, bytes };
  });

  rendered = [];
  for (const { job, bytes } of pdfBuffers) {
    const doc = await PDFDocument.load(bytes);
    const [pdfPage] = doc.getPages();
    rendered.push({ job, pdfBytes: bytes, widthPt: pdfPage.getWidth(), heightPt: pdfPage.getHeight() });
  }

  console.log(`[render-pdf] ${slug}: rendering cover (spine ${spineMm}mm)…`);
  coverBytes = await renderOne(browser, jobUrl({ kind: 'cover' }));
} finally {
  await cleanup(browser);
}
const renderMs = Date.now() - renderStart;

// ---------------------------------------------------------------------------
// Step 5: validate every page's exact physical size.
// ---------------------------------------------------------------------------

// Round-22: every submitted page (single, spread half, or cover) is the
// exact TRIM size — no bleed. Prodigi's own system "will automatically
// generate" bleed and cut marks (docs/plans/prodigi-order-spec.md, citing
// the print guide p.4) — shipping 216mm (210 trim + 3mm bleed on each side)
// here is exactly the mistake that got the first order rejected.
const TRIM_PAGE_MM = PHYSICAL.pageSizeMm; // 210mm
const TOLERANCE_PT = 0.5;

function assertSizeMm(label: string, widthPt: number, heightPt: number, expectedWidthMm: number, expectedHeightMm: number) {
  const expectedWidthPt = mmToPt(expectedWidthMm);
  const expectedHeightPt = mmToPt(expectedHeightMm);
  const widthOk = Math.abs(widthPt - expectedWidthPt) <= TOLERANCE_PT;
  const heightOk = Math.abs(heightPt - expectedHeightPt) <= TOLERANCE_PT;
  if (!widthOk || !heightOk) {
    throw new Error(
      `[render-pdf] FATAL — ${label} is ${widthPt.toFixed(2)}x${heightPt.toFixed(2)}pt, expected ${expectedWidthPt.toFixed(2)}x${expectedHeightPt.toFixed(2)}pt (${expectedWidthMm}x${expectedHeightMm}mm) +-${TOLERANCE_PT}pt`,
    );
  }
}

for (const r of rendered) {
  // Every content page — single or spread half — is the same 210x210mm trim square now (no bleed-inclusive 216/213mm distinction left to make).
  assertSizeMm(`interior page ${r.job.physicalPageNumber} (${r.job.templateId}${r.job.half ? ` ${r.job.half} half` : ''})`, r.widthPt, r.heightPt, TRIM_PAGE_MM, TRIM_PAGE_MM);
}

const coverDoc = await PDFDocument.load(coverBytes);
const [coverPdfPage] = coverDoc.getPages();
const coverSpineMm = Number((coverPage.params as { spineMm?: number }).spineMm ?? 0);
// Trim-only cover width: 2*210 + spine, no bleed (round-22 — was previously +PHYSICAL.bleedMm*2, the same 216-style mistake as the content pages).
const coverWidthMm = PHYSICAL.pageSizeMm * 2 + coverSpineMm;
assertSizeMm('cover', coverPdfPage.getWidth(), coverPdfPage.getHeight(), coverWidthMm, TRIM_PAGE_MM);

// ---------------------------------------------------------------------------
// Step 6: assemble the interior PDF, in physical page order, and write both files.
// ---------------------------------------------------------------------------

const merged = await PDFDocument.create();
for (const r of rendered.sort((a, b) => a.job.physicalPageNumber - b.job.physicalPageNumber)) {
  const src = await PDFDocument.load(r.pdfBytes);
  const [copied] = await merged.copyPages(src, [0]);
  merged.addPage(copied);
}
const interiorBytes = await merged.save();

const interiorPath = path.join(outDir, 'interior.pdf');
const coverPath = path.join(outDir, 'cover.pdf');
fs.writeFileSync(interiorPath, interiorBytes);
fs.writeFileSync(coverPath, coverBytes);

if (merged.getPageCount() !== interiorPageCount) {
  console.error(`[render-pdf] FATAL — assembled interior PDF has ${merged.getPageCount()} pages, expected ${interiorPageCount}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 7: report (ids/counts only — never memory content).
// ---------------------------------------------------------------------------

const interiorSizeMb = fs.statSync(interiorPath).size / (1024 * 1024);
const coverSizeMb = fs.statSync(coverPath).size / (1024 * 1024);
const samplePage = rendered[0];

console.log('');
console.log(`[render-pdf] ${slug}: DONE`);
console.log(`  interior: ${interiorPath} — ${merged.getPageCount()} pages @ ${TRIM_PAGE_MM}x${TRIM_PAGE_MM}mm trim (no bleed), ${interiorSizeMb.toFixed(1)}MB`);
console.log(`  cover:    ${coverPath} — 1 page, ${coverSizeMb.toFixed(1)}MB (spine ${coverSpineMm}mm, ${coverWidthMm}x${TRIM_PAGE_MM}mm trim, no bleed)`);
console.log(`  sample page ${samplePage.job.physicalPageNumber} (${samplePage.job.templateId}): ${samplePage.widthPt.toFixed(2)}x${samplePage.heightPt.toFixed(2)}pt`);
console.log(`  render wall time: ${(renderMs / 1000).toFixed(1)}s (${jobs.length} interior pages + 1 cover, concurrency ${concurrency})`);
