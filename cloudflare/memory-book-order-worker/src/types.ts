/**
 * Shared types for the Memory Book order Cloudflare Workflow
 * (memory-book-5c plan, Design Decision 4). Mirrors
 * cloudflare/memory-book-worker/src/types.ts's conventions: the Workflow
 * event payload stays ID-only (never PII/payment/address content), and
 * every bridge/render-worker/Prodigi response type is validated at the
 * call site -- never trusted blind.
 */

export interface Env {
  ENVIRONMENT: string;
  SUPABASE_BRIDGE_URL: string;
  DISPATCH_SIGNING_SECRET: string;
  SUPABASE_BRIDGE_HMAC_SECRET: string;
  RENDER_WORKER_URL: string;
  RENDER_WORKER_HMAC_SECRET: string;
  PRODIGI_API_BASE_URL: string;
  PRODIGI_API_KEY: string;
  PRODIGI_SKU: string;
  MEMORY_BOOK_ORDER_WORKFLOW: Workflow;
}

/** The Workflow event payload -- deliberately ID-only, mirroring
 * memory-book-worker's WorkflowDispatchPayload. `orderId` is the stable
 * `memory_book_orders.id`; `attemptId` is the CAS token minted by
 * stripe-webhook (or the sweep's redispatch) for THIS attempt -- == the
 * Workflow instance id, == `workflow_attempt_id`/`workflow_instance_id`.
 * Every private input (frozen book document, address, price) is fetched
 * fresh from the signed bridge inside a step, never carried in this
 * event. */
export interface WorkflowDispatchPayload {
  orderId: string;
  attemptId: string;
}

export const WORKFLOW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Bridge operation payloads/responses ────────────────────────────────────

export type BridgeOperation = 'load_order' | 'verify_and_presign_output' | 'mark_submitted' | 'mark_failed' | 'send_order_email';

/** A `step.do` return value must be RPC-serializable (Cloudflare
 * Workflows' `Rpc.Serializable<T>` constraint), which `unknown` does not
 * satisfy. A genuinely recursive JSON type (`string | number | ... |
 * JsonValue[] | { [k: string]: JsonValue }`) hits a SEPARATE TypeScript
 * limitation instead ("Type instantiation is excessively deep") once
 * `Serializable<T>`'s own mapped-type recursion is layered on top of it.
 * `eslint-disable`-style escape hatch: these two fields are `any` on
 * purpose -- this Worker never reads INTO their structure, only passes
 * them through opaquely (book document + edits) to the render worker's
 * `/fit`/`/render` calls (see workflow.ts) and to Prodigi/email payloads
 * it never touches, so there is no real type safety being given up here,
 * only a `Serializable<T>` typechecking workaround for arbitrarily-shaped
 * pass-through JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpaqueJson = any;

export interface OrderContext {
  id: string;
  bookId: string;
  bookDocumentSnapshot: OpaqueJson;
  editsSnapshot: OpaqueJson;
  quotedPageCount: number;
  priceCents: number;
  shippingCostCents: number;
  currency: string;
  shippingAddress: {
    name: string;
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode: string;
    countryCode: string;
  };
}

export interface LoadOrderResponse {
  order: OrderContext;
}

export interface VerifyAndPresignOutputResponse {
  interiorUrl: string;
  coverUrl: string;
  interiorSize: number;
  coverSize: number;
}

export interface MarkSubmittedResponse {
  submitted: boolean;
}

export interface MarkFailedResponse {
  failed: boolean;
}

export interface SendOrderEmailResponse {
  sent: boolean;
}

// ── Render worker response shapes (plan Design Decision 2/3) ──────────────

export interface RenderWorkerFitResult {
  /** THE page count -- SUBMITTED-INTERIOR count, post front-matter-verso
   * drop, even-enforced. */
  pageCount: number;
}

export type RenderWorkerRenderState = 'accepted' | 'in_progress' | 'done' | 'failed';

export interface RenderWorkerRenderResult {
  state: RenderWorkerRenderState;
  interiorKey?: string;
  coverKey?: string;
  pageCount?: number;
  interiorChecksum?: string;
  coverChecksum?: string;
  errorCode?: string;
}
