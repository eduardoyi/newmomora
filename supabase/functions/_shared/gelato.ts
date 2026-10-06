// Minimal Gelato order API v4 client for the holiday card shop
// (docs/plans/holiday-cards-p1.md Step 2/6). Plain `fetch` with an injected
// fetch function, like `stripe.ts` and `prodigi.ts`; no Deno-only APIs and no
// supabase-js, so it runs in Edge Functions and Cloudflare Workers.
//
// Facts verified against the live API during dogfooding (2026-10-05/06):
//   - quote:  POST /v4/orders:quote   -> { quotes: [{ fulfillmentCountry,
//             products: [{ price }], shipmentMethods: [{ name, price|null,
//             minDeliveryDays, maxDeliveryDays, type }] }] }; prices are in
//             currency units (5.84 = $5.84) and `price` is the line total.
//   - draft:  POST /v4/orders with orderType 'draft' (not produced, not charged)
//   - confirm: PATCH /v4/orders/{id} { orderType: 'order' } turns the draft into
//             a real order (this is the only action after payment).
//   - get:    GET  /v4/orders/{id}
// Not yet verified against a live response (no order has shipped yet): the
// tracking fields (`items[].fulfillments[]`), draft deletion (DELETE
// /v4/orders/{id}) and cancel (POST /v4/orders/{id}:cancel). Parsers are
// tolerant there and the canary order is the check.
//
// Privacy: the API key and the shipping address never reach a log, an error
// message or a thrown value. Errors carry the HTTP status and Gelato's error
// code only (never its `message`, which can echo address fields).

const GELATO_API_BASE = 'https://order.gelatoapis.com/v4';

/**
 * Gelato sits behind Cloudflare, which answers a request with a bot-looking
 * User-Agent (Python/urllib, Deno's, undici's default) with a `1010` block page.
 * A curl-like agent passes; every call here sends it.
 */
export const GELATO_USER_AGENT = 'curl/8.7.1';

const DEFAULT_TIMEOUT_MS = 30_000;

export class GelatoApiError extends Error {
  constructor(
    /** HTTP status; 0 = the request never got a response (network/timeout). */
    public readonly status: number,
    /** Gelato's machine-readable code (or `cf_<n>` for a Cloudflare block), when present. */
    public readonly code: string | null,
    operation: string,
  ) {
    super(`Gelato ${operation} failed (${status}${code ? `: ${code}` : ''})`);
    this.name = 'GelatoApiError';
  }

