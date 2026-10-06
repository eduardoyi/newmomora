/**
 * Holiday card order surface (docs/plans/holiday-cards-p1.md §2/§4/Step 6).
 * One function, JWT auth, owner/manager of the card's family, buyer-only orders
 * (same shape and conventions as `memory-book-orders`). Ops:
 *
 *   create_draft     { cardId }                       -> insert a bare draft order
 *   quote            { orderId, address, packs }      -> Gelato quote + our fixed price, CAS draft|quoted -> quoted
 *   create_checkout  { orderId, expectedEditsVersion } -> claim the card, freeze the snapshot, render print files, create
 *                                                        the Gelato DRAFT, create the Stripe Checkout Session, CAS quoted -> checkout
 *   cancel_checkout  { orderId }                      -> expire the open session, cancel, delete draft + files
 *   status           { orderId }                      -> the buyer's view of the order
 *
 * Money path, in order (nothing is rendered or created AFTER payment except one
 * idempotent PATCH, done by `stripe-webhook` / the sweep):
 *   quote -> checkout (render + Gelato draft + Stripe session) -> paid (webhook)
 *   -> Gelato PATCH draft -> submitted -> in_production -> shipped (sweep).
 *
 * Ordering kill switch: create_draft, quote and create_checkout answer 403
 * HOLIDAY_CARD_ORDERS_PAUSED while `holiday_card_settings.orders_enabled` is false
 * (500 if the setting cannot be read: fail closed).
 *
 * Idempotency of `create_checkout` (all inside `status = 'quoted'`, so a retry
 * after any crash resumes instead of duplicating):
 *   - a transient claim in `print_files.claim` (taken by an optimistic
 *     `updated_at` compare-and-set) stops a double tap on the same order from
 *     running twice; the CARD-level claim (`claim_holiday_card_checkout`) is the
 *     lock across orders (version pin, one open checkout per card, edit lock) and
 *     is held while the order is in `checkout`;
 *   - the frozen snapshot + hash and the rendered files are persisted before
 *     the Gelato draft is created; an existing draft id is verified and reused,
 *     never duplicated;
 *   - Stripe customer and session are created with idempotency keys derived
 *     from (order, snapshot hash, price, packs, address, session expiry), so a
 *     retry of the same attempt sends an identical request and returns the same
 *     session;
 *   - a card that was already ordered reprints the first paid order's frozen
 *     snapshot (reorders), never live data;
 *   - an order already in `checkout` returns its still-open session.
 *
 * Privacy: ids, statuses and codes only in logs and errors. Addresses, names,
 * letter text, Stripe/Gelato secrets are never logged or returned in errors.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { checkBillingFamilyWrite } from '../_shared/billing.ts';
import { sendTransactionalEmailWithOutcome } from '../_shared/bento.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { createDraft, deleteDraft, GelatoApiError, type GelatoAddress, getOrder, quoteOrder } from '../_shared/gelato.ts';
import {
  CARD_PRODUCTS,
  CARDS_PER_PACK,
  evaluateQuote,
  gelatoFilesFor,
  HOLIDAY_CARD_PRODUCT_NAME,
  HOLIDAY_CARD_TAX_CODE,
  isValidPacks,
  priceCents,
  regionForCountry,
  type CardProduct,
  type CardRegion,
} from '../_shared/holiday-card-products.ts';
import {
  deletePrintFiles,
  type FulfillmentDeps,
  isFreshClaim,
  parsePrintFiles,
  printFilesPrefix,
  type PrintFileRecord,
  type PrintFilesState,
  printOrderPrefix,
  releaseCardClaim,
  releaseUnpaidArtifacts,
} from '../_shared/holiday-card-fulfillment.ts';
import { canonicalJson, type FrozenCardSnapshot, snapshotHash } from '../_shared/holiday-card-snapshot.ts';
import {
  cardUnchangedForPrint,
  CardLoadError,
  checkFilmGate,
  HOLIDAY_CARD_COLUMNS,
  type HolidayCardRow,
  loadCardSnapshot,
  loadOrderedSnapshot,
  type OrderedSnapshot,
  type SnapshotLoaderDeps,
} from '../_shared/holiday-card-snapshot-loader.ts';
import { createPresignedGetUrls, deleteObject, headObject, listObjectKeys } from '../_shared/r2.ts';
import {
  renderCard,
  RenderCardContentError,
  RenderCardUnavailableError,
} from '../_shared/render-card-client.ts';
import {
  createGenericCheckoutSession,
  createStripeCustomer,
  expireCheckoutSession,
  retrieveCheckoutSession,
  StripeApiError,
} from '../_shared/stripe.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';
import { serveWithSentry } from '../_shared/sentry.ts';

// ── Shapes ───────────────────────────────────────────────────────────────

export interface CardShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
}

export type HolidayCardOrdersRequestBody =
  | { op: 'create_draft'; cardId: string }
  | { op: 'quote'; orderId: string; address: unknown; packs: unknown }
  | { op: 'create_checkout'; orderId: string; expectedEditsVersion: number }
  | { op: 'cancel_checkout'; orderId: string }
  | { op: 'status'; orderId: string };

export interface HolidayCardOrdersDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  checkBillingFamilyWrite: typeof checkBillingFamilyWrite;
  fetch: typeof fetch;
  now: () => number;
  createPresignedGetUrls: typeof createPresignedGetUrls;
  imageSize?: SnapshotLoaderDeps['imageSize'];
  listKeys: (prefix: string) => Promise<string[]>;
  deleteKey: (key: string) => Promise<void>;
  /** R2 HEAD: the rendered print files are checked against what the render service reported. */
  headObject: (key: string) => Promise<{ contentLength: number | null } | null>;
  sendEmail: typeof sendTransactionalEmailWithOutcome;
}

export const DEFAULT_DEPENDENCIES: HolidayCardOrdersDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  getCallerFamilyRole,
  checkBillingFamilyWrite,
  // Every upstream call (Gelato, Stripe, R2 probes) rides this fetch: a hung
  // upstream must fail loud (a clean 502), never hang the op. The render
  // service passes its own, longer signal (a cold Fly machine).
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }),
  now: () => Date.now(),
  createPresignedGetUrls,
  listKeys: listObjectKeys,
  deleteKey: deleteObject,
  headObject,
  sendEmail: sendTransactionalEmailWithOutcome,
};

const ORDER_COLUMNS =
  'id, card_id, family_id, requested_by, status, region, format, product_uid, file_layout, packs, currency, price_cents, shipping_address, snapshot_hash, gelato_order_id, print_files, stripe_session_id, updated_at';

interface OrderRow {
  id: string;
  card_id: string | null;
  family_id: string;
  requested_by: string | null;
  status: string;
  region: string | null;
  format: string | null;
  product_uid: string | null;
  file_layout: string | null;
  packs: number | null;
  currency: string | null;
  price_cents: number | null;
  shipping_address: CardShippingAddress | null;
  snapshot_hash: string | null;
  gelato_order_id: string | null;
  print_files: unknown;
  stripe_session_id: string | null;
  updated_at: string;
}

/** 7 days: the longest an S3-style presigned URL can live. The Gelato draft's file URLs. */
const PRINT_FILE_URL_TTL_SECONDS = 7 * 24 * 3600;
/** The render service downloads the pictures right away. */
const ASSET_URL_TTL_SECONDS = 15 * 60;

