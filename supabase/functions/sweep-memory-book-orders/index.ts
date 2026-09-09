/**
 * Cron-secret sweep for Memory Book orders (memory-book-5c plan, Design
 * Decision 4's "Post-submission tracking" + round-2's "zero-dispatch
 * recovery"). Same `x-cron-secret` pattern as every other cron Edge
 * Function in this repo (`schedule-daily-reminders`, `cleanup-gallery-
 * imports`, `process-billing-webhooks`) -- `validateCronSecret`, no user
 * JWT.
 *
 * Three responsibilities, one pass:
 *
 *  1. Zero-dispatch reconciliation (round-2 review, mirrors the gallery-
 *     import mark-before-dispatch + reconciliation-sweep pattern): any
 *     order sitting in `paid` with no `workflow_started_at` (the webhook's
 *     mark-before-dispatch claim never landed, e.g. it crashed between the
 *     `paid` CAS and the `rendering` CAS) is claimed fresh and dispatched;
 *     any order sitting in `rendering` whose `workflow_started_at` is
 *     stale (the dispatch call itself may have failed silently, or the
 *     Workflow instance died without ever reaching `mark_submitted`/
 *     `mark_failed`) is RE-dispatched using its EXISTING
 *     `workflow_instance_id` -- the Cloudflare Worker's `/dispatch` handler
 *     already treats a duplicate Workflow id as an idempotent 202 (see
 *     `cloudflare/memory-book-order-worker/src/index.ts`), so redispatching
 *     the same instance is always safe, never a second concurrent attempt
 *     against the SAME row.
 *  2. Post-submission tracking: polls Prodigi for every order in
 *     `('submitted', 'in_production', 'shipped')` (the
 *     `memory_book_orders_active_status_idx` partial index exists
 *     specifically for this scan) and advances `submitted -> in_production
 *     -> shipped`, sending a tracking email on the `shipped` transition.
 *     NOTE: this sweep does NOT advance to `delivered` -- Prodigi's Orders
 *     API reports fulfillment/shipment stage, not final carrier delivery
 *     confirmation, and no carrier-tracking integration exists in this repo
 *     yet. `delivered` is left for a future change (see "Not yet covered"
 *     in the feature doc's Testing section for the same posture on other
 *     wave-2 gaps).
 *  3. Alarms: "not in_production within 4h" (matches the 2h Prodigi
 *     order-edit window plus margin, per prodigi-order-spec.md's "Order
 *     edit window" section) and "stuck > 10 days" (4-6 days production +
 *     shipping transit, per that same doc's §7) -- both owner alarm
 *     emails, never a silent stall. Also ages an abandoned `quoted` order
 *     past 48h as a BACKSTOP to `stripe-webhook`'s reactive
 *     `checkout.session.expired` handling (Stripe's own Checkout Session
 *     default expiry is 24h and fires that event reliably, so this branch
 *     should rarely fire -- it exists for the case where the webhook
 *     delivery itself was somehow lost).
 *
 * Prodigi order webhook/callback check (task item 4's explicit ask,
 * "check whether Prodigi offers order webhooks/callbacks... NOTE findings,
 * don't build it"): docs/plans/prodigi-order-spec.md -- the canonical,
 * previously-researched Prodigi API reference in this repo -- documents
 * the Orders/Quotes/spine endpoints and the dashboard-configured "Order
 * edit window" in detail, but contains NO mention of a webhook/callback
 * facility for order status changes anywhere in its Ordering/Turnaround
 * sections. This sweep is therefore pure polling, as the plan anticipated
 * ("prefer them if real, keeping the sweep as reconciliation"). A wave-2
 * owner action, not done here (no live Prodigi API key in this
 * environment, and the plan is explicit that this task should not build
 * one on spec alone): re-check Prodigi's live API reference
 * (https://www.prodigi.com/print-api/docs/reference/) for a "Webhooks" or
 * "Callbacks" section before the real canary -- if one exists, this sweep
 * should be demoted to a reconciliation-only safety net behind it, per the
 * plan's own instruction.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getProdigiOrderStatus, type ProdigiOrderStatus } from '../_shared/prodigi.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

const DEFAULT_ALERT_RECIPIENT = 'hello@usemomora.com';
const PAID_RECONCILE_GRACE_MS = 2 * 60_000;
const RENDERING_STALE_MS = 15 * 60_000;
const NOT_IN_PRODUCTION_ALARM_MS = 4 * 60 * 60_000;
const STUCK_ALARM_MS = 10 * 24 * 60 * 60_000;
const QUOTED_ABANDON_BACKSTOP_MS = 48 * 60 * 60_000;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function dispatchOrderWorkflow(fetchFn: typeof fetch, orderId: string, attemptId: string): Promise<void> {
  const endpoint = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_ORDER_WORKFLOW_URL');
  const secret = Deno.env.get('CLOUDFLARE_MEMORY_BOOK_ORDER_DISPATCH_SECRET');
  if (!endpoint || !secret) throw new Error('Cloudflare memory book order workflow is not configured');
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const rawBody = JSON.stringify({ orderId, attemptId });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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
  if (!response.ok && response.status !== 409) throw new Error(`order workflow dispatch failed (${response.status})`);
}

function getAlertRecipient(): string {
  return Deno.env.get('MEMORY_BOOK_ORDER_ALERT_EMAIL')?.trim() || DEFAULT_ALERT_RECIPIENT;
}

async function alertOwner(
  sendEmail: typeof sendTransactionalEmailWithOutcome,
  orderId: string,
  reason: string,
  detail: string,
): Promise<void> {
  try {
    await sendEmail({
      to: getAlertRecipient(),
      subject: `Momora order alert: ${reason}`,
      htmlBody: `<p>Order <code>${orderId}</code> needs attention.</p><p>Reason: ${reason}</p><p>${detail}</p>`,
    });
  } catch (error) {
    console.error('sweep-memory-book-orders owner alert failed', reason, error instanceof Error ? error.message : 'unknown');
  }
}

export interface SweepDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  now: () => number;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
}

export const DEFAULT_DEPENDENCIES: SweepDependencies = {
  createServiceClient,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => Date.now(),
  sendEmail: sendTransactionalEmailWithOutcome,
};

interface ReconcileRow {
  id: string;
  status: string;
  workflow_instance_id: string | null;
  workflow_attempt_id: string | null;
  workflow_started_at: string | null;
}

/** Zero-dispatch reconciliation. Returns counts for the response body
 * (content-free -- ids and counts only, never memory content). */
