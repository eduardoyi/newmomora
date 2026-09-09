/**
 * Memory Book order surface (memory-book-5c plan, Design Decision 4 as
 * amended in `plans/memory-book-5c-checkout-fulfillment.md`). Four
 * operations behind one function, mirroring `memory-book-edits/index.ts`'s
 * shape (JWT auth via `getAuthenticatedNonAnonymousUser`, owner/manager
 * family-role check, service-role DB access, dependency-injected for
 * tests):
 *
 *   - `create_draft`: inserts a bare `memory_book_orders` row for a
 *     `ready` book (owner/manager only). The client COULD insert this row
 *     itself under RLS (see docs/features/memory-book-orders.md's "Client
 *     integration" section) -- this op exists anyway so the "book must be
 *     `ready`" business rule (RLS cannot express it) is enforced
 *     server-side before a draft is ever created, and so the web checkout
 *     flow has one API surface for the whole order lifecycle.
 *   - `quote`: address in, our price + real Prodigi shipping out. Runs the
 *     `originalFile` backfill (Design Decision 1) against the book's
 *     CURRENT `book_document` if it predates that field, persists the
 *     patched document back to `memory_books`, calls the render worker's
 *     `POST /fit` for THE page count (Design Decision 2), calls Prodigi's
 *     `POST /v4.0/quotes` for shipping, computes the total from
 *     `PRICE_USD_CENTS`, and persists the whole bundle with a CAS
 *     `draft -> quoted`.
 *   - `create_checkout`: builds a Stripe Checkout Session from the
 *     ALREADY-PERSISTED quote (never re-derived from client input),
 *     `shipping_address_collection` disabled, the quoted address pinned
 *     onto a fresh Stripe Customer so Stripe Tax computes VAT against the
 *     real destination (see `_shared/stripe.ts`'s header comment). Does
 *     NOT change `status` -- the row stays `quoted` until
 *     `stripe-webhook`'s `checkout.session.completed` handler CASes
 *     `quoted -> paid` (this is the "decide and document" note from the
 *     task: per docs/features/memory-book-orders.md's state-machine table,
 *     `paid` is set by the WEBHOOK, not this op -- a Checkout Session can
 *     be abandoned or retried, so the row must not claim `paid` before
 *     Stripe confirms payment actually happened).
 *   - `status`: a convenience read (RLS `select` already covers this for a
 *     direct client query -- this op exists only because the web checkout
 *     page already talks to this function for everything else).
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getAuthenticatedNonAnonymousUser } from '../_shared/auth.ts';
import { handleCors } from '../_shared/cors.ts';
import { errorResponse, jsonResponse } from '../_shared/errors.ts';
import { getCallerFamilyRole, isManagerRole } from '../_shared/family-access.ts';
import { backfillOriginalFilesForBook } from '../_shared/memory-book-backfill.ts';
import { getProdigiQuote, PRODIGI_CONFIRMED_SKU } from '../_shared/prodigi.ts';
import { fitBookForQuote } from '../_shared/render-worker-client.ts';
import { createCheckoutSession, createStripeCustomer } from '../_shared/stripe.ts';
import { createServiceClient } from '../_shared/supabase-admin.ts';

// ── Shapes ───────────────────────────────────────────────────────────────

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

export type MemoryBookOrdersRequestBody =
  | { op: 'create_draft'; bookId: string }
  | { op: 'quote'; orderId: string; address: unknown; shippingMethod?: string }
  | { op: 'create_checkout'; orderId: string }
  | { op: 'status'; orderId: string };

export interface MemoryBookOrdersDependencies {
  getAuthenticatedUser: typeof getAuthenticatedNonAnonymousUser;
  createServiceClient: typeof createServiceClient;
  getCallerFamilyRole: typeof getCallerFamilyRole;
  fetch: typeof fetch;
  now: () => number;
}

export const DEFAULT_DEPENDENCIES: MemoryBookOrdersDependencies = {
  getAuthenticatedUser: getAuthenticatedNonAnonymousUser,
  createServiceClient,
  getCallerFamilyRole,
  // Every upstream call (render worker /fit, Prodigi, Stripe) rides this
  // fetch. A hung upstream must fail loud — each call site's catch turns
  // the rejection into a clean 502 — never hang the whole op: the
  // buyer-facing symptom of a hang is an infinite "Getting your quote…"
  // spinner (owner-hit 2026-09-09). 30s is generous for all three
  // upstreams (each normally answers in 1–3s).
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }),
  now: () => Date.now(),
};

const DEFAULT_SHIPPING_METHOD = 'Standard';
const ALLOWED_SHIPPING_METHODS = new Set(['Budget', 'Standard', 'Express']);
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength && !CONTROL_CHAR_PATTERN.test(value);
}

/** Validates the client-supplied shipping address shape. This is the ONLY
 * server-side gate on address content -- the row's `shipping_address`
 * column reaches the DB exclusively through this op (see the RLS
 * with-check's null lock in the 20260908120000 migration), so there is
 * exactly one place a malformed address could ever get in. */
