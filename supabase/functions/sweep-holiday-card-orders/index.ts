/**
 * Cron-secret sweep for holiday-card orders and cards (docs/plans/
 * holiday-cards-p1.md Step 6/7). Invoked every 10 minutes by pg_cron
 * (`invoke-sweep-holiday-card-orders`, migration 20261006120000) with the same
 * `x-cron-secret` header as every other cron function here
 * (`validateCronSecret`; `verify_jwt = false` in config.toml). Idempotent and
 * cheap when idle; each pass is isolated (one failing pass never blocks the
 * others) and bounded by a batch size.
 *
 *   1. confirm       `paid` orders the webhook did not confirm (older than ~2
 *                    min): PATCH the Gelato draft only while it is a draft ->
 *                    `submitted`. Owner alert once at ~30 min; `failed` after 6 h.
 *   2. track         `submitted` / `in_production`: poll Gelato. passed /
 *                    printing -> `in_production`; shipped (+ tracking) ->
 *                    `shipped` + email; failed / canceled -> `failed` + owner
 *                    alert; on_hold is NOT terminal (one alert, keeps polling). `gelato_status` is always persisted.
 *   3. aging         `quoted` older than 48 h, and `checkout` orders 1 h after their
 *                    Stripe session's `expires_at` (kept in `print_files.sessionExpiresAt`;
 *                    the webhook's `expired` handler is the primary path, this is the
 *                    backstop; an order with no stored expiry falls back to 48 h) ->
 *                    `cancelled` + the Gelato draft and print files deleted + the card's
 *                    checkout claim released. A `checkout` order whose Stripe session
 *                    turns out to be PAID (a lost webhook) is never cancelled: the owner
 *                    is alerted once instead.
 *   4. clean-up      cancelled-and-never-paid orders that still hold a draft or
 *                    files (a clean-up that failed earlier), and retention:
 *                    `print-orders/<orderId>/` is deleted 30 days after
 *                    `shipped_at`; for `failed` / `cancelled` orders at once when
 *                    they were never paid or are refunded, else (a PAID order that
 *                    failed) 30 days after the failure; `print_files` is nulled so
 *                    it never repeats.
 *   4b. refunds      a refunded order still paid/submitted/in_production: retry the
 *                    Gelato delete/cancel, finish -> `cancelled`, or alert once.
 *   5. generation    cards stuck in `generating` (stale heartbeat > 20 min, or
 *                    never leased > 10 min): bump the attempt counter (cap 3) and
 *                    re-dispatch to the year-film worker, or fail the card. FAILED cards with a
 *                    retryable code (and attempts left, 10 min after the failure) are
 *                    reset to generating and re-dispatched.
 *   5b. card claims  a card-level checkout claim (`holiday_cards.checkout_order_id`)
 *                    older than 10 min whose order is not in `checkout` (and not
 *                    mid-`create_checkout`) is released.
 *   5c. card ready   (owner decision 2026-10-06) a card that waited for its film
 *                    (film_id set, `holiday_card_readiness` = 'ready', younger than 2
 *                    days) pushes its creator ONCE: `ready_notified_at` is claimed with
 *                    a CAS BEFORE the push (at-most-once). Cards without a film were
 *                    ready in ~2 min while the parent watched: no push.
 *   6. ordered films hourly: an ordered card whose film failed or lost its
 *                    video -> owner alert (once: the card's `last_failure_code`
 *                    is the dedupe marker).
 *
 * Fulfillment ignores `families.deleted_at`: a paid order is never dropped
 * because the family was deleted. Nothing here logs addresses, names, letter
 * text or secrets: ids, statuses and codes only.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { validateCronSecret } from '../_shared/cron.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { type PushRouteData, sendExpoPushNotification } from '../_shared/expo-push.ts';
import { GelatoApiError, type GelatoOrder, getOrder } from '../_shared/gelato.ts';
import {
  classifyGelatoError,
  confirmPaidOrder,
  failPaidOrder,
  type FulfillmentDeps,
  flagRefundNotCancelled,
  isFreshClaim,
  parsePrintFiles,
  processRefundedOrder,
  releaseCardClaim,
  releasePrintFiles,
  releaseUnpaidArtifacts,
} from '../_shared/holiday-card-fulfillment.ts';
import { alertCardOwner, sendCardShippedEmail } from '../_shared/holiday-card-order-notify.ts';
import { deleteObject, listObjectKeys } from '../_shared/r2.ts';
import { serveWithSentry } from '../_shared/sentry.ts';
import { postSignedToYearFilmWorker } from '../_shared/year-film-worker-dispatch.ts';
import { expireCheckoutSession, retrieveCheckoutSession } from '../_shared/stripe.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

// ── Tuning ───────────────────────────────────────────────────────────────

export const PAID_CONFIRM_GRACE_MS = 2 * 60_000;
/** The tick that crosses this age alerts (stateless dedupe: the window below is wider than the 10 min cadence). */
export const PAID_ALERT_AFTER_MS = 30 * 60_000;
export const PAID_ALERT_WINDOW_MS = 15 * 60_000;
export const PAID_FAIL_AFTER_MS = 6 * 60 * 60_000;
export const SUBMITTED_MISSING_GRACE_MS = 15 * 60_000;
export const SHIPPED_WITHOUT_TRACKING_AFTER_MS = 24 * 60 * 60_000;
export const QUOTED_AGING_MS = 48 * 60 * 60_000;
/** A `checkout` order is aged this long after its Stripe session's `expires_at` (the webhook's `expired` event is the primary path). */
export const CHECKOUT_AGING_AFTER_EXPIRY_MS = 60 * 60_000;
/** A card-level checkout claim older than this is stale (same 10 minutes as `claim_holiday_card_checkout`). */
export const CARD_CLAIM_STALE_MS = 10 * 60_000;
export const RETENTION_AFTER_SHIPPED_MS = 30 * 24 * 60 * 60_000;
export const GENERATION_STALE_HEARTBEAT_MS = 20 * 60_000;
export const GENERATION_NEVER_LEASED_MS = 10 * 60_000;
export const GENERATION_ATTEMPT_CAP = 3;
/** Cards older than this never get a "ready" push (a late sweep must not announce a stale card). */
export const READY_PUSH_WINDOW_MS = 2 * 24 * 60 * 60_000;

