#!/usr/bin/env node
// store-assets/build-preview.mjs
//
// Builds review aids (NOT upload masters) under store-assets/preview/ from
// the already-rendered out/v2/** PNGs: per-bucket contact sheets (all 7
// defaults), a first-three row, ~390 CSS-pixel single-card views, and
// 120-140px-per-card legibility diagnostics, plus an index.html gallery.
//
// Uses the `sips` CLI (macOS, always present) for resizing/compositing via
// a tiny HTML->PNG-free approach: we build an HTML contact-sheet page and
// screenshot it with the same Playwright browser render.mjs already uses,
// so no new image-processing dependency is introduced.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_V2 = path.join(__dirname, "out", "v2");
const PREVIEW = path.join(__dirname, "preview");

const BUCKETS = ["appstore", "appstore-alt", "appstore-65", "ipad"];
const FRAMES = [
  "01-more-than-photos",
  "02-existing-photos",
  "03-unphotographed-stories",
  "04-little-voice",
  "05-optional-book",
  "06-private-family",
  "07-look-back",
];
const ASPECT = { appstore: 1260 / 2736, "appstore-alt": 1320 / 2868, "appstore-65": 1284 / 2778, ipad: 2064 / 2752 };

async function fileUrl(p) {
  return "file://" + path.resolve(p);
}

async function renderHtmlToPng(html, outPath, width, height) {
  // page.setContent() runs at the about:blank origin, which Chromium does
  // NOT allow to load file:// image sources (blocked as cross-origin). Write
  // the HTML to a real file:// document (next to the images it references,
  // same trick render.mjs itself uses for the screenshot template) and
  // page.goto() it instead, so the file:// <img> tags actually load.
  const tmpHtmlPath = outPath + ".tmp.html";
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(tmpHtmlPath, html, "utf-8");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.resolve(tmpHtmlPath), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const imgs = Array.from(document.images);
    await Promise.all(
      imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); })))
    );
  });
  await page.screenshot({ path: outPath, type: "png" });
  await browser.close();
  await fs.unlink(tmpHtmlPath);
}