export function validateShippingAddress(input: unknown): { address: ShippingAddress } | { error: string } {
  if (!isPlainObject(input)) return { error: 'address is required' };
  if (!isBoundedString(input.name, 200)) return { error: 'address.name is required' };
  if (!isBoundedString(input.line1, 200)) return { error: 'address.line1 is required' };
  if (input.line2 !== undefined && !isBoundedString(input.line2, 200)) return { error: 'address.line2 is invalid' };
  if (input.city !== undefined && !isBoundedString(input.city, 200)) return { error: 'address.city is invalid' };
  if (input.state !== undefined && !isBoundedString(input.state, 200)) return { error: 'address.state is invalid' };
  if (!isBoundedString(input.postalCode, 20)) return { error: 'address.postalCode is required' };
  if (typeof input.countryCode !== 'string' || !COUNTRY_CODE_PATTERN.test(input.countryCode)) {
    return { error: 'address.countryCode must be a 2-letter ISO code' };
  }
  return {
    address: {
      name: input.name,
      line1: input.line1,
      line2: input.line2,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      countryCode: input.countryCode,
    },
  };
}

// ── create_draft ─────────────────────────────────────────────────────────

interface BookForDraftRow {
  id: string;
  family_id: string;
  status: string;
}

async function handleCreateDraft(
  dependencies: MemoryBookOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  bookId: unknown,
): Promise<Response> {
  if (typeof bookId !== 'string' || !bookId) {
    return errorResponse('bookId is required', 400, 'validation_error');
  }

  const { data: book, error: bookError } = await supabase
    .from('memory_books')
    .select('id, family_id, status')
    .eq('id', bookId)
    .maybeSingle<BookForDraftRow>();
  if (bookError) {
    console.error('memory-book-orders create_draft book lookup failed', bookError.message);
    return errorResponse('Failed to load memory book', 500, 'internal_error');
  }
  if (!book) return errorResponse('Memory book not found', 404, 'BOOK_NOT_FOUND');

  const callerRole = await dependencies.getCallerFamilyRole(supabase, book.family_id, callerId);
  if (!isManagerRole(callerRole)) {
    return errorResponse('Not authorized to order this memory book', 403, 'forbidden');
  }
  if (book.status !== 'ready') {
    return errorResponse('Memory book is not ready to order', 409, 'BOOK_NOT_READY');
  }

  const { data: order, error: insertError } = await supabase
    .from('memory_book_orders')
    .insert({ book_id: book.id, family_id: book.family_id, requested_by: callerId })
    .select('id, status')
    .single();
  if (insertError) {
    console.error('memory-book-orders create_draft insert failed', insertError.message);
    return errorResponse('Failed to create order draft', 500, 'internal_error');
  }

  return jsonResponse({ success: true, orderId: order.id, status: order.status }, 201);
}

// ── quote ────────────────────────────────────────────────────────────────

interface OrderRow {
  id: string;
  book_id: string;
  family_id: string;
  requested_by: string | null;
  status: string;
  price_cents: number | null;
  shipping_cost_cents: number | null;
  shipping_address: ShippingAddress | null;
  quoted_page_count: number | null;
}

interface BookForQuoteRow {
  id: string;
  family_id: string;
  book_document: unknown;
}