// ── Validation ───────────────────────────────────────────────────────────

const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const US_POSTAL = /^\d{5}(-\d{4})?$/;
const CA_POSTAL = /^([A-Za-z]\d[A-Za-z])[ -]?(\d[A-Za-z]\d)$/;
const REGION_CODE = /^[A-Z]{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !CONTROL_CHAR_PATTERN.test(value);
}

export type AddressValidation =
  | { address: CardShippingAddress }
  | { error: string }
  | { unsupportedCountry: true };

/**
 * Validates and normalises the shipping address. Same field rules as the
 * books' `validateShippingAddress`, but the country list is the card shop's
 * (`regionForCountry`: US and CA), the city and state are required (Gelato needs
 * both for the US and Canada) and the postal code is shape-checked, so a typo is
 * refused BEFORE any money is involved.
 */
export function validateCardShippingAddress(input: unknown): AddressValidation {
  if (!isPlainObject(input)) return { error: 'address is required' };
  if (!isBoundedString(input.name, 200)) return { error: 'address.name is required' };
  if (!isBoundedString(input.line1, 200)) return { error: 'address.line1 is required' };
  if (input.line2 !== undefined && input.line2 !== null && input.line2 !== '' && !isBoundedString(input.line2, 200)) {
    return { error: 'address.line2 is invalid' };
  }
  if (!isBoundedString(input.city, 200)) return { error: 'address.city is required' };
  if (!isBoundedString(input.state, 200)) return { error: 'address.state is required' };
  if (!isBoundedString(input.postalCode, 20)) return { error: 'address.postalCode is required' };
  if (typeof input.countryCode !== 'string') return { error: 'address.countryCode must be a 2-letter ISO code' };
  const countryCode = input.countryCode.trim().toUpperCase();
  if (!COUNTRY_CODE_PATTERN.test(countryCode)) return { error: 'address.countryCode must be a 2-letter ISO code' };
  if (regionForCountry(countryCode) === null) return { unsupportedCountry: true };

  const state = (input.state as string).trim().toUpperCase();
  if (!REGION_CODE.test(state)) return { error: 'address.state must be a 2-letter state or province code' };
  let postalCode = (input.postalCode as string).trim();
  if (countryCode === 'US') {
    if (!US_POSTAL.test(postalCode)) return { error: 'address.postalCode is not a valid US ZIP code' };
  } else {
    const match = CA_POSTAL.exec(postalCode);
    if (!match) return { error: 'address.postalCode is not a valid Canadian postal code' };
    postalCode = `${match[1]} ${match[2]}`.toUpperCase();
  }
  const line2 = typeof input.line2 === 'string' && input.line2.trim() ? input.line2.trim() : undefined;
  return {
    address: {
      name: (input.name as string).trim(),
      line1: (input.line1 as string).trim(),
      ...(line2 ? { line2 } : {}),
      city: (input.city as string).trim(),
      state,
      postalCode,
      countryCode,
    },
  };
}

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '.' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function gelatoAddress(address: CardShippingAddress, email: string): GelatoAddress {
  const { firstName, lastName } = splitName(address.name);
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

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Loading ──────────────────────────────────────────────────────────────

async function loadOwnedOrder(
  supabase: SupabaseClient,
  orderId: unknown,
  callerId: string,
): Promise<{ order: OrderRow } | { response: Response }> {
  if (typeof orderId !== 'string' || !orderId) return { response: errorResponse('orderId is required', 400, 'validation_error') };
  const { data: order, error } = await supabase
    .from('holiday_card_orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .maybeSingle<OrderRow>();
  if (error) {
    console.error('holiday-card-orders order lookup failed', error.message);
    return { response: errorResponse('Failed to load order', 500, 'internal_error') };
  }
  // Same shape whether the id is unknown or belongs to another buyer.
  if (!order || order.requested_by !== callerId) return { response: errorResponse('Order not found', 404, 'ORDER_NOT_FOUND') };
  return { order };
}

/** Role + billing gate for a mutating op on an order or card of `familyId`. */
async function authorizeWrite(
  dependencies: HolidayCardOrdersDependencies,
  supabase: SupabaseClient,
  familyId: string,
  callerId: string,
): Promise<Response | null> {
  const role = await dependencies.getCallerFamilyRole(supabase, familyId, callerId);
  if (!isManagerRole(role)) return errorResponse('Not authorized to order holiday cards for this family', 403, 'forbidden');
  return dependencies.checkBillingFamilyWrite(supabase, familyId, callerId, 'holiday_card_order');
}

async function loadCard(supabase: SupabaseClient, cardId: string | null): Promise<{ card: HolidayCardRow } | { response: Response }> {
  if (!cardId) return { response: errorResponse('Card not found', 404, 'CARD_NOT_FOUND') };
  const { data: card, error } = await supabase
    .from('holiday_cards')
    .select(HOLIDAY_CARD_COLUMNS)
    .eq('id', cardId)
    .maybeSingle<HolidayCardRow>();
  if (error) {
    console.error('holiday-card-orders card lookup failed', error.message);
    return { response: errorResponse('Failed to load card', 500, 'internal_error') };
  }
  if (!card || card.deleted_at) return { response: errorResponse('Card not found', 404, 'CARD_NOT_FOUND') };
  return { card };
}

function requireReadyCard(card: HolidayCardRow): Response | null {
  return card.status === 'ready' ? null : errorResponse('The card is not ready to order yet', 409, 'CARD_NOT_READY');
}

async function familyIsLive(supabase: SupabaseClient, familyId: string): Promise<boolean> {
  const { data } = await supabase.from('families').select('id, deleted_at').eq('id', familyId).maybeSingle<{ id: string; deleted_at: string | null }>();
  return Boolean(data) && !data?.deleted_at;
}

// ── create_draft ─────────────────────────────────────────────────────────

async function handleCreateDraft(
  dependencies: HolidayCardOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  cardId: unknown,
): Promise<Response> {
  if (typeof cardId !== 'string' || !cardId) return errorResponse('cardId is required', 400, 'validation_error');
  const loaded = await loadCard(supabase, cardId);
  if ('response' in loaded) return loaded.response;
  const { card } = loaded;

  const denied = await authorizeWrite(dependencies, supabase, card.family_id, callerId);
  if (denied) return denied;
  const notReady = requireReadyCard(card);
  if (notReady) return notReady;

  // A parent who reopens the shop gets their open draft back instead of a pile of drafts.
  const { data: existing, error: existingError } = await supabase
    .from('holiday_card_orders')
    .select('id, status')
    .eq('card_id', card.id)
    .eq('requested_by', callerId)
    .eq('status', 'draft')
    .limit(1)
    .maybeSingle<{ id: string; status: string }>();
  if (existingError) {
    console.error('holiday-card-orders create_draft lookup failed', existingError.message);
    return errorResponse('Failed to create order draft', 500, 'internal_error');
  }
  if (existing) return jsonResponse({ success: true, orderId: existing.id, status: existing.status });

  const { data: order, error: insertError } = await supabase
    .from('holiday_card_orders')
    .insert({ card_id: card.id, family_id: card.family_id, requested_by: callerId })
    .select('id, status')
    .single();
  if (insertError || !order) {
    console.error('holiday-card-orders create_draft insert failed', insertError?.message ?? 'no row');
    return errorResponse('Failed to create order draft', 500, 'internal_error');
  }
  return jsonResponse({ success: true, orderId: order.id, status: order.status }, 201);
}

// ── quote ────────────────────────────────────────────────────────────────

async function handleQuote(
  dependencies: HolidayCardOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  callerEmail: string | null,
  body: { orderId: string; address: unknown; packs: unknown },
): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const order = owned.order;
  if (order.status !== 'draft' && order.status !== 'quoted') {
    return errorResponse('Order can no longer be quoted', 409, 'ORDER_NOT_QUOTABLE');
  }

  const denied = await authorizeWrite(dependencies, supabase, order.family_id, callerId);
  if (denied) return denied;

  if (!isValidPacks(body.packs)) return errorResponse('packs must be 1, 2, 3, 5 or 10', 400, 'PACKS_INVALID');
  const packs = body.packs;

  const validated = validateCardShippingAddress(body.address);
  if ('unsupportedCountry' in validated) {
    return errorResponse('We only ship holiday cards to the United States and Canada for now', 422, 'COUNTRY_NOT_SUPPORTED');
  }
  if ('error' in validated) return errorResponse(validated.error, 400, 'validation_error');
  const address = validated.address;
  const region = regionForCountry(address.countryCode);
  if (!region) return errorResponse('We only ship holiday cards to the United States and Canada for now', 422, 'COUNTRY_NOT_SUPPORTED');
  const product = CARD_PRODUCTS[region];

  if (!callerEmail) return errorResponse('Account email is required to order', 400, 'EMAIL_REQUIRED');

  // A checkout that is mid-flight owns the row; do not reset it from under it.
  const prior = parsePrintFiles(order.print_files);
  if (order.status === 'quoted' && isFreshClaim(prior, dependencies.now())) {
    return errorResponse('A checkout is already being prepared for this order', 409, 'CHECKOUT_IN_PROGRESS');
  }

  const loaded = await loadCard(supabase, order.card_id);
  if ('response' in loaded) return loaded.response;
  const notReady = requireReadyCard(loaded.card);
  if (notReady) return notReady;

  const gelatoApiKey = Deno.env.get('GELATO_API_KEY');
  if (!gelatoApiKey) {
    console.error('holiday-card-orders quote missing GELATO_API_KEY');
    return errorResponse('Order quoting is not configured', 500, 'internal_error');
  }

  let verdict;
  try {
    const quote = await quoteOrder(dependencies.fetch, gelatoApiKey, {
      orderReferenceId: order.id,
      customerReferenceId: order.family_id,
      currency: product.currency,
      recipient: gelatoAddress(address, callerEmail),
      items: [{ itemReferenceId: 'cards', productUid: product.productUid, quantity: packs }],
    });
    verdict = evaluateQuote(region, packs, quote);
  } catch (error) {
    if (error instanceof GelatoApiError && !error.retryable) {
      console.error('holiday-card-orders quote rejected by Gelato', order.id, error.status, error.code ?? '');
      return errorResponse('We could not get a delivery quote for this address', 422, 'NOT_DELIVERABLE');
    }
    console.error('holiday-card-orders quote Gelato failed', order.id, error instanceof Error ? error.name : 'unknown');
    return errorResponse('Unable to compute the delivery quote', 502, 'GELATO_UNAVAILABLE');
  }
  if (!verdict.ok) {
    console.error('holiday-card-orders quote refused', order.id, verdict.reason);
    if (verdict.reason === 'not_deliverable') return errorResponse('We cannot deliver holiday cards to this address', 422, 'NOT_DELIVERABLE');
    if (verdict.reason === 'over_cost_guard') {
      return errorResponse('We cannot ship this order to this address at the standard price', 422, 'OVER_COST_GUARD');
    }
    return errorResponse('Unable to compute the delivery quote', 502, 'GELATO_UNAVAILABLE');
  }

  // One write: the quote bundle (a CAS on the status we read) and a reset of
  // any checkout progress an earlier attempt left on a re-quoted order.
  const { data: updated, error: updateError } = await supabase
    .from('holiday_card_orders')
    .update({
      status: 'quoted',
      region,
      format: product.format,
      product_uid: product.productUid,
      file_layout: product.fileLayout,
      packs,
      currency: product.currency,
      price_cents: verdict.priceCents,
      gelato_cost_cents: verdict.costCents,
      shipping_address: address,
      card_snapshot: null,
      snapshot_hash: null,
      print_files: null,
      gelato_order_id: null,
      gelato_status: null,
    })
    .eq('id', order.id)
    .eq('status', order.status)
    // Optimistic lock: a create_checkout that claimed the row since we read it changed updated_at.
    .eq('updated_at', order.updated_at)
    .select('id')
    .maybeSingle();
  if (updateError) {
    console.error('holiday-card-orders quote CAS failed', updateError.message);
    return errorResponse('Failed to persist quote', 500, 'internal_error');
  }
  if (!updated) {
    return order.status === 'quoted'
      ? errorResponse('A checkout is already being prepared for this order', 409, 'CHECKOUT_IN_PROGRESS')
      : errorResponse('Order was already quoted', 409, 'ORDER_NOT_QUOTABLE');
  }

  // A re-quote resets the checkout progress: a claim a crashed attempt left behind goes too.
  await releaseCardClaim(supabase, order.id);

  // Best-effort: whatever a previous attempt had created for the OLD quote.
  if (order.gelato_order_id) {
    try {
      await deleteDraft(dependencies.fetch, gelatoApiKey, order.gelato_order_id);
    } catch {
      console.error('holiday-card-orders quote could not delete the previous draft', order.id);
    }
  }
  if (order.print_files) {
    try {
      await deletePrintFiles(dependencies, order.id);
    } catch {
      console.error('holiday-card-orders quote could not delete previous print files', order.id);
    }
  }

  return jsonResponse({
    success: true,
    orderId: order.id,
    status: 'quoted',
    region,
    format: product.format,
    packs,
    cards: packs * CARDS_PER_PACK,
    priceCents: verdict.priceCents,
    currency: product.currency,
  });
}

// ── create_checkout ──────────────────────────────────────────────────────

const LOAD_ERROR_STATUS: Record<string, number> = {
  CARD_NOT_FOUND: 404,
  CARD_DELETED: 404,
  CARD_NOT_READY: 409,
  FAMILY_NOT_FOUND: 409,
  FRONT_PHOTO_UNREADABLE: 422,
  NO_FRONT_PHOTO: 422,
  NO_LETTERS: 422,
  INVALID_CARD: 422,
  LOAD_FAILED: 500,
};

/** Writes the order's print_files without the claim (kept files stay), best effort. */
async function releaseClaim(supabase: SupabaseClient, orderId: string, claimId: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('holiday_card_orders')
      .select('id, status, print_files')
      .eq('id', orderId)
      .maybeSingle<{ id: string; status: string; print_files: unknown }>();
    if (!data || data.status !== 'quoted') return;
    const state = parsePrintFiles(data.print_files);
    if (state.claim?.id !== claimId) return;
    const { claim: _claim, ...rest } = state;
    await supabase
      .from('holiday_card_orders')
      .update({ print_files: Object.keys(rest).length > 0 ? rest : null })
      .eq('id', orderId)
      .eq('status', 'quoted');
  } catch {
    console.error('holiday-card-orders could not release the checkout claim', orderId);
  }
}

