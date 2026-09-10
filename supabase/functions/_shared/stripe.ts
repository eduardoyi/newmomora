/**
 * Minimal Stripe REST client (memory-book-5c plan, Design Decision 4):
 * fetch + secret key, no heavy SDK, per the plan's explicit instruction
 * ("Stripe's REST API directly (fetch + secret key; no heavy SDK unless the
 * repo pattern prefers one)") -- this repo has no existing Stripe usage
 * anywhere (see the plan's own "Context" section), so there is no pattern to
 * match; every other webhook-shaped Edge Function in this repo (RevenueCat,
 * billing) also talks to its provider via plain `fetch`, so this keeps that
 * convention rather than introducing the `stripe` npm package as this
 * change's one new heavy dependency.
 *
 * Two responsibilities:
 *  - `createStripeCustomer` / `createCheckoutSession`: build a Checkout
 *    Session with the quote's price + shipping baked in as line items, the
 *    quoted address pinned onto a Customer (so Stripe Tax computes VAT
 *    against the REAL destination without Checkout's own
 *    `shipping_address_collection` ever being enabled -- see
 *    memory-book-orders/index.ts's `create_checkout` op).
 *  - `verifyStripeSignature`: WebCrypto reimplementation of Stripe's
 *    documented `Stripe-Signature` HMAC-SHA256 scheme (constructEvent) --
 *    https://docs.stripe.com/webhooks#verify-manually -- Deno Edge
 *    Functions have no Node `crypto` module, so this mirrors the exact
 *    approach `cloudflare/memory-book-worker/src/crypto.ts` already uses for
 *    a different HMAC scheme in this repo (WebCrypto `crypto.subtle`, hex
 *    digest, constant-time compare).
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
// Pinned to the account's own version (2026-08-26.dahlia — the default the
// account received at creation; webhook endpoint uses the same). Keep the
// two in lockstep when upgrading: Workbench shows the account version.
const STRIPE_API_VERSION = '2026-08-26.dahlia';

export interface StripeAddressInput {
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode: string;
  countryCode: string;
}

export class StripeApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Stripe's form-encoding: nested objects/arrays become `key[subkey]` /
 * `key[]` pairs. Recursing here (rather than hand-building every call site's
 * body string) keeps `createCheckoutSession`'s params readable as a plain
 * nested object, matching how Stripe's own docs express request shapes.
 */
function appendFormEntries(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendFormEntries(params, `${key}[${index}]`, item));
    return;
  }
  if (typeof value === 'object') {
    for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
      appendFormEntries(params, `${key}[${subKey}]`, subValue);
    }
    return;
  }
  params.append(key, String(value));
}

function encodeFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    appendFormEntries(params, key, value);
  }
  return params.toString();
}

async function stripeRequest(
  fetchFn: typeof fetch,
  secretKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${STRIPE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': STRIPE_API_VERSION,
    },
    body: encodeFormBody(body),
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof json.error === 'object' && json.error !== null && 'message' in json.error
      ? String((json.error as Record<string, unknown>).message)
      : `Stripe request failed (${response.status})`;
    throw new StripeApiError(response.status, message);
  }
  return json;
}

export interface CreateStripeCustomerInput {
  email: string;
  address: StripeAddressInput;
}

/** Returns the Customer id. Creating a fresh Customer per order (never
 * reused across orders) keeps the quoted address as the single source of
 * truth for Stripe Tax on THIS purchase -- see `create_checkout`'s header
 * comment for why re-collecting an address via Checkout itself is exactly
 * what Design Decision 4 disables. */
export async function createStripeCustomer(
  fetchFn: typeof fetch,
  secretKey: string,
  input: CreateStripeCustomerInput,
): Promise<string> {
  const result = await stripeRequest(fetchFn, secretKey, '/customers', {
    email: input.email,
    address: {
      line1: input.address.line1,
      line2: input.address.line2 ?? undefined,
      city: input.address.city ?? undefined,
      state: input.address.state ?? undefined,
      postal_code: input.address.postalCode,
      country: input.address.countryCode,
    },
  });
  return String(result.id);
}

