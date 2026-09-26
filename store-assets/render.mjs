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
  "appstore-65": { w: 1284, h: 2778, outDir: "out/appstore-65" },
  play: { w: 1080, h: 1920, outDir: "out/play" },
  feature: { w: 1024, h: 500, outDir: "out/feature" },
  ipad: { w: 2064, h: 2752, outDir: "out/ipad" },
  "play-tablet7": { w: 1080, h: 1920, outDir: "out/play-tablet7" },
  "play-tablet10": { w: 1620, h: 2880, outDir: "out/play-tablet10" },
};

// Bucket keys that use the iPad capture set + iPad device frame / tablet
// param overrides (`*_tablet` suffix) inside the template. Mirrors
// templates/screenshot.html's own TABLET_SIZES set — kept here too so the
// native-resolution upscale guard (below) can resolve the right override.
const TABLET_SIZES = new Set(["ipad", "play-tablet7", "play-tablet10"]);

// ---------------------------------------------------------------------------
// Copy registry loader (WP-D §2) — screenshot headline/support/disclosure
// come ONLY from store-assets/listing/registry.v2.json. A manifest slide
// references copy with `params.copyRef: { list, id }` (list is
// "screenshots" | "opener_challengers" | "optional_ownership_replacement").
// If a slide ALSO hand-writes headline/support/disclosure, we fail unless
// they are byte-identical to the registry (drift guard) — see PLAN.md §1.3.
// ---------------------------------------------------------------------------

async function loadRegistry() {
  const registryPath = path.resolve(__dirname, "listing", "registry.v2.json");
  const raw = await fs.readFile(registryPath, "utf-8");
  return JSON.parse(raw);
}

function findCopyEntry(registry, ref) {
  const list = registry[ref.list];
  if (!Array.isArray(list)) {
    throw new Error(`copyRef.list "${ref.list}" not found in registry.v2.json`);
  }
  const entry = list.find((e) => e.id === ref.id);
  if (!entry) {
    throw new Error(`copyRef.id "${ref.id}" not found in registry.v2.json ${ref.list}`);
  }
  return entry;
}

function applyCopyRef(slide, registry) {
  if (!slide.params || !slide.params.copyRef) return slide;
  const entry = findCopyEntry(registry, slide.params.copyRef);
  const resolved = {
    headline: entry.headline,
    subline: entry.support,
    disclosure: entry.disclosure || undefined,
  };
  const merged = { ...slide.params };
  for (const [key, value] of Object.entries(resolved)) {
    if (value === undefined) continue;
    if (merged[key] !== undefined) {
      if (merged[key] !== value) {
        throw new Error(
          `Slide "${slide.id}": manifest ${key} drifted from registry.v2.json ${slide.params.copyRef.list}/${slide.params.copyRef.id}.\n` +
            `  manifest: ${JSON.stringify(merged[key])}\n  registry: ${JSON.stringify(value)}`
        );
      }
    } else {
      merged[key] = value;
    }
  }
  return { ...slide, params: merged };
}

function parseArgs(argv) {
  const args = { manifest: "manifest.json", id: null, outRoot: "out" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--manifest") args.manifest = argv[++i];
    else if (argv[i] === "--id") args.id = argv[++i];
    else if (argv[i] === "--out-root") args.outRoot = argv[++i];
  }
  return args;
}

// SIZES[key].outDir is authored as "out/<bucket>" for the default v1 root.
// --out-root lets a manifest render into a sibling tree (e.g. "out/v2",
// "out/v2-challenger-photo") without touching v1's own out/<bucket> paths.
function resolveOutDir(outDirV1, outRoot) {
  const bucket = outDirV1.replace(/^out\//, "");
  return path.join(outRoot, bucket);
}

async function readPngDimensions(filePath) {
  // Minimal PNG header parser (avoids adding an image-size dependency).
  // PNG signature (8 bytes) + IHDR chunk: 4-byte length, 4-byte "IHDR",
  // then width (4 bytes), height (4 bytes), bit depth (1 byte), and color
  // type (1 byte). Color type 2 = RGB (opaque, no alpha), 6 = RGBA, 3 =
  // indexed (may carry a tRNS alpha chunk), 0/4 = greyscale(+alpha).
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(26);
    await fh.read(buf, 0, 26, 0);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const colorType = buf.readUInt8(25);
    return { width, height, colorType, hasAlpha: colorType === 4 || colorType === 6 };
  } finally {
    await fh.close();
  }
}