async function resumeOpenCheckout(dependencies: HolidayCardOrdersDependencies, order: OrderRow): Promise<Response> {
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeSecretKey || !order.stripe_session_id) {
    return errorResponse('Checkout is not available for this order', 409, 'CHECKOUT_NOT_OPEN');
  }
  try {
    const session = await retrieveCheckoutSession(dependencies.fetch, stripeSecretKey, order.stripe_session_id);
    if (session.status === 'open' && session.url) {
      return jsonResponse({
        success: true,
        orderId: order.id,
        status: 'checkout',
        checkoutUrl: session.url,
        sessionId: session.id,
        resumed: true,
        expiresAt: parsePrintFiles(order.print_files).sessionExpiresAt ?? null,
      });
    }
    if (session.status === 'complete') return errorResponse('This order has already been paid', 409, 'ORDER_ALREADY_PAID');
    return errorResponse('The checkout session is no longer open', 409, 'CHECKOUT_NOT_OPEN');
  } catch (error) {
    console.error('holiday-card-orders create_checkout resume failed', order.id, error instanceof Error ? error.name : 'unknown');
    return errorResponse('Unable to resume checkout', 502, 'STRIPE_UNAVAILABLE');
  }
}

/** Stripe Checkout Session lifetime (Stripe requires 30 minutes to 24 hours; 35 leaves margin). */
export const STRIPE_SESSION_TTL_MS = 35 * 60_000;
/**
 * A retry of the same attempt reuses the persisted session expiry (identical
 * Stripe request -> the same session) only while at least this much of it is
 * left; otherwise it is a NEW attempt with a new expiry, hence a new key.
 */
