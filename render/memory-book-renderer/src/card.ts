import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderCardPdf, splitCardPdf, type CardPdfChecks, type RenderCardPdfOptions, type RenderCardPdfResult } from '../../../book-renderer/scripts/lib/renderCardPdf';
import { inspectPdf } from '../../../book-renderer/scripts/lib/cardPdfChecks';
import { CardRenderError, type CardErrorCode } from '../../../book-renderer/src/card/errors';
import { cardInputFromData } from '../../../book-renderer/src/card/fromData';
import { normalizeEdits } from '../../../book-renderer/src/card/edits';
import { cardGeometry } from '../../../book-renderer/src/card/geometry';
import { parseCardData } from '../../../book-renderer/src/card/types';
import type { R2Client } from './r2';
import type { RenderWorkerEnv } from './env';
import { ID_PATTERN } from './render';

/**
 * `POST /render-card` (docs/plans/holiday-cards-p1.md Step 5): ONE synchronous
 * card render. The shop's `create_checkout` sends the frozen card document, its
 * edits and presigned GET URLs for the pictures; this module downloads the
 * pictures into a throwaway temp dir, prints the card through book-renderer's
 * `renderCardPdf` (service path: document and edits served from memory, never on
 * disk), checks the result with pdf-lib, uploads the PDF(s) to R2 under
 * `outputPrefix` and answers with keys + sha256.
 *
 * Content problems the shop can show are 422 `{ok:false, code, message}`; infra
 * problems are 5xx. Messages and logs carry ids, codes, counts and sizes only,
 * never letter text, names, addresses or URLs (a presigned URL carries a
 * signature, so asset errors name the role "front picture" / "portrait 2", not
 * the URL or the file).
 */

export const CARD_REQUEST_MODES = ['validate', 'render'] as const;
export const CARD_FORMAT_VALUES = ['5R', 'A5'] as const;
export const CARD_FILE_LAYOUTS = ['two_files', 'one_pdf'] as const;
export type CardRequestMode = (typeof CARD_REQUEST_MODES)[number];
export type CardRequestFormat = (typeof CARD_FORMAT_VALUES)[number];
export type CardFileLayout = (typeof CARD_FILE_LAYOUTS)[number];

export interface CardRenderRequestBody {
  orderId: string;
  mode: CardRequestMode;
  format: CardRequestFormat;
  fileLayout: CardFileLayout;
  /** The card document (`CardData`, book-renderer/src/card/types.ts). */
  card: Record<string, unknown>;
  /** `CardEdits` (book-renderer/src/card/edits.ts). */
  edits: Record<string, unknown>;
  /** File name the card document references -> presigned https GET URL. */
  assets: Record<string, string>;
  /** `print-orders/<...orderId...>/` */
  outputPrefix: string;
}

export type CardErrorResponseCode = CardErrorCode | 'ASSET_FETCH_FAILED' | 'UPLOAD_FAILED' | 'RENDER_FAILED';

/** An error with the HTTP status + code the route answers with. */
export class CardRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: CardErrorResponseCode | 'INTERNAL_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'CardRouteError';
  }
}

export interface CardOutputFile {
  side: 'front' | 'back' | 'both';
  key: string;
  sha256: string;
  bytes: number;
}

export interface CardRenderResponse {
  ok: true;
  mode: CardRequestMode;
  files: CardOutputFile[];
  checks: CardPdfChecks;
}

/** Hard floor for the front picture's effective dpi at the placed size (the editor warns below 200). */
export const MIN_FRONT_DPI = 150;
const MAX_ASSET_ENTRIES = 64;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const ASSET_TIMEOUT_MS = 60_000;
const ALLOWED_ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** `assets/photo-1.jpg`: no leading dot or slash per segment (so no `..`), plain characters only. */
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const OUTPUT_PREFIX_PATTERN = /^print-orders\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const bad = (message: string): CardRouteError => new CardRouteError(422, 'BAD_INPUT', message);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True for an https URL that is not obviously a loopback/private/link-local target. */
export function isPublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[')) return false; // IPv6 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224) return false;
  }
  return true;
}

