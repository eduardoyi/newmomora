import { renderBookPdfs } from '../../../book-renderer/scripts/lib/renderBookPdfs';
import type { BookManifest, BookOutline } from '../../../book-renderer/src/model/types';
import type { MemoryBookEditsShape } from '../../../book-renderer/src/model/edits';
import { presignMany, type R2Client } from './r2';
import { planPresign } from './manifestRewrite';
import {
  claimRunning,
  coverObjectKey,
  interiorObjectKey,
  readStatus,
  writeDone,
  writeFailed,
  type RenderStatus,
} from './status';
import type { RenderWorkerEnv } from './env';

/** UUID v4-shaped id — mirrors `cloudflare/memory-book-worker/src/types.ts`'s
 * `WORKFLOW_ID_PATTERN`. `orderId`/`attemptId` are interpolated directly
 * into R2 object keys (see status.ts) — this is a security boundary, not
 * just a shape check: an unvalidated id could otherwise inject a `../` or
 * an unrelated prefix into the key. */
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RenderRequestBody {
  orderId: string;
  attemptId: string;
  bookDocument: { outline: BookOutline; manifest: BookManifest };
  edits?: MemoryBookEditsShape;
  spineMm: number;
}

export function isRenderRequestBody(value: unknown): value is RenderRequestBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const doc = v.bookDocument as Record<string, unknown> | undefined;
  return (
    typeof v.orderId === 'string' &&
    ID_PATTERN.test(v.orderId) &&
    typeof v.attemptId === 'string' &&
    ID_PATTERN.test(v.attemptId) &&
    Boolean(doc) &&
    typeof doc === 'object' &&
    Boolean(doc?.outline) &&
    Boolean(doc?.manifest) &&
    typeof v.spineMm === 'number' &&
    Number.isFinite(v.spineMm) &&
    v.spineMm > 0
  );
}

export type RenderAcceptResult =
  | { kind: 'accepted' }
  | { kind: 'already-done'; status: Extract<RenderStatus, { status: 'done' }> }
  | { kind: 'conflict'; status: RenderStatus | null };

/**
 * `POST /render`'s SYNCHRONOUS half (memory-book-5c plan, Decision 3:
 * "`/render` idempotency is a REAL check ... before rendering, the worker
 * checks R2 for existing output at the attemptId prefix and returns it").
 * `server.ts` awaits this, responds to the HTTP request based on the
 * result, and ONLY on `'accepted'` kicks off `runRenderJob` unawaited (see
 * that function's doc comment for why the actual render never blocks this
 * response — "Async by contract").
 */
export async function acceptRenderRequest(client: R2Client, orderId: string, attemptId: string): Promise<RenderAcceptResult> {
  const existing = await readStatus(client, orderId, attemptId);
  if (existing?.status === 'done') return { kind: 'already-done', status: existing };
  if (existing?.status === 'running') return { kind: 'conflict', status: existing };
  // Undefined, or a previous 'failed' marker for this SAME attemptId — a
  // failed attempt is not sticky forever (the plan's own "failure recovery
  // is refund-or-retry, never silent"), so a fresh POST /render is allowed
  // to retry: fall through to the atomic claim below.

  const claim = await claimRunning(client, orderId, attemptId);
  if (!claim.claimed) {
    // Lost the race to a concurrent request for the SAME attemptId (see
    // claimRunning's own doc comment on the conditional-PUT mechanism).
    if (claim.existing?.status === 'done') return { kind: 'already-done', status: claim.existing };
    return { kind: 'conflict', status: claim.existing };
  }
  return { kind: 'accepted' };
}

/** Presigned R2 GET URLs used for render-time image loads — short-lived,
 * per Decision 3 ("short for render-time image loads"), but long enough to
 * outlast a real multi-minute, concurrency-4 render of a 100+ page book
 * (every URL is minted once, up front, before any page navigation starts). */
const ASSET_GET_URL_TTL_SECONDS = 15 * 60;

/**
 * The actual render pipeline — presign, rewrite, `renderBookPdfs()`, upload,
 * finalize status. Called ONLY after `acceptRenderRequest` returns
 * `'accepted'`, and NEVER awaited by the HTTP handler that calls it (a real
 * print render runs minutes — see `renderBookPdfs.ts` — while every repo
 * Cloudflare Workflow step times out at 30-120s; the plan's own "Async by
 * contract" note). `server.ts` fires this and returns; the caller (future
 * order workflow) polls `GET /status/<attemptId>` instead.
 *
 * Never logs `bookDocument`/`edits` content — only ids/counts, same
 * discipline `render-pdf.mts` already followed (project-wide "no memory
 * content in logs" rule; also true structurally, since nothing here reads
 * memory text at all).
 */
export async function runRenderJob(env: RenderWorkerEnv, client: R2Client, body: RenderRequestBody): Promise<void> {
  const { orderId, attemptId, bookDocument, spineMm } = body;
  const edits = body.edits ?? {};
  try {
    const plan = planPresign(bookDocument.manifest, edits);
    const presignedUrlByKey = await presignMany(client, plan.objectKeys, ASSET_GET_URL_TTL_SECONDS);
    const { manifest, edits: rewrittenEdits } = plan.rewrite(presignedUrlByKey);

    const result = await renderBookPdfs({
      servedDistDir: env.servedDistDir,
      spineMm,
      data: { mode: 'attempt', attemptId, outline: bookDocument.outline, manifest, edits: rewrittenEdits },
      concurrency: env.concurrency,
    });

    await client.putObject(interiorObjectKey(orderId, attemptId), result.interiorPdf, 'application/pdf');
    await client.putObject(coverObjectKey(orderId, attemptId), result.coverPdf, 'application/pdf');

    await writeDone(client, orderId, attemptId, {
      pageCount: result.pageCount,
      checksums: result.checksums,
    });
  } catch (error) {
    // Font hard-fail / dimension-validation failures (wave 1) and any other
    // renderBookPdfs()/fitBookForPrint() throw all surface here — their
    // messages are ids/counts/template ids only (see those modules' own
    // error strings), never memory content, so it's safe to persist verbatim.
    const reason = error instanceof Error ? error.message : String(error);
    await writeFailed(client, orderId, attemptId, reason).catch(() => {});
    throw error;
  }
}