export const SESSION_REUSE_MIN_LEFT_MS = 10 * 60_000;

/** The `expires_at` (unix seconds + ISO) for this attempt: the persisted one while it still has life, else now + 35 min. */
export function chooseSessionExpiry(
  stored: string | undefined,
  nowMs: number,
): { seconds: number; iso: string; reused: boolean } {
  const storedMs = stored ? Date.parse(stored) : NaN;
  if (Number.isFinite(storedMs) && storedMs - nowMs >= SESSION_REUSE_MIN_LEFT_MS) {
    return { seconds: Math.floor(storedMs / 1000), iso: new Date(Math.floor(storedMs / 1000) * 1000).toISOString(), reused: true };
  }
  const seconds = Math.floor((nowMs + STRIPE_SESSION_TTL_MS) / 1000);
  return { seconds, iso: new Date(seconds * 1000).toISOString(), reused: false };
}

/** The columns `claim_holiday_card_checkout` returns beyond what the loader types. */
type ClaimedCardRow = HolidayCardRow & {
  edits_version: number | null;
  checkout_order_id: string | null;
  checkout_claimed_at: string | null;
};

interface RpcFailure {
  code?: string;
  message?: string;
  hint?: string | null;
}

/** Maps what `claim_holiday_card_checkout` raises (SQLSTATE in `code`, tag in `hint` = message). */
function claimFailureResponse(orderId: string, error: RpcFailure): Response {
  const tag = error.hint || error.message || '';
  if (tag === 'CARD_CHANGED' || error.code === '40001') {
    return errorResponse('The card was changed since you last looked at it; reload it and try again', 409, 'CARD_CHANGED');
  }
  if (tag === 'CHECKOUT_OPEN_ELSEWHERE' || error.code === '55000') {
    return errorResponse('Another checkout is already open for this card', 409, 'CHECKOUT_OPEN_ELSEWHERE');
  }
  if (tag === 'card_not_found' || error.code === 'P0002') return errorResponse('Card not found', 404, 'CARD_NOT_FOUND');
  console.error('holiday-card-orders create_checkout card claim failed', orderId, error.code ?? 'unknown');
  return errorResponse('Failed to start checkout', 500, 'internal_error');
}

/** FILM_BLOCKED / FILM_NOT_READY / QR_LINK_DISABLED copy. */
function gateFailureResponse(code: 'FILM_NOT_READY' | 'FILM_BLOCKED' | 'QR_LINK_DISABLED', reorder: boolean): Response {
  if (code === 'QR_LINK_DISABLED') {
    return errorResponse('The QR link printed on this card was turned off, so it cannot be reprinted as it was', 409, code);
  }
  if (reorder) return errorResponse('The card film is unavailable, so this card cannot be reprinted with its QR code', 409, code);
  const message = code === 'FILM_NOT_READY'
    ? 'The card film is still being made; try again in a moment or switch the QR code off'
    : 'The card film is unavailable; switch the QR code off to order';
  return errorResponse(message, 409, code);
}

/**
 * A reorder prints the FIRST paid order's frozen QR. It is refused (never printed
 * differently) when that QR's link was disabled or replaced, or its film is
 * blocked / gone. Uses `checkFilmGate` with `strict: true` (a blocked or given-up
 * film is a refusal here, not "print without a QR" as for a new order) on the
 * printed token, with the buyer's QR choice taken out of the picture (the frozen
 * card already printed it).
 */
async function checkFrozenQr(
  supabase: SupabaseClient,
  card: HolidayCardRow,
  printedToken: string,
): Promise<'FILM_NOT_READY' | 'FILM_BLOCKED' | 'QR_LINK_DISABLED' | null> {
  if (card.share_token !== printedToken) return 'QR_LINK_DISABLED';
  const gate = await checkFilmGate(supabase, { ...card, edits: {} }, { strict: true });
  if (!gate.ok) return gate.code;
  return gate.shareTokenActive ? null : 'QR_LINK_DISABLED';
}

/** Rendered sides that make a complete set for a layout (a P1 two_files order meets a one_pdf product). */
function filesMatchLayout(files: PrintFileRecord[], layout: string): boolean {
  const sides = files.map((f) => f.side).sort().join(',');
  return layout === 'two_files' ? sides === 'back,front' : sides === 'both';
}

async function cardEditsVersion(supabase: SupabaseClient, cardId: string): Promise<number | null> {
  const { data, error } = await supabase.from('holiday_cards').select('id, edits_version').eq('id', cardId).maybeSingle<{ id: string; edits_version: number | null }>();
  if (error) throw new CardLoadError('LOAD_FAILED');
  return data?.edits_version ?? null;
}

/**
 * `create_checkout`. Two locks, two jobs:
 *   - the ORDER-level `print_files.claim` (an optimistic CAS on `updated_at`) stops a
 *     double tap on the SAME order from running twice, and carries the resumable
 *     progress (rendered files, snapshot hash, session expiry);
 *   - the CARD-level claim (`claim_holiday_card_checkout`) is the exclusion lock
 *     across orders: it checks the version the buyer looked at, allows one open
 *     checkout per card, blocks edits while it is fresh, and returns the re-read
 *     card row the snapshot is built from. The order claim is taken first (a lost
 *     order claim must never release the card claim its winner holds).
 * The card claim stays while the order is in `checkout` and is released when the
 * order leaves it (paid, expired, cancelled, aged, refunded) or an attempt fails.
 */
