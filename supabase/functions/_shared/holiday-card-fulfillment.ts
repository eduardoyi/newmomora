/**
 * Shared fulfillment steps for holiday-card orders (docs/plans/
 * holiday-cards-p1.md Step 6), used by `stripe-webhook` (right after payment),
 * `sweep-holiday-card-orders` (the fallback and the clean-up) and
 * `holiday-card-orders` (cancel):
 *
 *   - `confirmPaidOrder`: the whole post-payment pipeline, PAY FIRST like the
 *     Memory Book (nothing is rendered or created before the customer pays).
 *     Every step is idempotent and resumable from the order row, so the webhook
 *     (right after payment) and the sweep (fallback) can both run it:
 *       (a) render the print PDFs (content-addressed prefix; existing intact files for
 *           this snapshot hash and the ORDER's frozen layout are reused; the order's
 *           frozen product_uid/file_layout/format/currency are used, never the catalogue);
 *       (b) create the Gelato DRAFT (an existing `gelato_order_id` is reused; one Gelato
 *           lost is forgotten and rebuilt);
 *       (c) held canary: a listed family's order stops here (files + draft exist
 *           for inspection), fail-closed;
 *       (d) ask Stripe whether the payment was already refunded (a partial refund holds
 *           the order until the owner sets `failure_reason = 'PARTIAL_REFUND_OK'`);
 *       (e) CAS re-check (still paid, not refunded, unflagged), then PATCH the draft
 *           into an order if Gelato still reports a draft, then CAS `paid -> submitted`
 *           (only the CAS winner emails).
 *     A transient problem -- and ANY exception that is not a render 422 or a
 *     non-retryable Gelato API error -- is `retry` (the sweep retries; alert at 30 min,
 *     `failed` at 6 h, measured from `print_files.pipelineStartedAt`); a content
 *     problem (render 422, Gelato refusing the draft) marks the order `failed` and
 *     alerts the owner -- like the book, NO automatic refund: the owner refunds or
 *     fixes it by hand.
 *   - `releaseUnpaidArtifacts` / `releasePrintFiles` / `repurgePrintFiles`: delete the
 *     Gelato draft and the rendered print files of an order that will never be
 *     produced. `print_files` becomes a `{ purgedAt }` marker (not null); the prefix
 *     is purged once more >= 1 h later because a render still running can write after
 *     the first purge.
 *   - the `print_files` column's shape (a transient checkout claim, then the
 *     rendered files and the Stripe session expiry of the attempt).
 *   - `releaseCardClaim`: clears the card-level checkout claim
 *     (`release_holiday_card_checkout`) when an order leaves `checkout`.
 *
 * Privacy: ids, statuses and codes only. Never an address, a name, letter text
 * or a secret in a log, an error or an alert.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { cancelOrder, confirmOrder, createDraft, deleteDraft, GelatoApiError, type GelatoAddress, getOrder } from './gelato.ts';
import { alertCardOwner, lookupBuyerEmail, type SendEmail, sendCardOrderConfirmationEmail } from './holiday-card-order-notify.ts';
import { gelatoFilesFor } from './holiday-card-products.ts';
import { parseFrozenSnapshot } from './holiday-card-snapshot.ts';
import { renderCard, RenderCardContentError } from './render-card-client.ts';
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
  /** First time the post-payment pipeline ran for this order: the STABLE start of the alert (30 min) / fail (6 h) clock (writes bump `updated_at`). */
  pipelineStartedAt?: string;
  /** Last pipeline attempt: the sweep rotates its confirm pass by it (oldest attempt first, never-tried first). */
  pipelineAttemptAt?: string;
  /** Set right before the Gelato PATCH by the CAS that re-checks the order (paid, no flag, not refunded). */
  confirmingAt?: string;
  /** The owner acknowledged a partial refund (`failure_reason = 'PARTIAL_REFUND_OK'`): the partial-refund check is not repeated. */
  partialRefundAckAt?: string;
  /** Print files + draft were released at this time (the order will never print). The prefix is purged once more >= 1 h later. */
  purgedAt?: string;
  repurgedAt?: string;
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
  for (const key of ['sessionExpiresAt', 'pipelineStartedAt', 'pipelineAttemptAt', 'confirmingAt', 'partialRefundAckAt', 'purgedAt', 'repurgedAt'] as const) {
    if (typeof raw[key] === 'string') out[key] = raw[key] as string;
  }
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

