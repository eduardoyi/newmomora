/**
 * Minimal Prodigi REST client (memory-book-5c plan, Design Decision 4).
 * Plain `fetch`, matching `stripe.ts`'s "no heavy SDK" convention -- Prodigi
 * has no official JS SDK anyway. Facts (endpoints, request/response shapes,
 * the confirmed SKU) are sourced from docs/plans/prodigi-order-spec.md; see
 * that doc's "Open questions for support" section for what is still
 * inference rather than a confirmed field name (flagged inline below where
 * it matters).
 *
 * `PRODIGI_API_BASE_URL` env var switches sandbox
 * (`https://api.sandbox.prodigi.com`) vs production
 * (`https://api.prodigi.com`) -- sandbox is free and never charges/fulfills
 * (prodigi-order-spec.md §5), so every non-canary path in this repo must
 * default to it until the owner explicitly promotes to production.
 */

export const PRODIGI_CONFIRMED_SKU = 'BOOK-FE-8_3-SQ-LF-G';

export class ProdigiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function prodigiRequest(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof json.message === 'string' ? json.message : `Prodigi request failed (${response.status})`;
    throw new ProdigiApiError(response.status, message);
  }
  return json;
}

export interface ProdigiQuoteInput {
  sku: string;
  destinationCountryCode: string;
  shippingMethod: string;
  copies?: number;
  /** Best-effort per prodigi-order-spec.md §6 ("`numberOfPages` in the
   * item's attributes") -- the exact attribute KEY (`pageCount` here) is
   * NOT confirmed against a real Prodigi response; flagged as an open
   * question in that doc (#2/#3). Revisit once the owner's sandbox key
   * confirms the real attribute name. */
  numberOfPages: number;
}

export interface ProdigiQuoteResult {
  itemsCostCents: number;
  shippingCostCents: number;
  currency: string;
}