async function reconcileDispatch(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ claimed: number; redispatched: number }> {
  const now = dependencies.now();
  const { data: candidates, error } = await supabase
    .from('memory_book_orders')
    .select('id, status, workflow_instance_id, workflow_attempt_id, workflow_started_at')
    .in('status', ['paid', 'rendering'])
    .returns<ReconcileRow[]>();
  if (error) {
    console.error('sweep-memory-book-orders reconcile lookup failed', error.message);
    return { claimed: 0, redispatched: 0 };
  }

  let claimed = 0;
  let redispatched = 0;

  for (const row of candidates ?? []) {
    if (row.status === 'paid') {
      const startedAtMs = row.workflow_started_at ? Date.parse(row.workflow_started_at) : NaN;
      if (Number.isFinite(startedAtMs) && now - startedAtMs < PAID_RECONCILE_GRACE_MS) continue;
      const attemptId = crypto.randomUUID();
      const { data: claimedRow, error: claimError } = await supabase
        .from('memory_book_orders')
        .update({
          status: 'rendering',
          workflow_instance_id: attemptId,
          workflow_attempt_id: attemptId,
          workflow_started_at: new Date(now).toISOString(),
          workflow_completed_at: null,
        })
        .eq('id', row.id)
        .eq('status', 'paid')
        .select('id')
        .maybeSingle();
      if (claimError || !claimedRow) continue;
      claimed += 1;
      try {
        await dispatchOrderWorkflow(dependencies.fetch, row.id, attemptId);
        redispatched += 1;
      } catch {
        console.error('sweep-memory-book-orders zero-dispatch redispatch failed', row.id);
      }
      continue;
    }

    // status === 'rendering'
    const startedAtMs = row.workflow_started_at ? Date.parse(row.workflow_started_at) : NaN;
    if (!Number.isFinite(startedAtMs) || now - startedAtMs < RENDERING_STALE_MS) continue;
    if (!row.workflow_instance_id) continue;
    try {
      await dispatchOrderWorkflow(dependencies.fetch, row.id, row.workflow_instance_id);
      redispatched += 1;
    } catch {
      console.error('sweep-memory-book-orders stale-rendering redispatch failed', row.id);
    }
  }

  return { claimed, redispatched };
}