  /** Worth retrying later: network failure, rate limit, or a Gelato 5xx. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The response came back 2xx but not in the shape we need. */
export class GelatoParseError extends Error {
  constructor(operation: string) {
    super(`Gelato ${operation} returned an unexpected response`);
    this.name = 'GelatoParseError';
  }
}

export interface GelatoClientOptions {
  /** Defaults to the production API. */
  baseUrl?: string;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const isObj = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

function errorCodeFrom(body: unknown, text: string): string | null {
  if (isObj(body)) {
    for (const key of ['code', 'errorCode', 'error']) {
      const value = body[key];
      if (typeof value === 'string' && SAFE_CODE.test(value)) return value;
    }
    return null;
  }
  // Cloudflare block pages are plain text/HTML: "error code: 1010".
  const cf = /error code:?\s*(\d{3,5})/i.exec(text);
  return cf ? `cf_${cf[1]}` : null;
}

async function gelatoRequest(
  fetchFn: typeof fetch,
  apiKey: string,
  options: GelatoClientOptions | undefined,
  operation: string,
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: Json,
): Promise<{ status: number; json: Json | null }> {
  const headers: Record<string, string> = {
    'X-API-KEY': apiKey,
    'User-Agent': GELATO_USER_AGENT,
    Accept: '*/*',
  };
  if (body) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetchFn(`${options?.baseUrl ?? GELATO_API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // Never forward the underlying error: it can include the request URL/body.
    throw new GelatoApiError(0, 'network', operation);
  }
  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new GelatoApiError(response.status, errorCodeFrom(parsed, text), operation);
  return { status: response.status, json: isObj(parsed) ? parsed : null };
}

// ── Parsing helpers ───────────────────────────────────────────────────────

/** Currency units (number or numeric string) to integer cents. */
function toCents(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function toInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

const ORDER_ID = /^[A-Za-z0-9-]{8,64}$/;

function orderPath(orderId: string): string {
  if (!ORDER_ID.test(orderId)) throw new Error('GELATO_ORDER_ID_INVALID');
  return `/orders/${orderId}`;
}

// ── Address ───────────────────────────────────────────────────────────────

export interface GelatoAddress {
  firstName: string;
  lastName: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  state?: string | null;
  postCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  email: string;
  phone?: string | null;
}

/** Trims, drops empty optionals, validates the required fields. The thrown message never contains address data. */
function buildAddress(address: GelatoAddress): Json {
  const required = {
    firstName: address.firstName,
    lastName: address.lastName,
    addressLine1: address.addressLine1,
    city: address.city,
    postCode: address.postCode,
    country: address.country,
    email: address.email,
  };
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`GELATO_ADDRESS_INVALID:${field}`);
  }
  const country = address.country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new Error('GELATO_ADDRESS_INVALID:country');
  const out: Json = {
    firstName: address.firstName.trim(),
    lastName: address.lastName.trim(),
    addressLine1: address.addressLine1.trim(),
    city: address.city.trim(),
    postCode: address.postCode.trim(),
    country,
    email: address.email.trim(),
  };
  const optional: [string, string | null | undefined][] = [
    ['addressLine2', address.addressLine2],
    ['state', address.state],
    ['phone', address.phone],
  ];
  for (const [key, value] of optional) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

// ── Quote ─────────────────────────────────────────────────────────────────

export interface GelatoItemFile {
  type: 'default' | 'back';
  url: string;
}

export interface GelatoQuoteInput {
  /** Any reference (our order id). */
  orderReferenceId: string;
  customerReferenceId: string;
  currency: string;
  recipient: GelatoAddress;
  items: {
    itemReferenceId: string;
    productUid: string;
    /** Packs. */
    quantity: number;
    /** Optional; see `QUOTE_PLACEHOLDER_FILE`. */
    files?: GelatoItemFile[];
  }[];
}

/**
 * The verified 2026-10-06 quote call sent a placeholder file per item (no real
 * print file exists at quote time). The quote does not need real artwork; we
 * keep that exact shape when the caller passes none.
 */
export const QUOTE_PLACEHOLDER_FILE: GelatoItemFile = { type: 'default', url: 'https://example.com/a.pdf' };

export interface GelatoShipmentMethod {
  uid: string | null;
  name: string;
  /** Integer cents; null = Gelato cannot price this method (not a deliverability signal). */
  priceCents: number | null;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  /** Gelato's own class (normal, express, ...), when sent. */
  type: string | null;
}

export interface GelatoQuoteEntry {
  fulfillmentCountry: string | null;
  currency: string | null;
  /** Sum of the product prices (line totals), cents; null when none was priced. */
  productsCents: number | null;
  shipmentMethods: GelatoShipmentMethod[];
}

export interface GelatoQuote {
  currency: string | null;
  quotes: GelatoQuoteEntry[];
}

function parseQuote(json: Json | null): GelatoQuote {
  if (!json || !Array.isArray(json.quotes)) throw new GelatoParseError('quote');
  const quotes: GelatoQuoteEntry[] = json.quotes.filter(isObj).map((q) => {
    const prices = (Array.isArray(q.products) ? q.products : []).filter(isObj).map((p) => toCents(p.price));
    const productsCents = prices.length > 0 && prices.every((p) => p !== null) ? (prices as number[]).reduce((a, b) => a + b, 0) : null;
    const methods = (Array.isArray(q.shipmentMethods) ? q.shipmentMethods : []).filter(isObj).map((m): GelatoShipmentMethod => ({
      uid: str(m.shipmentMethodUid),
      name: str(m.name) ?? 'Shipping',
      priceCents: toCents(m.price),
      minDeliveryDays: toInt(m.minDeliveryDays),
      maxDeliveryDays: toInt(m.maxDeliveryDays),
      type: str(m.type),
    }));
    const firstProduct = (Array.isArray(q.products) ? q.products : []).filter(isObj)[0];
    return {
      fulfillmentCountry: str(q.fulfillmentCountry),
      currency: str(firstProduct?.currency) ?? str(q.currency),
      productsCents,
      shipmentMethods: methods,
    };
  });
  return { currency: quotes.find((q) => q.currency)?.currency ?? null, quotes };
}

/** `POST /v4/orders:quote` (single quote: `allowMultipleQuotes: false`). */
export async function quoteOrder(fetchFn: typeof fetch, apiKey: string, input: GelatoQuoteInput, options?: GelatoClientOptions): Promise<GelatoQuote> {
  const { json } = await gelatoRequest(fetchFn, apiKey, options, 'quote', '/orders:quote', 'POST', {
    orderReferenceId: input.orderReferenceId,
    customerReferenceId: input.customerReferenceId,
    currency: input.currency,
    allowMultipleQuotes: false,
    recipient: buildAddress(input.recipient),
    products: input.items.map((item) => ({
      itemReferenceId: item.itemReferenceId,
      productUid: item.productUid,
      quantity: item.quantity,
      files: item.files && item.files.length > 0 ? item.files : [QUOTE_PLACEHOLDER_FILE],
    })),
  });
  return parseQuote(json);
}

// ── Orders ────────────────────────────────────────────────────────────────

/**
 * Gelato's fulfillment statuses folded into a small union. The raw string is
 * always kept next to it (`rawFulfillmentStatus`).
 *   created      the order/draft exists, nothing has happened yet
 *   pending      accepted, waiting on files, approval or payment
 *   passed       Gelato fetched the files and handed the order to production
 *   in_production  being printed
 *   printed      printed, not yet shipped
 *   shipped      with the carrier (tracking available)
 *   delivered    Gelato reports delivery (nothing in our flow depends on it)
 *   canceled     canceled by us or Gelato
 *   failed       refused or failed (file/format/destination problems)
 *   on_hold      held for attention (not_connected, pending_approval, held)
 *   unknown      a value we have not seen; callers treat it like `pending`
 */
export type GelatoFulfillmentStatus =
  | 'created'
  | 'pending'
  | 'passed'
  | 'in_production'
  | 'printed'
  | 'shipped'
  | 'delivered'
  | 'canceled'
  | 'failed'
  | 'on_hold'
  | 'unknown';

const STATUS_ALIASES: Record<string, GelatoFulfillmentStatus> = {
  created: 'created',
  draft: 'created',
  pending: 'pending',
  uploading: 'pending',
  queued: 'pending',
  passed: 'passed',
  in_production: 'in_production',
  inproduction: 'in_production',
  production: 'in_production',
  printing: 'in_production',
  printed: 'printed',
  shipped: 'shipped',
  in_transit: 'shipped',
  delivered: 'delivered',
  canceled: 'canceled',
  cancelled: 'canceled',
  failed: 'failed',
  refused: 'failed',
  rejected: 'failed',
  error: 'failed',
  on_hold: 'on_hold',
  held: 'on_hold',
  hold: 'on_hold',
  pending_approval: 'on_hold',
  not_connected: 'on_hold',
};

export function normalizeFulfillmentStatus(raw: unknown): GelatoFulfillmentStatus {
  if (typeof raw !== 'string') return 'unknown';
  return STATUS_ALIASES[raw.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? 'unknown';
}

export interface GelatoOrderItem {
  id: string | null;
  itemReferenceId: string | null;
  quantity: number | null;
  fulfillmentStatus: GelatoFulfillmentStatus;
  rawFulfillmentStatus: string | null;
  /** The file slots Gelato recorded (`default`, `back`). */
  fileTypes: string[];
}

export interface GelatoReceipt {
  type: string | null;
  currency: string | null;
  /** Prices after discounts when Gelato sends them, else the initial ones. */
  productsCents: number | null;
  shippingCents: number | null;
  totalCents: number | null;
}

export interface GelatoTracking {
  carrier: string | null;
  trackingCode: string | null;
  trackingUrl: string | null;
}

export interface GelatoOrder {
  id: string;
  /** 'draft' | 'order' (anything else is passed through). */
  orderType: string;
  isDraft: boolean;
  orderReferenceId: string | null;
  fulfillmentStatus: GelatoFulfillmentStatus;
  rawFulfillmentStatus: string | null;
  financialStatus: string | null;
  currency: string | null;
  /** Gelato's reason when it refused the order (e.g. `capability`), when sent. */
  refusalReasonCode: string | null;
  items: GelatoOrderItem[];
  receipts: GelatoReceipt[];
  shipment: {
    methodName: string | null;
    minDeliveryDate: string | null;
    maxDeliveryDate: string | null;
    fulfillmentCountry: string | null;
  } | null;
  /** Tracking entries, deduplicated; empty until the carrier has the parcel. */
  tracking: GelatoTracking[];
}

function parseTracking(order: Json): GelatoTracking[] {
  const sources: unknown[] = [order.fulfillments, order.tracking];
  for (const item of Array.isArray(order.items) ? order.items : []) {
    if (isObj(item)) sources.push(item.fulfillments, item.tracking);
  }
  const out: GelatoTracking[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const entry of Array.isArray(source) ? source : []) {
      if (!isObj(entry)) continue;
      const trackingCode = str(entry.trackingCode) ?? str(entry.trackingNumber);
      const trackingUrl = str(entry.trackingUrl);
      if (!trackingCode && !trackingUrl) continue;
      const key = `${trackingCode ?? ''}|${trackingUrl ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ carrier: str(entry.shipmentMethodName) ?? str(entry.carrier) ?? str(entry.carrierName), trackingCode, trackingUrl });
    }
  }
  return out;
}