function parseMoneyToCents(value: unknown): number {
  if (typeof value === 'object' && value !== null && 'amount' in value) {
    const amount = Number((value as { amount: unknown }).amount);
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  }
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/** `POST /v4.0/quotes` -- price-only dry run, works in sandbox with no
 * charge (prodigi-order-spec.md §6). Requests `currencyCode: 'USD'`
 * (best-effort -- matches the plan's owner decision to keep Prodigi's own
 * billing currency, no fx spread; unconfirmed whether the field name is
 * exactly `currencyCode`, revisit at the real-order canary). */
export async function getProdigiQuote(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  input: ProdigiQuoteInput,
): Promise<ProdigiQuoteResult> {
  const result = await prodigiRequest(fetchFn, baseUrl, apiKey, '/v4.0/quotes', 'POST', {
    shippingMethod: input.shippingMethod,
    destinationCountryCode: input.destinationCountryCode,
    currencyCode: 'USD',
    items: [
      {
        sku: input.sku,
        copies: input.copies ?? 1,
        attributes: { pageCount: String(input.numberOfPages) },
      },
    ],
  });

  const quotes = Array.isArray(result.quotes) ? result.quotes : [result];
  const quote = (quotes[0] ?? {}) as Record<string, unknown>;
  const costSummary = (quote.costSummary ?? {}) as Record<string, unknown>;
  const items = costSummary.items as Record<string, unknown> | undefined;
  const shipping = costSummary.shipping as Record<string, unknown> | undefined;
  const currency = typeof items?.currency === 'string'
    ? items.currency
    : typeof shipping?.currency === 'string'
      ? shipping.currency
      : 'USD';

  return {
    itemsCostCents: parseMoneyToCents(items?.amount ?? items),
    shippingCostCents: parseMoneyToCents(shipping?.amount ?? shipping),
    currency: currency.toLowerCase(),
  };
}

export interface ProdigiSpineInput {
  sku: string;
  destinationCountryCode: string;
  numberOfPages: number;
}

/** `POST /v4.0/products/spine` -- documented special-case response shape
 * (`{ success, message, spineInfo: { widthMm } }`, NOT the standard outcome
 * envelope every other Prodigi endpoint uses -- prodigi-order-spec.md §3). */
export async function getProdigiSpineWidthMm(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  input: ProdigiSpineInput,
): Promise<number> {
  const result = await prodigiRequest(fetchFn, baseUrl, apiKey, '/v4.0/products/spine', 'POST', {
    sku: input.sku,
    destinationCountryCode: input.destinationCountryCode,
    numberOfPages: input.numberOfPages,
  });
  const spineInfo = result.spineInfo as Record<string, unknown> | undefined;
  const widthMm = Number(spineInfo?.widthMm);
  if (!Number.isFinite(widthMm) || widthMm <= 0) {
    throw new ProdigiApiError(502, 'Prodigi spine response missing a usable widthMm');
  }
  return widthMm;
}

export interface ProdigiRecipient {
  name: string;
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode: string;
  countryCode: string;
  email?: string | null;
}

export interface ProdigiSubmitOrderInput {
  sku: string;
  shippingMethod: string;
  recipient: ProdigiRecipient;
  /** Separate-file API setup (prodigi-order-spec.md "Round-22" section --
   * the confirmed pipeline shape): a cover file (front+back+spine) and a
   * separate inner-pages file, submitted as two assets. Print area NAMES
   * (`default` for interior, `cover` for the cover file) are inferred from
   * the spec doc's generic `printArea` example ("default", "spine") and
   * are NOT independently confirmed for this exact two-file submission
   * mode -- flagged in that doc's own open questions (#3); the real-order
   * canary (plan step 7) is the actual confirmation point.
   */
  interiorPdfUrl: string;
  coverPdfUrl: string;
  orderId: string;
}

export interface ProdigiSubmitOrderResult {
  prodigiOrderId: string;
  status: string;
}

/** `POST /v4.0/Orders` -- `metadata` carries our `orderId` for
 * cross-reference (the sweep's own polling keys off `prodigi_order_id`
 * going forward, but a support conversation about a specific order needs
 * this the other direction too). */
export async function submitProdigiOrder(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  input: ProdigiSubmitOrderInput,
): Promise<ProdigiSubmitOrderResult> {
  const result = await prodigiRequest(fetchFn, baseUrl, apiKey, '/v4.0/Orders', 'POST', {
    shippingMethod: input.shippingMethod,
    recipient: {
      name: input.recipient.name,
      email: input.recipient.email ?? undefined,
      address: {
        line1: input.recipient.line1,
        line2: input.recipient.line2 ?? undefined,
        postalOrZipCode: input.recipient.postalCode,
        countryCode: input.recipient.countryCode,
        townOrCity: input.recipient.city ?? undefined,
        stateOrCounty: input.recipient.state ?? undefined,
      },
    },
    items: [
      {
        sku: input.sku,
        copies: 1,
        assets: [
          { printArea: 'default', url: input.interiorPdfUrl },
          { printArea: 'cover', url: input.coverPdfUrl },
        ],
      },
    ],
    metadata: { orderId: input.orderId },
  });
  const order = (result.order ?? result) as Record<string, unknown>;
  const prodigiOrderId = typeof order.id === 'string' ? order.id : null;
  if (!prodigiOrderId) {
    throw new ProdigiApiError(502, 'Prodigi order response missing an order id');
  }
  return {
    prodigiOrderId,
    status: typeof order.status === 'object' && order.status !== null && 'stage' in order.status
      ? String((order.status as Record<string, unknown>).stage)
      : 'unknown',
  };
}

export interface ProdigiOrderStatus {
  prodigiOrderId: string;
  stage: string;
  shipments: Array<{ carrier?: string; trackingUrl?: string | null; trackingNumber?: string | null }>;
}

/** `GET /v4.0/Orders/{id}` -- used by the sweep to advance
 * submitted -> in_production -> shipped -> delivered (docs/features/
 * memory-book-orders.md's Sweep contract). */
export async function getProdigiOrderStatus(
  fetchFn: typeof fetch,
  baseUrl: string,
  apiKey: string,
  prodigiOrderId: string,
): Promise<ProdigiOrderStatus> {
  const result = await prodigiRequest(
    fetchFn,
    baseUrl,
    apiKey,
    `/v4.0/Orders/${encodeURIComponent(prodigiOrderId)}`,
    'GET',
  );
  const order = (result.order ?? result) as Record<string, unknown>;
  const status = order.status as Record<string, unknown> | undefined;
  const shipments = Array.isArray(order.shipments) ? order.shipments as Array<Record<string, unknown>> : [];
  return {
    prodigiOrderId,
    stage: typeof status?.stage === 'string' ? status.stage : 'unknown',
    shipments: shipments.map((shipment) => ({
      carrier: typeof shipment.carrier === 'string' ? shipment.carrier : undefined,
      trackingUrl: typeof shipment.trackingUrl === 'string' ? shipment.trackingUrl : null,
      trackingNumber: typeof shipment.trackingNumber === 'string' ? shipment.trackingNumber : null,
    })),
  };
}
