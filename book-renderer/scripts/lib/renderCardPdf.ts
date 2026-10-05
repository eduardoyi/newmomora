import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import puppeteer, { type Browser } from 'puppeteer';
import { PDFDocument } from 'pdf-lib';
import { cardGeometry } from '../../src/card/geometry';
import type { cardStats } from '../../src/card/document';
import { assertSizeMm, serveStatic } from './renderBookPdfs';

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
 *   - The page is the bleed (no TrimBox/BleedBox: Gelato misplaced the art
 *     when they were set). Gelato's API takes the back as a separate file, so
 *     `splitCardPdf` writes front/back single-page PDFs. (Chromium cannot write
 *     PDF/X-4 or an output intent: plain RGB PDF.)
 */

export interface RenderCardPdfOptions {
  /** Built `vite build --config vite.card.config.ts` output (dist-card). */
  distDir: string;
  /** Directory holding `<slug>/card.json` + `assets/`. */
  cardDataDir: string;
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
  port?: number;
}

export interface RenderCardPdfResult {
  pdf: Buffer;
  pageCount: number;
  /** Final page sizes in pt (after the pdf-lib pass). */
  pageSizesPt: [number, number][];
  orientation: 'landscape' | 'portrait';
  stats: ReturnType<typeof cardStats>;
  checksum: string;
}

function startServer(distDir: string, cardDataDir: string, port: number): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const decoded = decodeURIComponent(url.pathname);
    // /<slug>/card.json and /<slug>/assets/* come from card-data; the rest from the build.
    const slugMatch = /^\/([a-z0-9][a-z0-9-]*)\/(card\.json|edits\.json|assets\/.+)$/.exec(decoded);
    if (slugMatch) return serveStatic(cardDataDir, decoded, res);
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
  if (!fs.existsSync(path.join(options.cardDataDir, options.slug, 'card.json'))) {
    throw new Error(`renderCardPdf: card-data/${options.slug}/card.json missing — run eval:holiday-card-assets`);
  }
  const { server, port } = await startServer(options.distDir, options.cardDataDir, options.port ?? 0);
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
    page.on('pageerror', (e) => console.warn(`[card-pdf] page error: ${e.message}`));
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('[data-print-ready="true"]') !== null || document.querySelector('[data-print-error]') !== null, {
      timeout: 60000,
    });
    const errorMessage = await page.evaluate(() => document.querySelector('[data-print-error]')?.getAttribute('data-print-error') ?? null);
    if (errorMessage) throw new Error(`card print render error: ${errorMessage}`);
    await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
    const brokenImages = await page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode().catch(() => undefined))));
      // Fail loud on any image that never produced pixels (a 404'd photo must never print as a broken-image icon).
      return imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).map((img) => img.src.split('?')[0].slice(-80));
    });
    if (brokenImages.length > 0) throw new Error(`card print render: broken images: ${brokenImages.join(', ')}`);

    const stats = (await page.evaluate(() => (window as unknown as { __CARD_STATS__?: unknown }).__CARD_STATS__)) as RenderCardPdfResult['stats'] | undefined;
    if (!stats) throw new Error('card print render: no stats exposed (page did not finish fitting)');
    const orientation = stats.orientation;

    const raw = await page.pdf({ printBackground: true, preferCSSPageSize: true, timeout: 120000 });
    await page.close();

    // Validate the exact physical size of every page (MediaBox only).
    const g = cardGeometry(orientation, stats.format ?? '5R');
    const doc = await PDFDocument.load(raw);
    const pages = doc.getPages();
    if (pages.length !== 2) throw new Error(`renderCardPdf: FATAL — PDF has ${pages.length} pages, expected 2 (front + back)`);
    const sizes: [number, number][] = [];
    pages.forEach((p, i) => {
      assertSizeMm(i === 0 ? 'card front' : 'card back', p.getWidth(), p.getHeight(), g.pageW, g.pageH);
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
    return {
      pdf: Buffer.from(bytes),
      pageCount: pages.length,
      pageSizesPt: sizes,
      orientation,
      stats,
      checksum: crypto.createHash('sha256').update(bytes).digest('hex'),
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