function parseOrder(json: Json | null, operation: string): GelatoOrder {
  const id = json ? str(json.id) : null;
  if (!json || !id) throw new GelatoParseError(operation);
  const orderType = str(json.orderType) ?? 'order';
  const rawItems = (Array.isArray(json.items) ? json.items : []).filter(isObj);
  const items = rawItems.map((item): GelatoOrderItem => ({
    id: str(item.id),
    itemReferenceId: str(item.itemReferenceId),
    quantity: toInt(item.quantity),
    fulfillmentStatus: normalizeFulfillmentStatus(item.fulfillmentStatus),
    rawFulfillmentStatus: str(item.fulfillmentStatus),
    fileTypes: (Array.isArray(item.files) ? item.files : []).filter(isObj).map((f) => str(f.type)).filter((t): t is string => t !== null),
  }));
  const receipts = (Array.isArray(json.receipts) ? json.receipts : []).filter(isObj).map((r): GelatoReceipt => ({
    type: str(r.type),
    currency: str(r.currency),
    productsCents: toCents(r.productsPrice ?? r.productsPriceInitial),
    shippingCents: toCents(r.shippingPrice ?? r.shippingPriceInitial),
    totalCents: toCents(r.totalInclVat ?? r.total ?? r.totalInitial),
  }));
  const shipment = isObj(json.shipment)
    ? {
      methodName: str(json.shipment.shipmentMethodName),
      minDeliveryDate: str(json.shipment.minDeliveryDate),
      maxDeliveryDate: str(json.shipment.maxDeliveryDate),
      fulfillmentCountry: str(json.shipment.fulfillmentCountry),
    }
    : null;
  return {
    id,
    orderType,
    isDraft: orderType === 'draft',
    orderReferenceId: str(json.orderReferenceId),
    fulfillmentStatus: normalizeFulfillmentStatus(json.fulfillmentStatus),
    rawFulfillmentStatus: str(json.fulfillmentStatus),
    financialStatus: str(json.financialStatus),
    currency: str(json.currency) ?? receipts.find((r) => r.currency)?.currency ?? null,
    refusalReasonCode: str(json.refusalReasonCode) ?? rawItems.map((item) => str(item.refusalReasonCode)).find((code) => code !== null) ?? null,
    items,
    receipts,
    shipment,
    tracking: parseTracking(json),
  };
}