// Resolve a param that may be a plain value or a `{ default, ipad, ... }`
// per-size-bucket override map (mirrors the template's own `*_tablet`
// convention, generalized to any bucket key so `card`/`inset` placements
// can differ between the iPhone buckets and the iPad bucket).
function resolveForSize(value, sizeKey) {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    if (Object.prototype.hasOwnProperty.call(value, sizeKey)) return value[sizeKey];
    if (Object.prototype.hasOwnProperty.call(value, "default")) return value.default;
  }
  return value;
}

// Standing rule (WP-D §1b): a `card`/`inset` crop must render at or below
// 100% of its native pixel resolution — never upscaled. This resolves each
// card/inset's rendered width for a given size bucket and throws loudly if
// it would exceed the source file's native width.
async function assertNoUpscale(slide, sizeKey, sizeInfo) {
  const params = slide.params || {};
  if (params.layout !== "card") return;

  const items = [];
  const cardsRaw = TABLET_SIZES.has(sizeKey) && params.cards_tablet ? params.cards_tablet : params.cards;
  for (const card of cardsRaw || []) items.push({ label: `card ${card.src}`, spec: card });

  const insetsRaw = TABLET_SIZES.has(sizeKey) && params.insets_tablet ? params.insets_tablet : params.insets;
  for (const inset of insetsRaw || []) {
    if (inset.placeholder) continue; // no pixels to check
    items.push({ label: `inset ${inset.src}`, spec: inset });
  }

  for (const { label, spec } of items) {
    if (!spec.src) continue;
    const widthPct = resolveForSize(spec.width_pct, sizeKey);
    if (widthPct == null) continue;
    const renderedWidth = (widthPct / 100) * sizeInfo.w;
    const assetPath = path.resolve(__dirname, "templates", spec.src);
    let native;
    try {
      native = await readPngDimensions(assetPath);
    } catch (err) {
      throw new Error(`Slide "${slide.id}" (${sizeKey}): cannot read ${label} at ${assetPath}: ${err.message}`);
    }
    if (renderedWidth > native.width + 0.5) {
      throw new Error(
        `Slide "${slide.id}" (${sizeKey}): ${label} would render at ${renderedWidth.toFixed(1)}px wide, ` +
          `exceeding its native width of ${native.width}px. Reduce width_pct for this bucket instead of upscaling.`
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(__dirname, args.manifest);
  const manifestRaw = await fs.readFile(manifestPath, "utf-8");
  const manifest = JSON.parse(manifestRaw);
  const registry = await loadRegistry();
  manifest.slides = manifest.slides.map((slide) => applyCopyRef(slide, registry));

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
    await fs.mkdir(path.resolve(__dirname, resolveOutDir(size.outDir, args.outRoot)), { recursive: true });
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

      await assertNoUpscale(slide, slide.size, sizeInfo);

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

      const outPath = path.resolve(__dirname, resolveOutDir(sizeInfo.outDir, args.outRoot), `${slide.id}.png`);
      await page.screenshot({ path: outPath, type: "png" });
      await page.close();

      const dims = await readPngDimensions(outPath);
      const ok = dims.width === sizeInfo.w && dims.height === sizeInfo.h && !dims.hasAlpha;
      if (dims.hasAlpha) {
        hadError = true;
        console.error(`[FAIL] ${slide.id}: output has an alpha channel (PNG color type ${dims.colorType}); required opaque RGB (${outPath})`);
      }
      if (dims.width !== sizeInfo.w || dims.height !== sizeInfo.h) {
        hadError = true;
        console.error(
          `[FAIL] ${slide.id}: expected ${sizeInfo.w}x${sizeInfo.h}, got ${dims.width}x${dims.height} (${outPath})`
        );
      }
      if (ok) {
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
