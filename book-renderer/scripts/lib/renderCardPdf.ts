import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import puppeteer, { type Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { cardGeometry } from '../../src/card/geometry';
import type { cardStats } from '../../src/card/document';
import { CardRenderError, isCardErrorCode } from '../../src/card/errors';
import { assertSizeMm, mmToPt, serveStatic } from './renderBookPdfs';
import { inspectPdf } from './cardPdfChecks';

/**
 * `renderCardPdf()` — the holiday card's print pipeline (docs/plans/holiday-cards.md C3).
 * Same Puppeteer approach as `renderBookPdfs` (a static server over a prebuilt
 * dist, no vite at runtime, `data-print-ready` / `data-print-error` readiness,
 * explicit font and image checks, `page.pdf({ preferCSSPageSize })`), pointed
 * at `card-print.html`. Differences from the book flow:
 *
 *   - The file INCLUDES the 4 mm bleed on every side (Gelato wants it in the
 *     file; the book flow submits trim-size files because Prodigi adds bleed).
 *   - ONE PDF, page 1 = front, page 2 = back.
 *   - `card-data/<slug>/` (real family photos and letters) is served by this
 *     module's own server from `cardDataDir`; it is never copied into `distDir`.
 *   - Service path (docs/plans/holiday-cards-p1.md Step 5): `inline` hands the
 *     card document and edits in as values (served from memory, never written to
 *     disk) and the pictures as a directory the caller filled; no card-data on
 *     disk is involved. Hard failures are thrown as typed `CardRenderError`s.
 *     Fonts/page boxes are checked with pdf-lib (`cardPdfChecks.ts`), no poppler.
 *   - The page is the bleed (no TrimBox/BleedBox: Gelato misplaced the art
 *     when they were set). Gelato's API takes the back as a separate file, so
 *     `splitCardPdf` writes front/back single-page PDFs. (Chromium cannot write
 *     PDF/X-4 or an output intent: plain RGB PDF.)
 */

export interface RenderCardPdfOptions {
  /** Built `vite build --config vite.card.config.ts` output (dist-card). */
  distDir: string;
  /** Directory holding `<slug>/card.json` + `assets/` (local CLI path; required unless `inline`). */
  cardDataDir?: string;
  /** Service path: the card document + edits as values and the directory the pictures were written to. */
  inline?: {
    card: unknown;
    edits?: unknown;
    /** `<assetsDir>/<file>` for every `file` the card document references. */
    assetsDir: string;
  };
  slug: string;
  /** `full-bleed` | `bordered` | `illustrated:<id>` */
  /** `full-bleed` | `bordered` | `illustrated:<id>`; omit to print the editor's saved choice. */
  front?: string;
  tone?: string;
  greeting?: string;
  qr?: boolean;
  orientation?: 'landscape' | 'portrait';
  position?: string;
  allowOverflow?: boolean;
  /** false = print without the family portraits by the signature. */
  portraits?: boolean;
  /** false = ignore card-data/<slug>/edits.json (print the generated card). */
  useEdits?: boolean;
  /** Hard floor for the front picture's effective dpi (throws IMAGE_LOW_RES below it). Omit = warning only, as in the CLI. */
  minFrontDpi?: number;
  port?: number;
}

export interface CardPdfChecks {
  pageWidthMm: number;
  pageHeightMm: number;
  pages: number;
  letterPt: number;
  letterFits: boolean;
  frontDpi: number;
  fontsEmbedded: boolean;
}

export interface RenderCardPdfResult {
  pdf: Buffer;
  pageCount: number;
  /** Final page sizes in pt (after the pdf-lib pass). */
  pageSizesPt: [number, number][];
  orientation: 'landscape' | 'portrait';
  stats: ReturnType<typeof cardStats>;
  checksum: string;
  checks: CardPdfChecks;
}

function sendJson(res: http.ServerResponse, data: unknown): void {
  const body = JSON.stringify(data ?? {});
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function startServer(distDir: string, source: { cardDataDir: string } | { slug: string; card: unknown; edits: unknown; assetsDir: string }, port: number): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    if ('card' in source) {
      // Inline: /<slug>/card.json + edits.json from memory, /<slug>/<file> from the assets directory.
      const prefix = `/${source.slug}/`;
      if (decoded === `${prefix}card.json`) return sendJson(res, source.card);
      if (decoded === `${prefix}edits.json`) return sendJson(res, source.edits);
      if (decoded.startsWith(prefix)) return serveStatic(source.assetsDir, decoded.slice(prefix.length - 1), res);
      return serveStatic(distDir, decoded, res);
    }
    // /<slug>/card.json and /<slug>/assets/* come from card-data; the rest from the build.
    const slugMatch = /^\/([a-z0-9][a-z0-9-]*)\/(card\.json|edits\.json|assets\/.+)$/.exec(decoded);
    if (slugMatch) return serveStatic(source.cardDataDir, decoded, res);
    serveStatic(distDir, decoded, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('renderCardPdf: no server port'));
      resolve({ server, port: address.port });
    });
  });
}