/** What the post-payment print pipeline needs beyond Gelato and Stripe: the render service and R2. */
export interface PrintPipelineDeps {
  renderUrl: string;
  renderSecret: string;
  /** R2: presigned GET urls (`_shared/r2.ts#createPresignedGetUrls`). */
  createPresignedGetUrls: (keys: string[], expiresIn?: number) => Promise<Record<string, string>>;
  /** R2 HEAD: the rendered files are checked against what the render service reported. */
  headObject: (key: string) => Promise<{ contentLength: number | null } | null>;
  /** Render request timeout (the sweep uses a shorter one than the webhook so a tick stays inside the function's time limit). */
  renderTimeoutMs?: number;
}

/** The render service settings (`MEMORY_BOOK_RENDER_WORKER_URL` + HMAC secret, shared with the book) plus R2; null when not configured. */
export function printPipelineFromEnv(
  r2: Pick<PrintPipelineDeps, 'createPresignedGetUrls' | 'headObject'>,
  options: { renderTimeoutMs?: number } = {},
): PrintPipelineDeps | null {
  const renderUrl = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_URL');
  const renderSecret = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET');
  if (!renderUrl || !renderSecret) return null;
  return { renderUrl, renderSecret, createPresignedGetUrls: r2.createPresignedGetUrls, headObject: r2.headObject, renderTimeoutMs: options.renderTimeoutMs };
}

export interface FulfillmentDeps {
  /** Clock (ms) for the pipeline's stamps; default `Date.now` (the sweep passes its own, tests a fake). */
  now?: () => number;
  /** Render service + R2 (null/absent: an order that still needs files or a draft is retried, never confirmed). */
  pipeline?: PrintPipelineDeps | null;
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
  // Anything else (our own bug, a presign/config problem, a TypeError) is never a refusal by Gelato:
  // retry (the 30-minute alert surfaces a stuck order), never fail a paid order for it.
  return { kind: 'retry' };
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
  print_files: unknown;
}

/** `failure_reason` the owner sets to release a partially refunded order that was held (`PARTIAL_REFUND_BEFORE_CONFIRM`). */
export const PARTIAL_REFUND_OK = 'PARTIAL_REFUND_OK';

/**
 * Stamps a pipeline attempt on a paid order (`print_files.pipelineAttemptAt`, the sweep's rotation key;
 * `pipelineStartedAt` once, the stable start of the alert/fail clock). Best effort.
 */
export async function markPipelineAttempt(supabase: SupabaseClient, orderId: string, state: PrintFilesState, nowMs: number = Date.now()): Promise<void> {
  const now = new Date(nowMs).toISOString();
  try {
    await supabase
      .from('holiday_card_orders')
      .update({ print_files: { ...state, pipelineStartedAt: state.pipelineStartedAt ?? now, pipelineAttemptAt: now } })
      .eq('id', orderId)
      .eq('status', 'paid');
  } catch {
    console.error('holiday-card could not stamp the pipeline attempt', orderId);
  }
}

/** CAS `paid -> failed` with a reason + owner alert. Returns true when this call flipped it. */
export async function failPaidOrder(
  deps: FulfillmentDeps,
  supabase: SupabaseClient,
  orderId: string,
  reason: string,
  detail = 'Payment captured but the order could not be confirmed at Gelato. Manual fix or refund required.',
): Promise<boolean> {
  const { data, error } = await supabase
    .from('holiday_card_orders')
    .update({ status: 'failed', failure_reason: reason })
    .eq('id', orderId)
    .eq('status', 'paid')
    // A refunded order is the refund path's (cancelled), never `failed`.
    .is('refunded_at', null)
    .select('id')
    .maybeSingle();
  if (error || !data) return false;
  await alertCardOwner(deps.sendEmail, orderId, reason, detail);
  return true;
}

// ── Print preparation (after payment) ────────────────────────────────────

const PRINT_FILE_URL_TTL_SECONDS = 7 * 24 * 3600;
/** The render service downloads the pictures right away. */
const ASSET_URL_TTL_SECONDS = 15 * 60;

