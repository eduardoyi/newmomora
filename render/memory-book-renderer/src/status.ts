import { PreconditionFailedError, type R2Client } from './r2';

/**
 * Async render status, persisted to R2 (memory-book-5c plan, Step 3:
 * "202-accepts, writes an in-progress marker to the attemptId R2 prefix
 * (409 to a concurrent duplicate) ... completed output is returned
 * idempotently forever"). This worker has no DB of its own to lean on for
 * replay safety (Decision 3, round-2 note) — R2, under the SAME prefix the
 * rendered PDFs land in, is the only durable state this process has, and it
 * must survive a process restart (Fly scale-to-zero) as well as a second
 * concurrent request landing on a DIFFERENT machine (Fly `hard_limit = 1`
 * bounds one machine to one in-flight request, not one in-flight render
 * worker-wide).
 *
 * Layout under `print-orders/<orderId>/<attemptId>/` (task brief's literal
 * path):
 *   status.json    — this module's own state (see `RenderStatus` below)
 *   interior.pdf    — written by render.ts once `pageCount`/checksums are known
 *   cover.pdf
 *
 * ids only in every persisted/returned shape below — never memory content
 * (project-wide rule; also true structurally here, since this module never
 * even sees a book's outline/manifest).
 */

export type RenderStatus =
  | { status: 'running'; startedAt: string }
  | {
      status: 'done';
      pageCount: number;
      checksums: { interior: string; cover: string };
      keys: { interior: string; cover: string };
      completedAt: string;
    }
  | { status: 'failed'; reason: string; failedAt: string };

export function statusObjectKey(orderId: string, attemptId: string): string {
  return `print-orders/${orderId}/${attemptId}/status.json`;
}

export function interiorObjectKey(orderId: string, attemptId: string): string {
  return `print-orders/${orderId}/${attemptId}/interior.pdf`;
}

export function coverObjectKey(orderId: string, attemptId: string): string {
  return `print-orders/${orderId}/${attemptId}/cover.pdf`;
}

export async function readStatus(client: R2Client, orderId: string, attemptId: string): Promise<RenderStatus | null> {
  const object = await client.getObject(statusObjectKey(orderId, attemptId));
  if (!object) return null;
  return JSON.parse(object.text) as RenderStatus;
}

async function writeStatus(
  client: R2Client,
  orderId: string,
  attemptId: string,
  status: RenderStatus,
  condition: { ifNoneMatch?: string; ifMatch?: string } = {},
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(status));
  await client.putObject(statusObjectKey(orderId, attemptId), body, 'application/json; charset=utf-8', condition);
}

export type ClaimResult = { claimed: true } | { claimed: false; existing: RenderStatus | null };

/**
 * Attempts to atomically create/reclaim the `running` marker — the real
 * idempotency check the plan calls for ("a REAL check, not the HMAC
 * window"). Two DIFFERENT atomic conditions, depending on whether this
 * attemptId has ever had a status written before — a single `IfNoneMatch:
 * '*'` condition is NOT enough on its own, because `status.json` is one
 * mutable key reused across the whole `running -> done|failed` lifecycle:
 * once ANY status has been written for an attemptId, the key already
 * exists, so `IfNoneMatch: '*'` would reject every retry forever, even a
 * legitimate one after a `failed` result (the plan's own "failure recovery
 * is refund-or-retry, never silent" — a retry must actually be possible).
 *
 *   1. No status exists yet (fresh attemptId): conditional create
 *      (`IfNoneMatch: '*'`) — R2's own create-if-absent support. A
 *      `PreconditionFailedError` means a concurrent request (a DIFFERENT
 *      Fly machine — see this file's own header comment) won the race;
 *      this call reports "not claimed" without touching anything.
 *   2. A `failed` status already exists (retry): conditional REPLACE
 *      (`IfMatch: <the etag just read>`) — atomic against a second,
 *      concurrent retry racing the SAME failed attemptId: only the request
 *      whose read is still current wins; the loser's `IfMatch` fails
 *      against the winner's now-different etag and reports "not claimed"
 *      the same way. `done`/`running` never reach this branch — the caller
 *      (`render.ts`'s `acceptRenderRequest`) short-circuits both before
 *      ever calling this function.
 */
export async function claimRunning(client: R2Client, orderId: string, attemptId: string): Promise<ClaimResult> {
  const startedAt = new Date().toISOString();
  const running: RenderStatus = { status: 'running', startedAt };

  const existing = await client.getObject(statusObjectKey(orderId, attemptId));
  const existingStatus = existing ? (JSON.parse(existing.text) as RenderStatus) : null;

  // Self-defending, regardless of caller discipline (`render.ts`'s
  // `acceptRenderRequest` already short-circuits `running`/`done` before
  // ever calling this — this is a second, independent guard, not the ONLY
  // one): a `running` or `done` marker is NEVER reclaimable. Only "nothing
  // yet" or "failed" fall through to an atomic write below.
  if (existingStatus && existingStatus.status !== 'failed') {
    return { claimed: false, existing: existingStatus };
  }

  try {
    if (!existing) {
      await writeStatus(client, orderId, attemptId, running, { ifNoneMatch: '*' });
    } else {
      // Retry-after-failed: conditional REPLACE on the exact version just
      // read (see this function's own doc comment, point 2).
      await writeStatus(client, orderId, attemptId, running, { ifMatch: existing.etag });
    }
    return { claimed: true };
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      const current = await readStatus(client, orderId, attemptId);
      return { claimed: false, existing: current };
    }
    throw error;
  }
}

export async function writeDone(
  client: R2Client,
  orderId: string,
  attemptId: string,
  result: { pageCount: number; checksums: { interior: string; cover: string } },
): Promise<RenderStatus> {
  const status: RenderStatus = {
    status: 'done',
    pageCount: result.pageCount,
    checksums: result.checksums,
    keys: { interior: interiorObjectKey(orderId, attemptId), cover: coverObjectKey(orderId, attemptId) },
    completedAt: new Date().toISOString(),
  };
  await writeStatus(client, orderId, attemptId, status);
  return status;
}

export async function writeFailed(client: R2Client, orderId: string, attemptId: string, reason: string): Promise<RenderStatus> {
  const status: RenderStatus = { status: 'failed', reason, failedAt: new Date().toISOString() };
  await writeStatus(client, orderId, attemptId, status);
  return status;
}