async function loadOwnedOrder(
  supabase: SupabaseClient,
  orderId: unknown,
  callerId: string,
): Promise<{ order: OrderRow } | { response: Response }> {
  if (typeof orderId !== 'string' || !orderId) {
    return { response: errorResponse('orderId is required', 400, 'validation_error') };
  }
  const { data: order, error } = await supabase
    .from('memory_book_orders')
    .select('id, book_id, family_id, requested_by, status, price_cents, shipping_cost_cents, shipping_address, quoted_page_count')
    .eq('id', orderId)
    .maybeSingle<OrderRow>();
  if (error) {
    console.error('memory-book-orders order lookup failed', error.message);
    return { response: errorResponse('Failed to load order', 500, 'internal_error') };
  }
  if (!order || order.requested_by !== callerId) {
    // Same shape whether the id is unknown or belongs to another buyer --
    // no oracle for "does this order exist for someone else" (mirrors
    // get-media-url/memory-book-edits' per-id omission convention).
    return { response: errorResponse('Order not found', 404, 'ORDER_NOT_FOUND') };
  }
  return { order };
}

async function handleQuote(
  dependencies: MemoryBookOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  body: { orderId: string; address: unknown; shippingMethod?: string },
): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const order = owned.order;
  if (order.status !== 'draft') {
    return errorResponse('Order has already been quoted', 409, 'ORDER_NOT_DRAFT');
  }

  const validatedAddress = validateShippingAddress(body.address);
  if ('error' in validatedAddress) return errorResponse(validatedAddress.error, 400, 'validation_error');
  const address = validatedAddress.address;

  const shippingMethod = typeof body.shippingMethod === 'string' && ALLOWED_SHIPPING_METHODS.has(body.shippingMethod)
    ? body.shippingMethod
    : DEFAULT_SHIPPING_METHOD;

  const { data: book, error: bookError } = await supabase
    .from('memory_books')
    .select('id, family_id, book_document')
    .eq('id', order.book_id)
    .maybeSingle<BookForQuoteRow>();
  if (bookError) {
    console.error('memory-book-orders quote book lookup failed', bookError.message);
    return errorResponse('Failed to load memory book', 500, 'internal_error');
  }
  if (!book || !book.book_document) {
    return errorResponse('Memory book is not ready to quote', 409, 'BOOK_NOT_READY');
  }

  const { data: editsRow, error: editsError } = await supabase
    .from('memory_book_edits')
    .select('edits')
    .eq('book_id', order.book_id)
    .maybeSingle();
  if (editsError) {
    console.error('memory-book-orders quote edits lookup failed', editsError.message);
    return errorResponse('Failed to load book edits', 500, 'internal_error');
  }
  const edits = editsRow?.edits ?? {};

  // Design Decision 1: backfill originalFile onto pre-existing book
  // documents (idempotent no-op if every asset already carries it or is
  // already its own original). Persisted back to memory_books regardless
  // of whether every asset resolved -- a partial patch is still strictly
  // better than none, and the FREEZE precondition (stripe-webhook, at
  // paid) re-runs this same check and refuses to freeze if anything is
  // still unresolved at that point.
  let bookDocumentForFit = book.book_document;
  try {
    const backfilled = await backfillOriginalFilesForBook(supabase, book.family_id, book.book_document);
    bookDocumentForFit = backfilled.bookDocument;
    if (backfilled.patchedCount > 0) {
      const { error: patchError } = await supabase
        .from('memory_books')
        .update({ book_document: backfilled.bookDocument })
        .eq('id', book.id);
      if (patchError) {
        console.error('memory-book-orders quote backfill persist failed', patchError.message);
      }
    }
    if (backfilled.unresolved.length > 0) {
      // Content-free: counts only, never a memory id or file path.
      console.error('memory-book-orders quote backfill left assets unresolved', backfilled.unresolved.length);
    }
  } catch (error) {
    console.error('memory-book-orders quote backfill failed', error instanceof Error ? error.message : 'unknown');
    // Non-fatal: fall through with the UN-patched document. The render
    // worker's /fit call below only needs a page count, not print-quality
    // assets -- the freeze precondition (payment time) is the actual
    // print-quality gate, not the quote.
  }

  const renderWorkerUrl = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_URL');
  const renderWorkerSecret = Deno.env.get('MEMORY_BOOK_RENDER_WORKER_HMAC_SECRET');
  if (!renderWorkerUrl || !renderWorkerSecret) {
    console.error('memory-book-orders quote missing render worker configuration');
    return errorResponse('Order quoting is not configured', 500, 'internal_error');
  }

  let pageCount: number;
  try {
    const fit = await fitBookForQuote(dependencies.fetch, renderWorkerUrl, renderWorkerSecret, {
      bookDocument: bookDocumentForFit,
      edits,
    });
    pageCount = fit.pageCount;
  } catch (error) {
    console.error('memory-book-orders quote /fit failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Unable to compute page count', 502, 'RENDER_WORKER_UNAVAILABLE');
  }

  const prodigiApiKey = Deno.env.get('PRODIGI_API_KEY');
  const prodigiBaseUrl = Deno.env.get('PRODIGI_API_BASE_URL') ?? 'https://api.sandbox.prodigi.com';
  const prodigiSku = Deno.env.get('PRODIGI_SKU') ?? PRODIGI_CONFIRMED_SKU;
  if (!prodigiApiKey) {
    console.error('memory-book-orders quote missing PRODIGI_API_KEY');
    return errorResponse('Order quoting is not configured', 500, 'internal_error');
  }

  let shippingCostCents: number;
  try {
    const quote = await getProdigiQuote(dependencies.fetch, prodigiBaseUrl, prodigiApiKey, {
      sku: prodigiSku,
      destinationCountryCode: address.countryCode,
      shippingMethod,
      numberOfPages: pageCount,
    });
    shippingCostCents = quote.shippingCostCents;
  } catch (error) {
    console.error('memory-book-orders quote Prodigi quote failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Unable to compute shipping cost', 502, 'PRODIGI_UNAVAILABLE');
  }

  const priceCentsRaw = Deno.env.get('PRICE_USD_CENTS');
  const priceCents = Number(priceCentsRaw);
  if (!priceCentsRaw || !Number.isFinite(priceCents) || priceCents <= 0) {
    console.error('memory-book-orders quote missing/invalid PRICE_USD_CENTS');
    return errorResponse('Order pricing is not configured', 500, 'internal_error');
  }

  const { data: updated, error: updateError } = await supabase
    .from('memory_book_orders')
    .update({
      status: 'quoted',
      price_cents: priceCents,
      quoted_page_count: pageCount,
      shipping_address: address,
      shipping_method: shippingMethod,
      shipping_cost_cents: shippingCostCents,
    })
    .eq('id', order.id)
    .eq('status', 'draft')
    .select('id')
    .maybeSingle();
  if (updateError) {
    console.error('memory-book-orders quote CAS failed', updateError.message);
    return errorResponse('Failed to persist quote', 500, 'internal_error');
  }
  if (!updated) {
    return errorResponse('Order was already quoted', 409, 'ORDER_NOT_DRAFT');
  }

  return jsonResponse({
    success: true,
    orderId: order.id,
    status: 'quoted',
    priceCents,
    shippingCostCents,
    totalCents: priceCents + shippingCostCents,
    currency: 'usd',
    pageCount,
  });
}

