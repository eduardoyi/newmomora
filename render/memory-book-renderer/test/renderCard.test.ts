import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName } from '../../../book-renderer/node_modules/pdf-lib';
import { createServer } from '../src/server';
import { sign } from '../src/crypto';
import { createFakeR2Client } from './fakeR2';
import { CardRenderError, CARD_ERROR_CODES } from '../../../book-renderer/src/card/errors';
import { inspectPdf } from '../../../book-renderer/scripts/lib/cardPdfChecks';
import type { RenderCardPdfOptions, RenderCardPdfResult } from '../../../book-renderer/scripts/lib/renderCardPdf';
import type { CardRouteDeps } from '../src/card';
import type { RenderWorkerEnv } from '../src/env';
import { fakeUrls, synthCard } from './fixtures/synthCard';

/**
 * `POST /render-card` contract tests with the print pipeline STUBBED (fast and
 * hermetic: real HMAC, real node:http server, in-memory R2, a real pdf-lib
 * split + inspection of whatever PDF the stub produces). The real Chromium
 * render is covered by renderCard.e2e.test.ts.
 */

const HMAC_SECRET = 'test-hmac-secret';
const MM = 72 / 25.4;

function testEnv(): RenderWorkerEnv {
  return {
    port: 0,
    hmacSecret: HMAC_SECRET,
    r2: { accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', endpoint: 'https://example.com', bucket: 'test-bucket' },
    servedDistDir: '/nonexistent/dist-print',
    cardDistDir: '/nonexistent/dist-card',
    concurrency: 1,
  };
}

/** A 2-page card-shaped PDF whose pages reference one (fake) embedded font program. */
async function stubPdf(opts: { sizeMm?: [number, number]; pages?: number; embedded?: boolean; withFont?: boolean } = {}): Promise<Uint8Array> {
  const [w, h] = opts.sizeMm ?? [185.8, 135];
  const doc = await PDFDocument.create();
  let resources: PDFDict | null = null;
  if (opts.withFont !== false) {
    const file = doc.context.register(doc.context.flateStream(new Uint8Array([1, 2, 3])));
    const descriptor = doc.context.register(doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Fake', ...(opts.embedded === false ? {} : { FontFile2: file }) }));
    const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+Fake', FontDescriptor: descriptor }));
    resources = doc.context.obj({ Font: { F1: font } }) as PDFDict;
  }
  for (let i = 0; i < (opts.pages ?? 2); i += 1) {
    const page = doc.addPage([w * MM, h * MM]);
    if (resources) page.node.set(PDFName.of('Resources'), resources);
  }
  return doc.save();
}

async function stubResult(pdf: Uint8Array, overrides: Partial<RenderCardPdfResult> = {}): Promise<RenderCardPdfResult> {
  return {
    pdf: Buffer.from(pdf),
    pageCount: 2,
    pageSizesPt: [],
    orientation: 'landscape',
    stats: {} as RenderCardPdfResult['stats'],
    checksum: 'unused',
    checks: { pageWidthMm: 185.8, pageHeightMm: 135, pages: 2, letterPt: 11.5, letterFits: true, frontDpi: 271, fontsEmbedded: true },
    ...overrides,
  };
}

async function post(baseUrl: string, body: unknown, options: { auth?: boolean | 'bad'; raw?: string } = {}): Promise<Response> {
  const rawBody = options.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.auth !== false) {
    Object.assign(headers, await sign(HMAC_SECRET, options.auth === 'bad' ? `${rawBody} ` : rawBody));
  }
  return fetch(`${baseUrl}/render-card`, { method: 'POST', headers, body: rawBody });
}

describe('POST /render-card (print pipeline stubbed)', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let r2: ReturnType<typeof createFakeR2Client>;
  let renderCard: ReturnType<typeof vi.fn<(options: RenderCardPdfOptions) => Promise<RenderCardPdfResult>>>;
  let fetchAsset: ReturnType<typeof vi.fn<NonNullable<CardRouteDeps['fetchAsset']>>>;
  const synth = synthCard();
  const orderId = randomUUID();

  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      orderId,
      mode: 'render',
      format: '5R',
      fileLayout: 'two_files',
      card: synth.card,
      edits: synth.edits,
      assets: fakeUrls(Object.keys(synth.assets)),
      outputPrefix: `print-orders/${orderId}/`,
      ...overrides,
    };
  }

  beforeEach(async () => {
    r2 = createFakeR2Client();
    renderCard = vi.fn(async () => stubResult(await stubPdf()));
    fetchAsset = vi.fn(async (url: string) => {
      const file = Object.keys(synth.assets).find((f) => url.includes(encodeURIComponent(f)));
      return { status: file ? 200 : 404, bytes: file ? synth.assets[file] : new Uint8Array() };
    });
    server = createServer(testEnv(), r2, { renderCard, fetchAsset });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('auth + envelope', () => {
    it('401 without HMAC headers, and for a signature over a different body', async () => {
      const unsigned = await post(baseUrl, validBody(), { auth: false });
      expect(unsigned.status).toBe(401);
      const bad = await post(baseUrl, validBody(), { auth: 'bad' });
      expect(bad.status).toBe(401);
      expect(renderCard).not.toHaveBeenCalled();
      expect(fetchAsset).not.toHaveBeenCalled();
    });

    it('422 BAD_INPUT for a body that is not JSON', async () => {
      const res = await post(baseUrl, null, { raw: '{nope' });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ ok: false, code: 'BAD_INPUT' });
    });

    it('413 for an oversized body (the card route takes URLs, never picture bytes)', async () => {
      const res = await post(baseUrl, validBody({ edits: { text: 'x'.repeat(1_100_000) } }));
      expect(res.status).toBe(413);
      expect(renderCard).not.toHaveBeenCalled();
    });
  });

  describe('input validation (422 BAD_INPUT, nothing rendered or downloaded)', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['orderId not a uuid', { orderId: 'order-1' }],
      ['unknown mode', { mode: 'preview' }],
      ['unknown format', { format: 'A4' }],
      ['unknown fileLayout', { fileLayout: 'three_files' }],
      ['card not an object', { card: 'nope' }],
      ['edits missing', { edits: undefined }],
      ['edits an array', { edits: [] }],
      ['assets not an object', { assets: [] }],
      ['asset URL over http', { assets: { 'assets/front.png': 'http://assets.example.com/a.png' } }],
      ['asset URL to localhost', { assets: { 'assets/front.png': 'https://localhost/a.png' } }],
      ['asset URL to a private address', { assets: { 'assets/front.png': 'https://10.0.0.5/a.png' } }],
      ['asset URL with credentials', { assets: { 'assets/front.png': 'https://user:pw@assets.example.com/a.png' } }],
      ['asset name with traversal', { assets: { '../front.png': 'https://assets.example.com/a.png' } }],
      ['asset name absolute', { assets: { '/etc/front.png': 'https://assets.example.com/a.png' } }],
      ['asset name not an image', { assets: { 'assets/front.svg': 'https://assets.example.com/a.svg' } }],
      ['outputPrefix outside print-orders', { outputPrefix: `book-orders/${orderId}/` }],
      ['outputPrefix without the orderId', { outputPrefix: `print-orders/${randomUUID()}/` }],
      ['outputPrefix with traversal', { outputPrefix: `print-orders/${orderId}/../other/` }],
      ['outputPrefix with an empty segment', { outputPrefix: `print-orders//${orderId}/` }],
      ['outputPrefix naming the orderId only as a substring', { outputPrefix: `print-orders/x${orderId}x/` }],
      ['outputPrefix not a string', { outputPrefix: 7 }],
    ];
    it.each(cases)('%s', async (_name, overrides) => {
      const res = await post(baseUrl, validBody(overrides));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ ok: false, code: 'BAD_INPUT' });
      expect(renderCard).not.toHaveBeenCalled();
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(r2.objects.size).toBe(0);
    });

    it('422 BAD_INPUT for a card document that fails parseCardData', async () => {
      const res = await post(baseUrl, validBody({ card: { ...synth.card, version: 2 } }));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ ok: false, code: 'BAD_INPUT' });
      expect(renderCard).not.toHaveBeenCalled();
    });

    it('accepts an outputPrefix without the trailing slash and normalises it', async () => {
      const res = await post(baseUrl, validBody({ outputPrefix: `print-orders/${orderId}` }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: { key: string }[] };
      expect(body.files.map((f) => f.key)).toEqual([`print-orders/${orderId}/front.pdf`, `print-orders/${orderId}/back.pdf`]);
    });
  });

  describe('assets', () => {
    it('IMAGE_MISSING (422) when the document references a picture with no URL; nothing is downloaded or rendered', async () => {
      const assets = fakeUrls(Object.keys(synth.assets));
      delete (assets as Record<string, string>)['assets/portrait-2.png'];
      const res = await post(baseUrl, validBody({ assets }));
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe('IMAGE_MISSING');
      expect(body.message).toContain('portrait 2');
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(renderCard).not.toHaveBeenCalled();
    });

    it('ignores extra asset entries (only what the render uses is downloaded)', async () => {
      const assets = { ...fakeUrls(Object.keys(synth.assets)), 'assets/unused.jpg': 'https://assets.example.com/unused.jpg?sig=1' };
      const res = await post(baseUrl, validBody({ assets }));
      expect(res.status).toBe(200);
      expect(fetchAsset).toHaveBeenCalledTimes(3);
    });

    it('IMAGE_MISSING (422) when a picture URL answers 404 (deleted) or 403 (expired); the message never contains the URL', async () => {
      for (const status of [404, 403]) {
        fetchAsset.mockImplementation(async () => ({ status, bytes: new Uint8Array() }));
        const res = await post(baseUrl, validBody());
        expect(res.status).toBe(422);
        const body = (await res.json()) as { code: string; message: string };
        expect(body.code).toBe('IMAGE_MISSING');
        expect(body.message).not.toContain('example.com');
        expect(body.message).not.toContain('X-Amz');
      }
      expect(renderCard).not.toHaveBeenCalled();
    });

    it('502 ASSET_FETCH_FAILED when the asset store itself fails (5xx)', async () => {
      fetchAsset.mockImplementation(async () => ({ status: 503, bytes: new Uint8Array() }));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, code: 'ASSET_FETCH_FAILED' });
    });

    it('hands the renderer the pictures in a temp dir (with the requested format) and removes it afterwards', async () => {
      let assetsDir = '';
      renderCard.mockImplementation(async (options) => {
        assetsDir = options.inline!.assetsDir;
        expect(readdirSync(`${assetsDir}/assets`).sort()).toEqual(['front.png', 'portrait-1.png', 'portrait-2.png']);
        expect((options.inline!.card as { format: string }).format).toBe('A5');
        expect(options.inline!.edits).toEqual(synth.edits);
        expect(options.distDir).toBe('/nonexistent/dist-card');
        expect(options.minFrontDpi).toBe(150);
        return stubResult(await stubPdf({ sizeMm: [218, 156] }));
      });
      const res = await post(baseUrl, validBody({ format: 'A5', fileLayout: 'one_pdf' }));
      expect(res.status).toBe(200);
      expect(assetsDir).not.toBe('');
      expect(existsSync(assetsDir)).toBe(false);
    });
  });

  describe('modes and file layouts', () => {
    it('validate: 200 with the checks, no files, nothing uploaded', async () => {
      const res = await post(baseUrl, validBody({ mode: 'validate' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        mode: 'validate',
        files: [],
        checks: { pageWidthMm: 185.8, pageHeightMm: 135, pages: 2, letterPt: 11.5, letterFits: true, frontDpi: 271, fontsEmbedded: true },
      });
      expect(r2.objects.size).toBe(0);
    });

    it('render + two_files (5R): front.pdf and back.pdf, one 185.8x135 mm page each, with sha256 + bytes of what was stored', async () => {
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; mode: string; files: { side: string; key: string; sha256: string; bytes: number }[] };
      expect(body.mode).toBe('render');
      expect(body.files.map((f) => [f.side, f.key])).toEqual([
        ['front', `print-orders/${orderId}/front.pdf`],
        ['back', `print-orders/${orderId}/back.pdf`],
      ]);
      for (const file of body.files) {
        const stored = r2.objects.get(file.key)!;
        expect(stored.contentType).toBe('application/pdf');
        expect(file.bytes).toBe(stored.body.byteLength);
        expect(file.sha256).toBe(createHash('sha256').update(stored.body).digest('hex'));
        const inspection = await inspectPdf(stored.body);
        expect(inspection.pages).toHaveLength(1);
        expect(inspection.pages[0].widthPt).toBeCloseTo(185.8 * MM, 1);
        expect(inspection.pages[0].heightPt).toBeCloseTo(135 * MM, 1);
        expect(inspection.pages[0].extraBoxes).toEqual([]);
        expect(inspection.fontsEmbedded).toBe(true);
      }
      expect(r2.objects.size).toBe(2);
    });

    it('render + one_pdf (A5): a single 2-page card.pdf of 218x156 mm, side "both"', async () => {
      renderCard.mockImplementation(async () => stubResult(await stubPdf({ sizeMm: [218, 156] })));
      const res = await post(baseUrl, validBody({ format: 'A5', fileLayout: 'one_pdf' }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { files: { side: string; key: string }[] };
      expect(body.files).toHaveLength(1);
      expect(body.files[0]).toMatchObject({ side: 'both', key: `print-orders/${orderId}/card.pdf` });
      const inspection = await inspectPdf(r2.objects.get(body.files[0].key)!.body);
      expect(inspection.pages).toHaveLength(2);
      expect(inspection.pages[0].widthPt).toBeCloseTo(218 * MM, 1);
      expect(inspection.pages[0].heightPt).toBeCloseTo(156 * MM, 1);
    });

    it('a portrait card is checked against the portrait page of its format (135x185.8 mm)', async () => {
      renderCard.mockImplementation(async () => stubResult(await stubPdf({ sizeMm: [135, 185.8] }), { orientation: 'portrait' }));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(200);
    });

    it('re-posting the same order overwrites the same keys (idempotent object names)', async () => {
      await post(baseUrl, validBody());
      await post(baseUrl, validBody());
      expect(r2.objects.size).toBe(2);
    });
  });

  describe('typed 422s from the print pipeline', () => {
    it.each([...CARD_ERROR_CODES])('maps a CardRenderError(%s) to 422 {ok:false, code, message}', async (code) => {
      renderCard.mockRejectedValue(new CardRenderError(code, `synthetic ${code}`));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ ok: false, code, message: `synthetic ${code}` });
      expect(r2.objects.size).toBe(0);
    });

    it('an unexpected renderer error is a 5xx RENDER_FAILED with a generic message', async () => {
      renderCard.mockRejectedValue(new Error('browser exploded at /tmp/x'));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, code: 'RENDER_FAILED', message: 'the card could not be rendered' });
    });

    it('PAGE_SIZE when the PDF is not the format size (A5 page for a 5R order)', async () => {
      renderCard.mockImplementation(async () => stubResult(await stubPdf({ sizeMm: [218, 156] })));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ ok: false, code: 'PAGE_SIZE' });
      expect(r2.objects.size).toBe(0);
    });

    it('FONTS when a font is not embedded', async () => {
      renderCard.mockImplementation(async () => stubResult(await stubPdf({ embedded: false })));
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ ok: false, code: 'FONTS' });
      expect(r2.objects.size).toBe(0);
    });

    it('502 UPLOAD_FAILED when R2 rejects the write', async () => {
      r2.putObject = vi.fn(async () => {
        throw new Error('R2 down');
      });
      const res = await post(baseUrl, validBody());
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ ok: false, code: 'UPLOAD_FAILED' });
    });
  });

  describe('privacy of logs and errors', () => {
    it('logs carry ids/codes/sizes only: never letter text, names or URLs', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await post(baseUrl, validBody());
      fetchAsset.mockImplementation(async () => ({ status: 404, bytes: new Uint8Array() }));
      await post(baseUrl, validBody());
      renderCard.mockRejectedValue(new Error('boom'));
      fetchAsset.mockImplementation(async (url: string) => ({ status: 200, bytes: synth.assets['assets/front.png'] ?? new Uint8Array([url.length]) }));
      await post(baseUrl, validBody());
      const output = [...log.mock.calls, ...err.mock.calls].flat().join('\n');
      expect(output).toContain(orderId);
      for (const secret of ['Rivera', 'Soto', 'Tomás', 'Lucía', 'parque', 'example.com', 'X-Amz', 'usemomora']) expect(output).not.toContain(secret);
    });
  });
});