/** Rendered sides that make a complete set for a layout. */
export function filesMatchLayout(files: PrintFileRecord[], layout: string): boolean {
  const sides = files.map((f) => f.side).sort().join(',');
  return layout === 'two_files' ? sides === 'back,front' : sides === 'both';
}

interface ShippingAddressLike {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
}

export function gelatoAddress(address: ShippingAddressLike, email: string): GelatoAddress {
  const parts = address.name.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.length === 1 ? '.' : parts.slice(1).join(' ');
  return {
    firstName,
    lastName,
    addressLine1: address.line1,
    addressLine2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    postCode: address.postalCode,
    country: address.countryCode,
    email,
  };
}

type PrepareResult = { ok: true; gelatoOrderId: string } | { ok: false; outcome: ConfirmOutcome };

interface PrepareRow {
  id: string;
  family_id: string;
  requested_by: string | null;
  status: string;
  region: string | null;
  product_uid: string | null;
  file_layout: string | null;
  format: string | null;
  currency: string | null;
  packs: number | null;
  shipping_address: ShippingAddressLike | null;
  card_snapshot: unknown;
  snapshot_hash: string | null;
  print_files: unknown;
  gelato_order_id: string | null;
}

/** What the owner is told when a render refuses the card after payment (the photo can be deleted after the customer paid). */
function renderRefusedDetail(code: string): string {
  return code === 'IMAGE_MISSING'
    ? 'Payment captured but a photo on the card was deleted after payment (IMAGE_MISSING): refund the buyer, or restore/re-pick the photo and rebuild the order by hand. There is no automatic refund.'
    : `Payment captured but the renderer refused the card (${code}). Refund the buyer or fix the card by hand. There is no automatic refund.`;
}

/**
 * Steps (a) + (b) of the pipeline for a PAID order: the print files and the Gelato
 * DRAFT. Resumable from the row: an existing `gelato_order_id` is trusted (the
 * confirm step verifies it is still a draft, and rebuilds it if Gelato lost it);
 * existing rendered files for this snapshot hash that fit the order's frozen
 * layout and are intact in R2 are reused. The product (uid, layout, format,
 * currency) is the ORDER's frozen quote, never today's catalogue.
 * No lock: concurrent runs (webhook + sweep) render the same content-addressed
 * files and race on a CAS (`gelato_order_id is null`); the loser deletes its own draft.
 * Retry = transient (render/Gelato/R2 unavailable, our own bugs); only a render
 * content refusal (422), a NON-retryable Gelato API refusal of the draft, or an
 * unusable row fails the order.
 */