// ── create_checkout ──────────────────────────────────────────────────────

async function handleCreateCheckout(
  dependencies: MemoryBookOrdersDependencies,
  supabase: SupabaseClient,
  callerId: string,
  callerEmail: string | null,
  body: { orderId: string },
): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const order = owned.order;
  if (order.status !== 'quoted') {
    return errorResponse('Order has not been quoted', 409, 'ORDER_NOT_QUOTED');
  }
  if (order.price_cents === null || order.shipping_cost_cents === null || !order.shipping_address) {
    console.error('memory-book-orders create_checkout order missing quote fields', order.id);
    return errorResponse('Order is missing quote details', 500, 'internal_error');
  }
  if (!callerEmail) {
    return errorResponse('Account email is required to check out', 400, 'EMAIL_REQUIRED');
  }

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const checkoutOrigin = Deno.env.get('MEMORY_BOOK_CHECKOUT_ORIGIN');
  if (!stripeSecretKey || !checkoutOrigin) {
    console.error('memory-book-orders create_checkout missing Stripe configuration');
    return errorResponse('Checkout is not configured', 500, 'internal_error');
  }

  let customerId: string;
  try {
    customerId = await createStripeCustomer(dependencies.fetch, stripeSecretKey, {
      email: callerEmail,
      address: {
        line1: order.shipping_address.line1,
        line2: order.shipping_address.line2 ?? null,
        city: order.shipping_address.city ?? null,
        state: order.shipping_address.state ?? null,
        postalCode: order.shipping_address.postalCode,
        countryCode: order.shipping_address.countryCode,
      },
    });
  } catch (error) {
    console.error('memory-book-orders create_checkout customer creation failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Unable to start checkout', 502, 'STRIPE_UNAVAILABLE');
  }

  let session: { sessionId: string; url: string | null };
  try {
    session = await createCheckoutSession(dependencies.fetch, stripeSecretKey, {
      customerId,
      orderId: order.id,
      priceCents: order.price_cents,
      shippingCostCents: order.shipping_cost_cents,
      currency: 'usd',
      successUrl: `${checkoutOrigin}/order/${order.id}?checkout=success`,
      cancelUrl: `${checkoutOrigin}/b/${order.book_id}?checkout=cancelled`,
    });
  } catch (error) {
    console.error('memory-book-orders create_checkout session creation failed', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Unable to start checkout', 502, 'STRIPE_UNAVAILABLE');
  }

  // CAS guard on `status = 'quoted'` -- if the webhook has already moved
  // this order to `paid` (a race with a prior, still-completable Checkout
  // Session), do not overwrite `stripe_session_id` with a second, now
  // orphaned session.
  const { data: updated, error: updateError } = await supabase
    .from('memory_book_orders')
    .update({ stripe_session_id: session.sessionId })
    .eq('id', order.id)
    .eq('status', 'quoted')
    .select('id')
    .maybeSingle();
  if (updateError) {
    console.error('memory-book-orders create_checkout session persist failed', updateError.message);
    return errorResponse('Failed to persist checkout session', 500, 'internal_error');
  }
  if (!updated) {
    return errorResponse('Order is no longer awaiting checkout', 409, 'ORDER_NOT_QUOTED');
  }

  return jsonResponse({ success: true, orderId: order.id, checkoutUrl: session.url, sessionId: session.sessionId });
}