export async function renderCardPdf(options: RenderCardPdfOptions): Promise<RenderCardPdfResult> {
  if (!fs.existsSync(path.join(options.distDir, 'card-print.html'))) {
    throw new Error(`renderCardPdf: ${options.distDir}/card-print.html missing — run "npm run card:build" first`);
  }
  const inline = options.inline;
  if (!inline) {
    if (!options.cardDataDir || !fs.existsSync(path.join(options.cardDataDir, options.slug, 'card.json'))) {
      throw new Error(`renderCardPdf: card-data/${options.slug}/card.json missing — run eval:holiday-card-assets`);
    }
  }
  const { server, port } = await startServer(
    options.distDir,
    inline ? { slug: options.slug, card: inline.card, edits: inline.edits ?? {}, assetsDir: inline.assetsDir } : { cardDataDir: options.cardDataDir! },
    options.port ?? 0,
  );
  let browser: Browser | null = null;
  try {
    // Same posture as renderBookPdfs: our own HTML against local files, so the setuid sandbox is dropped (root in Docker).
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const query = new URLSearchParams({ slug: options.slug });
    if (options.front) query.set('front', options.front);
    if (options.tone) query.set('tone', options.tone);
    if (options.greeting) query.set('greeting', options.greeting);
    if (options.qr !== undefined) query.set('qr', options.qr ? '1' : '0');
    if (options.orientation) query.set('orientation', options.orientation);
    if (options.position) query.set('position', options.position);
    if (options.allowOverflow) query.set('allowOverflow', '1');
    if (options.portraits !== undefined) query.set('portraits', options.portraits ? '1' : '0');
    if (options.useEdits === false) query.set('edits', '0');
    const url = `http://127.0.0.1:${port}/card-print.html?${query}`;

    const page = await browser.newPage();
    // Everything the card needs is on the loopback server; refuse any other network request (defence in depth: no URL in the card document is ever fetched).
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('http://127.0.0.1:') || u.startsWith('data:') || u.startsWith('blob:')) void r.continue();
      else void r.abort();
    });
    page.on('pageerror', (e: unknown) => console.warn(`[card-pdf] page error: ${e instanceof Error ? e.message : String(e)}`));
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('[data-print-ready="true"]') !== null || document.querySelector('[data-print-error]') !== null, {
      timeout: 60000,
    });
    const printError = await page.evaluate(() => {
      const el = document.querySelector('[data-print-error]');
      return el ? { message: el.getAttribute('data-print-error') ?? '', code: el.getAttribute('data-print-error-code') } : null;
    });
    if (printError) {
      const message = `card print render error: ${printError.message}`;
      if (isCardErrorCode(printError.code)) throw new CardRenderError(printError.code, message);
      throw new Error(message);
    }
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const brokenImages = await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode().catch(() => undefined))));
      // Fail loud on any image that never produced pixels (a 404'd photo must never print as a broken-image icon).
      return imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.src.split('?')[0].slice(-80));
    });
    if (brokenImages.length > 0) throw new CardRenderError('IMAGE_MISSING', `card print render: ${brokenImages.length} broken image(s): ${brokenImages.join(', ')}`);

    const stats = (await page.evaluate(() => (window as unknown as { __CARD_STATS__?: unknown }).__CARD_STATS__)) as RenderCardPdfResult['stats'] | undefined;
    if (!stats) throw new Error('card print render: no stats exposed (page did not finish fitting)');
    const orientation = stats.orientation;
    if (options.minFrontDpi !== undefined && stats.frontDpi < options.minFrontDpi) {
      throw new CardRenderError('IMAGE_LOW_RES', `the front picture is ${stats.frontDpi} dpi at the placed size (minimum ${options.minFrontDpi})`);
    }

    const raw = await page.pdf({ printBackground: true, preferCSSPageSize: true, timeout: 120000 });
    await page.close();

    // Validate the exact physical size of every page (MediaBox only).
    const g = cardGeometry(orientation, stats.format ?? '5R');
    const doc = await PDFDocument.load(raw);
    const pages = doc.getPages();
    if (pages.length !== 2) throw new CardRenderError('PAGE_SIZE', `renderCardPdf: FATAL — PDF has ${pages.length} pages, expected 2 (front + back)`);
    const sizes: [number, number][] = [];
    pages.forEach((p, i) => {
      try {
        assertSizeMm(i === 0 ? 'card front' : 'card back', p.getWidth(), p.getHeight(), g.pageW, g.pageH);
      } catch (e) {
        throw new CardRenderError('PAGE_SIZE', e instanceof Error ? e.message : String(e));
      }
      const w = p.getWidth();
      const h = p.getHeight();
      // The page IS the bleed (trim + 4 mm every side, Gelato's rule). No
      // TrimBox/BleedBox: Gelato's preview read the TrimBox and shifted the
      // artwork 4 mm, leaving white strips on the right and bottom (owner's
      // sample draft, 2026-10-05).
      p.setMediaBox(0, 0, w, h);
      sizes.push([w, h]);
    });
    doc.setTitle('Momora holiday card');
    doc.setProducer('Momora card renderer (Chromium + pdf-lib)');
    const bytes = await doc.save();

    // Pure-JS checks of the final bytes (no poppler): exact page boxes, no Trim/Bleed boxes, fonts embedded, no Type 3.
    const inspection = await inspectPdf(bytes);
    const boxed = inspection.pages.filter((p) => p.extraBoxes.length > 0);
    if (boxed.length > 0) throw new CardRenderError('PAGE_SIZE', `renderCardPdf: PDF pages carry ${boxed[0].extraBoxes.join('/')} (the page must be the bleed, no extra boxes)`);
    if (!inspection.fontsEmbedded) {
      throw new CardRenderError(
        'FONTS',
        `renderCardPdf: ${inspection.fonts.length} fonts, ${inspection.type3Count} Type 3, ${inspection.notEmbeddedCount} not embedded (every font must be embedded, none Type 3)`,
      );
    }
    const [firstW, firstH] = sizes[0];
    return {
      pdf: Buffer.from(bytes),
      pageCount: pages.length,
      pageSizesPt: sizes,
      orientation,
      stats,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
      checks: {
        pageWidthMm: Math.round((firstW / mmToPt(1)) * 100) / 100,
        pageHeightMm: Math.round((firstH / mmToPt(1)) * 100) / 100,
        pages: pages.length,
        letterPt: stats.letterPt,
        letterFits: stats.letterFits,
        frontDpi: stats.frontDpi,
        fontsEmbedded: inspection.fontsEmbedded,
      },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Gelato's order API wants the front and the back as separate files
 * (`type: "default"` and `type: "back"`): one single-page PDF each. */
export async function splitCardPdf(pdf: Uint8Array): Promise<{ front: Uint8Array; back: Uint8Array }> {
  const doc = await PDFDocument.load(pdf);
  if (doc.getPageCount() !== 2) throw new Error(`splitCardPdf: expected 2 pages, got ${doc.getPageCount()}`);
  const one = async (index: number) => {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(doc, [index]);
    out.addPage(page);
    out.setTitle(index === 0 ? 'Momora holiday card (front)' : 'Momora holiday card (back)');
    out.setProducer('Momora card renderer (Chromium + pdf-lib)');
    return out.save();
  };
  return { front: await one(0), back: await one(1) };
}
