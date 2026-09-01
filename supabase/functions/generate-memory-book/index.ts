/**
 * Memory Book generation dispatcher (V5a "part C"). Mirrors
 * generate-portrait-illustration/index.ts's cloudflare-backend dispatch
 * shape (docs/durable-ai-generation-workflows.md): JWT auth, manager/owner
 * family-role check, idempotent-fresh-generating redispatch, an atomic
 * compare-and-set claim to `generating`, then a signed dispatch to the
 * Cloudflare Worker.
 *
 * Deviation from the illustration/portrait precedent (documented, see
 * docs/features/memory-book-generation.md and this change's implementation
 * report): this task's explicit scope excludes schema changes, so there is
 * no `publish_memory_book_workflow(...)`-style Postgres RPC and no bridge
 * nonce-replay ledger table. The compare-and-set discipline the playbook
 * requires ("Publication is a database compare-and-set") is instead
 * enforced by a single service-role `UPDATE ... WHERE id = ... AND status
 * = ...` statement -- Postgres re-evaluates that WHERE clause against the
 * CURRENT row at write time (not the value this function read earlier), so
 * it is already a fully atomic CAS with no separate function needed. See
 * workflow-memory-book-bridge/index.ts's header comment for the matching
 * nonce-ledger deviation on the publish/fail side.
 */
import { getAuthenticatedNonAnonymousUser, getAuthenticatedUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

export interface GenerateMemoryBookRequest {
  memoryBookId: string;
}

export interface GenerateMemoryBookResponse {
  success: true;
  status: 'ready' | 'generating';
  queued?: true;
  attemptId?: string;
}

interface MemoryBookRow {
  id: string;
  family_id: string;
  status: 'queued' | 'generating' | 'ready' | 'failed';
  workflow_instance_id: string | null;
  generation_attempt_id: string | null;
  generation_started_at: string | null;
}

export interface GenerateMemoryBookDependencies {
  getAuthenticatedUser: typeof getAuthenticatedUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  fetch: typeof fetch;
  now: () => number;
}

export const DEFAULT_DEPENDENCIES: GenerateMemoryBookDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  getCallerFamilyRole,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
};

// Provisional -- not yet measured against real production runs (this
// pipeline has no image generation, so a text-outline-only lease should be
// materially shorter than the illustration workflow's 5:00+0:30, but this
// is the FIRST durable run of this pipeline; revisit once the E2E run in
// this change's own report gives a real duration to calibrate against, per
// docs/durable-ai-generation-workflows.md's warning against copying another
// pipeline's lease "without measuring that pipeline").
export const MEMORY_BOOK_LEASE_MS = 8 * 60_000;
export const MEMORY_BOOK_RECOVERY_GRACE_MS = 30_000;

export function isFreshGeneratingMemoryBook(generationStartedAt: string | null, now: number): boolean {
  if (!generationStartedAt) return false;
  const startedAt = Date.parse(generationStartedAt);
  return Number.isFinite(startedAt) && now - startedAt < MEMORY_BOOK_LEASE_MS + MEMORY_BOOK_RECOVERY_GRACE_MS;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatchMemoryBookWorkflow(
  fetchFn: typeof fetch,
  bookId: string,
  attemptId: string,
): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_DISPATCH_SECRET');
  if (!endpoint || !secret) {
    throw new Error('Cloudflare memory book workflow is not configured');
  }

  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify({ bookId, attemptId });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`),
  );
  const signature = hex(signatureBytes);

  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': signature,
    },
    body: rawBody,
  });
  await response.text().catch(() => '');
  // A duplicate Workflow instance is success: the attempt id is deliberately
  // reused after a network-ambiguous dispatch response (see the illustration
  // dispatcher's identical convention).
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cloudflare memory book workflow dispatch failed (${response.status})`);
  }
}