interface ActiveOrderRow {
  id: string;
  status: string;
  prodigi_order_id: string | null;
  requested_by: string | null;
  workflow_completed_at: string | null;
  updated_at: string;
  tracking_number: string | null;
}

function mapProdigiStageToStatus(stage: string, hasTracking: boolean): 'in_production' | 'shipped' | null {
  const normalized = stage.toLowerCase();
  if (hasTracking || normalized.includes('complete') || normalized.includes('shipped')) return 'shipped';
  if (normalized.includes('progress') || normalized.includes('production') || normalized.includes('hold')) return 'in_production';
  return null;
}

export interface ExtractedOrderTracking {
  tracking_number: string | null;
  tracking_url: string | null;
  carrier: string | null;
}

/** Order-status UX round, item 3: pulls the first shipment that actually
 * carries a tracking number out of Prodigi's (already-parsed, see
 * `_shared/prodigi.ts#getProdigiOrderStatus`) shipments array. Deliberately
 * defensive -- an empty/no-tracking-number shipments array (Prodigi reports
 * `shipped` before a carrier tracking number exists, which does happen) is
 * NOT an error, it's just "nothing to persist yet": every field comes back
 * `null`, never a fabricated placeholder. `tracking_url`/`carrier` can each
 * independently be `null` even when `tracking_number` is set -- Prodigi
 * doesn't guarantee either alongside a bare number. */
export function extractOrderTracking(shipments: ProdigiOrderStatus['shipments']): ExtractedOrderTracking {
  const shipment = shipments.find((candidate) => Boolean(candidate.trackingNumber));
  if (!shipment) return { tracking_number: null, tracking_url: null, carrier: null };
  return {
    tracking_number: shipment.trackingNumber ?? null,
    tracking_url: shipment.trackingUrl ?? null,
    carrier: shipment.carrier ?? null,
  };
}

