/**
 * Prodigi REST client for the order Workflow (spine width + order
 * submission -- the two Prodigi calls the WORKFLOW makes; the `quote` op's
 * own Prodigi call lives in `supabase/functions/_shared/prodigi.ts`, a
 * separate Deno-only copy since a Cloudflare Worker cannot import a Deno
 * module). Same facts/sources as that file (docs/plans/prodigi-order-
 * spec.md) -- kept in sync by hand; see that file's header comment for the
 * open questions this duplicates.
 */
import type { Env } from './types';

export class ProdigiApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function prodigiRequest(
  env: Env,
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${env.PRODIGI_API_BASE_URL}${path}`, {
    method,
    headers: {
      'X-API-Key': env.PRODIGI_API_KEY,
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

/** `POST /v4.0/products/spine` -- documented special-case response shape
 * (`{ success, message, spineInfo: { widthMm } }`). */
export async function getSpineWidthMm(env: Env, destinationCountryCode: string, numberOfPages: number): Promise<number> {
  const result = await prodigiRequest(env, '/v4.0/products/spine', 'POST', {
    sku: env.PRODIGI_SKU,
    destinationCountryCode,
    numberOfPages,
  });
  const spineInfo = result.spineInfo as Record<string, unknown> | undefined;
  const widthMm = Number(spineInfo?.widthMm);
  if (!Number.isFinite(widthMm) || widthMm <= 0) throw new ProdigiApiError(502, 'Prodigi spine response missing a usable widthMm');
  return widthMm;
}

export interface ProdigiRecipient {
  name: string;
  line1: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

export interface SubmitOrderInput {
  orderId: string;
  recipient: ProdigiRecipient;
  interiorPdfUrl: string;
  coverPdfUrl: string;
  shippingMethod?: string;
}

export interface SubmitOrderResult {
  prodigiOrderId: string;
}

/** `POST /v4.0/Orders` -- separate-file API setup (prodigi-order-spec.md's
 * confirmed pipeline shape): the cover file (front+back+spine) and the
 * inner-pages file are submitted as two assets. `metadata.orderId` lets a
 * support conversation cross-reference back to our order. */
export async function submitOrder(env: Env, input: SubmitOrderInput): Promise<SubmitOrderResult> {
  const result = await prodigiRequest(env, '/v4.0/Orders', 'POST', {
    shippingMethod: input.shippingMethod ?? 'Standard',
    recipient: {
      name: input.recipient.name,
      address: {
        line1: input.recipient.line1,
        line2: input.recipient.line2,
        postalOrZipCode: input.recipient.postalCode,
        countryCode: input.recipient.countryCode,
        townOrCity: input.recipient.city,
        stateOrCounty: input.recipient.state,
      },
    },
    items: [
      {
        sku: env.PRODIGI_SKU,
        copies: 1,
        // V4-proven order item shape (see _shared/prodigi.ts note).
        sizing: 'fillPrintArea',
        attributes: {},
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
  if (!prodigiOrderId) throw new ProdigiApiError(502, 'Prodigi order response missing an order id');
  return { prodigiOrderId };
}
