import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from '../src/server';
import { sign } from '../src/crypto';
import { createFakeR2Client } from './fakeR2';
import { inspectPdf } from '../../../book-renderer/scripts/lib/cardPdfChecks';
import type { RenderWorkerEnv } from '../src/env';
import { fakeUrls, letterOf, synthCard } from './fixtures/synthCard';

/**
 * REAL print render: builds book-renderer's `dist-card` (vite.card.config.ts),
 * launches Chromium through renderCardPdf and POSTs /render-card with a fully
 * synthetic card ("Rivera Soto": Tomás, Lucía) whose pictures are generated PNGs.
 * Skipped (not failed) when no Chrome is available for puppeteer.
 */

const BOOK_RENDERER_DIR = resolve(__dirname, '..', '..', '..', 'book-renderer');
const CARD_DIST = resolve(BOOK_RENDERER_DIR, 'dist-card');
const HMAC_SECRET = 'test-hmac-secret';
const MM = 72 / 25.4;

function chromeAvailable(): boolean {
  try {
    const puppeteer = createRequire(resolve(BOOK_RENDERER_DIR, 'package.json'))('puppeteer') as { executablePath(): string };
    return existsSync(puppeteer.executablePath());
  } catch {
    return false;
  }
}

const runner = chromeAvailable() ? describe : describe.skip;