async function trackProdigiOrders(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ polled: number; advanced: number; alarmed: number; autoCancelled: number }> {
  const prodigiApiKey = Deno.env.get('PRODIGI_API_KEY');
  const prodigiBaseUrl = Deno.env.get('PRODIGI_API_BASE_URL') ?? 'https://api.sandbox.prodigi.com';
  const now = dependencies.now();

  const { data: activeOrders, error } = await supabase
    .from('memory_book_orders')
    .select('id, status, prodigi_order_id, requested_by, workflow_completed_at, updated_at, tracking_number')
    .in('status', ['submitted', 'in_production', 'shipped'])
    .returns<ActiveOrderRow[]>();
  if (error) {
    console.error('sweep-memory-book-orders track lookup failed', error.message);
    return { polled: 0, advanced: 0, alarmed: 0, autoCancelled: 0 };
  }

  let polled = 0;
  let advanced = 0;
  let alarmed = 0;
  let autoCancelled = 0;

  for (const order of activeOrders ?? []) {
    // Stuck-too-long alarm applies regardless of Prodigi reachability.
    const referenceMs = Date.parse(order.workflow_completed_at ?? order.updated_at);
    if (Number.isFinite(referenceMs) && now - referenceMs > STUCK_ALARM_MS) {
      await alertOwner(dependencies.sendEmail, order.id, 'ORDER_STUCK', `Order has been "${order.status}" for over 10 days.`);
      alarmed += 1;
    }
    if (
      order.status === 'submitted' &&
      Number.isFinite(referenceMs) &&
      now - referenceMs > NOT_IN_PRODUCTION_ALARM_MS
    ) {
      await alertOwner(dependencies.sendEmail, order.id, 'NOT_IN_PRODUCTION', 'Order has not reached in_production within 4 hours of submission.');
      alarmed += 1;
    }

    if (!order.prodigi_order_id || !prodigiApiKey) continue;
    polled += 1;
    let prodigiStatus;
    try {
      prodigiStatus = await getProdigiOrderStatus(dependencies.fetch, prodigiBaseUrl, prodigiApiKey, order.prodigi_order_id);
    } catch {
      console.error('sweep-memory-book-orders Prodigi poll failed', order.id);
      continue;
    }

    // Cancelled at Prodigi (owner cancels during the 2h edit window, or
    // Prodigi rejects/cancels an order themselves) -- mirror it onto our
    // row so /orders doesn't show a phantom in-flight order. Checked BEFORE
    // the stage-advance mapping: a `Cancelled` stage must never be
    // reinterpreted as progress. `shipped` rows are never regressed (a book
    // that already left the printer isn't un-shipped by a stale stage), and
    // the owner is alerted because a paid order that will never ship needs a
    // manual refund decision.
    if (prodigiStatus.stage.toLowerCase().includes('cancel')) {
      if (order.status === 'shipped') continue;
      const { data: cancelled, error: cancelError } = await supabase
        .from('memory_book_orders')
        .update({ status: 'cancelled' })
        .eq('id', order.id)
        .eq('status', order.status)
        .select('id')
        .maybeSingle();
      if (!cancelError && cancelled) {
        autoCancelled += 1;
        await alertOwner(
          dependencies.sendEmail,
          order.id,
          'CANCELLED_AT_PRODIGI',
          `Prodigi reports order ${order.prodigi_order_id} as cancelled; the row (was "${order.status}") is now cancelled. If the buyer paid, decide on a refund.`,
        );
      }
      continue;
    }

    const hasTracking = prodigiStatus.shipments.some((shipment) => Boolean(shipment.trackingNumber));
    const nextStatus = mapProdigiStageToStatus(prodigiStatus.stage, hasTracking);
    if (!nextStatus) continue;

    const statusOrder = ['submitted', 'in_production', 'shipped'];
    if (statusOrder.indexOf(nextStatus) <= statusOrder.indexOf(order.status)) {
      // Not an advance -- but if this order is ALREADY `shipped` and we
      // never managed to persist tracking for it (Prodigi reported
      // `shipped` before a tracking number existed, a common Prodigi
      // sequencing quirk), backfill it now the first time Prodigi actually
      // supplies one. Never overwrites an already-persisted value, and
      // never sends a second "shipped" email -- that only fires on the
      // transition below.
      if (order.status === 'shipped' && !order.tracking_number && hasTracking) {
        const tracking = extractOrderTracking(prodigiStatus.shipments);
        await supabase.from('memory_book_orders').update(tracking).eq('id', order.id).eq('status', 'shipped');
      }
      continue;
    }

    const tracking = nextStatus === 'shipped' ? extractOrderTracking(prodigiStatus.shipments) : null;
    const { data: updated, error: updateError } = await supabase
      .from('memory_book_orders')
      .update({ status: nextStatus, ...(tracking ?? {}) })
      .eq('id', order.id)
      .eq('status', order.status)
      .select('id')
      .maybeSingle();
    if (updateError || !updated) continue;
    advanced += 1;

    if (nextStatus === 'shipped' && order.requested_by) {
      const { data: authUser } = await supabase.auth.admin.getUserById(order.requested_by);
      const email = authUser?.user?.email;
      if (email) {
        const carrierSuffix = tracking?.carrier ? ` via ${tracking.carrier}` : '';
        const trackingHtml = tracking?.tracking_url
          ? `<p>Track your delivery${carrierSuffix}: <a href="${tracking.tracking_url}">${tracking.tracking_url}</a></p>`
          : tracking?.tracking_number
            ? `<p>Tracking number${carrierSuffix}: ${tracking.tracking_number}</p>`
            : '';
        await dependencies.sendEmail({
          to: email,
          subject: 'Your Momora Memory Book has shipped',
          htmlBody: `<p>Great news -- your Memory Book has shipped!</p>${trackingHtml}`,
        });
      }
    }
  }

  return { polled, advanced, alarmed, autoCancelled };
}

async function ageAbandonedQuotes(dependencies: SweepDependencies, supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(dependencies.now() - QUOTED_ABANDON_BACKSTOP_MS).toISOString();
  const { data, error } = await supabase
    .from('memory_book_orders')
    .update({ status: 'cancelled' })
    .eq('status', 'quoted')
    .lt('updated_at', cutoff)
    .select('id')
    .returns<Array<{ id: string }>>();
  if (error) {
    console.error('sweep-memory-book-orders quote aging failed', error.message);
    return 0;
  }
  return data?.length ?? 0;
}

export async function handleSweepMemoryBookOrders(
  req: Request,
  dependencyOverrides: Partial<SweepDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');

  const supabase = dependencies.createServiceClient();

  const reconcile = await reconcileDispatch(dependencies, supabase);
  const track = await trackProdigiOrders(dependencies, supabase);
  const cancelledCount = await ageAbandonedQuotes(dependencies, supabase);

  return jsonResponse({
    success: true,
    reconcile,
    track,
    cancelledAbandonedQuotes: cancelledCount,
  });
}

if (import.meta.main) Deno.serve((request) => handleSweepMemoryBookOrders(request));