/** Throws a 422 `BAD_INPUT` CardRouteError for anything malformed. */
export function parseCardRenderRequest(value: unknown): CardRenderRequestBody {
  if (!isRecord(value)) throw bad('request body must be a JSON object');
  const { orderId, mode, format, fileLayout, card, edits, assets, outputPrefix } = value;
  if (typeof orderId !== 'string' || !ID_PATTERN.test(orderId)) throw bad('orderId must be a uuid');
  if (!(CARD_REQUEST_MODES as readonly unknown[]).includes(mode)) throw bad("mode must be 'validate' or 'render'");
  if (!(CARD_FORMAT_VALUES as readonly unknown[]).includes(format)) throw bad("format must be '5R' or 'A5'");
  if (!(CARD_FILE_LAYOUTS as readonly unknown[]).includes(fileLayout)) throw bad("fileLayout must be 'two_files' or 'one_pdf'");
  if (!isRecord(card)) throw bad('card must be an object');
  if (!isRecord(edits)) throw bad('edits must be an object');
  if (!isRecord(assets)) throw bad('assets must be an object of file name -> https URL');
  const entries = Object.entries(assets);
  if (entries.length > MAX_ASSET_ENTRIES) throw bad(`assets has more than ${MAX_ASSET_ENTRIES} entries`);
  for (const [name, url] of entries) {
    if (!ASSET_NAME_PATTERN.test(name) || name.length > 200 || !ALLOWED_ASSET_EXTENSIONS.has(path.extname(name).toLowerCase())) {
      throw bad('assets contains an unsafe or unsupported file name (png/jpg/webp, plain relative path)');
    }
    if (typeof url !== 'string' || url.length > 4096 || !isPublicHttpsUrl(url)) throw bad('every asset URL must be a public https URL');
  }
  if (typeof outputPrefix !== 'string') throw bad('outputPrefix must be a string');
  const prefix = outputPrefix.endsWith('/') ? outputPrefix : `${outputPrefix}/`;
  if (!OUTPUT_PREFIX_PATTERN.test(prefix) || prefix.includes('..') || prefix.includes('//') || !prefix.split('/').includes(orderId)) {
    throw bad("outputPrefix must start with 'print-orders/' and contain the orderId as a path segment");
  }
  return {
    orderId,
    mode: mode as CardRequestMode,
    format: format as CardRequestFormat,
    fileLayout: fileLayout as CardFileLayout,
    card,
    edits,
    assets: assets as Record<string, string>,
    outputPrefix: prefix,
  };
}

export interface FetchedAsset {
  status: number;
  bytes: Uint8Array;
}

export interface CardRouteDeps {
  /** Downloads one presigned URL. Tests inject a fake; production uses `fetchAssetOverHttps`. */
  fetchAsset?: (url: string, limits: { maxBytes: number; timeoutMs: number }) => Promise<FetchedAsset>;
  /** The print pipeline; tests inject a stub to exercise the error mapping. */
  renderCard?: (options: RenderCardPdfOptions) => Promise<RenderCardPdfResult>;
}

export async function fetchAssetOverHttps(url: string, limits: { maxBytes: number; timeoutMs: number }): Promise<FetchedAsset> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(limits.timeoutMs) });
  } catch {
    throw new CardRouteError(502, 'ASSET_FETCH_FAILED', 'a picture could not be fetched (network error)');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, bytes: new Uint8Array() };
  }
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > limits.maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new CardRouteError(422, 'IMAGE_MISSING', 'a picture is larger than the allowed size');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limits.maxBytes) {
          await reader.cancel().catch(() => {});
          throw new CardRouteError(422, 'IMAGE_MISSING', 'a picture is larger than the allowed size');
        }
        chunks.push(value);
      }
    }
  } catch (e) {
    if (e instanceof CardRouteError) throw e;
    throw new CardRouteError(502, 'ASSET_FETCH_FAILED', 'a picture could not be fetched (interrupted)');
  }
  return { status: res.status, bytes: Buffer.concat(chunks) };
}

/** The pictures this render references, in role order (front picture first, then portraits), found by dry-running the document assembly. */
function requiredAssets(card: ReturnType<typeof parseCardData>, edits: ReturnType<typeof normalizeEdits>): { file: string; role: string }[] {
  const files: string[] = [];
  cardInputFromData(card, edits, (file) => {
    files.push(file);
    return file;
  });
  return files.map((file, i) => ({ file, role: i === 0 ? 'front picture' : `portrait ${i}` }));
}

const sha256 = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');

