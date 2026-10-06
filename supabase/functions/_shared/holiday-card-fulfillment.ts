/**
 * Shared fulfillment steps for holiday-card orders (docs/plans/
 * holiday-cards-p1.md Step 6), used by `stripe-webhook` (right after payment),
 * `sweep-holiday-card-orders` (the fallback and the clean-up) and
 * `holiday-card-orders` (cancel):
 *
 *   - `confirmPaidOrder`: the ONLY thing that happens after payment: PATCH the
 *     Gelato draft into an order, if Gelato still reports it as a draft
 *     (`confirmDraftIfDraft`), then CAS `paid -> submitted`. Idempotent: the
 *     webhook and the sweep can both run it and only the CAS winner emails.
 *   - `releaseUnpaidArtifacts` / `releasePrintFiles`: delete the Gelato draft
 *     and the rendered print files of an order that will never be produced.
 *   - the `print_files` column's shape (a transient checkout claim, then the
 *     rendered files and the Stripe session expiry of the attempt).
 *   - `releaseCardClaim`: clears the card-level checkout claim
 *     (`release_holiday_card_checkout`) when an order leaves `checkout`.
 *
 * Privacy: ids, statuses and codes only. Never an address, a name, letter text
 * or a secret in a log, an error or an alert.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { cancelOrder, confirmOrder, deleteDraft, GelatoApiError, GelatoParseError, getOrder } from './gelato.ts';
import { alertCardOwner, type SendEmail, sendCardOrderConfirmationEmail } from './holiday-card-order-notify.ts';
import { retrievePaymentIntent } from './stripe.ts';

// ── print_files column ───────────────────────────────────────────────────

export interface PrintFileRecord {
  side: 'front' | 'back' | 'both';
  key: string;
  sha256: string;
  bytes: number;
}

/**
 * `holiday_card_orders.print_files` (service-role only jsonb). Non-null means
 * "there may be objects under `print-orders/<orderId>/`"; the sweep deletes them
 * and sets the column back to null, so a null column is the "already gone"
 * record that stops the retention pass from repeating.
 *   claim   transient lock taken by `create_checkout` while it renders and
 *           creates the Gelato draft (a double tap or a crashed attempt)
 *   files   the rendered PDFs (keys + sha256)
 */
export interface PrintFilesState {
  claim?: { id: string; at: string };
  files?: PrintFileRecord[];
  snapshotHash?: string;
  renderedAt?: string;
  /**
   * ISO time the Stripe Checkout Session of this attempt expires (the `expires_at`
   * sent to Stripe, and part of its idempotency key). Persisted BEFORE the session
   * is created so a retry of the same attempt sends an identical request; the
   * sweep ages a `checkout` order one hour after it.
   */
  sessionExpiresAt?: string;
}

export function parsePrintFiles(value: unknown): PrintFilesState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: PrintFilesState = {};
  const claim = raw.claim as Record<string, unknown> | undefined;
  if (claim && typeof claim.id === 'string' && typeof claim.at === 'string') out.claim = { id: claim.id, at: claim.at };
  if (Array.isArray(raw.files)) {
    out.files = raw.files.filter((f): f is PrintFileRecord => {
      const file = f as Record<string, unknown> | null;
      return !!file && typeof file.key === 'string' && typeof file.sha256 === 'string' && typeof file.bytes === 'number' &&
        (file.side === 'front' || file.side === 'back' || file.side === 'both');
    });
  }
  if (typeof raw.snapshotHash === 'string') out.snapshotHash = raw.snapshotHash;
  if (typeof raw.renderedAt === 'string') out.renderedAt = raw.renderedAt;
  if (typeof raw.sessionExpiresAt === 'string') out.sessionExpiresAt = raw.sessionExpiresAt;
  return out;
}

/**
 * A claim younger than this belongs to a live `create_checkout`; older = crashed,
 * take over. The claim is `print_files.claim = { id: <uuid>, at: <ISO> }`; `at`
 * is refreshed when the render is persisted. Worst-case work under one claim is
 * ~4 minutes (render 120 s + Gelato 30 s + Stripe 2 x 30 s), hence 10.
 */
export const CHECKOUT_CLAIM_TTL_MS = 10 * 60_000;

export function isFreshClaim(state: PrintFilesState, nowMs: number): boolean {
  if (!state.claim) return false;
  const at = Date.parse(state.claim.at);
  return Number.isFinite(at) && nowMs - at < CHECKOUT_CLAIM_TTL_MS;
}

