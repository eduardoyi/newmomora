import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import puppeteer, { type Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { PHYSICAL } from '../../src/model/types';
import type { BookManifest, BookOutline } from '../../src/model/types';
import type { MemoryBookEditsShape } from '../../src/model/edits';
import { parseManifest, parseOutline } from '../../src/model/loader';
import { fitBookForPrint, type FitBookForPrintResult, type RenderJob } from './fitBookForPrint';

/**
 * `renderBookPdfs()` — the print pipeline's Puppeteer-driving library
 * (memory-book-5c plan, Step 2c), extracted out of `render-pdf.mts` so the
 * SAME code drives a real render whether the caller is the CLI (`npm run
 * book:pdf`, unchanged behavior) or the future render worker (Decision 3,
 * a separate step — `render/memory-book-renderer/`). Two things the
 * original script did that this library deliberately does NOT do, per
 * Decision 3 ("no vite build/preview spawn at runtime"):
 *
 *   - No `vite build` — the caller must hand in an already-built
 *     `servedDistDir` (the CLI wrapper still runs `vite build` itself,
 *     once, before calling this; the render worker's Docker image builds
 *     it once at image-build time and never rebuilds per request).
 *   - No `vite preview` — this module runs its own minimal static file
 *     server (see `startServer` below) over `servedDistDir`, loopback-only
 *     (127.0.0.1), so no vite dev-server process is spawned per render.
 *
 * Data source modes mirror `PrintApp.tsx`'s own two modes exactly (see that
 * file's header comment) — this library serves the identical contract:
 *   - `{ mode: 'slug', slug }` — the book's outline/manifest are read
 *     directly from `<servedDistDir>/<slug>/manifest.json` and
 *     `.../book.outline.json` (already there because `vite build`'s
 *     `publicDir: 'book-data'` copies them in — see vite.config.ts), and
 *     `print.html?slug=<slug>&...` is what gets navigated. No edits are
 *     applied (byte-identical to every render before this step existed).
 *   - `{ mode: 'attempt', attemptId, outline, manifest, edits }` — the
 *     book data is supplied in-memory (the future render worker's own
 *     request payload — a frozen `book_document_snapshot` + `edits_snapshot`
 *     off an order row); this library serves it back out at
 *     `/attempt/<attemptId>/outline.json|manifest.json|edits.json` (from
 *     memory, no disk write) and navigates `print.html?attempt=<attemptId>&...`.
 *
 * Page count: `fitBookForPrint()` (the same Node-only, no-Chrome function
 * this library calls first) computes THE canonical submitted-interior page
 * count (plan Decision 2) — returned here unchanged, so a caller never
 * needs to recompute or guess it from PDF page counting after the fact.
 */

export type RenderBookPdfsDataInput =
  | { mode: 'slug'; slug: string }
  | { mode: 'attempt'; attemptId: string; outline: BookOutline; manifest: BookManifest; edits?: MemoryBookEditsShape };

export interface RenderBookPdfsOptions {
  /**
   * Prebuilt `vite build` output directory to serve as the static root
   * (index.html, print.html, /assets/*, and — SLUG mode only — the book's
   * own /<slug>/manifest.json etc via the build's publicDir passthrough).
   * This library never runs `vite build`/`vite preview` itself (see this
   * file's header comment) — the caller is responsible for `servedDistDir`
   * already existing and being current.
   */
  servedDistDir: string;
  /** Required, forwarded to the fitter/cover box — a real Prodigi-quoted spine width, never guessed/defaulted (same rule the CLI has always enforced at its own arg-parsing layer). */
  spineMm: number;
  data: RenderBookPdfsDataInput;
  /** TCP port for the internal static server. Default 0 — the OS assigns a free ephemeral port, so concurrent renders (or repeated test runs) never clash on a fixed port. */
  port?: number;
  /** Puppeteer page-render worker pool size. Default 4 (unchanged from the CLI). */
  concurrency?: number;
}

export interface RenderBookPdfsResult {
  interiorPdf: Buffer;
  coverPdf: Buffer;
  /** THE page count (plan Decision 2) — see fitBookForPrint.ts's header comment. */
  pageCount: number;
  checksums: { interior: string; cover: string };
  /** Raw fit diagnostics (ids/counts only, never memory content) — the same info the CLI has always logged. */
  capacity: FitBookForPrintResult['capacity'];
  gaps: FitBookForPrintResult['gaps'];
  skipped: FitBookForPrintResult['skipped'];
}

const PT_PER_MM = 72 / 25.4;
function mmToPt(mm: number): number {
  return mm * PT_PER_MM;
}
function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Minimal static file server — see this file's header comment on why no
// vite process is spawned. Loopback-only: this process's own Puppeteer is
// the only intended client (same posture the future render worker's PII
// data endpoints need — Decision 3 — just one level down).
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function contentType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res: http.ServerResponse, data: unknown): void {
  const body = JSON.stringify(data ?? {});
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(rootDir: string, pathname: string, res: http.ServerResponse): void {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? '/index.html' : decoded;
  const normalizedRoot = path.normalize(rootDir);
  const resolved = path.normalize(path.join(rootDir, relative));
  // Path-traversal guard — this server only ever serves a locally-built
  // dist/ directory to a Puppeteer instance THIS process launched, but
  // fail closed regardless of how narrow the real exposure is.
  if (!resolved.startsWith(normalizedRoot)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': contentType(resolved) });
    res.end(data);
  });
}