export const CONFIRM_BATCH = 25;
export const TRACK_BATCH = 150;
export const TRACK_CONCURRENCY = 5;
export const AGING_BATCH = 25;
export const CLEANUP_BATCH = 25;
export const GENERATION_BATCH = 25;
export const READY_PUSH_BATCH = 25;
export const FILM_CHECK_CARD_CAP = 1000;
const IN_CHUNK = 100;

// ── Dependencies ─────────────────────────────────────────────────────────

export interface SweepDependencies {
  createServiceClient: typeof createServiceClient;
  fetch: typeof fetch;
  now: () => number;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
  listKeys: (prefix: string) => Promise<string[]>;
  deleteKey: (key: string) => Promise<void>;
  /** POST the year-film worker's `/holiday-cards/generate` (HMAC, `_shared/year-film-worker-dispatch.ts`). true = accepted. */
  dispatchGeneration: (cardId: string, attemptId: string) => Promise<boolean>;
  /** Expo push (`_shared/expo-push.ts`); true = accepted by Expo. */
  sendPush: (token: string, title: string, body: string, data?: PushRouteData) => Promise<boolean>;
}

export const DEFAULT_DEPENDENCIES: SweepDependencies = {
  createServiceClient,
  // A hung Gelato/Stripe call must fail loud for THIS order and let the sweep move on.
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }),
  now: () => Date.now(),
  sendEmail: sendTransactionalEmailWithOutcome,
  listKeys: listObjectKeys,
  deleteKey: deleteObject,
  // Shared HMAC helper (same scheme as schedule-year-films' /dispatch).
  dispatchGeneration: (cardId, attemptId) => postSignedToYearFilmWorker('/holiday-cards/generate', { cardId, attemptId }),
  sendPush: sendExpoPushNotification,
};