/**
 * Clears the card-level checkout claim held by `orderId` (`release_holiday_card_
 * checkout`: a no-op unless the claim belongs to that order). Call it whenever an
 * order leaves `checkout` (paid, expired, cancelled, aged, refunded) or a
 * `create_checkout` attempt fails. Best effort: a failure is logged and the claim
 * simply goes stale after 10 minutes (the sweep also clears it).
 */
export async function releaseCardClaim(supabase: SupabaseClient, orderId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('release_holiday_card_checkout', { p_order_id: orderId });
    if (error) console.error('holiday-card could not release the card checkout claim', orderId);
  } catch {
    console.error('holiday-card could not release the card checkout claim', orderId);
  }
}

const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything of one order lives under this prefix (retention lists and deletes all of it). */
export function printOrderPrefix(orderId: string): string {
  if (!ORDER_ID_PATTERN.test(orderId)) throw new Error('HOLIDAY_CARD_ORDER_ID_INVALID');
  return `print-orders/${orderId}/`;
}

/**
 * Where ONE snapshot's PDFs are rendered: content-addressed by the snapshot
 * hash, so a re-render for a changed card can never overwrite the files a
 * Gelato draft (or a paid order) points at.
 */
export function printFilesPrefix(orderId: string, snapshotHash: string): string {
  if (!/^[0-9a-f]{16,64}$/.test(snapshotHash)) throw new Error('HOLIDAY_CARD_SNAPSHOT_HASH_INVALID');
  return `${printOrderPrefix(orderId)}${snapshotHash.slice(0, 16)}/`;
}

// ── Dependencies ─────────────────────────────────────────────────────────

export interface FulfillmentDeps {
  fetch: typeof fetch;
  sendEmail: SendEmail;
  /** R2: every object key under a prefix. */
  listKeys: (prefix: string) => Promise<string[]>;
  /** R2: delete one object. */
  deleteKey: (key: string) => Promise<void>;
  /** `GELATO_API_KEY`; null = not configured (every Gelato step reports a retry). */
  gelatoApiKey: string | null;
  /** `STRIPE_SECRET_KEY`; null = not configured (confirm cannot verify refunds, so it retries). */
  stripeSecretKey: string | null;
}

// ── Gelato error classification ──────────────────────────────────────────

type GelatoFailure = { kind: 'retry' } | { kind: 'missing' } | { kind: 'rejected'; code: string };

const SAFE_CODE = /[^A-Za-z0-9_.-]/g;

export function classifyGelatoError(error: unknown): GelatoFailure {
  if (error instanceof GelatoApiError) {
    if (error.status === 404) return { kind: 'missing' };
    if (error.retryable) return { kind: 'retry' };
    return { kind: 'rejected', code: (error.code ?? `http_${error.status}`).replace(SAFE_CODE, '').slice(0, 40) || 'unknown' };
  }
  if (error instanceof GelatoParseError) return { kind: 'retry' };
  return { kind: 'rejected', code: 'unexpected' };
}

// ── Confirm after payment ────────────────────────────────────────────────

/** `failure_reason` of a paid order held back for the canary (the sweep never confirms a flagged order). */
export const HELD_FOR_CANARY = 'HELD_FOR_CANARY';

export type ConfirmOutcome =
  | 'submitted' // this call did the paid -> submitted CAS
  | 'already_advanced' // another path moved it (webhook vs sweep) or the CAS lost
  | 'not_paid' // the row is not `paid` any more
  | 'blocked' // refunded or flagged for manual handling: never confirmed
  | 'retry' // Gelato/transport problem: stays `paid`, the sweep retries
  | 'failed'; // unrecoverable: the row is now `failed` and the owner was alerted

interface PaidOrderRow {
  id: string;
  family_id: string | null;
  status: string;
  gelato_order_id: string | null;
  requested_by: string | null;
  packs: number | null;
  refunded_at: string | null;
  failure_reason: string | null;
  stripe_payment_intent_id: string | null;
}

/** CAS `paid -> failed` with a reason + owner alert. Returns true when this call flipped it. */
export async function failPaidOrder(deps: FulfillmentDeps, supabase: SupabaseClient, orderId: string, reason: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .update({ status: 'failed', failure_reason: reason })
    .eq('id', orderId)
    .eq('status', 'paid')
    .select('id')
    .maybeSingle();
  if (error || !data) return false;
  await alertCardOwner(deps.sendEmail, orderId, reason, 'Payment captured but the order could not be confirmed at Gelato. Manual fix or refund required.');
  return true;
}