async function handleCreateCheckout(
  dependencies: HolidayCardOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  callerEmail: string | null,
  body: { orderId: string; expectedEditsVersion?: unknown },
): Promise<Response> {
  const expectedVersion = body.expectedEditsVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return errorResponse('expectedEditsVersion is required', 400, 'validation_error');
  }

  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const order = owned.order;

  const denied = await authorizeWrite(dependencies, supabase, order.family_id, callerId);
  if (denied) return denied;

  if (order.status === 'checkout') return resumeOpenCheckout(dependencies, order);
  if (order.status !== 'quoted') return errorResponse('Order has not been quoted', 409, 'ORDER_NOT_QUOTED');

  const product: CardProduct | null = order.region && order.region in CARD_PRODUCTS ? CARD_PRODUCTS[order.region as CardRegion] : null;
  if (
    !product || order.price_cents === null || order.packs === null || !order.shipping_address || !order.currency ||
    !order.product_uid || !order.file_layout || !order.format
  ) {
    console.error('holiday-card-orders create_checkout order missing quote fields', order.id);
    return errorResponse('Order is missing quote details', 500, 'internal_error');
  }
  // The quote is the price, but a product/price change between quote and
  // checkout must send the buyer back to the quote, never silently charge a
  // different amount.
  if (
    !isValidPacks(order.packs) || priceCents(product.region, order.packs) !== order.price_cents ||
    order.product_uid !== product.productUid || order.currency !== product.currency
  ) {
    return errorResponse('The quote is out of date; please request a new one', 409, 'QUOTE_STALE');
  }
  if (!callerEmail) return errorResponse('Account email is required to check out', 400, 'EMAIL_REQUIRED');

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const checkoutOrigin = Deno.env.get('HOLIDAY_CARD_CHECKOUT_ORIGIN') ?? Deno.env.get('MEMORY_BOOK_CHECKOUT_ORIGIN');
  const gelatoApiKey = Deno.env.get('GELATO_API_KEY');
  const renderUrl = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_URL');
  const renderSecret = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET');
  if (!stripeSecretKey || !checkoutOrigin || !gelatoApiKey || !renderUrl || !renderSecret) {
    console.error('holiday-card-orders create_checkout missing configuration');
    return errorResponse('Checkout is not configured', 500, 'internal_error');
  }

  // The order-level claim: an optimistic compare-and-set on updated_at. Whoever
  // wins runs the render + draft + session; the other gets CHECKOUT_IN_PROGRESS.
  const nowMs = dependencies.now();
  const prior = parsePrintFiles(order.print_files);
  if (isFreshClaim(prior, nowMs)) return errorResponse('Checkout is already being prepared for this order', 409, 'CHECKOUT_IN_PROGRESS');
  const claimId = crypto.randomUUID();
  const claimed: PrintFilesState = { ...prior, claim: { id: claimId, at: new Date(nowMs).toISOString() } };
  const { data: claimRow, error: claimError } = await supabase
    .from('holiday_card_orders')
    // file_layout / format follow the CURRENT product (an order quoted under an older layout is re-pointed).
    .update({ print_files: claimed, file_layout: product.fileLayout, format: product.format })
    .eq('id', order.id)
    .eq('status', 'quoted')
    .eq('updated_at', order.updated_at)
    .select('id, updated_at')
    .maybeSingle<{ id: string; updated_at: string }>();
  if (claimError) {
    console.error('holiday-card-orders create_checkout claim failed', order.id, claimError.message);
    return errorResponse('Failed to start checkout', 500, 'internal_error');
  }
  if (!claimRow) return errorResponse('Checkout is already being prepared for this order', 409, 'CHECKOUT_IN_PROGRESS');
  // What `print_files` holds right now (this call's own writes keep it in step).
  let dbState: PrintFilesState = claimed;

  // Every failure from here on gives both claims back (the order keeps whatever
  // progress it made, so a retry resumes).
  const fail = async (response: Response): Promise<Response> => {
    await releaseClaim(supabase, order.id, claimId);
    await releaseCardClaim(supabase, order.id);
    return response;
  };

  // The card-level claim: version pin + one open checkout per card + the edit lock.
  // The card the snapshot is built from is the row this RPC re-read under its lock.
  const { data: claimData, error: cardClaimError } = await supabase.rpc('claim_holiday_card_checkout', {
    p_order_id: order.id,
    p_expected_version: expectedVersion,
  });
  if (cardClaimError) return fail(claimFailureResponse(order.id, cardClaimError as RpcFailure));
  const claimedCard = (Array.isArray(claimData) ? claimData[0] : claimData) as ClaimedCardRow | null | undefined;
  if (!claimedCard || typeof claimedCard !== 'object' || typeof claimedCard.id !== 'string') {
    console.error('holiday-card-orders create_checkout card claim returned no card', order.id);
    return fail(errorResponse('Failed to start checkout', 500, 'internal_error'));
  }
  const card: HolidayCardRow = claimedCard;

  // Preconditions on the card (before anything is rendered or created).
  const notReady = requireReadyCard(card);
  if (notReady) return fail(notReady);
  if (!(await familyIsLive(supabase, order.family_id))) return fail(errorResponse('Family not found', 404, 'CARD_NOT_FOUND'));

  // 1. What prints. A card that was already ordered reprints the FIRST paid order's
  //    frozen snapshot (same hash: a reorder can never silently differ); any other
  //    card is snapshotted from the row the claim just re-read.
  let ordered: OrderedSnapshot | null;
  try {
    ordered = await loadOrderedSnapshot(supabase, card.id);
  } catch (error) {
    const code = error instanceof CardLoadError ? error.code : 'unknown';
    console.error('holiday-card-orders create_checkout ordered snapshot unavailable', order.id, code);
    if (code === 'INVALID_CARD') {
      return fail(errorResponse('This card cannot be reprinted right now', 409, 'REORDER_UNAVAILABLE'));
    }
    return fail(errorResponse('Failed to prepare the card for printing', 500, 'internal_error'));
  }

  let snapshot: FrozenCardSnapshot;
  let hash: string;
  /** The share token the print carries as a QR (null = prints without one). */
  let printedToken: string | null;
  if (ordered) {
    const frozen = ordered.snapshot;
    if (frozen.card.format !== product.format) {
      console.error('holiday-card-orders create_checkout reorder format differs', order.id);
      return fail(errorResponse('This card cannot be reprinted in this format', 409, 'REORDER_UNAVAILABLE'));
    }
    printedToken = frozen.qrUrl && frozen.card.qr.token ? frozen.card.qr.token : null;
    if (printedToken) {
      let blocked;
      try {
        blocked = await checkFrozenQr(supabase, card, printedToken);
      } catch {
        return fail(errorResponse('Failed to check the card film', 500, 'internal_error'));
      }
      if (blocked) return fail(gateFailureResponse(blocked, true));
    }
    snapshot = frozen;
    const storedHash = ordered.order.snapshotHash;
    hash = storedHash && /^[0-9a-f]{16,64}$/.test(storedHash) ? storedHash : await snapshotHash(frozen);
  } else {
    let gate;
    try {
      gate = await checkFilmGate(supabase, card);
    } catch {
      return fail(errorResponse('Failed to check the card film', 500, 'internal_error'));
    }
    if (!gate.ok) return fail(gateFailureResponse(gate.code, false));
    let loaded;
    try {
      loaded = await loadCardSnapshot(
        { createPresignedGetUrls: dependencies.createPresignedGetUrls, fetch: dependencies.fetch, imageSize: dependencies.imageSize },
        supabase,
        card,
        { format: product.format, shareTokenActive: gate.shareTokenActive },
      );
    } catch (error) {
      if (error instanceof CardLoadError) {
        console.error('holiday-card-orders create_checkout snapshot refused', order.id, error.code);
        return fail(errorResponse(`The card cannot be printed yet (${error.code})`, LOAD_ERROR_STATUS[error.code] ?? 422, error.code));
      }
      console.error('holiday-card-orders create_checkout snapshot failed', order.id, error instanceof Error ? error.name : 'unknown');
      return fail(errorResponse('Failed to prepare the card for printing', 500, 'internal_error'));
    }
    snapshot = loaded.snapshot;
    hash = loaded.hash;
    printedToken = snapshot.qrUrl ? card.share_token : null;
  }

  // 2. Print files: content-addressed by the snapshot hash. Reuse the ones already
  //    rendered for this exact snapshot (if they are still in R2 at the size the
  //    render service reported), else render a fresh set under this hash's prefix.
  const filesIntact = async (candidate: PrintFileRecord[]): Promise<boolean> => {
    try {
      for (const file of candidate) {
        const head = await dependencies.headObject(file.key);
        if (!head || head.contentLength !== file.bytes) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  let files: PrintFileRecord[];
  const sameSnapshot = prior.snapshotHash === hash && order.snapshot_hash === hash;
  if (sameSnapshot && prior.files && prior.files.length > 0 && filesMatchLayout(prior.files, product.fileLayout) && await filesIntact(prior.files)) {
    files = prior.files;
  } else {
    try {
      const assetKeys = snapshot.assets.map((asset) => asset.key);
      const urlsByKey = await dependencies.createPresignedGetUrls(assetKeys, ASSET_URL_TTL_SECONDS);
      const assets: Record<string, string> = {};
      for (const asset of snapshot.assets) {
        const url = urlsByKey[asset.key];
        if (!url) throw new Error('missing presigned url');
        assets[asset.file] = url;
      }
      const result = await renderCard(dependencies.fetch, renderUrl, renderSecret, {
        orderId: order.id,
        mode: 'render',
        format: product.format,
        fileLayout: product.fileLayout,
        card: snapshot.card,
        edits: snapshot.edits,
        assets,
        outputPrefix: printFilesPrefix(order.id, hash),
      });
      const sides = new Set(result.files.map((f) => f.side));
      const complete = product.fileLayout === 'two_files' ? sides.has('front') && sides.has('back') : sides.has('both');
      if (!complete) throw new RenderCardUnavailableError(502, 'render service returned the wrong files');
      // The objects must really be there, at the size the service reported, before a draft points at them.
      if (!(await filesIntact(result.files))) throw new RenderCardUnavailableError(502, 'rendered print files are missing from storage');
      files = result.files;
    } catch (error) {
      if (error instanceof RenderCardContentError) {
        // The card itself is the problem (letter too long, photo too small...): the
        // order stays `quoted`, nothing was charged, the parent edits the card and retries.
        console.error('holiday-card-orders create_checkout render refused', order.id, error.code);
        return fail(errorResponse(error.message, 422, error.code));
      }
      console.error('holiday-card-orders create_checkout render failed', order.id, error instanceof Error ? error.name : 'unknown');
      return fail(errorResponse('Unable to prepare the print files right now', 502, 'RENDER_UNAVAILABLE'));
    }
    // A draft made for ANOTHER snapshot points at other files: never reuse it.
    if (order.gelato_order_id) {
      try {
        await deleteDraft(dependencies.fetch, gelatoApiKey, order.gelato_order_id);
      } catch {
        console.error('holiday-card-orders create_checkout could not delete the draft of the previous snapshot', order.id);
      }
    }
    // Files of the previous snapshot are no longer referenced.
    for (const old of prior.files ?? []) {
      if (!files.some((f) => f.key === old.key)) await dependencies.deleteKey(old.key).catch(() => undefined);
    }
    // A new snapshot is a new attempt: the previous session expiry is not carried over.
    const progress: PrintFilesState = { claim: { id: claimId, at: new Date(dependencies.now()).toISOString() }, files, snapshotHash: hash, renderedAt: new Date(dependencies.now()).toISOString() };
    const { data: saved, error: saveError } = await supabase
      .from('holiday_card_orders')
      .update({
        card_snapshot: { card: snapshot.card, edits: snapshot.edits, assets: snapshot.assets, qrUrl: snapshot.qrUrl, front: snapshot.front },
        snapshot_hash: hash,
        print_files: progress,
        gelato_order_id: null,
        gelato_status: null,
      })
      .eq('id', order.id)
      .eq('status', 'quoted')
      .select('id')
      .maybeSingle();
    if (saveError || !saved) {
      console.error('holiday-card-orders create_checkout snapshot persist failed', order.id);
      return fail(errorResponse('Failed to record the print files', saveError ? 500 : 409, saveError ? 'internal_error' : 'ORDER_NOT_QUOTED'));
    }
    dbState = progress;
    order.gelato_order_id = null;
  }

  // 3. The Gelato draft (free; not produced until confirmed after payment). Reuse
  //    a draft a previous attempt of THIS snapshot already created.
  let gelatoOrderId = order.gelato_order_id;
  if (gelatoOrderId) {
    try {
      const existing = await getOrder(dependencies.fetch, gelatoApiKey, gelatoOrderId);
      if (!existing.isDraft) {
        console.error('holiday-card-orders create_checkout existing Gelato order is not a draft', order.id);
        return fail(errorResponse('The print order is in an unexpected state', 409, 'ORDER_NOT_QUOTED'));
      }
    } catch (error) {
      if (error instanceof GelatoApiError && error.status === 404) {
        gelatoOrderId = null; // the draft is gone: make a new one below
      } else {
        console.error('holiday-card-orders create_checkout draft check failed', order.id);
        return fail(errorResponse('Unable to reach the print provider', 502, 'GELATO_UNAVAILABLE'));
      }
    }
  }
  if (!gelatoOrderId) {
    try {
      const urls = await dependencies.createPresignedGetUrls(files.map((f) => f.key), PRINT_FILE_URL_TTL_SECONDS);
      const urlFor = (side: PrintFileRecord['side']) => {
        const file = files.find((f) => f.side === side);
        return file ? urls[file.key] : undefined;
      };
      const gelatoFiles = gelatoFilesFor(product.fileLayout, { frontUrl: urlFor('front'), backUrl: urlFor('back'), pdfUrl: urlFor('both') });
      const draft = await createDraft(dependencies.fetch, gelatoApiKey, {
        orderReferenceId: order.id,
        customerReferenceId: order.family_id,
        currency: product.currency,
        items: [{ itemReferenceId: 'cards', productUid: product.productUid, quantity: order.packs, files: gelatoFiles }],
        shippingAddress: gelatoAddress(order.shipping_address, callerEmail),
      });
      gelatoOrderId = draft.id;
      const { data: persisted, error: persistError } = await supabase
        .from('holiday_card_orders')
        .update({ gelato_order_id: draft.id, gelato_status: draft.rawFulfillmentStatus ?? 'draft' })
        .eq('id', order.id)
        .eq('status', 'quoted')
        .select('id')
        .maybeSingle();
      if (persistError || !persisted) {
        console.error('holiday-card-orders create_checkout draft id persist failed', order.id);
        // The order moved on (aged/cancelled) or the write failed: do not leave an unreferenced draft behind.
        if (!persisted && !persistError) await deleteDraft(dependencies.fetch, gelatoApiKey, draft.id).catch(() => undefined);
        return fail(errorResponse('Failed to record the print order', persistError ? 500 : 409, persistError ? 'internal_error' : 'ORDER_NOT_QUOTED'));
      }
    } catch (error) {
      if (error instanceof GelatoApiError && !error.retryable) {
        console.error('holiday-card-orders create_checkout draft rejected', order.id, error.status, error.code ?? '');
        return fail(errorResponse('The print provider rejected this order', 422, 'DRAFT_REJECTED'));
      }
      console.error('holiday-card-orders create_checkout draft failed', order.id, error instanceof Error ? error.name : 'unknown');
      return fail(errorResponse('Unable to reach the print provider', 502, 'GELATO_UNAVAILABLE'));
    }
  }

  // 4. The Stripe Checkout Session. Its `expires_at` is fixed per ATTEMPT: chosen
  //    once (now + 35 min), persisted in `print_files.sessionExpiresAt` BEFORE the
  //    call and reused by a retry while >= 10 minutes of it remain, so a retry sends
  //    a byte-identical request and Stripe hands back the same session. The expiry
  //    is part of the idempotency key: a new attempt (the old expiry has run low)
  //    gets a new expiry AND a new key. (The card claim's timestamp is not used: it
  //    is refreshed by every re-claim, so it is not stable across retries.)
  // The Customer does not depend on the session: one per (order, email, address), whatever the attempt.
  const customerKey = (await sha256Hex(canonicalJson({ orderId: order.id, email: callerEmail, address: order.shipping_address }))).slice(0, 32);
  let expiry = chooseSessionExpiry(dbState.sessionExpiresAt, dependencies.now());
  let session: { sessionId: string; url: string | null };
  for (let round = 0;; round += 1) {
    if (!expiry.reused) {
      const withExpiry: PrintFilesState = { ...dbState, sessionExpiresAt: expiry.iso };
      const { data: stored, error: storeError } = await supabase
        .from('holiday_card_orders')
        .update({ print_files: withExpiry })
        .eq('id', order.id)
        .eq('status', 'quoted')
        .select('id')
        .maybeSingle();
      if (storeError || !stored) {
        console.error('holiday-card-orders create_checkout session expiry persist failed', order.id);
        return fail(errorResponse('Failed to start checkout', storeError ? 500 : 409, storeError ? 'internal_error' : 'ORDER_NOT_QUOTED'));
      }
      dbState = withExpiry;
    }
    const attemptKey = (await sha256Hex(canonicalJson({
      orderId: order.id,
      hash,
      priceCents: order.price_cents,
      packs: order.packs,
      currency: order.currency,
      address: order.shipping_address,
      expiresAt: expiry.seconds,
    }))).slice(0, 32);
    try {
      const customerId = await createStripeCustomer(dependencies.fetch, stripeSecretKey, {
        email: callerEmail,
        address: {
          line1: order.shipping_address.line1,
          line2: order.shipping_address.line2 ?? null,
          city: order.shipping_address.city,
          state: order.shipping_address.state,
          postalCode: order.shipping_address.postalCode,
          countryCode: order.shipping_address.countryCode,
        },
        idempotencyKey: `hc-cust-${customerKey}`,
      });
      session = await createGenericCheckoutSession(dependencies.fetch, stripeSecretKey, {
        customerId,
        currency: order.currency.toLowerCase(),
        lineItems: [{ name: HOLIDAY_CARD_PRODUCT_NAME, taxCode: HOLIDAY_CARD_TAX_CODE, unitAmountCents: order.price_cents }],
        metadata: { productType: 'holiday_card', orderId: order.id, snapshotHash: hash },
        successUrl: `${checkoutOrigin}/c/${card.id}?order=${order.id}&checkout=success`,
        cancelUrl: `${checkoutOrigin}/c/${card.id}?order=${order.id}&checkout=cancelled`,
        idempotencyKey: `hc-sess-${attemptKey}`,
        expiresAt: expiry.seconds,
      });
      break;
    } catch (error) {
      // A REUSED expiry that Stripe refuses (400: under its 30-minute minimum) means the
      // previous attempt never reached Stripe (a replay of one that did would have succeeded):
      // nothing exists there, so start a new attempt with a fresh expiry and key, once.
      if (round === 0 && expiry.reused && error instanceof StripeApiError && error.status === 400) {
        expiry = chooseSessionExpiry(undefined, dependencies.now());
        continue;
      }
      console.error('holiday-card-orders create_checkout Stripe failed', order.id, error instanceof Error ? error.name : 'unknown');
      return fail(errorResponse('Unable to start checkout', 502, 'STRIPE_UNAVAILABLE'));
    }
  }
  if (!session.url) {
    console.error('holiday-card-orders create_checkout session has no url', order.id);
    return fail(errorResponse('Unable to start checkout', 502, 'STRIPE_UNAVAILABLE'));
  }

  // Closing a session we just made also forgets its expiry: with the expiry kept, a retry
  // would reuse the same idempotency key and Stripe would replay the dead session.
  const closeOwnSession = async (): Promise<void> => {
    await expireCheckoutSession(dependencies.fetch, stripeSecretKey, session.sessionId).catch(() => undefined);
    const { sessionExpiresAt: _dropped, ...rest } = dbState;
    dbState = rest;
    await supabase
      .from('holiday_card_orders')
      .update({ print_files: rest })
      .eq('id', order.id)
      .eq('status', 'quoted');
  };

  // 5. Last look: the card may have been deleted, its link disabled or its edits
  //    changed (a claim older than 10 minutes no longer blocks edits) while we worked.
  let unchanged = false;
  try {
    unchanged = await cardUnchangedForPrint(supabase, card.id, printedToken) &&
      (await cardEditsVersion(supabase, card.id)) === expectedVersion;
  } catch {
    await closeOwnSession();
    return fail(errorResponse('Failed to re-check the card', 500, 'internal_error'));
  }
  if (!unchanged) {
    console.error('holiday-card-orders create_checkout card changed while preparing', order.id);
    await expireCheckoutSession(dependencies.fetch, stripeSecretKey, session.sessionId).catch(() => undefined);
    if (gelatoOrderId) await deleteDraft(dependencies.fetch, gelatoApiKey, gelatoOrderId).catch(() => undefined);
    await deletePrintFiles(dependencies, order.id).catch(() => undefined);
    await supabase
      .from('holiday_card_orders')
      .update({ gelato_order_id: null, gelato_status: null, print_files: null, card_snapshot: null, snapshot_hash: null })
      .eq('id', order.id)
      .eq('status', 'quoted');
    await releaseCardClaim(supabase, order.id);
    return errorResponse('The card was changed or deleted while preparing checkout', 409, 'CARD_CHANGED');
  }

  // 6. quoted -> checkout (the snapshot, hash and draft id are already persisted).
  //    The card claim is KEPT from here: the order is now the card's open checkout.
  const finalFiles: PrintFilesState = { files, snapshotHash: hash, renderedAt: new Date(dependencies.now()).toISOString(), sessionExpiresAt: expiry.iso };
  const { data: advanced, error: advanceError } = await supabase
    .from('holiday_card_orders')
    .update({ status: 'checkout', stripe_session_id: session.sessionId, print_files: finalFiles })
    .eq('id', order.id)
    .eq('status', 'quoted')
    .select('id')
    .maybeSingle();
  if (advanceError) {
    if ((advanceError as RpcFailure).code === '23505') {
      // holiday_card_orders_one_checkout_per_card: another order of this card is in
      // `checkout`. Close the session we just made and give our claims back.
      console.error('holiday-card-orders create_checkout another checkout is open for the card', order.id);
      await closeOwnSession();
      return fail(errorResponse('Another checkout is already open for this card', 409, 'CHECKOUT_OPEN_ELSEWHERE'));
    }
    console.error('holiday-card-orders create_checkout checkout CAS failed', order.id, advanceError.message);
    return fail(errorResponse('Failed to record the checkout session', 500, 'internal_error'));
  }
  if (!advanced) {
    // The order was cancelled/aged while we worked: close the session we just made.
    await expireCheckoutSession(dependencies.fetch, stripeSecretKey, session.sessionId).catch(() => undefined);
    await releaseCardClaim(supabase, order.id);
    return errorResponse('Order is no longer awaiting checkout', 409, 'ORDER_NOT_QUOTED');
  }

  return jsonResponse({ success: true, orderId: order.id, status: 'checkout', checkoutUrl: session.url, sessionId: session.sessionId, expiresAt: expiry.iso });
}

// ── cancel_checkout ──────────────────────────────────────────────────────

async function handleCancelCheckout(
  dependencies: HolidayCardOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  body: { orderId: string },
): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const order = owned.order;
  const role = await dependencies.getCallerFamilyRole(supabase, order.family_id, callerId);
  if (!isManagerRole(role)) return errorResponse('Not authorized', 403, 'forbidden');
  if (order.status !== 'checkout' && order.status !== 'quoted') {
    return errorResponse('Only an order that has not been paid can be cancelled', 409, 'ORDER_NOT_CANCELLABLE');
  }

  if (order.status === 'checkout') {
    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeSecretKey || !order.stripe_session_id) return errorResponse('Checkout is not configured', 500, 'internal_error');
    try {
      await expireCheckoutSession(dependencies.fetch, stripeSecretKey, order.stripe_session_id);
    } catch (error) {
      // Stripe refuses to expire a session that is no longer open: find out which.
      try {
        const session = await retrieveCheckoutSession(dependencies.fetch, stripeSecretKey, order.stripe_session_id);
        if (session.status === 'complete') return errorResponse('This order has already been paid', 409, 'ORDER_ALREADY_PAID');
        if (session.status !== 'expired') throw error;
      } catch {
        console.error('holiday-card-orders cancel_checkout could not expire the session', order.id);
        return errorResponse('Unable to cancel checkout right now', 502, 'STRIPE_UNAVAILABLE');
      }
    }
  }

  const { data: cancelled, error } = await supabase
    .from('holiday_card_orders')
    .update({ status: 'cancelled' })
    .eq('id', order.id)
    .eq('status', order.status)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('holiday-card-orders cancel_checkout CAS failed', order.id, error.message);
    return errorResponse('Failed to cancel the order', 500, 'internal_error');
  }
  if (!cancelled) return errorResponse('The order changed while cancelling', 409, 'ORDER_NOT_CANCELLABLE');
  // The order no longer holds the card.
  await releaseCardClaim(supabase, order.id);

  const fulfillmentDeps: FulfillmentDeps = {
    fetch: dependencies.fetch,
    sendEmail: dependencies.sendEmail,
    listKeys: dependencies.listKeys,
    deleteKey: dependencies.deleteKey,
    gelatoApiKey: Deno.env.get('GELATO_API_KEY') ?? null,
    stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY') ?? null,
  };
  // Best effort: the sweep retries any cancelled, never-paid order that still has artifacts.
  await releaseUnpaidArtifacts(fulfillmentDeps, supabase, order.id);
  return jsonResponse({ success: true, orderId: order.id, status: 'cancelled' });
}

