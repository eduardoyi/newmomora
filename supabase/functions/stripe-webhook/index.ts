/**
 * Stripe webhook for Memory Book orders (memory-book-5c plan, Design
 * Decision 4). `verify_jwt = false` in config.toml (Stripe cannot supply a
 * Supabase JWT) -- authorization is instead the Stripe signature check
 * below, same "signed-request-replaces-JWT" shape as
 * `workflow-memory-book-bridge`'s HMAC bridge and `revenuecat-webhook`'s
 * shared-secret check, just with Stripe's own scheme
 * (`_shared/stripe.ts#verifyStripeSignature`).
 *
 * Event-id idempotency, documented deviation (same posture
 * `workflow-memory-book-bridge/index.ts`'s header comment takes for ITS own
 * nonce-ledger deviation): this repo has no generic "processed Stripe event
 * ids" table, and adding one is a schema change outside this task's scope
 * (schema/RLS shipped in a separate wave-1 change,
 * supabase/migrations/20260908120000_memory_book_orders.sql). Every write
 * this handler makes is ALREADY a compare-and-set keyed on the row's
 * CURRENT `status` (`quoted -> paid`, `paid -> rendering`,
 * `quoted -> cancelled`) or is naturally idempotent (`refunded_at` being set
 * to the same value twice). A replayed Stripe event -- which Stripe does
 * send, by design, until the endpoint 200s -- can therefore only ever repeat
 * a no-op: the second `checkout.session.completed` delivery finds
 * `status <> 'quoted'` and the CAS matches zero rows, so nothing double-
 * fires. This is a real, intentional trade against a dedicated ledger
 * table; a future change that also owns a migration could add one for
 * defense-in-depth against a CAS-bypassing bug, but does not need to for
 * correctness today.
 *
 * Every handler returns 200 once the event has been durably accounted for
 * (including a deliberate "refuse to process" outcome, e.g. an amount/
 * address mismatch or an unresolved originalFile) -- Stripe retries a
 * non-2xx response indefinitely, which would only ever repeat the same
 * refusal. A refusal is instead surfaced as an owner alarm email, never a
 * 5xx that trains Stripe to hammer this endpoint.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { backfillOriginalFilesForBook } from '../_shared/memory-book-backfill.ts';
import { verifyStripeSignature, type StripeEvent } from '../_shared/stripe.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const DEFAULT_ALERT_RECIPIENT = 'hello@usemomora.com';

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatchOrderWorkflow(fetchFn: typeof fetch, orderId: string, attemptId: string): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_ORDER_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_ORDER_DISPATCH_SECRET');
  if (!endpoint || !secret) {
    throw new Error('Cloudflare memory book order workflow is not configured');
  }
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify({ orderId, attemptId });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${nonce}.${rawBody}`));
  const response = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-dispatch-timestamp': timestamp,
      'x-dispatch-nonce': nonce,
      'x-dispatch-signature': hex(signatureBytes),
    },
    body: rawBody,
  });
  await response.text().catch(() => '');
  // A duplicate Workflow instance is success -- same convention
  // generate-memory-book/index.ts's dispatcher uses.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Cloudflare order workflow dispatch failed (${response.status})`);
  }
}

function getAlertRecipient(): string {
  return Deno.env.get('MEMORY_BOOK_ORDER_ALERT_EMAIL')?.trim() || DEFAULT_ALERT_RECIPIENT;
}

/** Owner alarm email -- PII-free by construction: only the order id and a
 * closed reason code ever go into the body (never an address, a memory
 * caption, or a Stripe object dump). Best-effort: a failed alert send is
 * logged, never re-thrown into the webhook's own response path (Stripe's
 * retry would only repeat the alert-send attempt, not fix the underlying
 * issue). */
async function alertOwner(
  sendEmail: typeof sendTransactionalEmailWithOutcome,
  orderId: string,
  reason: string,
  detail: string,
): Promise<void> {
  try {
    const outcome = await sendEmail({
      to: getAlertRecipient(),
      subject: `Momora order alert: ${reason}`,
      htmlBody: `<p>Order <code>${orderId}</code> needs attention.</p><p>Reason: ${reason}</p><p>${detail}</p>`,
    });
    if (outcome !== 'sent') console.error('stripe-webhook owner alert not confirmed sent', reason);
  } catch (error) {
    console.error('stripe-webhook owner alert failed', reason, error instanceof Error ? error.message : 'unknown');
  }
}

