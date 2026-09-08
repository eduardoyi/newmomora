import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { BridgeError, loadOrder, markFailed, markSubmitted, sendOrderEmail, verifyAndPresignOutput } from './bridge';
import { fitBook, getRenderStatus, renderBook, RenderWorkerError } from './render-worker';
import { getSpineWidthMm, ProdigiApiError, submitOrder } from './prodigi';
import type { Env, OrderContext, RenderWorkerRenderResult, WorkflowDispatchPayload } from './types';

const BRIDGE_STEP_RETRIES = { limit: 3, delay: '2 seconds', backoff: 'exponential' } as const;
// Provisional -- no real render worker exists yet to measure a real
// production-scale (up to 122 pages) render duration against (mirrors
// generate-memory-book/index.ts's own "provisional, not yet measured"
// lease comment). 40 attempts * 15s = 10 minutes; revisit once step 3's
// real render worker gives a measured duration.
const RENDER_POLL_MAX_ATTEMPTS = 40;
const RENDER_POLL_INTERVAL = '15 seconds';

type FailureCode =
  | 'ORDER_LOAD_FAILED'
  | 'SPINE_LOOKUP_FAILED'
  | 'RENDER_FAILED'
  | 'RENDER_TIMEOUT'
  | 'RENDER_OUTPUT_MISMATCH'
  | 'VERIFY_OUTPUT_FAILED'
  | 'PRODIGI_SUBMIT_FAILED'
  | 'UNKNOWN_ERROR';

// Each class prefixes its failure code into the MESSAGE, because the
// message is the only thing guaranteed to survive Cloudflare's step
// boundary (class identity and custom fields do not — canary finding).
class OrderLoadError extends Error { constructor(m: string) { super(`[ORDER_LOAD_FAILED] ${m}`); } }
class SpineLookupError extends Error { constructor(m: string) { super(`[SPINE_LOOKUP_FAILED] ${m}`); } }
class RenderStageError extends Error { constructor(m: string) { super(`[RENDER_FAILED] ${m}`); } }
class RenderTimeoutError extends Error { constructor(m: string) { super(`[RENDER_TIMEOUT] ${m}`); } }
class RenderOutputMismatchError extends Error { constructor(m: string) { super(`[RENDER_OUTPUT_MISMATCH] ${m}`); } }
class VerifyOutputError extends Error { constructor(m: string) { super(`[VERIFY_OUTPUT_FAILED] ${m}`); } }
class ProdigiSubmitError extends Error { constructor(m: string) { super(`[PRODIGI_SUBMIT_FAILED] ${m}`); } }

const FAILURE_CODES: FailureCode[] = [
  'ORDER_LOAD_FAILED', 'SPINE_LOOKUP_FAILED', 'RENDER_TIMEOUT',
  'RENDER_OUTPUT_MISMATCH', 'RENDER_FAILED', 'VERIFY_OUTPUT_FAILED',
  'PRODIGI_SUBMIT_FAILED',
];

function errorCode(error: unknown): FailureCode {
  if (error instanceof OrderLoadError || error instanceof NonRetryableError) return 'ORDER_LOAD_FAILED';
  if (error instanceof SpineLookupError) return 'SPINE_LOOKUP_FAILED';
  if (error instanceof RenderTimeoutError) return 'RENDER_TIMEOUT';
  if (error instanceof RenderOutputMismatchError) return 'RENDER_OUTPUT_MISMATCH';
  if (error instanceof RenderStageError) return 'RENDER_FAILED';
  if (error instanceof VerifyOutputError) return 'VERIFY_OUTPUT_FAILED';
  if (error instanceof ProdigiSubmitError) return 'PRODIGI_SUBMIT_FAILED';
  // Class identity does NOT survive Cloudflare's step-retry boundary (the
  // canary's every failure surfaced as UNKNOWN_ERROR despite the taxonomy
  // above). The step errors' MESSAGES do survive — each custom error class
  // prefixes its code (see constructors below), so parse it back out.
  const message = error instanceof Error ? error.message : '';
  for (const code of FAILURE_CODES) {
    if (message.includes(`[${code}]`)) return code;
  }
  return 'UNKNOWN_ERROR';
}