// ── status ───────────────────────────────────────────────────────────────

async function handleStatus(supabase: SupabaseClient, callerId: string, body: { orderId: string }): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const { data: full, error } = await supabase
    .from('holiday_card_orders')
    .select('id, card_id, status, packs, price_cents, currency, region, gelato_status, tracking_number, tracking_url, carrier, shipped_at, failure_reason, refunded_at')
    .eq('id', owned.order.id)
    .maybeSingle();
  if (error || !full) {
    console.error('holiday-card-orders status lookup failed', error?.message ?? 'missing row');
    return errorResponse('Failed to load order status', 500, 'internal_error');
  }
  return jsonResponse({
    success: true,
    orderId: full.id,
    cardId: full.card_id,
    status: full.status,
    packs: full.packs,
    cards: full.packs ? full.packs * CARDS_PER_PACK : null,
    priceCents: full.price_cents,
    currency: full.currency,
    region: full.region,
    gelatoStatus: full.gelato_status,
    trackingNumber: full.tracking_number,
    trackingUrl: full.tracking_url,
    carrier: full.carrier,
    shippedAt: full.shipped_at,
    failureReason: full.failure_reason,
    refunded: Boolean(full.refunded_at),
  });
}

// ── Orders kill switch ───────────────────────────────────────────────────