export async function handleGenerateMemoryBook(
  req: Request,
  dependencyOverrides: Partial<GenerateMemoryBookDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: GenerateMemoryBookRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!body.memoryBookId || typeof body.memoryBookId !== 'string') {
    return errorResponse('memoryBookId is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();
  const { data: row, error: rowError } = await supabase
    .from('memory_books')
    .select('id, family_id, status, workflow_instance_id, generation_attempt_id, generation_started_at')
    .eq('id', body.memoryBookId)
    .maybeSingle<MemoryBookRow>();
  if (rowError) {
    console.error('generate-memory-book row lookup failed', rowError.message);
    return errorResponse('Failed to load memory book', 500, 'internal_error');
  }
  if (!row) return errorResponse('Memory book not found', 404, 'MEMORY_BOOK_NOT_FOUND');

  const callerRole = await dependencies.getCallerFamilyRole(supabase, row.family_id, user.id);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized for this memory book', 403, 'forbidden');
  }

  if (row.status === 'ready') {
    return jsonResponse({ success: true, status: 'ready' } satisfies GenerateMemoryBookResponse, 200);
  }

  const now = dependencies.now();

  if (row.status === 'generating' && isFreshGeneratingMemoryBook(row.generation_started_at, now)) {
    // A prior request may have timed out after the CAS claim but before
    // observing the Worker's 202. Re-dispatch the same attempt id instead of
    // returning a misleading in-progress error or paying for another
    // outline run.
    if (row.workflow_instance_id && row.generation_attempt_id) {
      try {
        await dispatchMemoryBookWorkflow(dependencies.fetch, row.id, row.workflow_instance_id);
      } catch {
        console.error('generate-memory-book active workflow redispatch failed', row.id);
      }
      return jsonResponse(
        { success: true, status: 'generating', queued: true, attemptId: row.generation_attempt_id } satisfies GenerateMemoryBookResponse,
        202,
      );
    }
    return errorResponse('Memory book generation in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  // Claimable: queued, failed (explicit retry), or a stale generating row
  // (abandoned lease -- recoverable). Every branch reaches the SAME atomic
  // CAS below; only the WHERE guard differs for the stale-generating case
  // (see this file's header comment on why a plain status match alone isn't
  // enough to protect against two concurrent stale-recovery claims).
  const attemptId = crypto.randomUUID();
  const nowIso = new Date(now).toISOString();

  let claim = supabase
    .from('memory_books')
    .update({
      status: 'generating',
      workflow_instance_id: attemptId,
      generation_attempt_id: attemptId,
      generation_started_at: nowIso,
      generation_completed_at: null,
      failure_reason: null,
    })
    .eq('id', row.id)
    .eq('status', row.status);
  if (row.status === 'generating') {
    // Stale-recovery guard: only reclaim if the clock hasn't moved since we
    // read it (a legitimate concurrent claim would have written a NEW
    // generation_started_at, failing this predicate).
    claim = row.generation_started_at
      ? claim.eq('generation_started_at', row.generation_started_at)
      : claim.is('generation_started_at', null);
  }

  const { data: claimed, error: claimError } = await claim.select('id').maybeSingle();
  if (claimError) {
    console.error('generate-memory-book claim failed', claimError.message);
    return errorResponse('Failed to start memory book generation', 500, 'internal_error');
  }
  if (!claimed) {
    return errorResponse('Memory book generation in progress', 409, 'GENERATION_IN_PROGRESS');
  }

  try {
    await dispatchMemoryBookWorkflow(dependencies.fetch, row.id, attemptId);
  } catch {
    console.error('generate-memory-book dispatch failed', row.id);
    await supabase
      .from('memory_books')
      .update({
        status: 'failed',
        failure_reason: 'DISPATCH_FAILED',
        generation_completed_at: new Date(dependencies.now()).toISOString(),
      })
      .eq('id', row.id)
      .eq('generation_attempt_id', attemptId);
    return errorResponse('Failed to dispatch memory book generation', 500, 'GENERATION_FAILED');
  }

  return jsonResponse(
    { success: true, status: 'generating', queued: true, attemptId } satisfies GenerateMemoryBookResponse,
    202,
  );
}

if (import.meta.main) Deno.serve((request) => handleGenerateMemoryBook(request));