/** Never forward a raw caught error's message into a persisted field or
 * console line -- mirrors memory-book-worker's `errorMessageOnly` (no
 * memory content ever, and here also no address/payment content). */
function errorMessageOnly(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown_error';
}

function mapRecipient(address: OrderContext['shippingAddress']) {
  return {
    name: address.name,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

export class MemoryBookOrderWorkflow extends WorkflowEntrypoint<Env, WorkflowDispatchPayload> {
  async run(event: Readonly<WorkflowEvent<WorkflowDispatchPayload>>, step: WorkflowStep) {
    const { orderId, attemptId } = event.payload;

    try {
      // ── step 1: load the frozen snapshot + quote. The bridge re-verifies
      // status = 'rendering' AND workflow_attempt_id = attemptId before
      // returning anything -- a superseded/failed attempt bails here,
      // before any render-worker or Prodigi call. ──────────────────────────
      const order = await step.do(
        'load order',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async (): Promise<OrderContext> => {
          try {
            const result = await loadOrder(this.env, orderId, attemptId);
            return result.order;
          } catch (error) {
            if (error instanceof BridgeError && !error.retryable) {
              throw new NonRetryableError(errorMessageOnly(error));
            }
            throw new OrderLoadError(errorMessageOnly(error));
          }
        },
      );

      // ── step 2: re-fit the FROZEN snapshot (Design Decision 2's "quote's
      // /fit is untrusted client money, re-verify at payment time"). A
      // divergence from the quoted count is ALARMED, never a hard failure
      // -- the order still ships, using the FRESH (correct) count for
      // spine/print, per the plan's explicit "alarms on divergence" (not
      // "fails on divergence"). The alarm email send is itself best-effort
      // and cannot fail this step. ──────────────────────────────────────────
      const freshPageCount = await step.do(
        're-fit frozen snapshot',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '60 seconds' },
        async () => {
          const fit = await fitBook(this.env, order.bookDocumentSnapshot, order.editsSnapshot);
          if (fit.pageCount !== order.quotedPageCount) {
            try {
              await sendOrderEmail(
                this.env,
                orderId,
                'owner_alarm',
                `Page count diverged from the quote: quoted ${order.quotedPageCount}, re-fit ${fit.pageCount}. Proceeding with the re-fit count for print.`,
              );
            } catch {
              // best-effort -- never fail the render pipeline over a
              // notification.
            }
          }
          return fit.pageCount;
        },
      );

      // ── step 3: Prodigi spine width for the FRESH page count. ─────────────
      const spineMm = await step.do(
        'get spine width',
        { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
        async () => {
          try {
            return await getSpineWidthMm(this.env, order.shippingAddress.countryCode, freshPageCount);
          } catch (error) {
            throw new SpineLookupError(errorMessageOnly(error));
          }
        },
      );

      // ── step 4: dispatch the render, then poll GET /status in normal
      // short steps until done/failed (Design Decision 3: /render is async
      // by contract -- a real render can run minutes, past a single step's
      // timeout). ────────────────────────────────────────────────────────
      let renderResult: RenderWorkerRenderResult = await step.do(
        'render: dispatch',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
        async () => {
          try {
            return await renderBook(this.env, {
              orderId,
              attemptId,
              bookDocument: order.bookDocumentSnapshot,
              edits: order.editsSnapshot,
              spineMm,
            });
          } catch (error) {
            throw new RenderStageError(errorMessageOnly(error));
          }
        },
      );

      let pollAttempt = 0;
      while (renderResult.state !== 'done' && renderResult.state !== 'failed' && pollAttempt < RENDER_POLL_MAX_ATTEMPTS) {
        await step.sleep(`render: wait ${pollAttempt}`, RENDER_POLL_INTERVAL);
        renderResult = await step.do(
          `render: poll status ${pollAttempt}`,
          { retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
          async () => {
            try {
              return await getRenderStatus(this.env, orderId, attemptId);
            } catch (error) {
              throw new RenderStageError(errorMessageOnly(error));
            }
          },
        );
        pollAttempt += 1;
      }

      if (renderResult.state === 'failed') {
        throw new RenderStageError(renderResult.errorCode ?? 'RENDER_FAILED');
      }
      if (renderResult.state !== 'done') {
        throw new RenderTimeoutError('render did not complete within the poll budget');
      }
      if (!renderResult.interiorKey || !renderResult.coverKey) {
        throw new RenderStageError('render completed without output keys');
      }
      // Size/existence sanity happens in the bridge's HEAD checks (step 5);
      // this is the page-count sanity half (Design Decision 2: "THE page
      // count" feeds quote, spine, AND submission from the same source --
      // a render worker that returns a DIFFERENT count than what /fit and
      // the spine lookup used would silently ship a mismatched spine).
      if (typeof renderResult.pageCount === 'number' && renderResult.pageCount !== freshPageCount) {
        throw new RenderOutputMismatchError(`render pageCount ${renderResult.pageCount} != re-fit pageCount ${freshPageCount}`);
      }

      // ── step 5: verify (HEAD R2, size sanity) + presign 7-day URLs. ───────
      const output = await step.do(
        'verify and presign output',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async () => {
          try {
            return await verifyAndPresignOutput(this.env, orderId, attemptId, renderResult.interiorKey!, renderResult.coverKey!);
          } catch (error) {
            throw new VerifyOutputError(errorMessageOnly(error));
          }
        },
      );

      // ── step 6: submit the Prodigi order. ─────────────────────────────────
      const prodigiOrderId = await step.do(
        'submit prodigi order',
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '30 seconds' },
        async () => {
          try {
            const result = await submitOrder(this.env, {
              orderId,
              recipient: mapRecipient(order.shippingAddress),
              interiorPdfUrl: output.interiorUrl,
              coverPdfUrl: output.coverUrl,
              pageCount: freshPageCount,
            });
            return result.prodigiOrderId;
          } catch (error) {
            if (error instanceof ProdigiApiError || error instanceof RenderWorkerError) {
              throw new ProdigiSubmitError(errorMessageOnly(error));
            }
            throw new ProdigiSubmitError(errorMessageOnly(error));
          }
        },
      );

      // ── step 7: CAS rendering -> submitted. ───────────────────────────────
      await step.do(
        'mark submitted',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async () => await markSubmitted(this.env, orderId, attemptId, prodigiOrderId),
      );

      // ── step 8: paid-confirmation (buyer) + owner spot-check alarm email
      // (soft-launch human QA, per the plan's risk mitigation for the lost
      // 2h order-edit window). Both best-effort -- a failed send must never
      // undo an already-submitted, already-paid-for order. ─────────────────
      await step.do(
        'send order emails',
        { retries: { limit: 1, delay: '2 seconds' }, timeout: '15 seconds' },
        async () => {
          try {
            await sendOrderEmail(this.env, orderId, 'paid_confirmation');
          } catch {
            // best-effort
          }
          try {
            await sendOrderEmail(this.env, orderId, 'owner_alarm', undefined, {
              interiorUrl: output.interiorUrl,
              coverUrl: output.coverUrl,
            });
          } catch {
            // best-effort
          }
          return { sent: true };
        },
      );

      return { orderId, status: 'submitted' as const };
    } catch (error) {
      const code = errorCode(error);
      // Persist code + surviving message detail (sanitized, truncated) —
      // the canary spent hours on bare UNKNOWN_ERRORs.
      const detail = errorMessageOnly(error).replace(/^\[[A-Z_]+\] /, '');
      const reason = `${code}: ${detail}`.slice(0, 300);
      await step.do(
        'record order failure',
        { retries: BRIDGE_STEP_RETRIES, timeout: '30 seconds' },
        async () => await markFailed(this.env, orderId, attemptId, reason),
      );
      try {
        await step.do(
          'send failure alarm email',
          { retries: { limit: 1, delay: '2 seconds' }, timeout: '15 seconds' },
          async () => {
            await sendOrderEmail(this.env, orderId, 'owner_alarm', `Order failed at code ${code}. Payment was captured -- refund or retry manually.`);
            return { sent: true };
          },
        );
      } catch {
        // best-effort
      }
      return { orderId, status: 'failed' as const, code };
    }
  }
}
