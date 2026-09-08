import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseManifest, parseOutline } from '../src/model/loader';
import { PHYSICAL } from '../src/model/types';
import { fitBookForPrint } from './lib/fitBookForPrint';
import { renderBookPdfs } from './lib/renderBookPdfs';

/**
 * Print pipeline CLI (memory-book-5c plan, Step 2c: thin wrapper). All the
 * actual work — fitting/page-counting (`fitBookForPrint`) and driving
 * Puppeteer over the built `print.html` (`renderBookPdfs`) — now lives in
 * `scripts/lib/`, as an importable library the future render worker
 * (`render/memory-book-renderer/`, a separate step) calls too, in-process,
 * with in-memory book data instead of this script's on-disk `book-data/
 * <slug>/` + `vite build`. This file's own job is unchanged: CLI arg
 * parsing, running `vite build` once (still required for local/CLI use —
 * the render worker's Docker image instead builds `dist/` once at image-
 * build time and never rebuilds per request, per Decision 3), and writing
 * the two output files + a human-readable report.
 *
 * PDF method / physical-size model / SLUG-mode data contract are all
 * unchanged from before this refactor — see `scripts/lib/renderBookPdfs.ts`
 * and `scripts/lib/fitBookForPrint.ts` for where that logic now lives.
 *
 * Usage:
 *   npm run book:pdf -- --slug <slug> --spine-mm <mm> [--out-dir <dir>]
 *                        [--port 4321] [--concurrency 4]
 *   (--spine-mm is required — query Prodigi's spine API for the real value
 *   per page count, see docs/plans/prodigi-order-spec.md §3; never guessed.)
 */

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

const TRIM_PAGE_MM = PHYSICAL.pageSizeMm;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Step 1: fit the book (Node-side, no browser — `fitBookForPrint`, the same
// cheap "no Chrome" call the future render worker's `/fit` op will make).
// Never print memory content — ids and counts only (project-wide rule).
// ---------------------------------------------------------------------------

const manifestPath = path.join(bookDataDir, 'manifest.json');
const outlinePath = path.join(bookDataDir, 'book.outline.json');
if (!fs.existsSync(manifestPath) || !fs.existsSync(outlinePath)) {
  console.error(`book-data/${slug}/ is missing manifest.json or book.outline.json`);
  process.exit(1);
}

const manifest = parseManifest(readJson(manifestPath));
const outline = parseOutline(readJson(outlinePath));

let fit;
try {
  fit = fitBookForPrint({ outline, manifest, spineMm });
} catch (e) {
  console.error(`[render-pdf] ${slug}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

console.log(`[render-pdf] ${slug}: fitBook totalPages=${fit.document.totalPages} (highest printed folio; cover and front-matter-verso blank uncounted), ${fit.document.pages.length} page entries`);
console.log(
  `[render-pdf] ${slug}: capacity — cap ${fit.capacity.cap}, overCap ${fit.capacity.overCap}, pairingLevelUsed ${fit.capacity.pairingLevelUsed}, omitted ${fit.capacity.omittedMemoryIds.length}`,
);
if (fit.gaps.length > 0) {
  console.log(`[render-pdf] ${slug}: ${fit.gaps.length} layout gap(s) reported by the fitter (see the preview's Gaps panel for detail)`);
}
console.log(
  `[render-pdf] ${slug}: skipped front-matter-verso blank (id ${fit.frontMatterVersoPageId}, no printed folio) from interior PDF — Prodigi's system inserts this inside-front-cover blank automatically`,
);
console.log(`[render-pdf] ${slug}: ${fit.pageCount} interior PDF pages will be produced (fitBook totalPages=${fit.document.totalPages}, cover and front-matter-verso blank uncounted)`);

// ---------------------------------------------------------------------------
// Step 2: production build (once — serves both index.html and print.html;
// `publicDir: 'book-data'` copies this book's manifest/outline/assets in
// too, which is what lets SLUG mode's `renderBookPdfs()` read them straight
// out of `dist/<slug>/` with no separate book-data path of its own).
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
// Step 3: render (renderBookPdfs — static server + Puppeteer, no vite at
// runtime; see scripts/lib/renderBookPdfs.ts).
// ---------------------------------------------------------------------------

console.log(`[render-pdf] ${slug}: rendering ${fit.jobs.length} interior page(s) at concurrency ${concurrency}…`);
const renderStart = Date.now();
let result;
try {
  result = await renderBookPdfs({
    servedDistDir: path.join(rootDir, 'dist'),
    spineMm,
    data: { mode: 'slug', slug },
    port,
    concurrency,
  });
} catch (e) {
  console.error(`[render-pdf] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
const renderMs = Date.now() - renderStart;

// ---------------------------------------------------------------------------
// Step 4: write both output files + report (ids/counts only — never memory
// content). `renderBookPdfs` already validated every page's exact physical
// size and the assembled interior's page count against `fit.pageCount`
// (throwing, which the try/catch above already turned into a clean exit).
// ---------------------------------------------------------------------------

const interiorPath = path.join(outDir, 'interior.pdf');
const coverPath = path.join(outDir, 'cover.pdf');
fs.writeFileSync(interiorPath, result.interiorPdf);
fs.writeFileSync(coverPath, result.coverPdf);

const interiorSizeMb = result.interiorPdf.length / (1024 * 1024);
const coverSizeMb = result.coverPdf.length / (1024 * 1024);
const coverSpineMm = spineMm;
const coverWidthMm = PHYSICAL.pageSizeMm * 2 + coverSpineMm;

console.log('');
console.log(`[render-pdf] ${slug}: DONE`);
console.log(`  interior: ${interiorPath} — ${result.pageCount} pages @ ${TRIM_PAGE_MM}x${TRIM_PAGE_MM}mm trim (no bleed), ${interiorSizeMb.toFixed(1)}MB`);
console.log(`  cover:    ${coverPath} — 1 page, ${coverSizeMb.toFixed(1)}MB (spine ${coverSpineMm}mm, ${coverWidthMm}x${TRIM_PAGE_MM}mm trim, no bleed)`);
console.log(`  checksums: interior sha256=${result.checksums.interior}  cover sha256=${result.checksums.cover}`);
console.log(`  render wall time: ${(renderMs / 1000).toFixed(1)}s (${fit.jobs.length} interior pages + 1 cover, concurrency ${concurrency})`);