interface AttemptServeData {
  attemptId: string;
  outline: unknown;
  manifest: unknown;
  edits: unknown;
}

function startServer(servedDistDir: string, attempt: AttemptServeData | null, port: number): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (attempt) {
      const prefix = `/attempt/${attempt.attemptId}/`;
      if (url.pathname === `${prefix}outline.json`) return sendJson(res, attempt.outline);
      if (url.pathname === `${prefix}manifest.json`) return sendJson(res, attempt.manifest);
      if (url.pathname === `${prefix}edits.json`) return sendJson(res, attempt.edits ?? {});
    }
    serveStatic(servedDistDir, url.pathname, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('renderBookPdfs: failed to determine static server port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Puppeteer capture — unchanged behavior from render-pdf.mts's renderOne.
// ---------------------------------------------------------------------------

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
    // Fonts (vendored locally as of Step 2b, PrintApp.tsx's own hard-fail
    // check already ran before data-print-ready could appear — see that
    // file's LoadState doc comment) and every <img> decoded, before capture.
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode().catch(() => undefined))));
    });
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const TRIM_PAGE_MM = PHYSICAL.pageSizeMm;
const TOLERANCE_PT = 0.5;

function assertSizeMm(label: string, widthPt: number, heightPt: number, expectedWidthMm: number, expectedHeightMm: number): void {
  const expectedWidthPt = mmToPt(expectedWidthMm);
  const expectedHeightPt = mmToPt(expectedHeightMm);
  const widthOk = Math.abs(widthPt - expectedWidthPt) <= TOLERANCE_PT;
  const heightOk = Math.abs(heightPt - expectedHeightPt) <= TOLERANCE_PT;
  if (!widthOk || !heightOk) {
    throw new Error(
      `renderBookPdfs: FATAL — ${label} is ${widthPt.toFixed(2)}x${heightPt.toFixed(2)}pt, expected ${expectedWidthPt.toFixed(2)}x${expectedHeightPt.toFixed(2)}pt (${expectedWidthMm}x${expectedHeightMm}mm) +-${TOLERANCE_PT}pt`,
    );
  }
}

// ---------------------------------------------------------------------------
// The library entry point.
// ---------------------------------------------------------------------------