export async function renderCardOrder(
  env: RenderWorkerEnv,
  r2: R2Client,
  body: CardRenderRequestBody,
  deps: CardRouteDeps = {},
): Promise<CardRenderResponse> {
  const fetchAsset = deps.fetchAsset ?? fetchAssetOverHttps;
  const renderCard = deps.renderCard ?? renderCardPdf;

  // 1. Document + edits (pure Node, before any browser or download). The requested format wins over whatever the document carried.
  let data: ReturnType<typeof parseCardData>;
  try {
    data = parseCardData({ ...body.card, format: body.format });
  } catch (e) {
    throw bad(e instanceof Error ? e.message : 'card document is not valid');
  }
  const edits = normalizeEdits(body.edits);
  const required = requiredAssets(data, edits);
  const missing = required.filter((r) => !Object.hasOwn(body.assets, r.file));
  if (missing.length > 0) throw new CardRouteError(422, 'IMAGE_MISSING', `no URL supplied for: ${missing.map((m) => m.role).join(', ')}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'card-render-'));
  try {
    // 2. Pictures into the temp dir (only the ones this render uses).
    await Promise.all(
      required.map(async ({ file, role }) => {
        const fetched = await fetchAsset(body.assets[file], { maxBytes: MAX_ASSET_BYTES, timeoutMs: ASSET_TIMEOUT_MS });
        if (fetched.status === 404 || fetched.status === 403 || fetched.status === 410) {
          throw new CardRouteError(422, 'IMAGE_MISSING', `the ${role} could not be read (HTTP ${fetched.status}); it may have been deleted or its link expired`);
        }
        if (fetched.status < 200 || fetched.status >= 300) {
          throw new CardRouteError(502, 'ASSET_FETCH_FAILED', `the ${role} could not be fetched (HTTP ${fetched.status})`);
        }
        if (fetched.bytes.byteLength === 0) throw new CardRouteError(422, 'IMAGE_MISSING', `the ${role} is empty`);
        const target = path.join(tempDir, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, fetched.bytes);
      }),
    );

    // 3. Print.
    let result: RenderCardPdfResult;
    try {
      result = await renderCard({
        distDir: env.cardDistDir,
        slug: 'order',
        inline: { card: { ...body.card, format: body.format }, edits: body.edits, assetsDir: tempDir },
        minFrontDpi: MIN_FRONT_DPI,
      });
    } catch (e) {
      if (e instanceof CardRenderError) throw new CardRouteError(422, e.code, e.message);
      console.error('memory-book-renderer: render-card print failed', e instanceof Error ? e.message.slice(0, 300) : 'unknown');
      throw new CardRouteError(500, 'RENDER_FAILED', 'the card could not be rendered');
    }

    // 4. The page size must be the format's exact size (either orientation); fonts were checked inside renderCardPdf.
    const expected = cardGeometry(result.orientation, body.format);
    const pdfs: { side: CardOutputFile['side']; name: string; bytes: Uint8Array }[] =
      body.fileLayout === 'one_pdf'
        ? [{ side: 'both', name: 'card.pdf', bytes: result.pdf }]
        : await splitCardPdf(result.pdf).then((s) => [
            { side: 'front' as const, name: 'front.pdf', bytes: s.front },
            { side: 'back' as const, name: 'back.pdf', bytes: s.back },
          ]);
    const expectedPages = body.fileLayout === 'one_pdf' ? 2 : 1;
    for (const pdf of pdfs) {
      const inspection = await inspectPdf(pdf.bytes);
      const pageOk = inspection.pages.every((p) => Math.abs(p.widthPt - expected.pageW * (72 / 25.4)) <= 1.5 && Math.abs(p.heightPt - expected.pageH * (72 / 25.4)) <= 1.5);
      if (inspection.pages.length !== expectedPages || !pageOk || inspection.pages.some((p) => p.extraBoxes.length > 0)) {
        throw new CardRouteError(422, 'PAGE_SIZE', `${pdf.name}: ${inspection.pages.length} page(s), expected ${expectedPages} at ${expected.pageW}x${expected.pageH} mm with no extra page boxes`);
      }
      if (!inspection.fontsEmbedded) throw new CardRouteError(422, 'FONTS', `${pdf.name}: fonts are not all embedded`);
    }

    // 5. Upload (render mode only).
    const files: CardOutputFile[] = [];
    if (body.mode === 'render') {
      for (const pdf of pdfs) {
        const key = `${body.outputPrefix}${pdf.name}`;
        try {
          await r2.putObject(key, pdf.bytes, 'application/pdf');
        } catch {
          throw new CardRouteError(502, 'UPLOAD_FAILED', 'the print file could not be stored');
        }
        files.push({ side: pdf.side, key, sha256: sha256(pdf.bytes), bytes: pdf.bytes.byteLength });
      }
    }
    return { ok: true, mode: body.mode, files, checks: result.checks };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