export interface GelatoDraftInput {
  /** Our order id (`orderReferenceId`). */
  orderReferenceId: string;
  customerReferenceId: string;
  currency: string;
  items: {
    itemReferenceId: string;
    productUid: string;
    /** Packs. */
    quantity: number;
    files: GelatoItemFile[];
  }[];
  shippingAddress: GelatoAddress;
  /** Pin a shipment method from the quote; absent = Gelato's default. */
  shipmentMethodUid?: string | null;
}

/** `POST /v4/orders` as a draft: not produced, not charged until `confirmOrder`. */
export async function createDraft(fetchFn: typeof fetch, apiKey: string, input: GelatoDraftInput, options?: GelatoClientOptions): Promise<GelatoOrder> {
  if (input.items.length === 0 || input.items.some((item) => item.files.length === 0)) throw new Error('GELATO_DRAFT_INVALID');
  const body: Json = {
    orderType: 'draft',
    orderReferenceId: input.orderReferenceId,
    customerReferenceId: input.customerReferenceId,
    currency: input.currency,
    items: input.items.map((item) => ({
      itemReferenceId: item.itemReferenceId,
      productUid: item.productUid,
      files: item.files,
      quantity: item.quantity,
    })),
    shippingAddress: buildAddress(input.shippingAddress),
  };
  if (input.shipmentMethodUid) body.shipmentMethodUid = input.shipmentMethodUid;
  const { json } = await gelatoRequest(fetchFn, apiKey, options, 'createDraft', '/orders', 'POST', body);
  return parseOrder(json, 'createDraft');
}

