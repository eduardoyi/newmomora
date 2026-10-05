import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderCardPdf, splitCardPdf } from './lib/renderCardPdf';

/**
 * Holiday card print CLI (docs/plans/holiday-cards.md C3).
 *
 *   npm run card:pdf -- --slug <slug> [--front full-bleed|bordered|illustrated:<id>]
 *                       [--tone classic] [--greeting christmas|holidays|new-year]
 *                       [--no-qr] [--orientation landscape|portrait] [--position top-center]
 *                       [--out-dir <dir>] [--no-raster] [--skip-build]
 *                       [--no-portraits] [--no-edits]   (edits = card-data/<slug>/edits.json, the editor's saved state)
 *   npm run card:pdf -- --slug <slug> --saved          the editor's saved choices, as is
 *   npm run card:pdf -- --slug <slug> --review      the review set (below)
 *
 * Output: card-data/<slug>/print/<front>-<tone>[-noqr].pdf — 2 pages, exact page
 * size WITH 4 mm bleed (page 1 = front, page 2 = back) — plus, unless
 * --no-raster, a 300 dpi PNG per page (pdftoppm), the pdffonts table and the
 * pdfimages table (effective dpi of every placed picture) beside it.
 * stdout is sizes, counts and ids only; never letter text.
 *
 * Review set: full-bleed and bordered × classic, illustrated winter-walk ×
 * classic (portrait), and one no-QR back (bordered × classic).
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
    } else out[key] = 'true';
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');
const cardDataDir = path.join(rootDir, 'card-data');
const slug = args.slug;
if (!slug) {
  console.error('Usage: npm run card:pdf -- --slug <slug> [--front full-bleed|bordered|illustrated:<id>] [--tone classic] [--no-qr] [--review]');
  process.exit(1);
}
const outDir = args['out-dir'] ? path.resolve(args['out-dir']) : path.join(cardDataDir, slug, 'print');
fs.mkdirSync(outDir, { recursive: true });

interface Job {
  front?: string;
  tone?: string;
  qr?: boolean;
}
const jobs: Job[] = args.review
  ? [
      { front: 'full-bleed', tone: 'classic' },
      { front: 'bordered', tone: 'classic' },
      { front: 'illustrated:winter-walk', tone: 'classic' },
      { front: 'bordered', tone: 'classic', qr: false },
    ]
  : args.saved
    ? [{ front: undefined, tone: undefined }]
    : [{ front: args.front ?? 'full-bleed', tone: args.tone ?? 'classic', qr: args['no-qr'] ? false : undefined }];

if (!args['skip-build']) {
  console.log('[card-pdf] building (vite build, print entry only)…');
  const build = spawnSync('npx', ['vite', 'build', '--config', 'vite.card.config.ts', '--logLevel', 'warn'], { cwd: rootDir, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('[card-pdf] vite build failed');
    process.exit(1);
  }
}

function tool(cmd: string, argv: string[]): string | null {
  const r = spawnSync(cmd, argv, { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout + r.stderr;
}

let failed = 0;
for (const job of jobs) {
  const name = job.front ? `${job.front.replace(':', '-')}-${job.tone}${job.qr === false ? '-noqr' : ''}` : 'saved';
  const pdfPath = path.join(outDir, `${name}.pdf`);
  try {
    const t0 = Date.now();
    const result = await renderCardPdf({
      distDir: path.join(rootDir, 'dist-card'),
      cardDataDir,
      slug,
      front: job.front,
      tone: job.tone,
      qr: job.qr,
      greeting: args.greeting,
      portraits: args['no-portraits'] ? false : undefined,
      useEdits: args['no-edits'] ? false : undefined,
      orientation: args.orientation as 'landscape' | 'portrait' | undefined,
      position: args.position,
      allowOverflow: !!args['allow-overflow'],
    });
    fs.writeFileSync(pdfPath, result.pdf);
    // Gelato takes front and back as separate files (default / back).
    const { front, back } = await splitCardPdf(result.pdf);
    fs.writeFileSync(pdfPath.replace(/\.pdf$/, '-front.pdf'), front);
    fs.writeFileSync(pdfPath.replace(/\.pdf$/, '-back.pdf'), back);
    const s = result.stats;
    console.log(`\n[card-pdf] ${name}: ${result.pageCount} pages, ${s.orientation} ${s.pageMm[0]}x${s.pageMm[1]} mm (trim ${s.trimMm[0]}x${s.trimMm[1]}), ${(result.pdf.length / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(
      `  front: ${s.frontPixels[0]}x${s.frontPixels[1]} px placed ${s.placedMm[0]}x${s.placedMm[1]} mm = ${s.frontDpi} dpi, crop ${(s.frontCrop[0] * 100).toFixed(0)}%/${(s.frontCrop[1] * 100).toFixed(0)}%`,
    );
    console.log(`  picture covers ${(s.pictureShareOfTrim * 100).toFixed(0)}% of the trim area (${s.frontLayout})`);
    console.log(`  back: letter ${s.letterPt} pt, ${s.letterLines} lines, fits ${s.letterFits}${s.letterCappedByMax ? ' (at max size)' : ''}; QR ${s.qrMm ?? 'off'} mm; portraits ${s.portraitCount ? `${s.portraitCount} x ${s.portraitMm} mm` : 'none'}`);
    if (s.warnings.length) console.log(`  warnings: ${s.warnings.join('; ')}`);
    console.log(`  sha256 ${result.checksum.slice(0, 16)}…  ${pdfPath}`);

    if (!args['no-raster']) {
      const base = path.join(outDir, name);
      const r = spawnSync('pdftoppm', ['-r', '300', '-png', pdfPath, base], { encoding: 'utf-8' });
      if (r.error || r.status !== 0) console.log('  raster: pdftoppm unavailable or failed (install poppler)');
      else {
        const pngs = fs.readdirSync(outDir).filter((f) => f.startsWith(`${name}-`) && f.endsWith('.png')).sort();
        console.log(`  raster 300 dpi: ${pngs.join(', ')}`);
      }
      const fonts = tool('pdffonts', [pdfPath]);
      if (fonts) {
        fs.writeFileSync(`${base}.pdffonts.txt`, fonts);
        const rows = fonts.trim().split('\n').slice(2);
        const type3 = rows.filter((l) => /\bType 3\b/.test(l)).length;
        const notEmb = rows.filter((l) => !/\byes\s+(yes|no)\s+(yes|no)\s+\d/.test(l)).length;
        console.log(`  pdffonts: ${rows.length} fonts, Type 3: ${type3}, not embedded: ${notEmb}`);
        if (type3 > 0) throw new Error(`${name}: Type 3 fonts in the PDF`);
      }
      const images = tool('pdfimages', ['-list', pdfPath]);
      if (images) {
        fs.writeFileSync(`${base}.pdfimages.txt`, images);
        const rows = images.trim().split('\n').slice(2).map((l) => l.trim().split(/\s+/));
        console.log(`  pdfimages: ${rows.map((c) => `p${c[0]} ${c[3]}x${c[4]}px ${c[5]} ${c[12]}x${c[13]}ppi`).join('; ')}`);
      }
    }
  } catch (e) {
    failed++;
    console.error(`[card-pdf] ${name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(failed ? 1 : 0);