runner('POST /render-card (real Chromium render of a synthetic card)', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let r2: ReturnType<typeof createFakeR2Client>;
  let currentAssets: Record<string, Buffer> = {};

  beforeAll(async () => {
    // Always rebuild so the test exercises the current print app (a few seconds).
    const build = spawnSync('npx', ['vite', 'build', '--config', 'vite.card.config.ts', '--logLevel', 'warn'], { cwd: BOOK_RENDERER_DIR, encoding: 'utf-8' });
    if (build.status !== 0) throw new Error(`vite build (card) failed: ${build.stdout}${build.stderr}`);
    const env: RenderWorkerEnv = {
      port: 0,
      hmacSecret: HMAC_SECRET,
      r2: { accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', endpoint: 'https://example.com', bucket: 'test-bucket' },
      servedDistDir: '/nonexistent/dist-print',
      cardDistDir: CARD_DIST,
      concurrency: 1,
    };
    r2 = createFakeR2Client();
    server = createServer(env, r2, {
      fetchAsset: async (url) => {
        const file = Object.keys(currentAssets).find((f) => url.includes(encodeURIComponent(f)));
        return { status: file ? 200 : 404, bytes: file ? currentAssets[file] : new Uint8Array() };
      },
    });
    await new Promise<void>((r) => server.listen(0, r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function post(synth: ReturnType<typeof synthCard>, overrides: Record<string, unknown> = {}) {
    currentAssets = synth.assets;
    const orderId = randomUUID();
    const raw = JSON.stringify({
      orderId,
      mode: 'render',
      format: '5R',
      fileLayout: 'two_files',
      card: synth.card,
      edits: synth.edits,
      assets: fakeUrls(Object.keys(synth.assets)),
      outputPrefix: `print-orders/${orderId}/`,
      ...overrides,
    });
    const res = await fetch(`${baseUrl}/render-card`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await sign(HMAC_SECRET, raw)) }, body: raw });
    return { res, orderId, json: (await res.json()) as Record<string, any> };
  }

  it('5R / two_files: front.pdf + back.pdf, 185.8x135 mm, fonts embedded, letter fits, sha256 matches the stored bytes', async () => {
    const { res, orderId, json } = await post(synthCard());
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // pageWidthMm/pageHeightMm are MEASURED from the PDF (Chromium snaps page boxes to CSS px: within ~0.5 mm of nominal).
    expect(json.checks).toMatchObject({ pages: 2, letterFits: true, fontsEmbedded: true });
    expect(Math.abs(json.checks.pageWidthMm - 185.8)).toBeLessThan(0.5);
    expect(Math.abs(json.checks.pageHeightMm - 135)).toBeLessThan(0.5);
    expect(json.checks.frontDpi).toBeGreaterThan(200);
    expect(json.files.map((f: { side: string; key: string }) => [f.side, f.key])).toEqual([
      ['front', `print-orders/${orderId}/front.pdf`],
      ['back', `print-orders/${orderId}/back.pdf`],
    ]);
    for (const file of json.files) {
      const stored = r2.objects.get(file.key)!;
      expect(file.bytes).toBe(stored.body.byteLength);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      const inspection = await inspectPdf(stored.body);
      expect(inspection.pages).toHaveLength(1);
      expect(inspection.pages[0].widthPt).toBeCloseTo(185.8 * MM, 0);
      expect(inspection.pages[0].heightPt).toBeCloseTo(135 * MM, 0);
      expect(inspection.pages[0].extraBoxes).toEqual([]);
      expect(inspection.type3Count).toBe(0);
      expect(inspection.fontsEmbedded).toBe(true);
    }
  }, 120_000);

  it('validate mode renders and checks but returns no files and stores nothing', async () => {
    const before = r2.objects.size;
    const { res, json } = await post(synthCard(), { mode: 'validate' });
    expect(res.status).toBe(200);
    expect(json.files).toEqual([]);
    expect(json.checks).toMatchObject({ pages: 2, fontsEmbedded: true });
    expect(r2.objects.size).toBe(before);
  }, 120_000);

  it('A5 / one_pdf: a single 2-page card.pdf of 218x156 mm', async () => {
    const synth = synthCard();
    const { res, orderId, json } = await post(synth, { format: 'A5', fileLayout: 'one_pdf' });
    expect(res.status).toBe(200);
    expect(json.checks).toMatchObject({ pages: 2 });
    expect(Math.abs(json.checks.pageWidthMm - 218)).toBeLessThan(0.5);
    expect(Math.abs(json.checks.pageHeightMm - 156)).toBeLessThan(0.5);
    expect(json.files).toHaveLength(1);
    expect(json.files[0]).toMatchObject({ side: 'both', key: `print-orders/${orderId}/card.pdf` });
    const inspection = await inspectPdf(r2.objects.get(json.files[0].key)!.body);
    expect(inspection.pages).toHaveLength(2);
    expect(inspection.pages[1].widthPt).toBeCloseTo(218 * MM, 0);
  }, 120_000);

  it('LETTER_OVERFLOW (422) when the letter cannot fit at its readable minimum; nothing stored', async () => {
    const before = r2.objects.size;
    const { res, json } = await post(synthCard({ letterChars: 9000 }));
    expect(res.status).toBe(422);
    expect(json).toMatchObject({ ok: false, code: 'LETTER_OVERFLOW' });
    expect(json.message).not.toContain('Rivera');
    expect(r2.objects.size).toBe(before);
  }, 120_000);

  it('an edited (shorter) letter in the edits fits where the generated one overflowed', async () => {
    const synth = synthCard({ letterChars: 9000 });
    const edits = { ...synth.edits, letters: { classic: letterOf(300) } };
    const { res } = await post({ ...synth, edits });
    expect(res.status).toBe(200);
  }, 120_000);

  it('IMAGE_LOW_RES (422) when the front picture is below the dpi floor', async () => {
    const { res, json } = await post(synthCard({ photo: [800, 600] }));
    expect(res.status).toBe(422);
    expect(json).toMatchObject({ ok: false, code: 'IMAGE_LOW_RES' });
  }, 120_000);

  it('IMAGE_MISSING (422) when a picture is not a decodable image', async () => {
    const synth = synthCard();
    synth.assets['assets/front.png'] = Buffer.from('this is not a png');
    const { res, json } = await post(synth);
    expect(res.status).toBe(422);
    expect(json).toMatchObject({ ok: false, code: 'IMAGE_MISSING' });
  }, 120_000);
});