function fulfillmentDepsFor(dependencies: SweepDependencies): FulfillmentDeps {
  return {
    fetch: dependencies.fetch,
    sendEmail: dependencies.sendEmail,
    listKeys: dependencies.listKeys,
    deleteKey: dependencies.deleteKey,
    gelatoApiKey: Deno.env.get('GELATO_API_KEY') ?? null,
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY') ?? null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const ageMs = (now: number, stamp: string | null | undefined): number => {
  const at = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(at) ? now - at : 0;
};
const SAFE_CODE = /[^A-Za-z0-9_.-]/g;

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── 1. confirm paid orders ───────────────────────────────────────────────

interface PaidRow {
  id: string;
  updated_at: string;
}

async function confirmPaidOrders(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ submitted: number; retry: number; failed: number; alerted: number }> {
  const now = dependencies.now();
  const out = { submitted: 0, retry: 0, failed: 0, alerted: 0 };
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .select('id, updated_at')
    .eq('status', 'paid')
    .is('refunded_at', null)
    .is('failure_reason', null)
    .lt('updated_at', iso(now - PAID_CONFIRM_GRACE_MS))
    .order('updated_at', { ascending: true })
    .limit(CONFIRM_BATCH)
    .returns<PaidRow[]>();
  if (error) {
    console.error('sweep-holiday-card-orders confirm lookup failed', error.message);
    return out;
  }
  const fulfillmentDeps = fulfillmentDepsFor(dependencies);
  for (const row of data ?? []) {
    const outcome = await confirmPaidOrder(fulfillmentDeps, supabase, row.id);
    if (outcome === 'submitted') out.submitted += 1;
    else if (outcome === 'failed') out.failed += 1;
    else if (outcome === 'retry') {
      out.retry += 1;
      const age = ageMs(now, row.updated_at);
      if (age >= PAID_FAIL_AFTER_MS) {
        if (await failPaidOrder(fulfillmentDeps, supabase, row.id, 'CONFIRM_TIMEOUT')) out.failed += 1;
      } else if (age >= PAID_ALERT_AFTER_MS && age < PAID_ALERT_AFTER_MS + PAID_ALERT_WINDOW_MS) {
        await alertCardOwner(dependencies.sendEmail, row.id, 'PAID_NOT_SUBMITTED', 'A paid order has not been confirmed at Gelato for 30 minutes (Gelato unreachable or not configured). The sweep keeps retrying.');
        out.alerted += 1;
      }
    }
  }
  return out;
}

// ── 2. track submitted / in_production orders ────────────────────────────

interface TrackRow {
  id: string;
  status: string;
  gelato_order_id: string | null;
  gelato_status: string | null;
  requested_by: string | null;
  failure_reason: string | null;
  updated_at: string;
}

interface TrackDecision {
  patch: Record<string, unknown>;
  /** The order reached `shipped` in this decision. */
  shipped: { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null;
  /** The order is now `failed`. */
  failedReason: string | null;
  /** Gelato just put the order on hold (non-terminal): alert once, keep polling. */
  heldNow: boolean;
}

/** Pure: what to write for a polled order (null = nothing to change). */
export function decideTrack(row: TrackRow, order: GelatoOrder, nowMs: number): TrackDecision | null {
  const raw = order.rawFulfillmentStatus ?? order.fulfillmentStatus;
  const patch: Record<string, unknown> = {};
  if (raw !== row.gelato_status) patch.gelato_status = raw;
  let shipped: TrackDecision['shipped'] = null;
  let failedReason: string | null = null;
  let heldNow = false;
  // A hold (pending approval, not connected, held) can clear by itself: it is
  // NOT terminal. The marker doubles as the "alert once" dedupe and is removed
  // when the hold lifts.
  if (order.fulfillmentStatus === 'on_hold') {
    if (row.failure_reason === null) {
      patch.failure_reason = 'GELATO_ON_HOLD';
      heldNow = true;
    }
  } else if (row.failure_reason === 'GELATO_ON_HOLD') {
    patch.failure_reason = null;
  }

  switch (order.fulfillmentStatus) {
    case 'failed':
    case 'canceled': {
      const base = order.fulfillmentStatus === 'failed' ? 'GELATO_FAILED' : 'GELATO_CANCELED';
      const code = order.refusalReasonCode ? `:${order.refusalReasonCode.replace(SAFE_CODE, '').slice(0, 40)}` : '';
      failedReason = `${base}${code}`;
      patch.status = 'failed';
      patch.failure_reason = failedReason;
      break;
    }
    case 'shipped':
    case 'delivered': {
      const tracking = order.tracking.find((t) => t.trackingCode || t.trackingUrl) ?? null;
      // Wait for tracking; a parcel Gelato reports shipped for a day without a
      // tracking entry ships without one rather than staying "in production" forever.
      if (tracking || ageMs(nowMs, row.updated_at) >= SHIPPED_WITHOUT_TRACKING_AFTER_MS) {
        shipped = { carrier: tracking?.carrier ?? null, trackingNumber: tracking?.trackingCode ?? null, trackingUrl: tracking?.trackingUrl ?? null };
        patch.status = 'shipped';
        patch.shipped_at = iso(nowMs);
        patch.tracking_number = shipped.trackingNumber;
        patch.tracking_url = shipped.trackingUrl;
        patch.carrier = shipped.carrier;
      }
      break;
    }
    case 'passed':
    case 'in_production':
    case 'printed':
      if (row.status === 'submitted') patch.status = 'in_production';
      break;
    default:
      break;
  }
  return Object.keys(patch).length > 0 ? { patch, shipped, failedReason, heldNow } : null;
}

async function trackOrders(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ polled: number; advanced: number; shipped: number; failed: number; held: number; capped: boolean }> {
  const now = dependencies.now();
  const out = { polled: 0, advanced: 0, shipped: 0, failed: 0, held: 0, capped: false };
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, gelato_order_id, gelato_status, requested_by, failure_reason, updated_at')
    .in('status', ['submitted', 'in_production'])
    .order('updated_at', { ascending: true })
    .limit(TRACK_BATCH)
    .returns<TrackRow[]>();
  if (error) {
    console.error('sweep-holiday-card-orders track lookup failed', error.message);
    return out;
  }
  const rows = data ?? [];
  out.capped = rows.length >= TRACK_BATCH;
  const apiKey = Deno.env.get('GELATO_API_KEY');
  if (!apiKey) {
    if (rows.length > 0) console.error('sweep-holiday-card-orders track skipped: GELATO_API_KEY is not configured');
    return out;
  }

  await mapPool(rows, TRACK_CONCURRENCY, async (row) => {
    if (!row.gelato_order_id) return;
    out.polled += 1;
    let order: GelatoOrder;
    try {
      order = await getOrder(dependencies.fetch, apiKey, row.gelato_order_id);
    } catch (e) {
      const failure = classifyGelatoError(e);
      if (failure.kind === 'missing' && ageMs(now, row.updated_at) > SUBMITTED_MISSING_GRACE_MS) {
        const { data: flipped } = await supabase
          .from('holiday_card_orders')
          .update({ status: 'failed', failure_reason: 'GELATO_ORDER_MISSING' })
          .eq('id', row.id)
          .eq('status', row.status)
          .select('id')
          .maybeSingle();
        if (flipped) {
          out.failed += 1;
          await alertCardOwner(dependencies.sendEmail, row.id, 'GELATO_ORDER_MISSING', 'A submitted order no longer exists at Gelato (deleted or cancelled there). Check the Gelato dashboard; the buyer may need a refund.');
        }
        return;
      }
      console.error('sweep-holiday-card-orders Gelato poll failed', row.id, e instanceof GelatoApiError ? e.status : 'error');
      return;
    }

    const decision = decideTrack(row, order, now);
    if (!decision) return;
    const { data: updated, error: updateError } = await supabase
      .from('holiday_card_orders')
      .update(decision.patch)
      .eq('id', row.id)
      .eq('status', row.status)
      .select('id')
      .maybeSingle();
    if (updateError || !updated) return;
    if (decision.patch.status) out.advanced += 1;
    if (decision.shipped) {
      out.shipped += 1;
      await sendCardShippedEmail(dependencies.sendEmail, supabase, row, decision.shipped);
    }
    if (decision.failedReason) {
      out.failed += 1;
      await alertCardOwner(dependencies.sendEmail, row.id, decision.failedReason, 'Gelato reports the order failed or was cancelled. The row is now failed; check the Gelato dashboard (and refund the buyer if it cannot be produced).');
    }
    if (decision.heldNow) {
      out.held += 1;
      await alertCardOwner(dependencies.sendEmail, row.id, 'GELATO_ON_HOLD', 'Gelato put this order on hold (pending approval, not connected or held). It is still being polled; check the Gelato dashboard.');
    }
  });
  return out;
}

// ── 3. age quoted / checkout orders ──────────────────────────────────────

interface AgingRow {
  id: string;
  status: string;
  stripe_session_id: string | null;
}

const SESSION_EXPIRES_PATH = 'print_files->>sessionExpiresAt';

async function ageOrders(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ cancelled: number; paidWebhookMissed: number }> {
  const now = dependencies.now();
  const cutoff = iso(now - QUOTED_AGING_MS);
  const out = { cancelled: 0, paidWebhookMissed: 0 };
  const fulfillmentDeps = fulfillmentDepsFor(dependencies);

  const { data: quoted, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, stripe_session_id')
    .eq('status', 'quoted')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(AGING_BATCH)
    .returns<AgingRow[]>();
  if (error) {
    console.error('sweep-holiday-card-orders quote aging lookup failed', error.message);
  }
  for (const row of quoted ?? []) {
    const { data: cancelled } = await supabase
      .from('holiday_card_orders')
      .update({ status: 'cancelled' })
      .eq('id', row.id)
      .eq('status', 'quoted')
      .select('id')
      .maybeSingle();
    if (!cancelled) continue;
    out.cancelled += 1;
    await releaseCardClaim(supabase, row.id); // a crashed create_checkout may have left the card claim
    await releaseUnpaidArtifacts(fulfillmentDeps, supabase, row.id);
  }

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  // `failure_reason is null` skips checkouts already flagged (PAID_WEBHOOK_MISSED), which wait for a human.
  // Due: 1 h after the session's own `expires_at`; an order with no stored expiry (created before the
  // expiry was recorded) falls back to the 48 h rule. Two bounded queries, so neither starves the other.
  const [byExpiry, legacy] = await Promise.all([
    supabase
      .from('holiday_card_orders')
      .select('id, status, stripe_session_id')
      .eq('status', 'checkout')
      .is('failure_reason', null)
      .lt(SESSION_EXPIRES_PATH, iso(now - CHECKOUT_AGING_AFTER_EXPIRY_MS))
      .order('updated_at', { ascending: true })
      .limit(AGING_BATCH)
      .returns<AgingRow[]>(),
    supabase
      .from('holiday_card_orders')
      .select('id, status, stripe_session_id')
      .eq('status', 'checkout')
      .is('failure_reason', null)
      .is(SESSION_EXPIRES_PATH, null)
      .lt('updated_at', cutoff)
      .order('updated_at', { ascending: true })
      .limit(AGING_BATCH)
      .returns<AgingRow[]>(),
  ]);
  const checkoutError = byExpiry.error ?? legacy.error;
  if (checkoutError) {
    console.error('sweep-holiday-card-orders checkout aging lookup failed', checkoutError.message);
    return out;
  }
  const checkouts = [...new Map([...(byExpiry.data ?? []), ...(legacy.data ?? [])].map((row) => [row.id, row])).values()].slice(0, AGING_BATCH);
  if (checkouts.length > 0 && !stripeSecretKey) {
    console.error('sweep-holiday-card-orders checkout aging skipped: STRIPE_SECRET_KEY is not configured');
    return out;
  }
  for (const row of checkouts) {
    if (!stripeSecretKey || !row.stripe_session_id) continue;
    try {
      const session = await retrieveCheckoutSession(dependencies.fetch, stripeSecretKey, row.stripe_session_id);
      if (session.status === 'complete') {
        // The customer paid but the webhook never moved the order: never cancel
        // (that would delete the draft of a paid order). Flag once for a human.
        const { data: flagged } = await supabase
          .from('holiday_card_orders')
          .update({ failure_reason: 'PAID_WEBHOOK_MISSED' })
          .eq('id', row.id)
          .eq('status', 'checkout')
          .is('failure_reason', null)
          .select('id')
          .maybeSingle();
        if (flagged) {
          out.paidWebhookMissed += 1;
          await alertCardOwner(dependencies.sendEmail, row.id, 'PAID_WEBHOOK_MISSED', 'The Stripe session for this order is complete but the order never left checkout. Re-send the checkout.session.completed event from the Stripe dashboard.');
        }
        continue;
      }
      if (session.status === 'open') await expireCheckoutSession(dependencies.fetch, stripeSecretKey, row.stripe_session_id);
    } catch (e) {
      console.error('sweep-holiday-card-orders checkout session check failed', row.id, e instanceof Error ? e.name : 'unknown');
      continue;
    }
    const { data: cancelled } = await supabase
      .from('holiday_card_orders')
      .update({ status: 'cancelled' })
      .eq('id', row.id)
      .eq('status', 'checkout')
      .select('id')
      .maybeSingle();
    if (!cancelled) continue;
    out.cancelled += 1;
    await releaseCardClaim(supabase, row.id);
    await releaseUnpaidArtifacts(fulfillmentDeps, supabase, row.id);
  }
  return out;
}

// ── 3b. stale card-level checkout claims ─────────────────────────────────

/**
 * `claim_holiday_card_checkout` is released when an order leaves `checkout` or a
 * `create_checkout` attempt fails; a crash can leave one behind. Anything older
 * than 10 minutes whose order is not in `checkout` (and is not a `quoted` order
 * with a fresh `create_checkout` claim) is released. A claim whose order is in
 * `checkout` is the live one and is never touched.
 */
async function clearStaleCardClaims(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ released: number }> {
  const now = dependencies.now();
  const out = { released: 0 };
  const { data: cards, error } = await supabase
    .from('holiday_cards')
    .select('id, checkout_order_id, checkout_claimed_at')
    .not('checkout_order_id', 'is', null)
    .lt('checkout_claimed_at', iso(now - CARD_CLAIM_STALE_MS))
    .order('checkout_claimed_at', { ascending: true })
    .limit(CLEANUP_BATCH)
    .returns<{ id: string; checkout_order_id: string; checkout_claimed_at: string }[]>();
  if (error) {
    console.error('sweep-holiday-card-orders stale claim lookup failed', error.message);
    return out;
  }
  const claims = cards ?? [];
  if (claims.length === 0) return out;
  const { data: orders, error: orderError } = await supabase
    .from('holiday_card_orders')
    .select('id, status, print_files')
    .in('id', claims.map((c) => c.checkout_order_id))
    .returns<{ id: string; status: string; print_files: unknown }[]>();
  if (orderError) {
    console.error('sweep-holiday-card-orders stale claim order lookup failed', orderError.message);
    return out;
  }
  const orderById = new Map((orders ?? []).map((o) => [o.id, o]));
  for (const claim of claims) {
    const order = orderById.get(claim.checkout_order_id);
    if (order?.status === 'checkout') continue;
    if (order?.status === 'quoted' && isFreshClaim(parsePrintFiles(order.print_files), now)) continue;
    await releaseCardClaim(supabase, claim.checkout_order_id);
    out.released += 1;
  }
  return out;
}

// ── 4. clean-up + retention ──────────────────────────────────────────────

async function cleanUp(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ unpaidReleased: number; filesDeleted: number }> {
  const now = dependencies.now();
  const out = { unpaidReleased: 0, filesDeleted: 0 };
  const fulfillmentDeps = fulfillmentDepsFor(dependencies);

  // (a) cancelled, never paid, still holding a Gelato draft or files (an earlier clean-up failed).
  const unpaidIds = new Set<string>();
  for (const column of ['gelato_order_id', 'print_files']) {
    const { data, error } = await supabase
      .from('holiday_card_orders')
      .select('id')
      .eq('status', 'cancelled')
      .is('stripe_payment_intent_id', null)
      .not(column, 'is', null)
      .limit(CLEANUP_BATCH)
      .returns<{ id: string }[]>();
    if (error) console.error('sweep-holiday-card-orders unpaid clean-up lookup failed', error.message);
    for (const row of data ?? []) unpaidIds.add(row.id);
  }
  for (const id of [...unpaidIds].slice(0, CLEANUP_BATCH)) {
    if (await releaseUnpaidArtifacts(fulfillmentDeps, supabase, id)) out.unpaidReleased += 1;
  }

  // (b) retention. The rule keeps the files of a PAID order that failed (we may still
  //     have to fix and re-submit it) until it was refunded or 30 days passed since it
  //     failed; a never-paid failed/cancelled order is cleaned at once. Shipped orders
  //     lose them 30 days after shipped_at. Each criterion is its own bounded query so a
  //     pile of retained orders can never starve the others.
  const retentionIds = new Set<string>();
  const finishedStatuses = ['failed', 'cancelled'];
  const add = (rows: { id: string }[] | null) => { for (const row of rows ?? []) retentionIds.add(row.id); };
  const lookups: [string, PromiseLike<{ data: { id: string }[] | null; error: { message: string } | null }>][] = [
    ['never-paid', supabase.from('holiday_card_orders').select('id').in('status', finishedStatuses).is('stripe_payment_intent_id', null).not('print_files', 'is', null).limit(CLEANUP_BATCH).returns<{ id: string }[]>()],
    ['refunded', supabase.from('holiday_card_orders').select('id').in('status', finishedStatuses).not('refunded_at', 'is', null).not('print_files', 'is', null).limit(CLEANUP_BATCH).returns<{ id: string }[]>()],
    ['failed-30d', supabase.from('holiday_card_orders').select('id').in('status', finishedStatuses).lt('updated_at', iso(now - RETENTION_AFTER_SHIPPED_MS)).not('print_files', 'is', null).limit(CLEANUP_BATCH).returns<{ id: string }[]>()],
    ['shipped-30d', supabase.from('holiday_card_orders').select('id').eq('status', 'shipped').lt('shipped_at', iso(now - RETENTION_AFTER_SHIPPED_MS)).not('print_files', 'is', null).limit(CLEANUP_BATCH).returns<{ id: string }[]>()],
  ];
  for (const [name, lookup] of lookups) {
    const { data, error } = await lookup;
    if (error) console.error(`sweep-holiday-card-orders retention lookup (${name}) failed`, error.message);
    add(data);
  }
  for (const id of [...retentionIds].slice(0, CLEANUP_BATCH)) {
    if (await releasePrintFiles(fulfillmentDeps, supabase, id)) out.filesDeleted += 1;
  }
  return out;
}

// ── 4b. refunds that did not finish ──────────────────────────────────────

async function finishRefunds(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ cancelled: number; retry: number; flagged: number }> {
  const now = dependencies.now();
  const out = { cancelled: 0, retry: 0, flagged: 0 };
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, gelato_order_id, refunded_at, failure_reason')
    .not('refunded_at', 'is', null)
    .in('status', ['paid', 'submitted', 'in_production'])
    .order('refunded_at', { ascending: true })
    .limit(CLEANUP_BATCH)
    .returns<{ id: string; status: string; gelato_order_id: string | null; refunded_at: string; failure_reason: string | null }[]>();
  if (error) {
    console.error('sweep-holiday-card-orders refund lookup failed', error.message);
    return out;
  }
  const fulfillmentDeps = fulfillmentDepsFor(dependencies);
  for (const row of data ?? []) {
    const outcome = await processRefundedOrder(fulfillmentDeps, supabase, row);
    if (outcome === 'cancelled') {
      out.cancelled += 1;
      continue;
    }
    if (outcome !== 'failed' && outcome !== 'retry') continue;
    if (outcome === 'retry') out.retry += 1;
    // Alert once: when Gelato refuses outright, or when it has been unreachable for 30 minutes.
    const overdue = ageMs(now, row.refunded_at) >= PAID_ALERT_AFTER_MS;
    if (outcome === 'retry' && !overdue) continue;
    // Matches an order with no reason AND a canary-held one (HELD_FOR_CANARY).
    if (await flagRefundNotCancelled(supabase, row.id)) {
      out.flagged += 1;
      await alertCardOwner(dependencies.sendEmail, row.id, 'REFUND_NOT_CANCELLED', `The order was refunded while "${row.status}" but its Gelato order could not be cancelled automatically. Cancel it in the Gelato dashboard.`);
    }
  }
  return out;
}

// ── 5. stuck card generation ─────────────────────────────────────────────

interface StuckCardRow {
  id: string;
}

/** Failure codes a re-dispatch can fix (transient work failures). NO_LETTERS and `generation_attempts_exhausted` are terminal. */
export const RETRYABLE_GENERATION_CODES = ['CONTEXT_LOAD_FAILED', 'FRONT_PICK_FAILED', 'FILM_SETUP_FAILED', 'LETTERS_FAILED', 'UNKNOWN_ERROR'] as const;
export const FAILED_RETRY_AFTER_MS = 10 * 60_000;

async function recoverGeneration(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ redispatched: number; dispatchFailed: number; exhausted: number; retriedFailed: number }> {
  const now = dependencies.now();
  const out = { redispatched: 0, dispatchFailed: 0, exhausted: 0, retriedFailed: 0 };

  /** Bump the attempt counter (cap 3) and dispatch; at the cap the card is failed for good. */
  const redispatch = async (cardId: string): Promise<boolean> => {
    const { data: attempt, error: rpcError } = await supabase.rpc('increment_holiday_card_generation_attempt', {
      p_card_id: cardId,
      p_cap: GENERATION_ATTEMPT_CAP,
    });
    if (rpcError) {
      console.error('sweep-holiday-card-orders attempt bump failed', cardId, rpcError.message);
      return false;
    }
    if (attempt === null || attempt === undefined) {
      // Cap reached (or the card is gone): stop retrying and tell the client it failed.
      const { data: failed } = await supabase
        .from('holiday_cards')
        .update({ status: 'failed', last_failure_code: 'generation_attempts_exhausted' })
        .eq('id', cardId)
        .eq('status', 'generating')
        .select('id')
        .maybeSingle();
      if (failed) out.exhausted += 1;
      return false;
    }
    let accepted = false;
    try {
      accepted = await dependencies.dispatchGeneration(cardId, crypto.randomUUID());
    } catch (e) {
      console.error('sweep-holiday-card-orders generation dispatch threw', cardId, e instanceof Error ? e.name : 'unknown');
    }
    if (accepted) out.redispatched += 1;
    else {
      out.dispatchFailed += 1;
      console.error('sweep-holiday-card-orders generation dispatch failed', cardId);
    }
    return accepted;
  };

  // (a) generating but stuck.
  const ids = new Set<string>();
  const { data: stale, error: staleError } = await supabase
    .from('holiday_cards')
    .select('id')
    .eq('status', 'generating')
    .is('deleted_at', null)
    .lt('heartbeat_at', iso(now - GENERATION_STALE_HEARTBEAT_MS))
    .order('heartbeat_at', { ascending: true })
    .limit(GENERATION_BATCH)
    .returns<StuckCardRow[]>();
  if (staleError) console.error('sweep-holiday-card-orders stale generation lookup failed', staleError.message);
  for (const row of stale ?? []) ids.add(row.id);
  const { data: neverLeased, error: neverError } = await supabase
    .from('holiday_cards')
    .select('id')
    .eq('status', 'generating')
    .is('deleted_at', null)
    .is('heartbeat_at', null)
    .lt('updated_at', iso(now - GENERATION_NEVER_LEASED_MS))
    .order('updated_at', { ascending: true })
    .limit(GENERATION_BATCH)
    .returns<StuckCardRow[]>();
  if (neverError) console.error('sweep-holiday-card-orders unleased generation lookup failed', neverError.message);
  for (const row of neverLeased ?? []) ids.add(row.id);
  for (const cardId of [...ids].slice(0, GENERATION_BATCH)) await redispatch(cardId);

  // (b) FAILED with a retryable code, attempts left, a cool-down after the failure. Runs AFTER (a): the
  //     reset below leaves a card generating without a heartbeat, which (a) must not pick up in this same tick.
  const { data: failedCards, error: failedError } = await supabase
    .from('holiday_cards')
    .select('id, last_failure_code')
    .eq('status', 'failed')
    .is('deleted_at', null)
    .in('last_failure_code', [...RETRYABLE_GENERATION_CODES])
    .lt('generation_attempts', GENERATION_ATTEMPT_CAP)
    .lt('updated_at', iso(now - FAILED_RETRY_AFTER_MS))
    .order('updated_at', { ascending: true })
    .limit(GENERATION_BATCH)
    .returns<{ id: string; last_failure_code: string }[]>();
  if (failedError) console.error('sweep-holiday-card-orders failed-card lookup failed', failedError.message);
  for (const card of failedCards ?? []) {
    // One UPDATE, guarded by the status AND the code we read: a card that moved on is left alone.
    const { data: reset } = await supabase
      .from('holiday_cards')
      .update({ status: 'generating', last_failure_code: null, workflow_instance_id: null, attempt_id: null, heartbeat_at: null })
      .eq('id', card.id)
      .eq('status', 'failed')
      .eq('last_failure_code', card.last_failure_code)
      .select('id')
      .maybeSingle();
    if (!reset) continue;
    out.retriedFailed += 1;
    await redispatch(card.id);
  }
  return out;
}

// ── 5c. "your card is ready" push ────────────────────────────────────────

/** Push copy in the card's language (`holiday_cards.language`: en | es). */
export function cardReadyPushCopy(language: string | null | undefined): { title: string; body: string } {
  return language === 'es'
    ? { title: 'Tu tarjeta de fiestas está lista', body: 'Ábrela para revisarla y pedirla.' }
    : { title: 'Your holiday card is ready', body: 'Open it to review and order.' };
}

interface ReadyCardRow {
  id: string;
  family_id: string;
  created_by: string | null;
  language: string | null;
}

/**
 * Cards that WAITED for a film (film_id set) and are now ready push their creator once.
 * Deliberately NOT gated on `notify_new_memories` / `notify_engagement`: like the Memory Book
 * "your book is ready" push, this reports the outcome of the creator's own action (they made
 * the card), not activity by someone else. A user with no push token (permission denied) is skipped.
 * `ready_notified_at` is claimed BEFORE sending, so a crash or a duplicate tick can never double-send;
 * a failed send is logged by card id and not retried (at-most-once, a push is best effort).
 */
async function notifyReadyCards(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ considered: number; waiting: number; claimed: number; sent: number; failed: number }> {
  const now = dependencies.now();
  const out = { considered: 0, waiting: 0, claimed: 0, sent: 0, failed: 0 };
  const { data, error } = await supabase
    .from('holiday_cards')
    .select('id, family_id, created_by, language')
    .eq('status', 'ready')
    .not('film_id', 'is', null)
    .is('ready_notified_at', null)
    .is('deleted_at', null)
    .gt('created_at', iso(now - READY_PUSH_WINDOW_MS))
    .order('created_at', { ascending: true })
    .limit(READY_PUSH_BATCH)
    .returns<ReadyCardRow[]>();
  if (error) {
    console.error('sweep-holiday-card-orders ready lookup failed', error.message);
    return out;
  }
  for (const card of data ?? []) {
    out.considered += 1;
    const { data: readiness, error: readinessError } = await supabase.rpc('holiday_card_readiness', { p_card_id: card.id });
    if (readinessError) {
      console.error('sweep-holiday-card-orders readiness failed', card.id, readinessError.code ?? 'unknown');
      continue;
    }
    if (readiness !== 'ready') {
      out.waiting += 1;
      continue;
    }
    // The CAS: only the writer that flips null -> now() sends.
    const { data: claimed } = await supabase
      .from('holiday_cards')
      .update({ ready_notified_at: iso(now) })
      .eq('id', card.id)
      .is('ready_notified_at', null)
      .eq('status', 'ready')
      .is('deleted_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) continue;
    out.claimed += 1;
    if (!card.created_by) continue;

    const { data: profile, error: profileError } = await supabase
      .from('user_profiles')
      .select('expo_push_token, deleted_at')
      .eq('id', card.created_by)
      .maybeSingle<{ expo_push_token: string | null; deleted_at: string | null }>();
    if (profileError) {
      console.error('sweep-holiday-card-orders profile lookup failed', card.id, profileError.code ?? 'unknown');
      out.failed += 1;
      continue;
    }
    if (!profile || profile.deleted_at || !profile.expo_push_token) continue;
    const copy = cardReadyPushCopy(card.language);
    try {
      const accepted = await dependencies.sendPush(profile.expo_push_token, copy.title, copy.body, {
        route: 'holiday-card',
        cardId: card.id,
        familyId: card.family_id,
      });
      if (accepted) out.sent += 1;
      else {
        out.failed += 1;
        console.error('sweep-holiday-card-orders ready push rejected', card.id);
      }
    } catch (pushError) {
      out.failed += 1;
      console.error('sweep-holiday-card-orders ready push failed', card.id, pushError instanceof Error ? pushError.name : 'unknown');
    }
  }
  return out;
}

// ── 6. ordered cards whose film is gone ──────────────────────────────────

interface FilmRow {
  id: string;
  status: string;
  video_key: string | null;
  ready_at: string | null;
}

/** An ordered card's printed QR points at its film: failed/ended, or a published film that lost its video, is broken. */
export function filmIsBroken(film: FilmRow): boolean {
  return film.status === 'failed' || film.status === 'ended' || (film.ready_at !== null && film.video_key === null);
}

async function checkOrderedFilms(
  dependencies: SweepDependencies,
  supabase: SupabaseClient,
): Promise<{ checked: number; alerted: number }> {
  const out = { checked: 0, alerted: 0 };
  const { data: orders, error } = await supabase
    .from('holiday_card_orders')
    .select('card_id')
    .in('status', ['paid', 'submitted', 'in_production', 'shipped'])
    .not('card_id', 'is', null)
    .limit(FILM_CHECK_CARD_CAP)
    .returns<{ card_id: string }[]>();
  if (error) {
    console.error('sweep-holiday-card-orders ordered films lookup failed', error.message);
    return out;
  }
  const cardIds = [...new Set((orders ?? []).map((o) => o.card_id))];
  for (const ids of chunk(cardIds, IN_CHUNK)) {
    const { data: cards } = await supabase
      .from('holiday_cards')
      .select('id, film_id, last_failure_code')
      .in('id', ids)
      .not('film_id', 'is', null)
      .returns<{ id: string; film_id: string; last_failure_code: string | null }[]>();
    const filmIds = (cards ?? []).map((c) => c.film_id);
    if (filmIds.length === 0) continue;
    const { data: films } = await supabase
      .from('year_films')
      .select('id, status, video_key, ready_at')
      .in('id', filmIds)
      .returns<FilmRow[]>();
    const filmById = new Map((films ?? []).map((f) => [f.id, f]));
    for (const card of cards ?? []) {
      const film = filmById.get(card.film_id);
      if (!film) continue;
      out.checked += 1;
      if (!filmIsBroken(film) || card.last_failure_code !== null) continue;
      // Mark first (the dedupe), then alert.
      const { data: marked } = await supabase
        .from('holiday_cards')
        .update({ last_failure_code: 'ordered_film_unavailable' })
        .eq('id', card.id)
        .is('last_failure_code', null)
        .select('id')
        .maybeSingle();
      if (!marked) continue;
      out.alerted += 1;
      await alertCardOwner(dependencies.sendEmail, card.id, 'ORDERED_FILM_UNAVAILABLE', `The film behind an ordered card's QR code is ${film.status}${film.video_key ? '' : ' with no video'}. Printed cards link to it.`);
    }
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────

async function pass<T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(`sweep-holiday-card-orders ${name} pass failed`, error instanceof Error ? error.name : 'unknown');
    return fallback;
  }
}

export async function handleSweepHolidayCardOrders(
  req: Request,
  dependencyOverrides: Partial<SweepDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');
  if (!validateCronSecret(req)) return errorResponse('Unauthorized', 401, 'unauthorized');

  const supabase = dependencies.createServiceClient();
  const confirm = await pass('confirm', null, () => confirmPaidOrders(dependencies, supabase));
  const track = await pass('track', null, () => trackOrders(dependencies, supabase));
  const aging = await pass('aging', null, () => ageOrders(dependencies, supabase));
  const claims = await pass('card-claims', null, () => clearStaleCardClaims(dependencies, supabase));
  const cleanup = await pass('cleanup', null, () => cleanUp(dependencies, supabase));
  const refunds = await pass('refunds', null, () => finishRefunds(dependencies, supabase));
  const generation = await pass('generation', null, () => recoverGeneration(dependencies, supabase));
  const ready = await pass('card-ready', null, () => notifyReadyCards(dependencies, supabase));
  // Hourly: the first tick of each hour (the cron runs every 10 minutes).
  const films = new Date(dependencies.now()).getUTCMinutes() < 10
    ? await pass('ordered-films', null, () => checkOrderedFilms(dependencies, supabase))
    : null;

  return jsonResponse({ success: true, confirm, track, aging, claims, cleanup, refunds, generation, ready, films });
}

if (import.meta.main) serveWithSentry('sweep-holiday-card-orders', (request) => handleSweepHolidayCardOrders(request));