async function preparePrintOrder(deps: FulfillmentDeps, supabase: SupabaseClient, orderId: string): Promise<PrepareResult> {
  const { data: row, error } = await supabase
    .from('holiday_card_orders')
    .select('id, family_id, requested_by, status, region, product_uid, file_layout, format, currency, packs, shipping_address, card_snapshot, snapshot_hash, print_files, gelato_order_id')
    .eq('id', orderId)
    .maybeSingle<PrepareRow>();
  if (error || !row) return { ok: false, outcome: 'retry' };
  if (row.status !== 'paid') return { ok: false, outcome: 'not_paid' };
  if (row.gelato_order_id) return { ok: true, gelatoOrderId: row.gelato_order_id };

  const fail = async (reason: string, detail: string): Promise<PrepareResult> => ({
    ok: false,
    outcome: (await failPaidOrder(deps, supabase, orderId, reason, detail)) ? 'failed' : 'already_advanced',
  });
  const incomplete = 'Payment captured but the order row is incomplete (snapshot, address or product missing). Refund or fix manually (no automatic refund).';

  const pipeline = deps.pipeline;
  if (!pipeline || !deps.gelatoApiKey) {
    console.error('holiday-card prepare: render service / R2 / Gelato is not configured, will retry', orderId);
    return { ok: false, outcome: 'retry' };
  }
  const snapshot = parseFrozenSnapshot(row.card_snapshot);
  const hash = row.snapshot_hash;
  const fileLayout = row.file_layout === 'two_files' || row.file_layout === 'one_pdf' ? row.file_layout : null;
  const format = row.format === '5R' || row.format === 'A5' ? row.format : null;
  const currency = row.currency === 'USD' || row.currency === 'EUR' ? row.currency : null;
  if (
    !row.product_uid || !fileLayout || !format || !currency || !row.shipping_address || !row.packs || !snapshot || !hash ||
    !/^[0-9a-f]{16,64}$/.test(hash)
  ) {
    return fail('PRINT_PREPARE_ORDER_INCOMPLETE', incomplete);
  }
  const state = parsePrintFiles(row.print_files);

  // (a) files
  const filesIntact = async (candidate: PrintFileRecord[]): Promise<boolean> => {
    try {
      for (const file of candidate) {
        const head = await pipeline.headObject(file.key);
        if (!head || head.contentLength !== file.bytes) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  let files: PrintFileRecord[];
  if (state.snapshotHash === hash && state.files && state.files.length > 0 && filesMatchLayout(state.files, fileLayout) && await filesIntact(state.files)) {
    files = state.files;
  } else {
    try {
      const urlsByKey = await pipeline.createPresignedGetUrls(snapshot.assets.map((asset) => asset.key), ASSET_URL_TTL_SECONDS);
      const assets: Record<string, string> = {};
      for (const asset of snapshot.assets) {
        const url = urlsByKey[asset.key];
        if (!url) throw new Error('missing presigned url');
        assets[asset.file] = url;
      }
      const result = await renderCard(deps.fetch, pipeline.renderUrl, pipeline.renderSecret, {
        orderId,
        mode: 'render',
        format,
        fileLayout,
        card: snapshot.card,
        edits: snapshot.edits,
        assets,
        outputPrefix: printFilesPrefix(orderId, hash),
      }, pipeline.renderTimeoutMs);
      const sides = new Set(result.files.map((f) => f.side));
      const complete = fileLayout === 'two_files' ? sides.has('front') && sides.has('back') : sides.has('both');
      if (!complete || !(await filesIntact(result.files))) {
        console.error('holiday-card prepare: render output incomplete or missing from storage, will retry', orderId);
        return { ok: false, outcome: 'retry' };
      }
      files = result.files;
    } catch (e) {
      if (e instanceof RenderCardContentError) {
        console.error('holiday-card prepare: render refused the card', orderId, e.code);
        return fail(`RENDER_REFUSED:${e.code}`, renderRefusedDetail(e.code));
      }
      console.error('holiday-card prepare: render unavailable, will retry', orderId, e instanceof Error ? e.name : 'unknown');
      return { ok: false, outcome: 'retry' };
    }
    // Files of an older snapshot / layout are no longer referenced.
    for (const old of state.files ?? []) {
      if (!files.some((f) => f.key === old.key)) await deps.deleteKey(old.key).catch(() => undefined);
    }
    // Re-read: another run (or the attempt stamp) may have written print_files meanwhile.
    const { data: latest } = await supabase.from('holiday_card_orders').select('id, print_files').eq('id', orderId).maybeSingle<{ id: string; print_files: unknown }>();
    const next: PrintFilesState = { ...parsePrintFiles(latest?.print_files ?? row.print_files), files, snapshotHash: hash, renderedAt: new Date((deps.now ?? Date.now)()).toISOString() };
    const { data: saved, error: saveError } = await supabase
      .from('holiday_card_orders')
      .update({ print_files: next })
      .eq('id', orderId)
      .eq('status', 'paid')
      .select('id')
      .maybeSingle();
    if (saveError || !saved) return { ok: false, outcome: saveError ? 'retry' : 'already_advanced' };
  }

  // (b) the draft
  const email = await lookupBuyerEmail(supabase, row.requested_by);
  if (!email) {
    console.error('holiday-card prepare: buyer email unavailable, will retry', orderId);
    return { ok: false, outcome: 'retry' };
  }
  /** The draft another run recorded meanwhile, if any. */
  const recordedDraft = async (): Promise<string | null> => {
    const { data } = await supabase.from('holiday_card_orders').select('id, status, gelato_order_id').eq('id', orderId).maybeSingle<{ id: string; status: string; gelato_order_id: string | null }>();
    return data?.status === 'paid' ? data.gelato_order_id : null;
  };
  let draftId: string;
  try {
    const urls = await pipeline.createPresignedGetUrls(files.map((f) => f.key), PRINT_FILE_URL_TTL_SECONDS);
    const urlFor = (side: PrintFileRecord['side']) => {
      const file = files.find((f) => f.side === side);
      return file ? urls[file.key] : undefined;
    };
    const draft = await createDraft(deps.fetch, deps.gelatoApiKey, {
      orderReferenceId: orderId,
      customerReferenceId: row.family_id,
      currency,
      items: [{
        itemReferenceId: 'cards',
        productUid: row.product_uid,
        quantity: row.packs,
        files: gelatoFilesFor(fileLayout, { frontUrl: urlFor('front'), backUrl: urlFor('back'), pdfUrl: urlFor('both') }),
      }],
      shippingAddress: gelatoAddress(row.shipping_address, email),
    });
    draftId = draft.id;
  } catch (e) {
    // Only Gelato's own non-retryable refusal is a rejection of the order. Anything else
    // (presign/config problems, our own input bugs, a transport error) is retried.
    if (e instanceof GelatoApiError && !e.retryable && e.status !== 404) {
      // Another run may have created and recorded a draft while this one was refused: use it.
      const other = await recordedDraft();
      if (other) return { ok: true, gelatoOrderId: other };
      const code = (e.code ?? `http_${e.status}`).replace(SAFE_CODE, '').slice(0, 40) || 'unknown';
      console.error('holiday-card prepare: Gelato refused the draft', orderId, code);
      return fail(`GELATO_DRAFT_REJECTED:${code}`, 'Payment captured but Gelato refused the draft order. Refund or fix manually (no automatic refund).');
    }
    console.error('holiday-card prepare: Gelato draft unavailable, will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return { ok: false, outcome: 'retry' };
  }
  const { data: persisted, error: persistError } = await supabase
    .from('holiday_card_orders')
    .update({ gelato_order_id: draftId, gelato_status: 'draft' })
    .eq('id', orderId)
    .eq('status', 'paid')
    .is('gelato_order_id', null)
    .select('id')
    .maybeSingle();
  if (persistError || !persisted) {
    // Lost a race (another run recorded its draft), the order moved on, or the write failed
    // (it may even have landed): delete OUR draft only if the row does not reference it.
    const { data: current } = await supabase.from('holiday_card_orders').select('id, status, gelato_order_id').eq('id', orderId).maybeSingle<{ id: string; status: string; gelato_order_id: string | null }>();
    if (current?.gelato_order_id === draftId) return { ok: true, gelatoOrderId: draftId };
    if (current) await deleteDraft(deps.fetch, deps.gelatoApiKey, draftId).catch(() => undefined);
    if (persistError || !current) return { ok: false, outcome: 'retry' };
    if (current.status === 'paid' && current.gelato_order_id) return { ok: true, gelatoOrderId: current.gelato_order_id };
    return { ok: false, outcome: current.status === 'paid' ? 'retry' : 'already_advanced' };
  }
  return { ok: true, gelatoOrderId: draftId };
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
    .select('id, family_id, status, gelato_order_id, requested_by, packs, refunded_at, failure_reason, stripe_payment_intent_id, print_files')
    .eq('id', orderId)
    .maybeSingle<PaidOrderRow>();
  if (error || !order) return 'retry';
  if (order.status !== 'paid') return 'not_paid';
  // `PARTIAL_REFUND_OK` is the owner's acknowledgment of a partial refund: it is the one flag that lets the order proceed.
  if (order.refunded_at || (order.failure_reason && order.failure_reason !== PARTIAL_REFUND_OK)) return 'blocked';
  const partialRefundAcknowledged = order.failure_reason === PARTIAL_REFUND_OK || Boolean(parsePrintFiles(order.print_files).partialRefundAckAt);

  if (!order.family_id) return 'retry';
  if (!deps.gelatoApiKey) {
    console.error('holiday-card confirm: GELATO_API_KEY is not configured', orderId);
    return 'retry';
  }
  if (!deps.stripeSecretKey || !order.stripe_payment_intent_id) {
    console.error('holiday-card confirm: cannot verify the payment (no Stripe key or payment intent), will retry', orderId);
    return 'retry';
  }

  // Stamp this attempt (the sweep rotates by it; the first stamp starts the stable alert/fail clock).
  await markPipelineAttempt(supabase, orderId, parsePrintFiles(order.print_files), (deps.now ?? Date.now)());

  // (a) print files + (b) the Gelato draft (pay first: nothing exists before payment).
  const prepared = await preparePrintOrder(deps, supabase, orderId);
  if (!prepared.ok) return prepared.outcome;
  const gelatoOrderId = prepared.gelatoOrderId;

  // (c) Held canary (docs/plans/holiday-cards-p2.md Step 2): a paid order of a listed
  // family is NEVER confirmed at Gelato. It runs once the files and the draft exist
  // (so the owner can inspect them) and before any confirm, and it fails closed: a
  // settings read error (or an answer that is not a boolean) is a `retry`.
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

  // (d) Out-of-order refund check.
  let ackedPartial = partialRefundAcknowledged;
  try {
    const payment = await retrievePaymentIntent(deps.fetch, deps.stripeSecretKey, order.stripe_payment_intent_id);
    if (payment.amountRefunded > 0) {
      const full = payment.amount === null || payment.amountRefunded >= payment.amount;
      if (!full && partialRefundAcknowledged) {
        // The owner said OK (failure_reason = PARTIAL_REFUND_OK): proceed; the marker is cleared by the CAS below.
        ackedPartial = true;
      } else if (!full) {
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
          await alertCardOwner(deps.sendEmail, orderId, 'PARTIAL_REFUND_BEFORE_CONFIRM', 'A paid order was partially refunded before it was sent to print. It is held. To print it anyway set failure_reason to PARTIAL_REFUND_OK (the next sweep tick prints it); otherwise refund it fully.');
        }
        return 'blocked';
      }
      if (full) {
        await supabase
          .from('holiday_card_orders')
          .update({ refunded_at: new Date().toISOString() })
          .eq('id', orderId)
          .is('refunded_at', null);
        const outcome = await processRefundedOrder(deps, supabase, { id: orderId, status: 'paid', gelato_order_id: gelatoOrderId });
        await alertCardOwner(
          deps.sendEmail,
          orderId,
          'REFUNDED_BEFORE_CONFIRM',
          outcome === 'cancelled' ? 'A paid order was refunded before it was sent to print; it was cancelled and never produced.' : 'A paid order was refunded before it was sent to print but its Gelato draft could not be removed yet; the sweep keeps retrying.',
        );
        return 'blocked';
      }
    }
  } catch (e) {
    console.error('holiday-card confirm: payment check failed, will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return 'retry';
  }

  // (e) Minutes can pass between the first read and here (render, draft, Stripe): CAS-re-check the
  // order RIGHT before the PATCH. It must still be paid, not refunded, and carry no flag (except the
  // owner's PARTIAL_REFUND_OK, which this CAS consumes: the acknowledgment lives on in print_files).
  {
    const { data: latest } = await supabase.from('holiday_card_orders').select('id, print_files').eq('id', orderId).maybeSingle<{ id: string; print_files: unknown }>();
    const stamp = new Date((deps.now ?? Date.now)()).toISOString();
    const confirmState: PrintFilesState = { ...parsePrintFiles(latest?.print_files ?? order.print_files), confirmingAt: stamp };
    if (ackedPartial && !confirmState.partialRefundAckAt) confirmState.partialRefundAckAt = stamp;
    const { data: cleared, error: confirmCasError } = await supabase
      .from('holiday_card_orders')
      .update({ print_files: confirmState, failure_reason: null })
      .eq('id', orderId)
      .eq('status', 'paid')
      .is('refunded_at', null)
      .or(`failure_reason.is.null,failure_reason.eq.${PARTIAL_REFUND_OK}`)
      .select('id')
      .maybeSingle();
    if (confirmCasError) {
      console.error('holiday-card confirm: pre-confirm CAS failed, will retry', orderId);
      return 'retry';
    }
    if (!cleared) return 'blocked';
  }

  let gelatoStatus: string | null;
  try {
    const current = await getOrder(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
    if (current.isDraft) {
      try {
        const confirmed = await confirmOrder(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
        gelatoStatus = confirmed.rawFulfillmentStatus ?? confirmed.fulfillmentStatus;
      } catch (patchError) {
        // A concurrent confirm (webhook vs sweep) can make OUR patch fail after the other one won:
        // look again, and treat "no longer a draft" as success.
        if (classifyGelatoError(patchError).kind !== 'rejected') throw patchError;
        const again = await getOrder(deps.fetch, deps.gelatoApiKey, gelatoOrderId);
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
    if (failure.kind === 'missing') {
      // Gelato lost the draft: forget it (only if the row still holds THAT id) and let the pipeline rebuild it.
      console.error('holiday-card confirm: the recorded Gelato draft is gone, it will be rebuilt', orderId);
      await supabase
        .from('holiday_card_orders')
        .update({ gelato_order_id: null, gelato_status: null })
        .eq('id', orderId)
        .eq('status', 'paid')
        .eq('gelato_order_id', gelatoOrderId);
      return 'retry';
    }
    return (await failPaidOrder(deps, supabase, orderId, `GELATO_CONFIRM_REJECTED:${failure.code}`)) ? 'failed' : 'already_advanced';
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
  // Already released (the marker stays so the prefix can be purged once more later): nothing to do.
  if (!row.gelato_order_id && parsePrintFiles(row.print_files).purgedAt) return true;

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
  // A marker, not null: a render that was still running can write files AFTER this purge,
  // so the prefix is purged once more >= 1 h later (`repurgePrintFiles`).
  const { error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({ gelato_order_id: null, print_files: { purgedAt: new Date((deps.now ?? Date.now)()).toISOString() } })
    .eq('id', orderId)
    .eq('status', 'cancelled');
  return !updateError;
}

/**
 * Retention for a finished order (shipped > 30 days, failed, cancelled): delete
 * the print files and null `print_files`. Status-guarded like the above.
 */
export async function releasePrintFiles(
  deps: Pick<FulfillmentDeps, 'listKeys' | 'deleteKey' | 'now'>,
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, print_files')
    .eq('id', orderId)
    .maybeSingle<{ id: string; status: string; print_files: unknown }>();
  if (error || !row || !['shipped', 'failed', 'cancelled'].includes(row.status)) return false;
  if (parsePrintFiles(row.print_files).purgedAt) return true; // already released
  try {
    await deletePrintFiles(deps, orderId);
  } catch (e) {
    console.error('holiday-card retention: delete will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return false;
  }
  const { error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({ print_files: { purgedAt: new Date((deps.now ?? Date.now)()).toISOString() } })
    .eq('id', orderId)
    .eq('status', row.status);
  return !updateError;
}

/** How long after the first purge the prefix is listed and deleted once more. */
export const REPURGE_AFTER_MS = 60 * 60_000;

/**
 * Second purge of an order that will never print (cancelled / failed): a render that was still running
 * when the first purge happened can write its PDFs afterwards. >= 1 h after `purgedAt`, delete whatever
 * is under `print-orders/<orderId>/` again and mark `repurgedAt`. Returns true when it did the purge.
 */
export async function repurgePrintFiles(
  deps: Pick<FulfillmentDeps, 'listKeys' | 'deleteKey'>,
  supabase: SupabaseClient,
  orderId: string,
  nowMs: number,
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('holiday_card_orders')
    .select('id, status, print_files')
    .eq('id', orderId)
    .maybeSingle<{ id: string; status: string; print_files: unknown }>();
  if (error || !row || !['failed', 'cancelled'].includes(row.status)) return false;
  const state = parsePrintFiles(row.print_files);
  const purgedAt = state.purgedAt ? Date.parse(state.purgedAt) : NaN;
  if (!Number.isFinite(purgedAt) || state.repurgedAt || nowMs - purgedAt < REPURGE_AFTER_MS) return false;
  try {
    await deletePrintFiles(deps, orderId);
  } catch (e) {
    console.error('holiday-card re-purge will retry', orderId, e instanceof Error ? e.name : 'unknown');
    return false;
  }
  const { error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({ print_files: { ...state, repurgedAt: new Date(nowMs).toISOString() } })
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