/**
 * `holiday_card_settings.orders_enabled`. Null = ordering is on. Fails CLOSED: a
 * settings read error (or an answer that is not a boolean) is a 500, never a pass.
 */
async function checkOrdersEnabled(supabase: SupabaseClient): Promise<Response | null> {
  const { data, error } = await supabase.rpc('holiday_card_orders_enabled');
  if (error || typeof data !== 'boolean') {
    console.error('holiday-card-orders kill switch read failed', (error as { code?: string } | null)?.code ?? 'no_boolean');
    return errorResponse('Ordering is temporarily unavailable', 500, 'internal_error');
  }
  return data ? null : errorResponse('Holiday card ordering is paused right now', 403, 'HOLIDAY_CARD_ORDERS_PAUSED');
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function handleHolidayCardOrders(
  req: Request,
  dependencyOverrides: Partial<HolidayCardOrdersDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: HolidayCardOrdersRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!isPlainObject(body) || typeof (body as { op?: unknown }).op !== 'string') {
    return errorResponse('op is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();

  // The ordering kill switch covers every op that starts or advances an order
  // (cancel_checkout and status stay available while ordering is paused).
  if (body.op === 'create_draft' || body.op === 'quote' || body.op === 'create_checkout') {
    const paused = await checkOrdersEnabled(supabase);
    if (paused) return paused;
  }

  switch (body.op) {
    case 'create_draft':
      return handleCreateDraft(dependencies, supabase, user.id, (body as { cardId: unknown }).cardId);
    case 'quote':
      return handleQuote(dependencies, supabase, user.id, user.email ?? null, body as { orderId: string; address: unknown; packs: unknown });
    case 'create_checkout':
      return handleCreateCheckout(dependencies, supabase, user.id, user.email ?? null, body as { orderId: string; expectedEditsVersion?: unknown });
    case 'cancel_checkout':
      return handleCancelCheckout(dependencies, supabase, user.id, body as { orderId: string });
    case 'status':
      return handleStatus(supabase, user.id, body as { orderId: string });
    default:
      return errorResponse('Unknown operation', 400, 'validation_error');
  }
}

if (import.meta.main) {
  serveWithSentry('holiday-card-orders', (request) => handleHolidayCardOrders(request));
}
