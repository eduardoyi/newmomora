/**
 * HMAC client for the render worker's `POST /fit` endpoint (memory-book-5c
 * plan, Design Decision 2/3), called by `memory-book-orders`' `quote` op to
 * get the SUBMITTED-INTERIOR page count for a book's CURRENT (not yet
 * frozen) inputs. Mirrors `generate-memory-book/index.ts`'s
 * `dispatchMemoryBookWorkflow` HMAC construction exactly (same
 * timestamp+nonce+rawBody scheme, same header names) per this change's
 * scope note ("HMAC client -- mirror the dispatch signing in
 * generate-memory-book") -- kept as its own shared module rather than
 * duplicated inline, since the order workflow bridge does not call this
 * (the Cloudflare order workflow calls the render worker directly with its
 * OWN copy of this signing scheme -- see
 * cloudflare/memory-book-order-worker/src/render-worker.ts -- because an
 * Edge Function and a Cloudflare Worker cannot share a Deno-only module).
 *
 * The render worker itself (`render/memory-book-renderer/`) is a separate,
 * not-yet-built change (plan step 3) -- this module only implements the
 * CALLING side of its documented contract (plan Design Decision 3: `/fit`
 * is synchronous, returns `{ pageCount }` in seconds).
 */

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signRenderWorkerRequest(secret: string, rawBody: string): Promise<{ timestamp: string; nonce: string; signature: string }> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return { timestamp, nonce, signature: hex(signatureBytes) };
}

export class RenderWorkerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface RenderWorkerFitInput {
  bookDocument: unknown;
  edits: unknown;
}

export interface RenderWorkerFitResult {
  /** THE page count (plan Design Decision 2's binding definition): the
   * SUBMITTED-INTERIOR count -- post front-matter-verso drop, even-enforced
   * -- the same number `render-pdf.mts` ends with. Feeds the quote, the
   * Prodigi spine lookup, and the Prodigi order alike. */
  pageCount: number;
}

/**
 * Calls the render worker's `POST /fit`. Throws `RenderWorkerError` on any
 * non-2xx or malformed response -- the `quote` op treats that as a hard
 * failure (an untrusted/absent page count must never silently become "0
 * pages" worth of money).
 */
export async function fitBookForQuote(
  fetchFn: typeof fetch,
  renderWorkerUrl: string,
  hmacSecret: string,
  input: RenderWorkerFitInput,
): Promise<RenderWorkerFitResult> {
  const rawBody = JSON.stringify(input);
  const { timestamp, nonce, signature } = await signRenderWorkerRequest(hmacSecret, rawBody);
  const response = await fetchFn(`${renderWorkerUrl}/fit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-render-timestamp': timestamp,
      'x-render-nonce': nonce,
      'x-render-signature': signature,
    },
    body: rawBody,
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new RenderWorkerError(response.status, `render worker /fit failed (${response.status})`);
  }
  const pageCount = Number(json.pageCount);
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    throw new RenderWorkerError(502, 'render worker /fit returned an invalid pageCount');
  }
  return { pageCount };
}