function cardCss() {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; background: #EDEAF3; font-family: -apple-system, sans-serif; }
    .grid { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px; align-items: flex-start; }
    figure { margin: 0; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.12); }
    figure img { display: block; }
    figcaption { font-size: 13px; padding: 6px 10px; color: #333; background: #fff; border-top: 1px solid #eee; }
  `;
}

async function buildContactSheets() {
  for (const bucket of BUCKETS) {
    const thumbW = 240;
    const aspect = ASPECT[bucket];
    const thumbH = Math.round(thumbW / aspect);
    const items = FRAMES.map((f) => {
      const src = path.join(OUT_V2, bucket, `${f}.png`);
      return `<figure><img src="file://${src}" width="${thumbW}" height="${thumbH}"><figcaption>${f}</figcaption></figure>`;
    }).join("\n");
    const html = `<html><head><style>${cardCss()}</style></head><body><div class="grid">${items}</div></body></html>`;
    const cols = 4;
    const rows = Math.ceil(FRAMES.length / cols);
    const width = cols * (thumbW + 24) + 24;
    const height = rows * (thumbH + 24 + 30) + 24;
    await renderHtmlToPng(html, path.join(PREVIEW, "contact-sheets", `${bucket}.png`), width, height);
    console.log(`[contact-sheet] ${bucket}`);
  }
}

async function buildFirstThree() {
  for (const bucket of BUCKETS) {
    const thumbW = 340;
    const aspect = ASPECT[bucket];
    const thumbH = Math.round(thumbW / aspect);
    const items = FRAMES.slice(0, 3)
      .map((f) => {
        const src = path.join(OUT_V2, bucket, `${f}.png`);
        return `<figure><img src="file://${src}" width="${thumbW}" height="${thumbH}"><figcaption>${f}</figcaption></figure>`;
      })
      .join("\n");
    const html = `<html><head><style>${cardCss()}</style></head><body><div class="grid">${items}</div></body></html>`;
    const width = 3 * (thumbW + 24) + 24;
    const height = thumbH + 24 + 30 + 24;
    await renderHtmlToPng(html, path.join(PREVIEW, "first-three", `${bucket}.png`), width, height);
    console.log(`[first-three] ${bucket}`);
  }
}

// ~390 CSS-pixel single-card views: the appstore bucket (representative
// default iPhone width) plus both opener challengers, one PNG per frame.
async function buildSingleCards390() {
  const width = 390;
  const bucket = "appstore";
  const aspect = ASPECT[bucket];
  const height = Math.round(width / aspect);
  const allFrames = [...FRAMES];
  for (const f of allFrames) {
    const src = path.join(OUT_V2, bucket, `${f}.png`);
    const html = `<html><head><style>body{margin:0;}img{display:block;width:${width}px;height:${height}px;}</style></head><body><img src="file://${src}"></body></html>`;
    await renderHtmlToPng(html, path.join(PREVIEW, "cards-390", `${f}.png`), width, height);
  }
  // Opener challenger frame 1s too.
  const challengers = [
    { file: path.join(__dirname, "out", "v2-challenger-photo", bucket, "existing-photo-first.png"), id: "existing-photo-first" },
    { file: path.join(__dirname, "out", "v2-challenger-voice", bucket, "voice-first.png"), id: "voice-first" },
  ];
  for (const c of challengers) {
    const html = `<html><head><style>body{margin:0;}img{display:block;width:${width}px;height:${height}px;}</style></head><body><img src="file://${c.file}"></body></html>`;
    await renderHtmlToPng(html, path.join(PREVIEW, "cards-390", `${c.id}.png`), width, height);
  }
  console.log(`[cards-390] ${allFrames.length + challengers.length} cards`);
}

// 120-140px-per-card legibility diagnostics: same set, much smaller, to
// check whether headline/support/draft-banner still read at thumbnail size.
async function buildLegibilityDiagnostics() {
  const width = 130;
  const bucket = "appstore";
  const aspect = ASPECT[bucket];
  const height = Math.round(width / aspect);
  const items = FRAMES.map((f) => {
    const src = path.join(OUT_V2, bucket, `${f}.png`);
    return `<figure><img src="file://${src}" width="${width}" height="${height}"><figcaption>${f}</figcaption></figure>`;
  }).join("\n");
  const html = `<html><head><style>${cardCss()} figcaption{font-size:10px;}</style></head><body><div class="grid">${items}</div></body></html>`;
  const cols = 7;
  const w = cols * (width + 16) + 16;
  const h = height + 16 + 26 + 16;
  await renderHtmlToPng(html, path.join(PREVIEW, "legibility", `${bucket}.png`), w, h);
  console.log(`[legibility] ${bucket}`);
}

async function buildIndex() {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Momora v2 store-asset previews (review aids, not upload masters)</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #FAFAFD; color: #2C2418; padding: 32px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 40px; border-bottom: 1px solid #EBE7F2; padding-bottom: 6px; }
  a { color: #B22A60; }
  ul { line-height: 1.9; }
  .note { background: #FDEAF1; border-radius: 8px; padding: 12px 16px; font-size: 14px; }
</style></head>
<body>
<h1>Momora v2 store-asset previews</h1>
<p class="note">Review aids only — not App Store upload masters. Upload masters live in <code>out/v2/&lt;bucket&gt;/</code> and the explicit allowlist is <code>out/v2/UPLOAD-CANDIDATES.json</code> (only 07-look-back is non-draft).</p>

<h2>Contact sheets (all 7 defaults, per bucket)</h2>
<ul>${BUCKETS.map((b) => `<li><a href="contact-sheets/${b}.png">${b}</a></li>`).join("\n")}</ul>

<h2>First-three row (frames 1-3, the load-bearing opening, per bucket)</h2>
<ul>${BUCKETS.map((b) => `<li><a href="first-three/${b}.png">${b}</a></li>`).join("\n")}</ul>

<h2>~390 CSS-pixel single-card views (appstore bucket)</h2>
<ul>${[...FRAMES, "existing-photo-first", "voice-first"].map((f) => `<li><a href="cards-390/${f}.png">${f}</a></li>`).join("\n")}</ul>

<h2>120-140px-per-card legibility diagnostics (appstore bucket, all 7 defaults)</h2>
<ul><li><a href="legibility/appstore.png">legibility/appstore.png</a></li></ul>

<h2>Byte-identity proof (opener challengers, frames 02-07)</h2>
<ul><li><a href="../out/v2/HASHES.txt">out/v2/HASHES.txt</a></li></ul>

<h2>Upload allowlists</h2>
<ul>
<li><a href="../out/v2/UPLOAD-CANDIDATES.json">defaults: out/v2/UPLOAD-CANDIDATES.json</a></li>
<li><a href="../out/v2-challenger-photo/UPLOAD-CANDIDATES.json">challenger photo: out/v2-challenger-photo/UPLOAD-CANDIDATES.json</a></li>
<li><a href="../out/v2-challenger-voice/UPLOAD-CANDIDATES.json">challenger voice: out/v2-challenger-voice/UPLOAD-CANDIDATES.json</a></li>
</ul>
</body></html>`;
  await fs.mkdir(PREVIEW, { recursive: true });
  await fs.writeFile(path.join(PREVIEW, "index.html"), html, "utf-8");
  console.log("[index] preview/index.html");
}

async function main() {
  await buildContactSheets();
  await buildFirstThree();
  await buildSingleCards390();
  await buildLegibilityDiagnostics();
  await buildIndex();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
