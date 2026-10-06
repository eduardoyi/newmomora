/**
 * HMAC client for the render service's `POST /render-card` (docs/plans/
 * holiday-cards-p1.md Step 5/6): ONE synchronous card render, called by the
 * holiday-card shop's `create_checkout` BEFORE payment.
 *
 * Same signing scheme as `render-worker-client.ts` (`/fit`): headers
 * `x-render-timestamp` / `x-render-nonce` / `x-render-signature`, HMAC-SHA256
 * over `${timestamp}.${nonce}.${rawBody}` with the shared secret. The service
 * URL and secret are the book's own (`MEMORY_BOOK_RENDER_WORKER_URL` /
 * `MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET`): the card route lives on the same
 * Fly service.
 *
 * Answers:
 *   200 { ok: true, mode, files: [{ side, key, sha256, bytes }], checks }
 *   422 { ok: false, code, message }   content the shop can show (a letter
 *                                      that does not fit, a low-res photo)
 *   401 / 5xx                          infra: the caller treats it as "try again"
 *
 * Privacy: errors carry the status, the machine code and the service's own
 * (content-free) message only. Nothing here logs the request body, which holds
 * the family's letter text, names and presigned photo URLs.
 */

export const RENDER_CARD_CONTENT_CODES = [
  'LETTER_OVERFLOW',
  'SAFE_MARGIN',
  'IMAGE_MISSING',
  'IMAGE_LOW_RES',
  'PAGE_SIZE',
  'FONTS',
  'BAD_INPUT',
] as const;
export type RenderCardContentCode = (typeof RENDER_CARD_CONTENT_CODES)[number];

export interface RenderCardRequest {
  orderId: string;
  mode: 'validate' | 'render';
  format: '5R' | 'A5';
  fileLayout: 'two_files' | 'one_pdf';
  /** The frozen `CardData` (`buildCardSnapshot().card`). */
  card: unknown;
  /** The frozen `CardEdits` (`buildCardSnapshot().edits`). */
  edits: unknown;
  /** Asset file name (as the card document references it) -> presigned GET URL. */
  assets: Record<string, string>;
  /** `print-orders/<orderId>/` */
  outputPrefix: string;
}

export interface RenderCardFile {
  side: 'front' | 'back' | 'both';
  key: string;
  sha256: string;
  bytes: number;
}

export interface RenderCardResult {
  mode: 'validate' | 'render';
  files: RenderCardFile[];
  checks: Record<string, unknown>;
}

/** The service refused the content (422): shown to the buyer; no money is involved yet. */
export class RenderCardContentError extends Error {
  constructor(public readonly code: RenderCardContentCode, message: string) {
    super(message);
    this.name = 'RenderCardContentError';
  }
}

/** The service could not render (network, 401, 5xx, malformed answer): retryable, not the buyer's fault. */
export class RenderCardUnavailableError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RenderCardUnavailableError';
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(secret: string, rawBody: string): Promise<{ timestamp: string; nonce: string; signature: string }> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return { timestamp, nonce, signature: hex(signatureBytes) };
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isContentCode(value: unknown): value is RenderCardContentCode {
  return typeof value === 'string' && (RENDER_CARD_CONTENT_CODES as readonly string[]).includes(value);
}

// A card renders in seconds, but a cold Fly machine adds 15-20 s (plan §3).
export const RENDER_CARD_TIMEOUT_MS = 120_000;

/**
 * Calls `POST /render-card`. Throws `RenderCardContentError` for a 422 with a
 * known content code and `RenderCardUnavailableError` for everything else that
 * is not a clean 200 (including a 422 with an unknown code or a body we cannot
 * read: that is a service problem, not something the buyer can fix).
 */
export async function renderCard(
  fetchFn: typeof fetch,
  renderServiceUrl: string,
  hmacSecret: string,
  request: RenderCardRequest,
  timeoutMs = RENDER_CARD_TIMEOUT_MS,
): Promise<RenderCardResult> {
  const rawBody = JSON.stringify(request);
  const { timestamp, nonce, signature } = await sign(hmacSecret, rawBody);
  let response: Response;
  try {
    response = await fetchFn(`${renderServiceUrl.replace(/\/$/, '')}/render-card`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-render-timestamp': timestamp,
        'x-render-nonce': nonce,
        'x-render-signature': signature,
      },
      body: rawBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Never forward the underlying error: it can include the URL.
    throw new RenderCardUnavailableError(0, 'render service unreachable');
  }
  const json = await response.json().catch(() => null) as unknown;

  if (response.status === 422 && isObj(json) && isContentCode(json.code)) {
    const message = typeof json.message === 'string' ? json.message.slice(0, 500) : 'the card could not be rendered';
    throw new RenderCardContentError(json.code, message);
  }
  if (!response.ok || !isObj(json) || json.ok !== true) {
    throw new RenderCardUnavailableError(response.status, `render service answered ${response.status}`);
  }
  const files: RenderCardFile[] = [];
  for (const file of Array.isArray(json.files) ? json.files : []) {
    if (
      !isObj(file) ||
      (file.side !== 'front' && file.side !== 'back' && file.side !== 'both') ||
      typeof file.key !== 'string' || !file.key.startsWith(request.outputPrefix) ||
      typeof file.sha256 !== 'string' || !SHA256_HEX.test(file.sha256) ||
      typeof file.bytes !== 'number' || !(file.bytes > 0)
    ) {
      throw new RenderCardUnavailableError(502, 'render service returned an invalid file entry');
    }
    files.push({ side: file.side, key: file.key, sha256: file.sha256, bytes: file.bytes });
  }
  return { mode: json.mode === 'validate' ? 'validate' : 'render', files, checks: isObj(json.checks) ? json.checks : {} };
}