export interface CreateCheckoutSessionInput {
  customerId: string;
  orderId: string;
  priceCents: number;
  shippingCostCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutSessionResult {
  sessionId: string;
  url: string | null;
}

/**
 * `shipping_address_collection` is deliberately OMITTED (Stripe only
 * collects a shipping address on Checkout when that param is explicitly
 * set -- there is no `{ enabled: false }` toggle, so omission IS "disabled"
 * per the plan's Design Decision 4). Instead the quoted address travels via
 * `customer` (see `createStripeCustomer`) with `automatic_tax.enabled` so
 * Stripe Tax computes VAT against the address we already quoted shipping
 * for, never a second address Checkout's own UI could otherwise collect.
 */
export async function createCheckoutSession(
  fetchFn: typeof fetch,
  secretKey: string,
  input: CreateCheckoutSessionInput,
): Promise<CreateCheckoutSessionResult> {
  const result = await stripeRequest(fetchFn, secretKey, '/checkout/sessions', {
    mode: 'payment',
    customer: input.customerId,
    customer_update: { shipping: 'auto' },
    line_items: [
      {
        price_data: {
          currency: input.currency,
          // txcd_35010000 = Books ("bound in a stiffer cover than the
          // pages" -- a layflat hardcover exactly). CORRECTED 2026-09-10:
          // the canary-era value txcd_35020200 was believed to be printed
          // books but is actually PERIODICALS (magazines) -- owner-caught
          // in the dashboard's tax-code picker during Stripe activation.
          // Books/periodicals VAT rates differ across the EU, so the
          // distinction is real money, not taxonomy. Also learned there:
          // the whole printed-matter family (Books, Periodicals, Printing)
          // is INELIGIBLE for Managed Payments, so the LLC stays merchant
          // of record and Stripe Tax does calculation only.
          product_data: { name: 'Momora Memory Book', tax_code: 'txcd_35010000' },
          unit_amount: input.priceCents,
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: input.currency,
          // txcd_92010001 = shipping.
          product_data: { name: 'Shipping', tax_code: 'txcd_92010001' },
          unit_amount: input.shippingCostCents,
        },
        quantity: 1,
      },
    ],
    // Canary finding: new accounts enable Managed Payments (Stripe as
    // merchant of record) by default. The 5c design is us-as-MoR with
    // Stripe Tax (hardened plan Decision 4/round-3); disable per-session.
    // Revisit deliberately at launch — Managed Payments may genuinely fit
    // a global physical-goods launch better (owner decision, logged).
    managed_payments: { enabled: false },
    // Stripe Tax requires an ACTIVATED account (head-office address).
    // Until activation (a launch prerequisite — legal entity, bank,
    // verification), STRIPE_AUTOMATIC_TAX=disabled lets test-mode
    // canaries run. Default is enabled: forgetting the env at launch
    // fails loud in checkout, never silently untaxed.
    automatic_tax: { enabled: Deno.env.get('STRIPE_AUTOMATIC_TAX') !== 'disabled' },
    metadata: { orderId: input.orderId },
    payment_intent_data: { metadata: { orderId: input.orderId } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  return {
    sessionId: String(result.id),
    url: typeof result.url === 'string' ? result.url : null,
  };
}

// ── Webhook signature verification ──────────────────────────────────────

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const toDigest = (value: string): { bytes: Uint8Array; valid: boolean } => {
    const bytes = new Uint8Array(32);
    const valid = /^[0-9a-f]{64}$/i.test(value);
    if (!valid) return { bytes, valid: false };
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return { bytes, valid: true };
  };
  const a = toDigest(left);
  const b = toDigest(right);
  let diff = 0;
  for (let index = 0; index < a.bytes.length; index += 1) diff |= a.bytes[index] ^ b.bytes[index];
  return a.valid && b.valid && diff === 0;
}

/** Parses a `Stripe-Signature` header (`t=<ts>,v1=<sig>[,v1=<sig>...]`) into
 * its timestamp and every v1 candidate signature -- Stripe can send more
 * than one v1 value during a signing-secret rotation, and a request is
 * valid if ANY of them match (Stripe's own documented behavior). */
function parseStripeSignatureHeader(header: string): { timestamp: string; signatures: string[] } | null {
  const parts = header.split(',').map((part) => part.trim());
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = value;
    else if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Verifies a raw webhook body against Stripe's `Stripe-Signature` header,
 * per https://docs.stripe.com/webhooks#verify-manually's documented
 * `t.<payload>` HMAC-SHA256 scheme: reimplemented with WebCrypto rather than
 * Stripe's `stripe.webhooks.constructEvent` (the plan's "no heavy SDK"
 * instruction) or Node's `crypto` module (unavailable to a Deno Edge
 * Function the way `cloudflare/memory-book-worker/src/crypto.ts` already
 * establishes for this repo's OTHER HMAC scheme). Returns the parsed event
 * only once the signature AND timestamp tolerance both pass -- never
 * trusts the body before that.
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = Date.now(),
): Promise<StripeEvent | null> {
  if (!signatureHeader) return null;
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!parsed) return null;

  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) return null;
  if (Math.abs(now / 1000 - timestampSeconds) > toleranceSeconds) return null;

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  const matched = parsed.signatures.some((candidate) => timingSafeEqualHex(expected, candidate.toLowerCase()));
  if (!matched) return null;

  try {
    const parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    if (
      typeof parsedBody.id !== 'string' ||
      typeof parsedBody.type !== 'string' ||
      typeof parsedBody.data !== 'object' ||
      parsedBody.data === null ||
      typeof (parsedBody.data as Record<string, unknown>).object !== 'object'
    ) {
      return null;
    }
    return parsedBody as unknown as StripeEvent;
  } catch {
    return null;
  }
}