export async function renderBookPdfs(options: RenderBookPdfsOptions): Promise<RenderBookPdfsResult> {
  const { servedDistDir, spineMm, data, concurrency = 4 } = options;

  // Step 1: resolve outline/manifest (Node-side, no browser) and fit —
  // identical for both data modes; SLUG mode reads the exact files already
  // copied into `servedDistDir` by `vite build`'s publicDir passthrough.
  let outline: BookOutline;
  let manifest: BookManifest;
  let edits: MemoryBookEditsShape | undefined;
  let attemptServe: AttemptServeData | null = null;

  if (data.mode === 'slug') {
    const manifestPath = path.join(servedDistDir, data.slug, 'manifest.json');
    const outlinePath = path.join(servedDistDir, data.slug, 'book.outline.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(outlinePath)) {
      throw new Error(`renderBookPdfs: ${servedDistDir}/${data.slug}/ is missing manifest.json or book.outline.json — was servedDistDir built with this book in book-data/?`);
    }
    manifest = parseManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    outline = parseOutline(JSON.parse(fs.readFileSync(outlinePath, 'utf-8')));
    edits = undefined;
  } else {
    outline = data.outline;
    manifest = data.manifest;
    edits = data.edits;
    attemptServe = { attemptId: data.attemptId, outline: data.outline, manifest: data.manifest, edits: data.edits ?? {} };
  }

  const fitResult = fitBookForPrint({ outline, manifest, edits, spineMm });
  const { document: document_, pageCount, coverPage, jobs } = fitResult;

  // Step 2: static server (no vite) — see this file's header comment.
  const { server, port: boundPort } = await startServer(servedDistDir, attemptServe, options.port ?? 0);
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  function jobUrl(job: RenderJob | { kind: 'cover' }): string {
    const dataParam = data.mode === 'slug' ? `slug=${encodeURIComponent(data.slug)}` : `attempt=${encodeURIComponent(data.attemptId)}`;
    if ('kind' in job) return `${baseUrl}/print.html?${dataParam}&spineMm=${spineMm}&kind=cover`;
    const half = job.half ? `&half=${job.half}` : '';
    return `${baseUrl}/print.html?${dataParam}&spineMm=${spineMm}&kind=page&pageIndex=${job.pageIndex}${half}`;
  }

  let browser: Browser | null = null;
  try {
    // `--no-sandbox`/`--disable-setuid-sandbox` (memory-book-5c plan, Step 3
    // — found by actually booting the render worker's Docker image, not by
    // inspection): the render worker's container runs Chrome as root (no
    // Dockerfile-level `USER` switch), and Chrome refuses to start its own
    // OS sandbox as root at all ("Running as root without --no-sandbox is
    // not supported"). Harmless to pass unconditionally here too for the
    // CLI's own non-Docker, non-root local runs — Chrome still applies every
    // OTHER isolation layer (site/process isolation, V8 sandboxing) either
    // way; only the setuid-helper sandbox is affected. Acceptable for BOTH
    // callers' threat model: this renders OUR OWN generated HTML/CSS/JS
    // against images fetched from OUR OWN R2 bucket (CLI: local disk;
    // worker: presigned GETs) — never arbitrary third-party/user-supplied
    // web content, which is the scenario `--no-sandbox` is actually
    // dangerous for.
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });

    interface RenderedPage {
      job: RenderJob;
      pdfBytes: Uint8Array;
      widthPt: number;
      heightPt: number;
    }

    const pdfBuffers = await mapWithConcurrency(jobs, concurrency, async (job) => {
      const bytes = await renderOne(browser as Browser, jobUrl(job));
      return { job, bytes };
    });

    const rendered: RenderedPage[] = [];
    for (const { job, bytes } of pdfBuffers) {
      const doc = await PDFDocument.load(bytes);
      const [pdfPage] = doc.getPages();
      rendered.push({ job, pdfBytes: bytes, widthPt: pdfPage.getWidth(), heightPt: pdfPage.getHeight() });
    }

    const coverBytes = await renderOne(browser, jobUrl({ kind: 'cover' }));

    // Step 5 (renumbered from render-pdf.mts): validate every page's exact
    // physical size — trim only, no bleed (Prodigi generates it itself).
    for (const r of rendered) {
      assertSizeMm(`interior page ${r.job.physicalPageNumber} (${r.job.templateId}${r.job.half ? ` ${r.job.half} half` : ''})`, r.widthPt, r.heightPt, TRIM_PAGE_MM, TRIM_PAGE_MM);
    }
    const coverDoc = await PDFDocument.load(coverBytes);
    const [coverPdfPage] = coverDoc.getPages();
    const coverSpineMm = Number((coverPage.params as { spineMm?: number }).spineMm ?? 0);
    const coverWidthMm = PHYSICAL.pageSizeMm * 2 + coverSpineMm;
    assertSizeMm('cover', coverPdfPage.getWidth(), coverPdfPage.getHeight(), coverWidthMm, TRIM_PAGE_MM);

    // Step 6: assemble the interior PDF, in physical page order.
    const merged = await PDFDocument.create();
    for (const r of [...rendered].sort((a, b) => a.job.physicalPageNumber - b.job.physicalPageNumber)) {
      const src = await PDFDocument.load(r.pdfBytes);
      const [copied] = await merged.copyPages(src, [0]);
      merged.addPage(copied);
    }
    const interiorBytes = await merged.save();

    if (merged.getPageCount() !== pageCount) {
      throw new Error(`renderBookPdfs: FATAL — assembled interior PDF has ${merged.getPageCount()} pages, expected ${pageCount}`);
    }

    return {
      interiorPdf: Buffer.from(interiorBytes),
      coverPdf: Buffer.from(coverBytes),
      pageCount,
      checksums: { interior: sha256Hex(interiorBytes), cover: sha256Hex(coverBytes) },
      capacity: fitResult.capacity,
      gaps: fitResult.gaps,
      skipped: fitResult.skipped,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
}
