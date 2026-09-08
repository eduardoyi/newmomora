/**
 * Signed HMAC bridge for the Memory Book order Cloudflare Workflow
 * (memory-book-5c plan, Design Decision 4). Mirrors
 * `workflow-memory-book-bridge/index.ts`'s shape exactly: the order
 * workflow (`cloudflare/memory-book-order-worker/`) has no Supabase
 * service-role credentials and no R2 credentials (blast-radius control --
 * the same reasoning that keeps the Prodigi key OUT of the render worker
 * keeps DB/R2 creds out of a Worker that also holds the Prodigi key), so
 * every private read/write happens here, authorized by a signed request
 * rather than a user JWT.
 *
 * Same event-id/nonce-ledger deviation as `workflow-memory-book-bridge`'s
 * own header comment: no dedicated replay-ledger table (out of this
 * change's scope, which owns no migration). `isSignedOrderWorkflowRequest`'s
 * 5-minute timestamp window plus the fact every mutating op here is
 * ALREADY a compare-and-set keyed on `workflow_attempt_id` (`mark_submitted`/
 * `mark_failed`) or naturally idempotent (`verify_and_presign_output` is a
 * pure read+presign, `send_order_email` re-sending the same email on a
 * replay is a Bento-side dedupe concern, not a correctness one here) means
 * a replayed request within the window can only ever repeat a no-op.
 *
 * Ops, matching the order workflow's steps
 * (cloudflare/memory-book-order-worker/src/workflow.ts):
 *   - `load_order`: the frozen snapshot + quote/shipping/price the
 *     workflow needs, gated on `status = 'rendering'` AND
 *     `workflow_attempt_id = attemptId` (a superseded/failed attempt bails
 *     here, cheaply, before any render-worker or Prodigi call -- same
 *     "re-verify before doing anything" posture as the generation bridge's
 *     `loadActiveBook`).
 *   - `verify_and_presign_output`: HEADs the render worker's uploaded PDFs
 *     in R2 (existence + size sanity -- this bridge is the only piece of
 *     this whole order pipeline with R2 credentials, matching Design
 *     Decision 3's "the render worker never holds the Prodigi key" blast-
 *     radius split applied to the OTHER direction: the order workflow,
 *     which DOES hold the Prodigi key, never holds R2 credentials either)
 *     and presigns 7-day GET URLs for Prodigi to fetch (prodigi-order-
 *     spec.md's proven expiry window).
 *   - `mark_submitted` / `mark_failed`: the workflow's terminal CAS steps.
 *   - `send_order_email`: paid-confirmation (buyer) and owner-alarm
 *     emails, via `_shared/bento.ts` -- kept here rather than given to the
 *     Cloudflare Worker directly so Bento credentials never need to be
 *     duplicated into a second runtime's secrets, and so the buyer's email
 *     address (looked up via `auth.admin.getUserById`) never has to cross
 *     the signed-bridge boundary as an explicit payload field.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { headObject, createPresignedGetUrls } from '../_shared/r2.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
const DEFAULT_ALERT_RECIPIENT = 'hello@usemomora.com';
const PRESIGN_SECONDS_7_DAYS = 7 * 24 * 60 * 60;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const toFixedDigest = (value: string): Uint8Array => {
    const digest = new Uint8Array(32);
    if (!/^[0-9a-f]{64}$/i.test(value)) return digest;
    for (let index = 0; index < 32; index += 1) digest[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    return digest;
  };
  const leftDigest = toFixedDigest(left);
  const rightDigest = toFixedDigest(right);
  let mismatch = 0;
  for (let index = 0; index < 32; index += 1) mismatch |= leftDigest[index] ^ rightDigest[index];
  return mismatch === 0;
}

export async function isSignedOrderWorkflowRequest(req: Request, rawBody: string): Promise<boolean> {
  const timestamp = req.headers.get('x-workflow-timestamp');
  const signature = req.headers.get('x-workflow-signature');
  const nonce = req.headers.get('x-workflow-nonce');
  const secret = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_ORDER_BRIDGE_SECRET');
  if (!timestamp || !signature || !nonce || !secret) return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > MAX_SIGNATURE_AGE_MS) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  return constantTimeEqual(hex(digest), signature.toLowerCase());
}

interface BridgeBody {
  operation: string;
  orderId?: unknown;
  attemptId?: unknown;
  interiorKey?: unknown;
  coverKey?: unknown;
  prodigiOrderId?: unknown;
  failureReason?: unknown;
  emailKind?: unknown;
  detail?: unknown;
  pdfLinks?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

interface OrderRow {
  id: string;
  book_id: string;
  family_id: string;
  requested_by: string | null;
  status: string;
  workflow_attempt_id: string | null;
  price_cents: number | null;
  shipping_cost_cents: number | null;
  currency: string;
  quoted_page_count: number | null;
  shipping_address: Record<string, unknown> | null;
  book_document_snapshot: unknown;
  edits_snapshot: unknown;
}

async function loadActiveOrder(
  supabase: SupabaseClient,
  orderId: string,
  attemptId: string,
): Promise<{ row: OrderRow } | { error: Response }> {
  const { data: row, error } = await supabase
    .from('memory_book_orders')
    .select('id, book_id, family_id, requested_by, status, workflow_attempt_id, price_cents, shipping_cost_cents, currency, quoted_page_count, shipping_address, book_document_snapshot, edits_snapshot')
    .eq('id', orderId)
    .maybeSingle<OrderRow>();
  if (error) return { error: errorResponse('Failed to load order', 500, 'internal_error') };
  if (!row) return { error: errorResponse('Order not found', 404, 'ORDER_NOT_FOUND') };
  if (row.status !== 'rendering' || row.workflow_attempt_id !== attemptId) {
    return { error: errorResponse('Order attempt is no longer current', 409, 'ORDER_SUPERSEDED') };
  }
  return { row };
}

async function handleLoadOrder(supabase: SupabaseClient, orderId: string, attemptId: string): Promise<Response> {
  const active = await loadActiveOrder(supabase, orderId, attemptId);
  if ('error' in active) return active.error;
  const order = active.row;
  if (!order.book_document_snapshot || !order.edits_snapshot || order.price_cents === null || order.shipping_cost_cents === null || order.quoted_page_count === null || !order.shipping_address) {
    return errorResponse('Order is missing frozen fields', 409, 'ORDER_INCOMPLETE');
  }
  return jsonResponse({
    order: {
      id: order.id,
      bookId: order.book_id,
      bookDocumentSnapshot: order.book_document_snapshot,
      editsSnapshot: order.edits_snapshot,
      quotedPageCount: order.quoted_page_count,
      priceCents: order.price_cents,
      shippingCostCents: order.shipping_cost_cents,
      currency: order.currency,
      shippingAddress: order.shipping_address,
    },
  });
}

async function handleVerifyAndPresignOutput(
  deps: BridgeDependencies,
  supabase: SupabaseClient,
  orderId: string,
  attemptId: string,
  interiorKey: string,
  coverKey: string,
): Promise<Response> {
  const active = await loadActiveOrder(supabase, orderId, attemptId);
  if ('error' in active) return active.error;

  const [interiorHead, coverHead] = await Promise.all([deps.headObject(interiorKey), deps.headObject(coverKey)]);
  if (!interiorHead || !interiorHead.contentLength || interiorHead.contentLength <= 0) {
    return errorResponse('Interior PDF missing or empty', 502, 'RENDER_OUTPUT_MISSING');
  }
  if (!coverHead || !coverHead.contentLength || coverHead.contentLength <= 0) {
    return errorResponse('Cover PDF missing or empty', 502, 'RENDER_OUTPUT_MISSING');
  }

  const urls = await deps.createPresignedGetUrls([interiorKey, coverKey], PRESIGN_SECONDS_7_DAYS);
  return jsonResponse({
    interiorUrl: urls[interiorKey],
    coverUrl: urls[coverKey],
    interiorSize: interiorHead.contentLength,
    coverSize: coverHead.contentLength,
  });
}

async function handleMarkSubmitted(
  supabase: SupabaseClient,
  orderId: string,
  attemptId: string,
  prodigiOrderId: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from('memory_book_orders')
    .update({
      status: 'submitted',
      prodigi_order_id: prodigiOrderId,
      workflow_completed_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('workflow_attempt_id', attemptId)
    .eq('status', 'rendering')
    .select('id')
    .maybeSingle();
  if (error) return errorResponse('Failed to record submission', 500, 'internal_error');
  return jsonResponse({ submitted: Boolean(data) });
}

async function handleMarkFailed(
  supabase: SupabaseClient,
  orderId: string,
  attemptId: string,
  failureReason: string,
): Promise<Response> {
  const { data, error } = await supabase
    .from('memory_book_orders')
    .update({
      status: 'failed',
      failure_reason: failureReason.slice(0, 200),
      workflow_completed_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .eq('workflow_attempt_id', attemptId)
    .eq('status', 'rendering')
    .select('id')
    .maybeSingle();
  if (error) return errorResponse('Failed to record failure', 500, 'internal_error');
  return jsonResponse({ failed: Boolean(data) });
}

function getAlertRecipient(): string {
  return Deno.env.get('MEMORY_BOOK_ORDER_ALERT_EMAIL')?.trim() || DEFAULT_ALERT_RECIPIENT;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function handleSendOrderEmail(
  deps: BridgeDependencies,
  supabase: SupabaseClient,
  orderId: string,
  emailKind: string,
  detail: string | null,
  pdfLinks: { interiorUrl?: string; coverUrl?: string } | null,
): Promise<Response> {
  const { data: order, error } = await supabase
    .from('memory_book_orders')
    .select('id, requested_by, prodigi_order_id')
    .eq('id', orderId)
    .maybeSingle();
  if (error || !order) {
    console.error('workflow-memory-book-order-bridge send_order_email order lookup failed', orderId);
    return jsonResponse({ sent: false });
  }

  if (emailKind === 'paid_confirmation') {
    if (!order.requested_by) return jsonResponse({ sent: false });
    const { data: authUser } = await supabase.auth.admin.getUserById(order.requested_by);
    const email = authUser?.user?.email;
    if (!email) return jsonResponse({ sent: false });
    const outcome = await deps.sendEmail({
      to: email,
      subject: 'Your Momora Memory Book order is on its way to print',
      htmlBody: `<p>Thank you for your order! We've submitted your Memory Book for printing.</p><p>Order reference: ${escapeHtml(order.id)}</p><p>We'll email you again once it ships.</p>`,
    });
    return jsonResponse({ sent: outcome === 'sent' });
  }

  // owner_alarm
  const links = pdfLinks ?? {};
  const linksHtml = [
    links.interiorUrl ? `<li>Interior PDF: <a href="${escapeHtml(links.interiorUrl)}">link (7-day expiry)</a></li>` : '',
    links.coverUrl ? `<li>Cover PDF: <a href="${escapeHtml(links.coverUrl)}">link (7-day expiry)</a></li>` : '',
  ].filter(Boolean).join('');
  const outcome = await deps.sendEmail({
    to: getAlertRecipient(),
    subject: `Momora order submitted -- spot-check ${order.id}`,
    htmlBody: `<p>Order <code>${escapeHtml(order.id)}</code> was submitted to Prodigi (Prodigi order id: ${escapeHtml(order.prodigi_order_id ?? 'unknown')}).</p><ul>${linksHtml}</ul><p>${detail ? escapeHtml(detail) : 'Soft-launch human QA: please spot-check the rendered PDFs during Prodigi\'s order-edit window.'}</p>`,
  });
  return jsonResponse({ sent: outcome === 'sent' });
}

export interface BridgeDependencies {
  createServiceClient: typeof createServiceClient;
  headObject: typeof headObject;
  createPresignedGetUrls: typeof createPresignedGetUrls;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
}

export const DEFAULT_DEPENDENCIES: BridgeDependencies = {
  createServiceClient,
  headObject,
  createPresignedGetUrls,
  sendEmail: sendTransactionalEmailWithOutcome,
};

export async function handleWorkflowMemoryBookOrderBridge(
  req: Request,
  dependencyOverrides: Partial<BridgeDependencies> = {},
): Promise<Response> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const rawBody = await req.text();
  if (!(await isSignedOrderWorkflowRequest(req, rawBody))) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  let body: BridgeBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }

  const validOperations = new Set(['load_order', 'verify_and_presign_output', 'mark_submitted', 'mark_failed', 'send_order_email']);
  if (typeof body.operation !== 'string' || !validOperations.has(body.operation) || !isUuid(body.orderId)) {
    return errorResponse('Invalid workflow operation', 400, 'validation_error');
  }

  const supabase = deps.createServiceClient();
  const orderId = body.orderId as string;

  try {
    if (body.operation === 'send_order_email') {
      const emailKind = typeof body.emailKind === 'string' ? body.emailKind : '';
      if (emailKind !== 'paid_confirmation' && emailKind !== 'owner_alarm') {
        return errorResponse('Invalid emailKind', 400, 'validation_error');
      }
      const detail = typeof body.detail === 'string' ? body.detail : null;
      const pdfLinks = typeof body.pdfLinks === 'object' && body.pdfLinks !== null ? body.pdfLinks as { interiorUrl?: string; coverUrl?: string } : null;
      return await handleSendOrderEmail(deps, supabase, orderId, emailKind, detail, pdfLinks);
    }

    if (!isUuid(body.attemptId)) return errorResponse('Invalid workflow operation', 400, 'validation_error');
    const attemptId = body.attemptId as string;

    switch (body.operation) {
      case 'load_order':
        return await handleLoadOrder(supabase, orderId, attemptId);
      case 'verify_and_presign_output': {
        if (typeof body.interiorKey !== 'string' || typeof body.coverKey !== 'string' || !body.interiorKey || !body.coverKey) {
          return errorResponse('interiorKey and coverKey are required', 400, 'validation_error');
        }
        return await handleVerifyAndPresignOutput(deps, supabase, orderId, attemptId, body.interiorKey, body.coverKey);
      }
      case 'mark_submitted': {
        if (typeof body.prodigiOrderId !== 'string' || !body.prodigiOrderId) {
          return errorResponse('prodigiOrderId is required', 400, 'validation_error');
        }
        return await handleMarkSubmitted(supabase, orderId, attemptId, body.prodigiOrderId);
      }
      case 'mark_failed': {
        const reason = typeof body.failureReason === 'string' && body.failureReason.trim() ? body.failureReason.trim() : 'UNKNOWN_ERROR';
        return await handleMarkFailed(supabase, orderId, attemptId, reason);
      }
      default:
        return errorResponse('Invalid workflow operation', 400, 'validation_error');
    }
  } catch {
    console.error('workflow memory book order bridge failed', body.operation, orderId);
    return errorResponse('Order workflow bridge operation failed', 500, 'internal_error');
  }
}

if (import.meta.main) Deno.serve((request) => handleWorkflowMemoryBookOrderBridge(request));
