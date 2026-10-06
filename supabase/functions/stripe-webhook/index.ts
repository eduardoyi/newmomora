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
 * Routing (holiday-card shop, docs/plans/holiday-cards-p1.md Step 6): the SAME
 * endpoint now also serves holiday-card orders. `checkout.session.completed` and
 * `checkout.session.expired` route on `metadata.productType`: `holiday_card` goes
 * to the card handlers (table `holiday_card_orders`); an ABSENT productType is a
 * Memory Book session -- legacy and in-flight sessions created before this change
 * never carried one -- and takes the book path unchanged; any other value is
 * ignored. `charge.refunded` carries no session metadata, so it looks the
 * payment intent up in BOTH order tables.
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
import {
  confirmPaidOrder,
  type FulfillmentDeps,
  flagRefundNotCancelled,
  processRefundedOrder,
  releaseCardClaim,
  releaseUnpaidArtifacts,
} from '../_shared/holiday-card-fulfillment.ts';
import { alertCardOwner } from '../_shared/holiday-card-order-notify.ts';
import { backfillOriginalFilesForBook } from '../_shared/memory-book-backfill.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { verifyStripeSignature, type StripeEvent } from '../_shared/stripe.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { serveWithSentry } from '../_shared/sentry.ts';

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

async function handleChargeRefunded(
  dependencies: StripeWebhookDependencies,
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<Response> {
  const charge = stripeObject(event);
  const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
  if (!paymentIntentId) return jsonResponse({ received: true, ignored: true });

  // Memory Book orders: unchanged.
  const { error } = await supabase
    .from('memory_book_orders')
    .update({ refunded_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .is('refunded_at', null);
  if (error) {
    console.error('stripe-webhook refund record failed', error.message);
    return errorResponse('Failed to record refund', 500, 'internal_error');
  }

  // Holiday card orders (the plan's "look the payment intent up in BOTH tables").
  return handleCardChargeRefunded(dependencies, supabase, charge, paymentIntentId);
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

// ── Holiday card orders ──────────────────────────────────────────────────

function fulfillmentDepsFor(dependencies: StripeWebhookDependencies): FulfillmentDeps {
  return {
    fetch: dependencies.fetch,
    sendEmail: dependencies.sendEmail,
    listKeys: dependencies.listKeys,
    deleteKey: dependencies.deleteKey,
    gelatoApiKey: Deno.env.get('GELATO_API_KEY') ?? null,
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY') ?? null,
  };
}

interface CardOrderRow {
  id: string;
  status: string;
  price_cents: number | null;
  currency: string | null;
  shipping_address: Record<string, unknown> | null;
  snapshot_hash: string | null;
  stripe_session_id: string | null;
}

const CARD_ALREADY_PAID_STATUSES = new Set(['paid', 'submitted', 'in_production', 'shipped']);

/**
 * `checkout.session.completed` for a card order. Verify, record the payment
 * (CAS `checkout -> paid`), then -- and only if everything matched -- confirm the
 * Gelato draft in the background (`EdgeRuntime.waitUntil`; the sweep is the
 * fallback). A mismatch leaves the order `paid` with a `failure_reason` marker
 * (the sweep never confirms a flagged order) and alerts the owner.
 */
async function handleCardCheckoutCompleted(
  dependencies: StripeWebhookDependencies,
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<Response> {
  const session = stripeObject(event);
  const orderId = typeof session.metadata === 'object' && session.metadata !== null
    ? (session.metadata as Record<string, unknown>).orderId
    : undefined;
  if (typeof orderId !== 'string' || !orderId) {
    console.error('stripe-webhook card checkout.session.completed missing orderId metadata');
    return jsonResponse({ received: true, ignored: true });
  }

  const { data: order, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, price_cents, currency, shipping_address, snapshot_hash, stripe_session_id')
    .eq('id', orderId)
    .maybeSingle<CardOrderRow>();
  if (error) {
    console.error('stripe-webhook card order lookup failed', error.message);
    return errorResponse('Failed to load order', 500, 'internal_error');
  }
  if (!order) {
    console.error('stripe-webhook card checkout.session.completed order not found', orderId);
    return jsonResponse({ received: true, ignored: true });
  }
  if (CARD_ALREADY_PAID_STATUSES.has(order.status)) return jsonResponse({ received: true, alreadyHandled: true });
  if (order.status !== 'checkout') {
    // Money was taken for an order that is not awaiting payment (cancelled or aged
    // out while the customer was paying): it cannot be fulfilled automatically.
    console.error('stripe-webhook card payment for an order not in checkout', orderId, order.status);
    await alertCardOwner(dependencies.sendEmail, orderId, 'PAID_ORDER_NOT_FULFILLABLE', `Payment captured but the order was ${order.status}. Refund or fulfil manually.`);
    return jsonResponse({ received: true, refused: 'order_not_in_checkout' });
  }

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const amountSubtotal = Number(session.amount_subtotal);
  const sessionCurrency = typeof session.currency === 'string' ? session.currency.toLowerCase() : '';
  const sessionAddress = (session.customer_details as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined
    ?? (session.shipping_details as Record<string, unknown> | undefined)?.address as Record<string, unknown> | undefined;
  const paymentStatus = typeof session.payment_status === 'string' ? session.payment_status : null;

  let mismatch: string | null = null;
  if (paymentStatus !== null && paymentStatus !== 'paid') mismatch = 'PAYMENT_NOT_PAID';
  else if (typeof session.id === 'string' && order.stripe_session_id !== null && session.id !== order.stripe_session_id) mismatch = 'PAYMENT_MISMATCH_SESSION';
  else if (!Number.isFinite(amountSubtotal) || order.price_cents === null || amountSubtotal !== order.price_cents) mismatch = 'PAYMENT_MISMATCH_AMOUNT';
  else if (!order.currency || sessionCurrency !== order.currency.toLowerCase()) mismatch = 'PAYMENT_MISMATCH_CURRENCY';
  else if (!addressesRoughlyMatch(order.shipping_address, sessionAddress)) mismatch = 'PAYMENT_MISMATCH_ADDRESS';
  else if (!order.snapshot_hash || metadata.snapshotHash !== order.snapshot_hash) mismatch = 'PAYMENT_MISMATCH_SNAPSHOT';

  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null;
  // The payment is recorded either way (the money is real); a mismatch only
  // withholds fulfilment.
  const { data: paidRow, error: paidError } = await supabase
    .from('holiday_card_orders')
    .update({
      status: 'paid',
      stripe_payment_intent_id: paymentIntentId,
      // Also clears a PAID_WEBHOOK_MISSED flag the sweep set before the event was re-sent.
      failure_reason: mismatch,
    })
    .eq('id', orderId)
    .eq('status', 'checkout')
    .select('id')
    .maybeSingle();
  if (paidError) {
    console.error('stripe-webhook card paid CAS failed', orderId, paidError.message);
    await alertCardOwner(dependencies.sendEmail, orderId, 'PAID_CAS_FAILED', 'Payment captured but the order row could not be updated. Investigate immediately.');
    return errorResponse('Failed to record payment', 500, 'internal_error');
  }
  if (!paidRow) return jsonResponse({ received: true, alreadyHandled: true });
  // The order left `checkout`: it no longer holds the card's checkout claim (mismatch or not).
  await releaseCardClaim(supabase, orderId);

  if (mismatch) {
    console.error('stripe-webhook card payment mismatch', orderId, mismatch);
    await alertCardOwner(dependencies.sendEmail, orderId, mismatch, 'The paid Stripe session did not match the persisted quote/snapshot. Payment captured, the order is NOT sent to print. Review, then clear failure_reason to let the sweep confirm it, or refund.');
    return jsonResponse({ received: true, refused: mismatch.toLowerCase().replace('payment_', '') });
  }

  // The only post-payment action: confirm the draft (idempotent). The sweep retries it.
  const fulfillmentDeps = fulfillmentDepsFor(dependencies);
  dependencies.waitUntil(
    confirmPaidOrder(fulfillmentDeps, supabase, orderId)
      .then(() => undefined)
      .catch((confirmError) => {
        console.error('stripe-webhook card confirm failed', orderId, confirmError instanceof Error ? confirmError.name : 'unknown');
      }),
  );
  return jsonResponse({ received: true, orderId, status: 'paid' });
}

/** `checkout.session.expired` for a card order: `checkout -> cancelled`, then delete the draft and the print files. */
async function handleCardCheckoutExpired(
  dependencies: StripeWebhookDependencies,
  supabase: SupabaseClient,
  event: StripeEvent,
): Promise<Response> {
  const session = stripeObject(event);
  const orderId = typeof session.metadata === 'object' && session.metadata !== null
    ? (session.metadata as Record<string, unknown>).orderId
    : undefined;
  if (typeof orderId !== 'string' || !orderId) return jsonResponse({ received: true, ignored: true });

  let query = supabase
    .from('holiday_card_orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .eq('status', 'checkout');
  // Only the order's own current session may cancel it.
  if (typeof session.id === 'string') query = query.eq('stripe_session_id', session.id);
  const { data: cancelled, error } = await query.select('id').maybeSingle();
  if (error) {
    console.error('stripe-webhook card expiry CAS failed', orderId, error.message);
    return errorResponse('Failed to record checkout expiry', 500, 'internal_error');
  }
  if (cancelled) {
    await releaseCardClaim(supabase, orderId);
    const fulfillmentDeps = fulfillmentDepsFor(dependencies);
    dependencies.waitUntil(
      releaseUnpaidArtifacts(fulfillmentDeps, supabase, orderId)
        .then(() => undefined)
        .catch(() => console.error('stripe-webhook card expiry clean-up failed', orderId)),
    );
  }
  return jsonResponse({ received: true });
}

/** True unless Stripe says this refund was only partial (a goodwill refund must not cancel the print order). */
function isFullRefund(charge: Record<string, unknown>): boolean {
  if (charge.refunded === true) return true;
  if (typeof charge.amount === 'number' && typeof charge.amount_refunded === 'number') return charge.amount_refunded >= charge.amount;
  return charge.refunded !== false;
}

/**
 * `charge.refunded` for a card order. The order is found by payment intent id,
 * or -- when no row carries it yet (the refund event beat `checkout.session.
 * completed`) -- by the `{productType:'holiday_card', orderId}` metadata the
 * payment intent (and so the charge) was created with. A full refund sets
 * `refunded_at` FIRST (that is what stops a not-yet-confirmed paid order from
 * ever being confirmed), then finishes the Gelato side: a draft is deleted, a
 * confirmed order is cancelled. A Gelato outage is left to the sweep (it retries
 * every refunded order still paid/submitted/in_production); a Gelato refusal
 * flags the order and alerts the owner.
 */
async function handleCardChargeRefunded(
  dependencies: StripeWebhookDependencies,
  supabase: SupabaseClient,
  charge: Record<string, unknown>,
  paymentIntentId: string,
): Promise<Response> {
  type Found = { id: string; status: string; gelato_order_id: string | null; stripe_payment_intent_id: string | null; failure_reason: string | null };
  const columns = 'id, status, gelato_order_id, stripe_payment_intent_id, failure_reason';
  const { data: byIntent, error } = await supabase
    .from('holiday_card_orders')
    .select(columns)
    .eq('stripe_payment_intent_id', paymentIntentId)
    .is('refunded_at', null);
  if (error) {
    console.error('stripe-webhook card refund lookup failed', error.message);
    return errorResponse('Failed to record refund', 500, 'internal_error');
  }
  let rows = (byIntent ?? []) as Found[];

  if (rows.length === 0) {
    const metadata = typeof charge.metadata === 'object' && charge.metadata !== null ? charge.metadata as Record<string, unknown> : {};
    if (metadata.productType === 'holiday_card' && typeof metadata.orderId === 'string' && metadata.orderId) {
      const { data: byMetadata, error: metadataError } = await supabase
        .from('holiday_card_orders')
        .select(columns)
        .eq('id', metadata.orderId)
        .is('refunded_at', null);
      if (metadataError) {
        console.error('stripe-webhook card refund metadata lookup failed', metadataError.message);
        return errorResponse('Failed to record refund', 500, 'internal_error');
      }
      // Only an order that has no payment intent yet, or this very one.
      rows = ((byMetadata ?? []) as Found[]).filter((r) => r.stripe_payment_intent_id === null || r.stripe_payment_intent_id === paymentIntentId);
    }
  }
  if (rows.length === 0) return jsonResponse({ received: true });
  if (!isFullRefund(charge)) {
    console.error('stripe-webhook card partial refund ignored', rows[0].id);
    return jsonResponse({ received: true, partialRefund: true });
  }

  const fulfillmentDeps = fulfillmentDepsFor(dependencies);
  for (const row of rows) {
    const { data: marked, error: markError } = await supabase
      .from('holiday_card_orders')
      .update({
        refunded_at: new Date().toISOString(),
        // Remember the payment intent if the refund beat the paid event.
        ...(row.stripe_payment_intent_id === null ? { stripe_payment_intent_id: paymentIntentId } : {}),
      })
      .eq('id', row.id)
      .is('refunded_at', null)
      .select('id')
      .maybeSingle();
    if (markError) {
      console.error('stripe-webhook card refund record failed', row.id, markError.message);
      return errorResponse('Failed to record refund', 500, 'internal_error');
    }
    if (!marked) continue;

    const outcome = await processRefundedOrder(fulfillmentDeps, supabase, row);
    if (outcome === 'failed') {
      // Also matches a canary-held order (HELD_FOR_CANARY), which a plain `is null` would skip.
      await flagRefundNotCancelled(supabase, row.id);
      await alertCardOwner(
        dependencies.sendEmail,
        row.id,
        'REFUND_NOT_CANCELLED',
        `The order was refunded while "${row.status}" but the Gelato order could not be cancelled automatically. Cancel it in the Gelato dashboard.`,
      );
    }
    // 'retry': Gelato was unreachable; the sweep finishes it.
  }
  return jsonResponse({ received: true });
}

export interface StripeWebhookDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  verifyStripeSignature: typeof verifyStripeSignature;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
  /** Holiday cards: background work after the 200 (`EdgeRuntime.waitUntil`); the sweep is the fallback. */
  waitUntil: (task: Promise<void>) => void;
  /** Holiday cards: R2 prefix listing + delete for print-file clean-up. */
  listKeys: (prefix: string) => Promise<string[]>;
  deleteKey: (key: string) => Promise<void>;
}

export const DEFAULT_DEPENDENCIES: StripeWebhookDependencies = {
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  verifyStripeSignature,
  sendEmail: sendTransactionalEmailWithOutcome,
  waitUntil: (task) => {
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (task: Promise<void>) => void } }).EdgeRuntime;
    if (runtime?.waitUntil) runtime.waitUntil(task);
    else void task; // not on the Edge runtime (tests / local): let it run unawaited
  },
  listKeys: listObjectKeys,
  deleteKey: deleteObject,
};

type ProductRoute = 'book' | 'holiday_card' | 'unknown';

/** Routes a checkout session event by `metadata.productType`. ABSENT = a Memory Book session (legacy / in flight). */
export function productRouteOf(event: StripeEvent): ProductRoute {
  const metadata = stripeObject(event).metadata;
  const productType = typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>).productType : undefined;
  if (productType === undefined || productType === null || productType === '') return 'book';
  return productType === 'holiday_card' ? 'holiday_card' : 'unknown';
}

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
      case 'checkout.session.completed': {
        const route = productRouteOf(event);
        if (route === 'holiday_card') return await handleCardCheckoutCompleted(dependencies, supabase, event);
        if (route === 'unknown') return jsonResponse({ received: true, ignored: true });
        return await handleCheckoutSessionCompleted(dependencies.fetch, dependencies.sendEmail, supabase, event);
      }
      case 'charge.refunded':
        return await handleChargeRefunded(dependencies, supabase, event);
      case 'checkout.session.expired': {
        const route = productRouteOf(event);
        if (route === 'holiday_card') return await handleCardCheckoutExpired(dependencies, supabase, event);
        if (route === 'unknown') return jsonResponse({ received: true, ignored: true });
        return await handleCheckoutSessionExpired(supabase, event);
      }
      default:
        return jsonResponse({ received: true, ignored: true });
    }
  } catch (error) {
    console.error('stripe-webhook handler failed', event.type, error instanceof Error ? error.message : 'unknown');
    return errorResponse('Webhook handling failed', 500, 'internal_error');
  }
}

if (import.meta.main) {
  serveWithSentry('stripe-webhook', (request) => handleStripeWebhook(request));
}