interface OrderRow {
  id: string;
  book_id: string;
  family_id: string;
  status: string;
  price_cents: number | null;
  shipping_cost_cents: number | null;
  shipping_address: Record<string, unknown> | null;
  stripe_payment_intent_id: string | null;
  workflow_attempt_id: string | null;
}

function stripeObject(event: StripeEvent): Record<string, unknown> {
  return event.data.object;
}

function normalizeForCompare(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Best-effort address match (round-3 "defense in depth on the money
 * path", not a byte-exact requirement -- Stripe/Checkout may normalize
 * casing/whitespace). Compares postal code, country, and the first
 * address line only; a mismatch here means the CUSTOMER changed their
 * shipping destination between quoting and paying, which must never be
 * silently accepted (the quoted price/shipping was computed for the
 * ORIGINAL address). */
function addressesRoughlyMatch(quoted: Record<string, unknown> | null, sessionAddress: Record<string, unknown> | null | undefined): boolean {
  if (!quoted || !sessionAddress) return false;
  const quotedPostal = normalizeForCompare(quoted.postalCode);
  const quotedCountry = normalizeForCompare(quoted.countryCode);
  const quotedLine1 = normalizeForCompare(quoted.line1);
  const sessionPostal = normalizeForCompare(sessionAddress.postal_code);
  const sessionCountry = normalizeForCompare(sessionAddress.country);
  const sessionLine1 = normalizeForCompare(sessionAddress.line1);
  return quotedPostal === sessionPostal && quotedCountry === sessionCountry && quotedLine1 === sessionLine1;
}

async function handleCheckoutSessionCompleted(
  fetchFn: typeof fetch,
  sendEmail: typeof sendTransactionalEmailWithOutcome,
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<Response> {
  const session = stripeObject(event);
  const orderId = typeof session.metadata === 'object' && session.metadata !== null
    ? (session.metadata as Record<string, unknown>).orderId
    : undefined;
  if (typeof orderId !== 'string' || !orderId) {
    console.error('stripe-webhook checkout.session.completed missing orderId metadata');
    return jsonResponse({ received: true, ignored: true });
  }

  const { data: order, error } = await supabase
    .from('memory_book_orders')
    .select('id, book_id, family_id, status, price_cents, shipping_cost_cents, shipping_address, stripe_payment_intent_id, workflow_attempt_id')
    .eq('id', orderId)
    .maybeSingle<OrderRow>();
  if (error) {
    console.error('stripe-webhook order lookup failed', error.message);
    return errorResponse('Failed to load order', 500, 'internal_error');
  }
  if (!order) {
    console.error('stripe-webhook checkout.session.completed order not found', orderId);
    return jsonResponse({ received: true, ignored: true });
  }
  if (order.status !== 'quoted') {
    // Idempotent replay (already paid/rendering/...) or an order that never
    // reached 'quoted' -- either way, nothing new to do.
    return jsonResponse({ received: true, alreadyHandled: true });
  }

  const amountSubtotal = Number(session.amount_subtotal);
  const expectedSubtotal = (order.price_cents ?? 0) + (order.shipping_cost_cents ?? 0);
  const sessionAddress = (session.customer_details as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined
    ?? (session.shipping_details as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined;

  if (!Number.isFinite(amountSubtotal) || amountSubtotal !== expectedSubtotal) {
    console.error('stripe-webhook amount mismatch', orderId);
    await alertOwner(sendEmail, orderId, 'AMOUNT_MISMATCH', 'Stripe amount_subtotal did not match the persisted quote. Payment captured -- do not fulfill without manual review.');
    return jsonResponse({ received: true, refused: 'amount_mismatch' });
  }
  if (!addressesRoughlyMatch(order.shipping_address, sessionAddress)) {
    console.error('stripe-webhook address mismatch', orderId);
    await alertOwner(sendEmail, orderId, 'ADDRESS_MISMATCH', 'Stripe session address did not match the persisted quote address. Payment captured -- do not fulfill without manual review.');
    return jsonResponse({ received: true, refused: 'address_mismatch' });
  }

  const { data: book, error: bookError } = await supabase
    .from('memory_books')
    .select('id, family_id, book_document')
    .eq('id', order.book_id)
    .maybeSingle();
  if (bookError || !book) {
    console.error('stripe-webhook book lookup failed', orderId);
    await alertOwner(sendEmail, orderId, 'BOOK_LOAD_FAILED', 'Payment captured but the source book could not be loaded for freezing.');
    return jsonResponse({ received: true, refused: 'book_load_failed' });
  }

  const { data: editsRow } = await supabase
    .from('memory_book_edits')
    .select('edits')
    .eq('book_id', order.book_id)
    .maybeSingle();
  const editsSnapshot = editsRow?.edits ?? { text: {}, images: {}, focalPoints: {} };

  // Freeze precondition (Design Decision 1): refuse to freeze a
  // book_document_snapshot missing originalFile anywhere. Re-runs the same
  // idempotent backfill the quote op already attempted -- if anything is
  // STILL unresolved here, the money has already been captured by Stripe,
  // so this is recorded as a failed order (not silently dropped) and
  // alarmed for manual resolution/refund.
  let patchedBookDocument = book.book_document;
  try {
    const backfilled = await backfillOriginalFilesForBook(supabase, book.family_id, book.book_document);
    patchedBookDocument = backfilled.bookDocument;
    if (backfilled.unresolved.length > 0) {
      const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
      await supabase
        .from('memory_book_orders')
        .update({
          status: 'failed',
          failure_reason: 'ORIGINAL_FILE_UNRESOLVED',
          book_document_snapshot: backfilled.bookDocument,
          edits_snapshot: editsSnapshot,
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq('id', orderId)
        .eq('status', 'quoted');
      await alertOwner(sendEmail, orderId, 'ORIGINAL_FILE_UNRESOLVED', 'Payment captured but the book document could not be fully backfilled with print-resolution assets. Manual fix or refund required.');
      return jsonResponse({ received: true, refused: 'original_file_unresolved' });
    }
  } catch (backfillError) {
    console.error('stripe-webhook freeze backfill failed', orderId, backfillError instanceof Error ? backfillError.message : 'unknown');
    await alertOwner(sendEmail, orderId, 'FREEZE_BACKFILL_FAILED', 'Payment captured but freezing the book document failed unexpectedly.');
    return jsonResponse({ received: true, refused: 'freeze_backfill_failed' });
  }

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;

  const { data: paidRow, error: paidError } = await supabase
    .from('memory_book_orders')
    .update({
      status: 'paid',
      book_document_snapshot: patchedBookDocument,
      edits_snapshot: editsSnapshot,
      stripe_payment_intent_id: paymentIntentId,
    })
    .eq('id', orderId)
    .eq('status', 'quoted')
    .select('id')
    .maybeSingle();
  if (paidError) {
    console.error('stripe-webhook paid CAS failed', orderId, paidError.message);
    await alertOwner(sendEmail, orderId, 'PAID_CAS_FAILED', 'Payment captured but the order row could not be updated. Investigate immediately.');
    return errorResponse('Failed to record payment', 500, 'internal_error');
  }
  if (!paidRow) {
    // Lost the race to another delivery of this same event -- already
    // handled, nothing further to do.
    return jsonResponse({ received: true, alreadyHandled: true });
  }

  // Mark-before-dispatch (round-2 zero-dispatch recovery, mirrors
  // generate-memory-book/index.ts's CAS-then-dispatch order): claim a fresh
  // workflow attempt BEFORE calling the Cloudflare Worker, so a crash
  // between the claim and the dispatch call leaves a `rendering` row the
  // sweep's reconciliation pass can find and redispatch, rather than a
  // `paid` row with an ambiguous "did we ever try" state.
  const attemptId = crypto.randomUUID();
  const { data: claimed, error: claimError } = await supabase
    .from('memory_book_orders')
    .update({
      status: 'rendering',
      workflow_instance_id: attemptId,
      workflow_attempt_id: attemptId,
      workflow_started_at: new Date().toISOString(),
      workflow_completed_at: null,
    })
    .eq('id', orderId)
    .eq('status', 'paid')
    .select('id')
    .maybeSingle();
  if (claimError || !claimed) {
    console.error('stripe-webhook rendering claim failed', orderId, claimError?.message ?? 'no row');
    // Not fatal to this response -- the order is safely `paid` and the
    // sweep's zero-dispatch reconciliation will pick it up.
    return jsonResponse({ received: true, dispatchPending: true });
  }

  try {
    await dispatchOrderWorkflow(fetchFn, orderId, attemptId);
  } catch (dispatchError) {
    console.error('stripe-webhook order workflow dispatch failed', orderId, dispatchError instanceof Error ? dispatchError.message : 'unknown');
    await supabase
      .from('memory_book_orders')
      .update({ status: 'failed', failure_reason: 'DISPATCH_FAILED', workflow_completed_at: new Date().toISOString() })
      .eq('id', orderId)
      .eq('workflow_attempt_id', attemptId);
    await alertOwner(sendEmail, orderId, 'DISPATCH_FAILED', 'Payment captured but the order workflow could not be dispatched.');
    return jsonResponse({ received: true, dispatchFailed: true });
  }

  return jsonResponse({ received: true, orderId, status: 'rendering' });
}

async function handleChargeRefunded(supabase: SupabaseClient, event: StripeEvent): Promise<Response> {
  const charge = stripeObject(event);
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  if (!paymentIntentId) return jsonResponse({ received: true, ignored: true });

  const { error } = await supabase
    .from('memory_book_orders')
    .update({ refunded_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .is('refunded_at', null);
  if (error) {
    console.error('stripe-webhook refund record failed', error.message);
    return errorResponse('Failed to record refund', 500, 'internal_error');
  }
  return jsonResponse({ received: true });
}

async function handleCheckoutSessionExpired(supabase: SupabaseClient, event: StripeEvent): Promise<Response> {
  const session = stripeObject(event);
  const orderId = typeof session.metadata === 'object' && session.metadata !== null
    ? (session.metadata as Record<string, unknown>).orderId
    : undefined;
  if (typeof orderId !== 'string' || !orderId) return jsonResponse({ received: true, ignored: true });

  const { error } = await supabase
    .from('memory_book_orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .eq('status', 'quoted');
  if (error) {
    console.error('stripe-webhook expiry CAS failed', orderId, error.message);
    return errorResponse('Failed to record checkout expiry', 500, 'internal_error');
  }
  return jsonResponse({ received: true });
}

export interface StripeWebhookDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  verifyStripeSignature: typeof verifyStripeSignature;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
}

export const DEFAULT_DEPENDENCIES: StripeWebhookDependencies = {
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  verifyStripeSignature,
  sendEmail: sendTransactionalEmailWithOutcome,
};

export async function handleStripeWebhook(
  req: Request,
  dependencyOverrides: Partial<StripeWebhookDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!webhookSecret) {
    console.error('stripe-webhook missing STRIPE_WEBHOOK_SECRET');
    return errorResponse('Webhook is not configured', 500, 'internal_error');
  }

  const rawBody = await req.text();
  const event = await dependencies.verifyStripeSignature(rawBody, req.headers.get('stripe-signature'), webhookSecret);
  if (!event) return errorResponse('Invalid signature', 401, 'unauthorized');

  const supabase = dependencies.createServiceClient();

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        return await handleCheckoutSessionCompleted(dependencies.fetch, dependencies.sendEmail, supabase, event);
      case 'charge.refunded':
        return await handleChargeRefunded(supabase, event);
      case 'checkout.session.expired':
        return await handleCheckoutSessionExpired(supabase, event);
      default:
        return jsonResponse({ received: true, ignored: true });
    }
  } catch (error) {
    console.error('stripe-webhook handler failed', event.type, error instanceof Error ? error.message : 'unknown');
    return errorResponse('Webhook handling failed', 500, 'internal_error');
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleStripeWebhook(request));
}
