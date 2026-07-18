#!/usr/bin/env node
/**
 * render.mjs — renders every slide in manifest.json to a pixel-exact PNG
 * using headless Chromium (Playwright).
 *
 * Usage:
 *   node render.mjs                 # render every slide in manifest.json
 *   node render.mjs --id appstore-01-hero   # render a single slide by id
 *   node render.mjs --manifest custom.json  # use a different manifest file
 *
 * Output:
 *   out/appstore/<id>.png      (1260x2736)
 *   out/appstore-alt/<id>.png  (1320x2868)
 *   out/play/<id>.png          (1080x1920)
 *   out/feature/<id>.png       (1024x500)
 *
 * A manifest slide may declare `size: "appstore"` (one output) or
 * `sizes: ["appstore", "appstore-alt", "play"]` (one output per size).
 *
 * Each output's pixel dimensions are asserted against the expected size for
 * its `size` bucket after rendering; the script exits non-zero (and prints
 * which slide failed) if any mismatch.
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SIZES = {
  appstore: { w: 1260, h: 2736, outDir: "out/appstore" },
  "appstore-alt": { w: 1320, h: 2868, outDir: "out/appstore-alt" },
  play: { w: 1080, h: 1920, outDir: "out/play" },
  feature: { w: 1024, h: 500, outDir: "out/feature" },
  ipad: { w: 2064, h: 2752, outDir: "out/ipad" },
  "play-tablet7": { w: 1080, h: 1920, outDir: "out/play-tablet7" },
  "play-tablet10": { w: 1620, h: 2880, outDir: "out/play-tablet10" },
};

function parseArgs(argv) {
  const args = { manifest: "manifest.json", id: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") args.manifest = argv[++i];
    else if (argv[i] === "--id") args.id = argv[++i];
  }
  return args;
}

async function readPngDimensions(filePath) {
  // Minimal PNG header parser (avoids adding an image-size dependency).
  // PNG signature (8 bytes) + IHDR chunk: 4-byte length, 4-byte "IHDR",
  // then width (4 bytes) and height (4 bytes), big-endian.
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(24);
    await fh.read(buf, 0, 24, 0);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  } finally {
    await fh.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(__dirname, args.manifest);
  const manifestRaw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw);

  let slides = manifest.slides;
  if (args.id) {
    slides = slides.filter((s) => s.id === args.id);
    if (slides.length === 0) {
      console.error(`No slide with id "${args.id}" found in ${args.manifest}`);
      process.exit(1);
    }
  }

  // Expand each slide into one render job per size. A slide may declare
  // either `size: "appstore"` (single) or `sizes: ["appstore", "play", ...]`.
  const jobs = [];
  for (const slide of slides) {
    const sizeKeys = Array.isArray(slide.sizes) ? slide.sizes : [slide.size];
    for (const sizeKey of sizeKeys) {
      jobs.push({ ...slide, size: sizeKey });
    }
  }

  // Ensure output directories exist.
  for (const size of Object.values(SIZES)) {
    await fs.mkdir(path.resolve(__dirname, size.outDir), { recursive: true });
  }

  const browser = await chromium.launch();
  const results = [];
  let hadError = false;

  try {
    for (const slide of jobs) {
      const sizeInfo = SIZES[slide.size];
      if (!sizeInfo) {
        console.error(`Slide "${slide.id}" has unknown size "${slide.size}"`);
        hadError = true;
        continue;
      }

      const templatePath = path.resolve(__dirname, "templates", slide.template);
      const templateUrl = "file://" + templatePath + `?size=${encodeURIComponent(slide.size)}`;

      const page = await browser.newPage({
        viewport: { width: sizeInfo.w, height: sizeInfo.h },
        deviceScaleFactor: 1,
      });

      // Inject slide params (merged with size) before any script on the page
      // runs, so the template's own render() picks it up via window.__SLIDE__.
      const slideData = { ...slide.params, size: slide.size };
      await page.addInitScript((data) => {
        window.__SLIDE__ = data;
      }, slideData);

      await page.goto(templateUrl, { waitUntil: "load" });

      // Wait for the template's own render() to have run, all @font-face
      // fonts to be loaded, and all <img> elements to have finished loading
      // (including ones with broken/empty src, which we don't wait forever
      // on — Playwright's default navigation timeout still applies).
      await page.waitForFunction(() => document.documentElement.getAttribute("data-ready") === "true");
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(async () => {
        const imgs = Array.from(document.images);
        await Promise.all(
          imgs.map((img) => {
            if (img.complete) return Promise.resolve();
            return new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            });
          })
        );
      });

      const outPath = path.resolve(__dirname, sizeInfo.outDir, `${slide.id}.png`);
      await page.screenshot({ path: outPath, type: "png" });
      await page.close();

      const dims = await readPngDimensions(outPath);
      const ok = dims.width === sizeInfo.w && dims.height === sizeInfo.h;
      if (!ok) {
        hadError = true;
        console.error(
          `[FAIL] ${slide.id}: expected ${sizeInfo.w}x${sizeInfo.h}, got ${dims.width}x${dims.height} (${outPath})`
        );
      } else {
        console.log(`[OK]   ${slide.id} -> ${path.relative(__dirname, outPath)} (${dims.width}x${dims.height})`);
      }
      results.push({ id: slide.id, ok, outPath, dims, expected: { w: sizeInfo.w, h: sizeInfo.h } });
    }
  } finally {
    await browser.close();
  }

  if (hadError) {
    console.error("\nOne or more slides failed dimension verification.");
    process.exit(1);
  }

  console.log(`\nRendered ${results.length} slide(s) successfully.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
