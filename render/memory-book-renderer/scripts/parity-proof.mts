import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

import { parseManifest, parseOutline } from '../../../book-renderer/src/model/loader';
import { fitBookForPrint } from '../../../book-renderer/scripts/lib/fitBookForPrint';
import { renderBookPdfs } from '../../../book-renderer/scripts/lib/renderBookPdfs';
import type { MemoryBookEditsShape } from '../../../book-renderer/src/model/edits';
import type { BookManifest } from '../../../book-renderer/src/model/types';

import { createR2Client, presignMany } from '../src/r2';
import { planPresign } from '../src/manifestRewrite';
import { sign } from '../src/crypto';

/**
 * REAL end-to-end parity proof (memory-book-5c plan, Step 3's acceptance —
 * task brief: "docker build, docker run with real R2 env … POST a real
 * /render for an EDITED book … Compare the produced PDFs against
 * renderBookPdfs run directly on the host with the same inputs"). This
 * script does not mock or fake ANY of its steps: real `docker build`, a
 * real container against real R2 credentials, real HTTP round trips over
 * presigned URLs, a real Puppeteer render inside the container AND a
 * second real Puppeteer render on the host.
 *
 * ── Why this uploads the fixture's local bytes to a scoped R2 test prefix ──
 * `book-renderer/book-data/enzo-year-one/manifest.json` is a REAL exported
 * family book, but its asset `file` values are deliberately anonymized
 * BASENAMES, not real bucket object keys — see
 * `supabase/scripts/eval-memory-book-assets.ts`'s own `objectKeyBasename`
 * doc comment ("never the full key, which carries a user/family id"). A
 * presigned GET against those bare basenames would 404 against the real
 * bucket. So this script uploads the fixture's own local asset bytes to R2
 * under `render-worker-parity-test/<orderId>/…` first, rewrites the
 * manifest/edits to those keys (a plain key rename — `planPresign`'s own
 * `rewrite()` is reused for this, since remapping "object key -> object
 * key" and "object key -> presigned URL" are the identical operation
 * shape), and cleans the uploaded objects up at the end. Every fetch that
 * follows is still a REAL R2 round trip against the REAL bucket with REAL
 * credentials — only the object KEYS are test-scoped, never faked data.
 *
 * ── The edits under test ──
 * imageReplace + coverPhoto + text + focalPoint, built from real asset keys
 * in the manifest (four distinct memories' own photo assets — see
 * `pickEditTargets` below). focalPoint targets a DIFFERENT slot than
 * imageReplace deliberately: `applyPreFit`'s substitution changes
 * `asset.file` in place, so a focal-point edit keyed by the PRE-substitution
 * slot key would no longer match `content.assetFile` in the fitted document
 * and would just orphan silently — targeting a different, untouched slot
 * is what actually exercises the focal-point apply path.
 *
 * Usage: `npm run parity-proof` from render/memory-book-renderer/, with
 * R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_ENDPOINT/R2_BUCKET
 * already in the environment (e.g. `set -a && source ../../supabase/.env.local
 * && set +a && npm run parity-proof`). Never prints credential VALUES, only
 * ids/counts/checksums — the project-wide "no memory content in logs" rule
 * also means this script never prints a memory's own text/caption.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDER_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(RENDER_DIR, '..', '..');
const BOOK_RENDERER_DIR = path.resolve(REPO_ROOT, 'book-renderer');
const BOOK_SLUG = 'enzo-year-one';
const BOOK_DATA_DIR = path.join(BOOK_RENDERER_DIR, 'book-data', BOOK_SLUG);
const SPINE_MM = 28; // Fixed test value (not Prodigi-quoted) — matches the pinned regression value used elsewhere in this repo's own test suite (fitBookForPrint.test.ts).
const IMAGE_TAG = 'memory-book-renderer:parity-proof';
const CONTAINER_NAME = 'memory-book-renderer-parity-proof';
const CONTAINER_PORT = 18099;

function log(message: string): void {
  console.log(`[parity-proof] ${message}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`parity-proof: missing required env var ${name} (source supabase/.env.local first)`);
  return value;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Step 0: real R2 credentials + client (this script's own presign pass, and
// the object uploads, all go through the SAME createR2Client the render
// worker itself uses — src/r2.ts, not a copy).
// ---------------------------------------------------------------------------

const r2Config = {
  accountId: requireEnv('R2_ACCOUNT_ID'),
  accessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  endpoint: requireEnv('R2_ENDPOINT'),
  bucket: requireEnv('R2_BUCKET'),
};
const r2 = createR2Client(r2Config);

const orderId = crypto.randomUUID();
const attemptId = crypto.randomUUID();
const hmacSecret = crypto.randomBytes(32).toString('hex');
const testPrefix = `render-worker-parity-test/${orderId}/`;

log(`orderId=${orderId} attemptId=${attemptId} bucket=${r2Config.bucket} (ids only — never memory content)`);

// ---------------------------------------------------------------------------
// Step 1: load the real fixture book.
// ---------------------------------------------------------------------------

const manifest = parseManifest(JSON.parse(fs.readFileSync(path.join(BOOK_DATA_DIR, 'manifest.json'), 'utf8')));
const outline = parseOutline(JSON.parse(fs.readFileSync(path.join(BOOK_DATA_DIR, 'book.outline.json'), 'utf8')));

// ---------------------------------------------------------------------------
// Step 2: pick four distinct real photo-asset targets from the manifest —
// ids/keys only, never memory text.
// ---------------------------------------------------------------------------

interface EditTarget {
  memoryId: string;
  file: string;
  aspectRatio: number;
}

function pickEditTargets(bookManifest: BookManifest, count: number): EditTarget[] {
  const picked: EditTarget[] = [];
  for (const [memoryId, memory] of Object.entries(bookManifest.memories)) {
    const photo = memory.assets.find((a) => a.kind === 'photo');
    if (!photo) continue;
    picked.push({ memoryId, file: photo.file, aspectRatio: photo.aspectRatio });
    if (picked.length === count) break;
  }
  if (picked.length < count) {
    throw new Error(`parity-proof: fixture book ${BOOK_SLUG} has fewer than ${count} distinct photo-asset memories`);
  }
  return picked;
}

const [replaceTarget, replaceSource, coverSource, focalTarget] = pickEditTargets(manifest, 4);
log(`edit targets selected (memory ids only): replaceTarget=${replaceTarget.memoryId} replaceSource=${replaceSource.memoryId} coverSource=${coverSource.memoryId} focalTarget=${focalTarget.memoryId}`);

const edits: MemoryBookEditsShape = {
  images: {
    [`${replaceTarget.memoryId}:${replaceTarget.file}`]: {
      slot: `${replaceTarget.memoryId}:${replaceTarget.file}`,
      mediaId: 'parity-proof-media-1',
      file: replaceSource.file,
      originalFile: replaceSource.file,
      aspectRatio: replaceSource.aspectRatio,
    },
    cover: {
      slot: 'cover',
      mediaId: 'parity-proof-media-2',
      file: coverSource.file,
      originalFile: coverSource.file,
      aspectRatio: coverSource.aspectRatio,
    },
  },
  text: {
    dedication: { target: 'dedication', value: 'Parity proof synthetic dedication text (not real memory content).' },
  },
  focalPoints: {
    [`${focalTarget.memoryId}:${focalTarget.file}`]: { slot: `${focalTarget.memoryId}:${focalTarget.file}`, x: 0.5, y: 0.3 },
  },
};

// ---------------------------------------------------------------------------
// Step 3: plan the presign — this is the FULL real set of R2 object keys
// this render needs (every manifest asset/illustration/portrait, plus the
// edits' own image sources), computed by the SAME `planPresign` the render
// worker itself uses.
// ---------------------------------------------------------------------------

const plan = planPresign(manifest, edits);
log(`${plan.objectKeys.length} distinct object keys referenced by this book+edits — uploading fixture bytes to the test prefix`);

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function uploadFixtureAssets(objectKeys: string[]): Promise<Record<string, string>> {
  const remap: Record<string, string> = {};
  let uploaded = 0;
  for (const key of objectKeys) {
    const localPath = path.join(BOOK_DATA_DIR, key);
    const bytes = fs.readFileSync(localPath);
    const testKey = `${testPrefix}${key}`;
    const contentType = CONTENT_TYPE_BY_EXT[path.extname(key).toLowerCase()] ?? 'application/octet-stream';
    await r2.putObject(testKey, bytes, contentType);
    remap[key] = testKey;
    uploaded += 1;
    if (uploaded % 50 === 0) log(`  uploaded ${uploaded}/${objectKeys.length}`);
  }
  log(`  uploaded ${uploaded}/${objectKeys.length} (done)`);
  return remap;
}

const keyRemap = await uploadFixtureAssets(plan.objectKeys);
// Reuse `planPresign`'s own `rewrite()` for a plain KEY rename (not a
// presigned URL) — see this file's header comment on why that's the same
// operation shape.
const { manifest: testManifest, edits: testEdits } = plan.rewrite(keyRemap);

// ---------------------------------------------------------------------------
// Step 4: pre-compute THE page count locally (no Chrome) — the number every
// comparison below is checked against.
// ---------------------------------------------------------------------------

const localFit = fitBookForPrint({ outline, manifest: testManifest, edits: testEdits, spineMm: SPINE_MM });
log(`local fitBookForPrint (no Chrome) pageCount=${localFit.pageCount}`);

// ---------------------------------------------------------------------------
// Step 5: real `docker build` + real container against real R2 env.
// ---------------------------------------------------------------------------

log('docker build …');
execFileSync('docker', ['build', '--build-context', `bookrenderer=${BOOK_RENDERER_DIR}`, '-t', IMAGE_TAG, '.'], {
  cwd: RENDER_DIR,
  stdio: 'inherit',
});

spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
log('docker run …');
// `RENDER_CONCURRENCY` passthrough: optional, forwarded from THIS script's
// own caller env (`env.ts` already defaults it to 4 when unset — see that
// file). Exists for exactly one reason, found the hard way running this
// proof on an Apple-Silicon dev machine: the container's Chrome renders run
// under Docker Desktop's QEMU amd64 emulation (no native arm64 Chrome for
// Testing build exists — see Dockerfile's own platform-pin comment), which
// multiplies each concurrent Chrome instance's CPU/memory cost; combined
// with whatever ELSE happens to be running in Docker on a shared dev
// machine at the same time, 4 concurrent emulated Chrome renderers can
// exceed the Docker Desktop VM's memory budget and get silently killed
// mid-render (no error surfaces — the container just disappears). A real
// Fly deploy runs NATIVE amd64 with no emulation tax and isn't subject to
// this at all; this knob is a local-development-only escape hatch (e.g.
// `RENDER_CONCURRENCY=1 npm run parity-proof`) for exactly that constrained
// case, never a production concern.
const renderConcurrencyArgs = process.env.RENDER_CONCURRENCY ? ['-e', `RENDER_CONCURRENCY=${process.env.RENDER_CONCURRENCY}`] : [];
execFileSync('docker', [
  'run',
  '-d',
  '--name', CONTAINER_NAME,
  '-p', `${CONTAINER_PORT}:8080`,
  '-e', `RENDER_WORKER_HMAC_SECRET=${hmacSecret}`,
  '-e', `R2_ACCOUNT_ID=${r2Config.accountId}`,
  '-e', `R2_ACCESS_KEY_ID=${r2Config.accessKeyId}`,
  '-e', `R2_SECRET_ACCESS_KEY=${r2Config.secretAccessKey}`,
  '-e', `R2_ENDPOINT=${r2Config.endpoint}`,
  '-e', `R2_BUCKET=${r2Config.bucket}`,
  ...renderConcurrencyArgs,
  IMAGE_TAG,
]);

const baseUrl = `http://127.0.0.1:${CONTAINER_PORT}`;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() - start > timeoutMs) throw new Error('parity-proof: container did not become healthy in time');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

log('waiting for container /health …');
await waitForHealth(60_000);
log('container healthy');

// ---------------------------------------------------------------------------
// Step 6: POST /render, poll /status.
// ---------------------------------------------------------------------------

async function signedRequest(method: string, urlPath: string, body?: unknown): Promise<Response> {
  const rawBody = body !== undefined ? JSON.stringify(body) : '';
  const headers = { 'content-type': 'application/json', ...(await sign(hmacSecret, rawBody)) };
  return fetch(`${baseUrl}${urlPath}`, { method, headers, body: rawBody.length > 0 ? rawBody : undefined });
}

log('POST /render …');
const renderRes = await signedRequest('POST', '/render', {
  orderId,
  attemptId,
  bookDocument: { outline, manifest: testManifest },
  edits: testEdits,
  spineMm: SPINE_MM,
});
if (renderRes.status !== 202) {
  throw new Error(`parity-proof: POST /render expected 202, got ${renderRes.status}: ${await renderRes.text()}`);
}
log('202 accepted — polling status …');

interface DoneStatus {
  status: 'done';
  pageCount: number;
  checksums: { interior: string; cover: string };
  keys: { interior: string; cover: string };
}

async function pollStatus(timeoutMs: number): Promise<DoneStatus> {
  const start = Date.now();
  for (;;) {
    const res = await signedRequest('GET', `/status/${attemptId}?orderId=${orderId}`);
    const body = (await res.json()) as { status: string; reason?: string };
    if (body.status === 'done') return body as unknown as DoneStatus;
    if (body.status === 'failed') throw new Error(`parity-proof: render FAILED — ${body.reason}`);
    if (Date.now() - start > timeoutMs) throw new Error(`parity-proof: render did not complete within ${timeoutMs}ms (last status: ${body.status})`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    log(`  … still ${body.status}`);
  }
}

const containerResult = await pollStatus(20 * 60 * 1000);
log(`container render DONE — pageCount=${containerResult.pageCount} checksums=${JSON.stringify(containerResult.checksums)}`);

// ---------------------------------------------------------------------------
// Step 7: download the container's PDFs from R2.
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbr-parity-'));
async function downloadObject(objectKey: string, destPath: string): Promise<void> {
  const url = await r2.presignGet(objectKey, 300);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`parity-proof: download failed for ${objectKey}: ${res.status}`);
  fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
}

const containerInteriorPath = path.join(tmpDir, 'container-interior.pdf');
const containerCoverPath = path.join(tmpDir, 'container-cover.pdf');
await downloadObject(containerResult.keys.interior, containerInteriorPath);
await downloadObject(containerResult.keys.cover, containerCoverPath);
log(`downloaded container PDFs to ${tmpDir}`);

// ---------------------------------------------------------------------------
// Step 8: host-side comparison run — renderBookPdfs() called DIRECTLY,
// independently re-presigning the SAME underlying (test-prefixed) object
// keys (a fresh presign call — the URL strings differ from the container's
// own, but resolve to the identical bytes in R2).
// ---------------------------------------------------------------------------

log('host-side renderBookPdfs() run …');
// `testManifest`/`testEdits` already carry the test-prefixed KEYS (Step 3's
// remap) — `planPresign` run again over them resolves those same keys
// (`sourceKeyForAsset`/`sourceKeyForImageEdit` read `file`/`originalFile`
// exactly like before; there's nothing special-cased about a "test" key).
// This is an INDEPENDENT presign call from the container's own internal one
// — the URL strings will differ, but both resolve to the identical bytes in
// R2, which is the whole point of using a real bucket for this proof.
const hostPlan = planPresign(testManifest, testEdits);
const hostPresignedUrlByKey = await presignMany(r2, hostPlan.objectKeys, 900);
const { manifest: hostManifest, edits: hostEdits } = hostPlan.rewrite(hostPresignedUrlByKey);

const distPrintDir = path.join(BOOK_RENDERER_DIR, 'dist-print');
if (!fs.existsSync(distPrintDir)) {
  throw new Error(`parity-proof: ${distPrintDir} does not exist — run "npx vite build --config vite.print.config.ts" in book-renderer/ first`);
}

const hostResult = await renderBookPdfs({
  servedDistDir: distPrintDir,
  spineMm: SPINE_MM,
  data: { mode: 'attempt', attemptId: 'host-comparison', outline, manifest: hostManifest, edits: hostEdits },
  concurrency: 4,
});
log(`host render DONE — pageCount=${hostResult.pageCount} checksums=${JSON.stringify(hostResult.checksums)}`);

const hostInteriorPath = path.join(tmpDir, 'host-interior.pdf');
const hostCoverPath = path.join(tmpDir, 'host-cover.pdf');
fs.writeFileSync(hostInteriorPath, hostResult.interiorPdf);
fs.writeFileSync(hostCoverPath, hostResult.coverPdf);

// ---------------------------------------------------------------------------
// Step 9: compare — page count, checksums, raster spot-check.
// ---------------------------------------------------------------------------

function rasterizePage(pdfPath: string, pageNumber: number, outPngBase: string): string {
  execFileSync('pdftoppm', ['-png', '-r', '150', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, outPngBase]);
  // pdftoppm appends -<page> (zero-padded per total page count) to the base name.
  const dir = path.dirname(outPngBase);
  const base = path.basename(outPngBase);
  const match = fs.readdirSync(dir).find((f) => f.startsWith(base) && f.endsWith('.png'));
  if (!match) throw new Error(`parity-proof: pdftoppm did not produce a PNG for ${pdfPath} page ${pageNumber}`);
  return path.join(dir, match);
}

function pngPixelDiffPercent(pngA: string, pngB: string): number {
  const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')
if a.size != b.size:
    print(f"SIZE_MISMATCH {a.size} {b.size}")
    sys.exit(0)
diff = ImageChops.difference(a, b)
hist = diff.convert('L').histogram()
total = a.size[0] * a.size[1]
nonzero = total - hist[0]
print(f"{100.0 * nonzero / total:.4f}")
`;
  const result = spawnSync('python3', ['-c', script, pngA, pngB], { encoding: 'utf-8' });
  return Number.parseFloat(result.stdout.trim());
}

const report: string[] = [];
report.push(`orderId=${orderId} attemptId=${attemptId} bucket=${r2Config.bucket}`);
report.push(`local fitBookForPrint pageCount=${localFit.pageCount}`);
report.push(`container pageCount=${containerResult.pageCount}`);
report.push(`host pageCount=${hostResult.pageCount}`);
const pageCountsMatch = localFit.pageCount === containerResult.pageCount && containerResult.pageCount === hostResult.pageCount;
report.push(`PAGE COUNT MATCH: ${pageCountsMatch}`);

const coverShaContainer = sha256File(containerCoverPath);
const coverShaHost = sha256File(hostCoverPath);
report.push(`cover sha256 — container=${coverShaContainer} host=${coverShaHost} byte-identical=${coverShaContainer === coverShaHost}`);
if (coverShaContainer !== coverShaHost) {
  const coverPngContainer = rasterizePage(containerCoverPath, 1, path.join(tmpDir, 'cover-container'));
  const coverPngHost = rasterizePage(hostCoverPath, 1, path.join(tmpDir, 'cover-host'));
  const diffPct = pngPixelDiffPercent(coverPngContainer, coverPngHost);
  report.push(`cover raster diff (150dpi, % pixels differing): ${diffPct}`);
}

const interiorShaContainer = sha256File(containerInteriorPath);
const interiorShaHost = sha256File(hostInteriorPath);
report.push(`interior sha256 — container=${interiorShaContainer} host=${interiorShaHost} byte-identical=${interiorShaContainer === interiorShaHost}`);

const spotPages = [1, Math.max(1, Math.floor(hostResult.pageCount / 2)), hostResult.pageCount].filter((p, i, arr) => arr.indexOf(p) === i);
for (const pageNumber of spotPages) {
  const pngContainer = rasterizePage(containerInteriorPath, pageNumber, path.join(tmpDir, `interior-container-p${pageNumber}`));
  const pngHost = rasterizePage(hostInteriorPath, pageNumber, path.join(tmpDir, `interior-host-p${pageNumber}`));
  const diffPct = pngPixelDiffPercent(pngContainer, pngHost);
  report.push(`interior page ${pageNumber} raster diff (150dpi, % pixels differing): ${diffPct}`);
}

log('\n=== PARITY PROOF REPORT ===\n' + report.join('\n'));

// ---------------------------------------------------------------------------
// Step 10: cleanup — R2 test objects, container.
// ---------------------------------------------------------------------------

log('cleaning up …');
spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' });
// Best-effort delete of every uploaded fixture object + the container's own
// output (never leave real R2 credentials' bucket holding test data).
// r2.ts's own `R2Client` interface has no delete/list op (the render worker
// itself never needs one) — this is the one place in the whole worker
// package that talks to `@aws-sdk/client-s3` directly, and only because
// it's test/proof cleanup, not production code.
const rawClient = new S3Client({
  region: 'auto',
  endpoint: r2Config.endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: r2Config.accessKeyId, secretAccessKey: r2Config.secretAccessKey },
});
async function deletePrefix(prefix: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await rawClient.send(new ListObjectsV2Command({ Bucket: r2Config.bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    for (const item of listed.Contents ?? []) {
      if (item.Key) await rawClient.send(new DeleteObjectCommand({ Bucket: r2Config.bucket, Key: item.Key }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}
await deletePrefix(testPrefix);
await deletePrefix(`print-orders/${orderId}/`);
log('done. tmp files left at ' + tmpDir);