/** `GET /v4/orders/{id}`. */
export async function getOrder(fetchFn: typeof fetch, apiKey: string, orderId: string, options?: GelatoClientOptions): Promise<GelatoOrder> {
  const { json } = await gelatoRequest(fetchFn, apiKey, options, 'getOrder', orderPath(orderId), 'GET');
  return parseOrder(json, 'getOrder');
}

/** `PATCH /v4/orders/{id} { orderType: 'order' }`: turns the draft into a real (charged, produced) order. */
export async function confirmOrder(fetchFn: typeof fetch, apiKey: string, orderId: string, options?: GelatoClientOptions): Promise<GelatoOrder> {
  const { json } = await gelatoRequest(fetchFn, apiKey, options, 'confirmOrder', orderPath(orderId), 'PATCH', { orderType: 'order' });
  return parseOrder(json, 'confirmOrder');
}

/**
 * Idempotent confirm for webhook/sweep retries: GET first and PATCH only while
 * Gelato still reports a draft (a second PATCH on a confirmed order would be an
 * error at best). `confirmed` is true when this call did the PATCH.
 */
export async function confirmDraftIfDraft(
  fetchFn: typeof fetch,
  apiKey: string,
  orderId: string,
  options?: GelatoClientOptions,
): Promise<{ order: GelatoOrder; confirmed: boolean }> {
  const current = await getOrder(fetchFn, apiKey, orderId, options);
  if (!current.isDraft) return { order: current, confirmed: false };
  return { order: await confirmOrder(fetchFn, apiKey, orderId, options), confirmed: true };
}

/** `DELETE /v4/orders/{id}` for a draft. A draft that is already gone (404) is success. */
export async function deleteDraft(fetchFn: typeof fetch, apiKey: string, orderId: string, options?: GelatoClientOptions): Promise<{ deleted: boolean }> {
  try {
    await gelatoRequest(fetchFn, apiKey, options, 'deleteDraft', orderPath(orderId), 'DELETE');
    return { deleted: true };
  } catch (error) {
    if (error instanceof GelatoApiError && error.status === 404) return { deleted: false };
    throw error;
  }
}

/** `POST /v4/orders/{id}:cancel` for a confirmed order that is still cancellable (refunds). */
export async function cancelOrder(fetchFn: typeof fetch, apiKey: string, orderId: string, options?: GelatoClientOptions): Promise<void> {
  await gelatoRequest(fetchFn, apiKey, options, 'cancelOrder', `${orderPath(orderId)}:cancel`, 'POST', {});
}