// ── status ───────────────────────────────────────────────────────────────

async function handleStatus(
  supabase: SupabaseClient,
  callerId: string,
  body: { orderId: string },
): Promise<Response> {
  const owned = await loadOwnedOrder(supabase, body.orderId, callerId);
  if ('response' in owned) return owned.response;
  const { data: full, error } = await supabase
    .from('memory_book_orders')
    .select('id, status, price_cents, shipping_cost_cents, quoted_page_count, prodigi_order_id, failure_reason, refunded_at')
    .eq('id', owned.order.id)
    .maybeSingle();
  if (error || !full) {
    console.error('memory-book-orders status lookup failed', error?.message ?? 'missing row');
    return errorResponse('Failed to load order status', 500, 'internal_error');
  }
  return jsonResponse({
    success: true,
    orderId: full.id,
    status: full.status,
    priceCents: full.price_cents,
    shippingCostCents: full.shipping_cost_cents,
    quotedPageCount: full.quoted_page_count,
    hasProdigiOrder: Boolean(full.prodigi_order_id),
    failureReason: full.failure_reason,
    refunded: Boolean(full.refunded_at),
  });
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function handleMemoryBookOrders(
  req: Request,
  dependencyOverrides: Partial<MemoryBookOrdersDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, 'method_not_allowed');

  const user = await dependencies.getAuthenticatedUser(req);
  if (!user) return errorResponse('Unauthorized', 401, 'unauthorized');

  let body: MemoryBookOrdersRequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, 'invalid_json');
  }
  if (!isPlainObject(body) || typeof (body as { op?: unknown }).op !== 'string') {
    return errorResponse('op is required', 400, 'validation_error');
  }

  const supabase = dependencies.createServiceClient();

  switch (body.op) {
    case 'create_draft':
      return handleCreateDraft(dependencies, supabase, user.id, (body as { bookId: unknown }).bookId);
    case 'quote':
      return handleQuote(dependencies, supabase, user.id, body as { orderId: string; address: unknown; shippingMethod?: string });
    case 'create_checkout':
      return handleCreateCheckout(dependencies, supabase, user.id, user.email ?? null, body as { orderId: string });
    case 'status':
      return handleStatus(supabase, user.id, body as { orderId: string });
    default:
      return errorResponse('Unknown operation', 400, 'validation_error');
  }
}

if (import.meta.main) {
  Deno.serve((request) => handleMemoryBookOrders(request));
}