/**
 * The one post-payment action: confirm the Gelato draft (only while Gelato
 * still reports a draft), then CAS `paid -> submitted`. Safe to call from the
 * webhook and the sweep at the same time and any number of times.
 *
 * Before the PATCH it asks Stripe whether the payment was already refunded
 * (webhook events can arrive out of order, and a refund can land between the
 * paid CAS and this call): a refunded order is never produced. Without a Stripe
 * key or on a Stripe error the answer is `retry` (fail closed).
 */
export async function confirmPaidOrder(
  deps: FulfillmentDeps,
  supabase: SupabaseClient,
  orderId: string,
): Promise<ConfirmOutcome> {
  const { data: order, error } = await supabase
    .from('holiday_card_orders')
    .select('id, family_id, status, gelato_order_id, requested_by, packs, refunded_at, failure_reason, stripe_payment_intent_id')
    .eq('id', orderId)
    .maybeSingle<PaidOrderRow>();
  if (error || !order) return 'retry';
  if (order.status !== 'paid') return 'not_paid';
  if (order.refunded_at || order.failure_reason) return 'blocked';

  // Held canary (docs/plans/holiday-cards-p2.md Step 2): a paid order of a listed
  // family is NEVER confirmed at Gelato. This is the first thing that happens,
  // before any Stripe or Gelato call, and it fails closed: a settings read error
  // (or an answer that is not a boolean) is a `retry`, never a confirm.
  if (!order.family_id) return 'retry';
  const { data: held, error: holdError } = await supabase.rpc('holiday_card_hold_confirm', { p_family_id: order.family_id });
  if (holdError || typeof held !== 'boolean') {
    console.error('holiday-card confirm: cannot read the canary hold list, will retry', orderId);
    return 'retry';
  }
  if (held) {
    // One CAS marks it (and decides who alerts): the webhook and the sweep can race here.
    const { data: flagged } = await supabase
      .from('holiday_card_orders')
      .update({ failure_reason: HELD_FOR_CANARY })
      .eq('id', orderId)
      .eq('status', 'paid')
      .is('failure_reason', null)
      .is('refunded_at', null)
      .select('id')
      .maybeSingle();
    if (flagged) {
      await alertCardOwner(deps.sendEmail, orderId, HELD_FOR_CANARY, 'paid order held before Gelato confirm (canary)');
    }
    return 'blocked';
  }

  if (!order.gelato_order_id) {
    return (await failPaidOrder(deps, supabase, orderId, 'GELATO_DRAFT_MISSING')) ? 'failed' : 'already_advanced';
  }
  if (!deps.gelatoApiKey) {
    console.error('holiday-card confirm: GELATO_API_KEY is not configured', orderId);
    return 'retry';
  }
  if (!deps.stripeSecretKey || !order.stripe_payment_intent_id) {
    console.error('holiday-card confirm: cannot verify the payment (no Stripe key or payment intent), will retry', orderId);
    return 'retry';
  }

  // Out-of-order refund check.
  try {
    const payment = await retrievePaymentIntent(deps.fetch, deps.stripeSecretKey, order.stripe_payment_intent_id);
    if (payment.amountRefunded > 0) {
      const full = payment.amount === null || payment.amountRefunded >= payment.amount;
      if (!full) {
        // A partial (goodwill) refund must not cancel the order automatically, but it must not be printed unseen either.
        const { data: flagged } = await supabase
          .from('holiday_card_orders')
          .update({ failure_reason: 'PARTIAL_REFUND_BEFORE_CONFIRM' })
          .eq('id', orderId)
          .eq('status', 'paid')
          .is('failure_reason', null)
          .select('id')
          .maybeSingle();
        if (flagged) {
          await alertCardOwner(deps.sendEmail, orderId, 'PARTIAL_REFUND_BEFORE_CONFIRM', 'A paid order was partially refunded before it was sent to print. It is held: clear failure_reason to print it, or refund fully.');
        }
        return 'blocked';
      }
      await supabase
        .from('holiday_card_orders')
        .update({ refunded_at: new Date().toISOString() })
        .eq('id', orderId)
        .is('refunded_at', null);
      const outcome = await processRefundedOrder(deps, supabase, { id: orderId, status: 'paid', gelato_order_id: order.gelato_order_id });
      await alertCardOwner(
        deps.sendEmail,
        orderId,
        'REFUNDED_BEFORE_CONFIRM',
        outcome === 'cancelled' ? 'A paid order was refunded before it was sent to print; it was cancelled and never produced.' : 'A paid order was refunded before it was sent to print but its Gelato draft could not be removed yet; the sweep keeps retrying.',
      );
      return 'blocked';
    }
  } catch (e) {
    console.error('holiday-card confirm: payment check failed, will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return 'retry';
  }

  let gelatoStatus: string | null;
  try {
    const current = await getOrder(deps.fetch, deps.gelatoApiKey, order.gelato_order_id);
    if (current.isDraft) {
      try {
        const confirmed = await confirmOrder(deps.fetch, deps.gelatoApiKey, order.gelato_order_id);
        gelatoStatus = confirmed.rawFulfillmentStatus ?? confirmed.fulfillmentStatus;
      } catch (patchError) {
        // A concurrent confirm (webhook vs sweep) can make OUR patch fail after the other one won:
        // look again, and treat "no longer a draft" as success.
        if (classifyGelatoError(patchError).kind !== 'rejected') throw patchError;
        const again = await getOrder(deps.fetch, deps.gelatoApiKey, order.gelato_order_id);
        if (again.isDraft) throw patchError;
        gelatoStatus = again.rawFulfillmentStatus ?? again.fulfillmentStatus;
      }
    } else {
      gelatoStatus = current.rawFulfillmentStatus ?? current.fulfillmentStatus;
    }
  } catch (e) {
    const failure = classifyGelatoError(e);
    if (failure.kind === 'retry') {
      console.error('holiday-card confirm: Gelato unavailable, will retry', orderId);
      return 'retry';
    }
    const reason = failure.kind === 'missing' ? 'GELATO_DRAFT_MISSING' : `GELATO_CONFIRM_REJECTED:${failure.code}`;
    return (await failPaidOrder(deps, supabase, orderId, reason)) ? 'failed' : 'already_advanced';
  }

  const { data: advanced, error: casError } = await supabase
    .from('holiday_card_orders')
    .update({ status: 'submitted', gelato_status: gelatoStatus })
    .eq('id', orderId)
    .eq('status', 'paid')
    .select('id')
    .maybeSingle();
  if (casError) {
    console.error('holiday-card confirm: submitted CAS failed', orderId);
    return 'retry';
  }
  if (!advanced) return 'already_advanced';
  await sendCardOrderConfirmationEmail(deps.sendEmail, supabase, order);
  return 'submitted';
}

// ── Refunds ──────────────────────────────────────────────────────────────

export type RefundOutcome = 'cancelled' | 'retry' | 'failed' | 'nothing';

/**
 * Finishes the Gelato side of a REFUNDED order (`refunded_at` already set): a
 * draft is deleted, a confirmed order is cancelled, then CAS the status to
 * `cancelled`. `retry` = Gelato unreachable (try again), `failed` = Gelato
 * refuses (a human must cancel it). Resumable: the sweep calls it again for
 * every refunded order still `paid`/`submitted`/`in_production`.
 */
export async function processRefundedOrder(
  deps: FulfillmentDeps,
  supabase: SupabaseClient,
  row: { id: string; status: string; gelato_order_id: string | null },
): Promise<RefundOutcome> {
  if (!['paid', 'submitted', 'in_production'].includes(row.status)) return 'nothing';
  let outcome: Awaited<ReturnType<typeof cancelGelatoOrderForRefund>> = 'gone';
  if (row.gelato_order_id) outcome = await cancelGelatoOrderForRefund(deps, row.gelato_order_id);
  if (outcome === 'failed' || outcome === 'retry') return outcome;
  // Whatever the order moved to meanwhile (e.g. shipped) is left alone.
  await supabase
    .from('holiday_card_orders')
    .update({ status: 'cancelled' })
    .eq('id', row.id)
    .eq('status', row.status);
  // A refunded order no longer holds the card (a no-op unless it still held the claim).
  await releaseCardClaim(supabase, row.id);
  return 'cancelled';
}

/**
 * Flags a refunded order whose Gelato side could not be cancelled
 * (`REFUND_NOT_CANCELLED`). Matches an order with no reason yet AND a canary-held
 * one (`HELD_FOR_CANARY`: refunded while held, then Gelato refused the delete),
 * never overwriting any other reason. Returns true when this call set the flag.
 */
export async function flagRefundNotCancelled(supabase: SupabaseClient, orderId: string): Promise<boolean> {
  const { data } = await supabase
    .from('holiday_card_orders')
    .update({ failure_reason: 'REFUND_NOT_CANCELLED' })
    .eq('id', orderId)
    .or(`failure_reason.is.null,failure_reason.eq.${HELD_FOR_CANARY}`)
    .select('id')
    .maybeSingle();
  return Boolean(data);
}

// ── Release artifacts of an order that will not be produced ──────────────

/** Deletes every object under `print-orders/<orderId>/`. Returns the number deleted. Throws on an R2 failure. */
export async function deletePrintFiles(deps: Pick<FulfillmentDeps, 'listKeys' | 'deleteKey'>, orderId: string): Promise<number> {
  const prefix = printOrderPrefix(orderId);
  const keys = await deps.listKeys(prefix);
  let deleted = 0;
  for (const key of keys) {
    // Belt and braces: never delete outside this order's own prefix.
    if (!key.startsWith(prefix)) continue;
    await deps.deleteKey(key);
    deleted += 1;
  }
  return deleted;
}

interface ReleasableRow {
  id: string;
  status: string;
  gelato_order_id: string | null;
  stripe_payment_intent_id: string | null;
  print_files: unknown;
}

/**
 * Clean-up of an UNPAID cancelled order (`cancelled` with no payment intent):
 * delete the Gelato draft (a draft that is already gone is success) and the
 * print files, then null both columns so the sweep does not repeat it. Refuses
 * (returns false) for any row that is not a cancelled, never-paid order: this
 * must never touch the draft of an order somebody paid for. Returns true when
 * everything that existed is gone; false means "try again later".
 */
export async function releaseUnpaidArtifacts(deps: FulfillmentDeps, supabase: SupabaseClient, orderId: string): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, gelato_order_id, stripe_payment_intent_id, print_files')
    .eq('id', orderId)
    .maybeSingle<ReleasableRow>();
  if (error || !row) return false;
  if (row.status !== 'cancelled' || row.stripe_payment_intent_id) return false;

  try {
    if (row.gelato_order_id) {
      if (!deps.gelatoApiKey) return false;
      await deleteDraft(deps.fetch, deps.gelatoApiKey, row.gelato_order_id);
    }
    await deletePrintFiles(deps, orderId);
  } catch (e) {
    console.error('holiday-card release: clean-up will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return false;
  }
  const { error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({ gelato_order_id: null, print_files: null })
    .eq('id', orderId)
    .eq('status', 'cancelled');
  return !updateError;
}

/**
 * Retention for a finished order (shipped > 30 days, failed, cancelled): delete
 * the print files and null `print_files`. Status-guarded like the above.
 */
export async function releasePrintFiles(
  deps: Pick<FulfillmentDeps, 'listKeys' | 'deleteKey'>,
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status')
    .eq('id', orderId)
    .maybeSingle<{ id: string; status: string }>();
  if (error || !row || !['shipped', 'failed', 'cancelled'].includes(row.status)) return false;
  try {
    await deletePrintFiles(deps, orderId);
  } catch (e) {
    console.error('holiday-card retention: delete will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return false;
  }
  const { error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({ print_files: null })
    .eq('id', orderId)
    .eq('status', row.status);
  return !updateError;
}

/** Cancels a draft or a confirmed Gelato order after a refund: delete while it is still a draft, else cancel. */
export async function cancelGelatoOrderForRefund(
  deps: FulfillmentDeps,
  gelatoOrderId: string,
): Promise<'deleted_draft' | 'cancelled' | 'gone' | 'retry' | 'failed'> {
  if (!deps.gelatoApiKey) return 'retry';
  try {
    const current = await getOrder(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
    if (current.isDraft) {
      const { deleted } = await deleteDraft(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
      return deleted ? 'deleted_draft' : 'gone';
    }
    await cancelOrder(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
    return 'cancelled';
  } catch (e) {
    const failure = classifyGelatoError(e);
    if (failure.kind === 'missing') return 'gone';
    return failure.kind === 'retry' ? 'retry' : 'failed';
  }
}
