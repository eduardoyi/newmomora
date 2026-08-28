#!/usr/bin/env node
/**
 * Illustration upscale comparison (V3 Phase 2, decision artifact, not
 * production code -- see docs/plans/prodigi-order-spec.md's appended
 * "AI-upscale options" section for the write-up this script's output feeds).
 *
 * Question this answers: Momora illustrations are generated at a fixed
 * 1024x1024px. Printed at up to 160mm (the largest a single illustration
 * spans in the book layout), that's ~163dpi -- below the commonly-cited
 * ~212dpi "safe" bar for coated photo-book stock. Does that actually look
 * bad once printed, or does the soft/painterly illustration style forgive
 * it? This script renders, for a few real illustrations, what (a) the
 * native 1024px source and (b) a classical lanczos3 upscale to ~2560px
 * actually look like at a simulated-300dpi 60x60mm patch, side by side, so
 * the owner can eyeball the honest answer instead of guessing from a DPI
 * number alone.
 *
 * Honesty check built into the method: lanczos3 is a *classical*
 * (interpolation-only) upscaler. It cannot invent detail that isn't in the
 * source -- it can only resample smoothly. If (b) looks meaningfully
 * better than (a) once printed, the improvement is coming entirely from
 * removing nearest-neighbor/bad-interpolation artifacts at the RIP stage,
 * NOT from added detail. If a genuine detail increase is needed, only a
 * learned/generative upscaler (real-ESRGAN, Topaz, etc. -- see the
 * appended doc section) or regenerating the source at higher resolution
 * can provide it.
 *
 * Usage: npm run generate   (from this directory, after `npm install`)
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCE_DIR = path.resolve(__dirname, '../../book-renderer/book-data/enzo-year-three/assets');
const OUTPUT_DIR = path.resolve(__dirname, '../../book-renderer/book-data/upscale-test');

// Deterministic, spread-out selection (not hand-picked "nicest" examples)
// out of the 71 illustration files present at research time -- indices
// 1, 24, 47 of the alphabetically-sorted list, i.e. roughly evenly spaced
// across the set.
const SAMPLE_FILES = [
  '01dc7b5d-ed77-436c-aed9-ca897432b228-illustration.webp',
  '4c81ecca-24cb-497b-9890-b211dcefa3ab-illustration.webp',
  '9a321ac3-4017-4f95-a21d-eb238e971333-illustration.webp',
];

const NATIVE_PX = 1024;
const UPSCALE_PX = 2560; // "~2560px" per the task brief -- exactly 2.5x.
const PRINT_MM = 160; // The largest a single illustration spans in the book layout (per task brief).
const PATCH_MM = 60; // Task-specified comparison patch size.
const DISPLAY_DPI = 300; // The "safe" bar being tested against.

const PATCH_DISPLAY_PX = Math.round((PATCH_MM / 25.4) * DISPLAY_DPI); // 709px

const nativeScalePxPerMm = NATIVE_PX / PRINT_MM; // 6.4
const nativePatchPx = Math.round(PATCH_MM * nativeScalePxPerMm); // 384

const upscaleScalePxPerMm = UPSCALE_PX / PRINT_MM; // 16
const upscalePatchPx = Math.round(PATCH_MM * upscaleScalePxPerMm); // 960

const nativeDpiAtPrintSize = (NATIVE_PX / PRINT_MM) * 25.4;
const upscaleDpiAtPrintSize = (UPSCALE_PX / PRINT_MM) * 25.4;

const THUMB_PX = 480;
const LABEL_HEIGHT = 118;
const TITLE_HEIGHT = 64;
const GAP = 28;
const MARGIN = 32;
const PANEL_W = PATCH_DISPLAY_PX;
const ROW_W = MARGIN * 2 + THUMB_PX + GAP + PANEL_W + GAP + PANEL_W;
const ROW_IMAGE_H = Math.max(THUMB_PX, PATCH_DISPLAY_PX);
const ROW_H = TITLE_HEIGHT + ROW_IMAGE_H + LABEL_HEIGHT + MARGIN;

const INK = '#2C2418';
const INK2 = '#6B5E4F';
const INK3 = '#9A8B79';
const BORDER = '#CFC8E0';
const BG = '#FAFAFD';
const BG_RGB = { r: 0xfa, g: 0xfa, b: 0xfd };
const ACCENT = '#D63E78';

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function svgToPng(svg, width, height) {
  return sharp(Buffer.from(svg), { density: 220 }).resize(width, height).png().toBuffer();
}

function textSvg(width, height, lines) {
  const tspans = lines
    .map(
      (line, i) =>
        `<text x="0" y="${i * line.lineHeight + line.baseline}" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="${line.size}" font-weight="${line.weight || 400}" fill="${line.color}">${escapeXml(line.text)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${tspans}</svg>`;
}

async function labelPanel(width, lines) {
  const height = LABEL_HEIGHT;
  return svgToPng(textSvg(width, height, lines), width, height);
}

/** Bordered frame + centered crop marker drawn onto the context thumbnail,
 * so the reader can see exactly where the 60mm patch was taken from --
 * important for honesty: a cherry-picked "easy" region would misrepresent
 * the finding. */
async function buildThumbnailWithMarker(sourceBuffer) {
  const thumb = await sharp(sourceBuffer)
    .resize(THUMB_PX, THUMB_PX, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  const markerFraction = nativePatchPx / NATIVE_PX; // fraction of the frame the 60mm patch covers
  const markerPx = Math.round(THUMB_PX * markerFraction);
  const markerOffset = Math.round((THUMB_PX - markerPx) / 2);

  const marker = `<svg xmlns="http://www.w3.org/2000/svg" width="${THUMB_PX}" height="${THUMB_PX}">
    <rect x="${markerOffset}" y="${markerOffset}" width="${markerPx}" height="${markerPx}"
      fill="none" stroke="${ACCENT}" stroke-width="3" stroke-dasharray="8 6" />
  </svg>`;

  return sharp(thumb)
    .composite([{ input: Buffer.from(marker), left: 0, top: 0 }])
    .png()
    .toBuffer();
}

async function buildNativePatch(sourceBuffer) {
  const offset = Math.round((NATIVE_PX - nativePatchPx) / 2);
  return sharp(sourceBuffer)
    .extract({ left: offset, top: offset, width: nativePatchPx, height: nativePatchPx })
    .resize(PATCH_DISPLAY_PX, PATCH_DISPLAY_PX, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
}

async function buildUpscaledPatch(sourceBuffer) {
  const upscaledFull = await sharp(sourceBuffer)
    .resize(UPSCALE_PX, UPSCALE_PX, { kernel: sharp.kernel.lanczos3 })
    .toBuffer();
  const offset = Math.round((UPSCALE_PX - upscalePatchPx) / 2);
  return sharp(upscaledFull)
    .extract({ left: offset, top: offset, width: upscalePatchPx, height: upscalePatchPx })
    // Downsize the (larger) upscaled crop to the same display canvas as the
    // native patch purely so the two sit at an equal size for side-by-side
    // comparison -- this step throws away a little of the interpolation's
    // (already-invented-nothing) smoothing, it does not add anything back.
    .resize(PATCH_DISPLAY_PX, PATCH_DISPLAY_PX, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
}

async function buildRow(filename, index) {
  const sourcePath = path.join(SOURCE_DIR, filename);
  const sourceBuffer = await readFile(sourcePath);
  const id = filename.replace('-illustration.webp', '');

  const [thumbnail, nativePatch, upscaledPatch] = await Promise.all([
    buildThumbnailWithMarker(sourceBuffer),
    buildNativePatch(sourceBuffer),
    buildUpscaledPatch(sourceBuffer),
  ]);

  const thumbLabel = await labelPanel(THUMB_PX, [
    { text: `Sample ${index + 1} -- ${id.slice(0, 8)}`, size: 15, weight: 600, color: INK, lineHeight: 20, baseline: 16 },
    { text: 'Full illustration, 1024x1024 native', size: 13, color: INK2, lineHeight: 18, baseline: 38 },
    { text: `Dashed box = the ${PATCH_MM}mm patch below`, size: 12, color: INK3, lineHeight: 17, baseline: 58 },
  ]);

  const nativeLabel = await labelPanel(PANEL_W, [
    { text: 'Native 1024px source', size: 15, weight: 600, color: INK, lineHeight: 20, baseline: 16 },
    { text: `${nativeDpiAtPrintSize.toFixed(0)} dpi at ${PRINT_MM}mm print size`, size: 13, color: INK2, lineHeight: 18, baseline: 38 },
    { text: `${PATCH_MM}x${PATCH_MM}mm patch, shown at simulated ${DISPLAY_DPI}dpi`, size: 12, color: INK3, lineHeight: 17, baseline: 58 },
    { text: 'No upscaling -- what actually prints today', size: 12, color: INK3, lineHeight: 17, baseline: 78 },
  ]);

  const upscaledLabel = await labelPanel(PANEL_W, [
    { text: `Lanczos3 upscale to ${UPSCALE_PX}px`, size: 15, weight: 600, color: INK, lineHeight: 20, baseline: 16 },
    { text: `${upscaleDpiAtPrintSize.toFixed(0)} dpi at ${PRINT_MM}mm print size`, size: 13, color: INK2, lineHeight: 18, baseline: 38 },
    { text: `Same ${PATCH_MM}x${PATCH_MM}mm patch, same simulated ${DISPLAY_DPI}dpi`, size: 12, color: INK3, lineHeight: 17, baseline: 58 },
    { text: 'Classical resample -- adds no new detail', size: 12, color: ACCENT, lineHeight: 17, baseline: 78 },
  ]);

  const title = await svgToPng(
    textSvg(ROW_W - MARGIN * 2, TITLE_HEIGHT, [
      { text: `${filename}`, size: 13, color: INK3, lineHeight: 18, baseline: 20 },
    ]),
    ROW_W - MARGIN * 2,
    TITLE_HEIGHT,
  );

  const thumbTop = TITLE_HEIGHT + Math.round((ROW_IMAGE_H - THUMB_PX) / 2);
  const patchTop = TITLE_HEIGHT + Math.round((ROW_IMAGE_H - PATCH_DISPLAY_PX) / 2);
  const thumbX = MARGIN;
  const nativeX = MARGIN + THUMB_PX + GAP;
  const upscaledX = nativeX + PANEL_W + GAP;

  const border = (x, y, w, h) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${BORDER}" stroke-width="1.5" />`;
  const borders = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_W}" height="${ROW_H}">
      ${border(thumbX, thumbTop, THUMB_PX, THUMB_PX)}
      ${border(nativeX, patchTop, PANEL_W, PATCH_DISPLAY_PX)}
      ${border(upscaledX, patchTop, PANEL_W, PATCH_DISPLAY_PX)}
    </svg>`,
  );

  return sharp({ create: { width: ROW_W, height: ROW_H, channels: 3, background: BG_RGB } })
    .composite([
      { input: title, left: MARGIN, top: 0 },
      { input: thumbnail, left: thumbX, top: thumbTop },
      { input: nativePatch, left: nativeX, top: patchTop },
      { input: upscaledPatch, left: upscaledX, top: patchTop },
      { input: borders, left: 0, top: 0 },
      { input: thumbLabel, left: thumbX, top: TITLE_HEIGHT + ROW_IMAGE_H + 8 },
      { input: nativeLabel, left: nativeX, top: TITLE_HEIGHT + ROW_IMAGE_H + 8 },
      { input: upscaledLabel, left: upscaledX, top: TITLE_HEIGHT + ROW_IMAGE_H + 8 },
    ])
    .png()
    .toBuffer();
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`Native patch: ${nativePatchPx}px source -> ${PATCH_DISPLAY_PX}px display (${nativeDpiAtPrintSize.toFixed(1)} dpi @ ${PRINT_MM}mm)`);
  console.log(`Upscaled patch: ${upscalePatchPx}px source -> ${PATCH_DISPLAY_PX}px display (${upscaleDpiAtPrintSize.toFixed(1)} dpi @ ${PRINT_MM}mm)`);

  const rows = [];
  for (const [index, filename] of SAMPLE_FILES.entries()) {
    console.log(`Processing sample ${index + 1}/${SAMPLE_FILES.length}: ${filename}`);
    const rowBuffer = await buildRow(filename, index);
    const id = filename.replace('-illustration.webp', '');
    const outPath = path.join(OUTPUT_DIR, `${index + 1}-${id.slice(0, 8)}-comparison.png`);
    await sharp(rowBuffer).toFile(outPath);
    console.log(`  wrote ${outPath}`);
    rows.push(rowBuffer);
  }

  // Combined single-glance grid: all rows stacked with a heading.
  const headingH = 90;
  const combinedW = ROW_W;
  const combinedH = headingH + rows.length * ROW_H;
  const heading = await svgToPng(
    textSvg(combinedW - MARGIN * 2, headingH, [
      { text: 'Illustration upscale comparison -- native 1024px vs. lanczos3 upscale to 2560px', size: 20, weight: 700, color: INK, lineHeight: 26, baseline: 30 },
      { text: `Simulated ${PATCH_MM}x${PATCH_MM}mm patch at ${DISPLAY_DPI}dpi, printed at ${PRINT_MM}mm illustration size`, size: 14, color: INK2, lineHeight: 20, baseline: 58 },
    ]),
    combinedW - MARGIN * 2,
    headingH,
  );

  const composite = [{ input: heading, left: MARGIN, top: 0 }];
  rows.forEach((rowBuffer, index) => {
    composite.push({ input: rowBuffer, left: 0, top: headingH + index * ROW_H });
  });

  const combinedPath = path.join(OUTPUT_DIR, '0-all-samples-comparison.png');
  await sharp({ create: { width: combinedW, height: combinedH, channels: 3, background: BG_RGB } })
    .composite(composite)
    .png()
    .toFile(combinedPath);
  console.log(`  wrote ${combinedPath}`);

  console.log('\nDone. Output is gitignored (book-renderer/book-data/* except sample/) -- review locally, do not commit.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
