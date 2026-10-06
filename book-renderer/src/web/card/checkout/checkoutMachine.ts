import type { CardShippingAddress } from '../../order/cardAddress';
import type { CardOrderQuote, Packs } from './checkoutTypes';
import { describeCheckoutError, isStillPreparing, type DescribableError, type ErrorView } from './errorCopy';

/**
 * The card checkout's states and transitions as a PURE reducer (docs/plans/
 * holiday-cards-p2.md Step 5), so every path (including the timeout / backoff
 * loop around `create_checkout`) unit-tests without React or a network. The
 * screen runs the effects (the calls, the timers) and dispatches the results;
 * time enters only through event fields (`now`), never `Date.now()` here.
 *
 *   starting -> quantity -> address -> quoting -> summary -> creating -> redirecting
 *
 * `creating` is where `create_checkout` runs (a second or two: the print files
 * are rendered after payment). A client timeout, a dropped connection or the server's "still
 * preparing" (409 CHECKOUT_IN_PROGRESS) do not fail it: the screen waits
 * (5, 10, 20, 30 s, then 30 s again) and calls again, which resumes the order
 * already in `checkout`. After ~3 minutes it gives up back on the summary with
 * a retry button. Any other error returns to the summary (or, on a resume with
 * no summary behind it, to `failed`) with its copy and recovery action.
 */

/** Waits between `create_checkout` re-calls; the last value repeats. */
export const BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 30_000];
/** Stop re-calling this long after the first call started. */
export const GIVE_UP_AFTER_MS = 3 * 60_000;

export function backoffDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)];
}

export const GAVE_UP_ERROR: ErrorView = {
  code: 'timeout',
  message: 'This is taking longer than expected. Nothing has been charged. Please try again.',
  action: 'retry',
};

export type CheckoutStep =
  /** Creating (or finding) the draft order. */
  | { kind: 'starting' }
  /** Nothing to continue from: the draft could not be created, or a resumed checkout failed. */
  | { kind: 'failed'; error: ErrorView; resume: { orderId: string; expectedVersion: number } | null }
  | { kind: 'quantity'; orderId: string; packs: Packs | null }
  | { kind: 'address'; orderId: string; packs: Packs; address: CardShippingAddress | null; error: ErrorView | null }
  | { kind: 'quoting'; orderId: string; packs: Packs; address: CardShippingAddress }
  | { kind: 'summary'; orderId: string; packs: Packs; address: CardShippingAddress; quote: CardOrderQuote; error: ErrorView | null }
  | {
      kind: 'creating';
      orderId: string;
      /** The summary to fall back to on an error (null when resuming a checkout that was already open). */
      back: { packs: Packs; address: CardShippingAddress; quote: CardOrderQuote } | null;
      /** The edits version the buyer reviewed; every re-call sends the same one. */
      expectedVersion: number;
      startedAt: number;
      /** Re-calls made so far (0 = the first call). */
      attempt: number;
      /** True while waiting out the backoff, false while a call is in flight. */
      waiting: boolean;
      delayMs: number;
    }
  | { kind: 'redirecting'; url: string };

export interface CheckoutModel {
  step: CheckoutStep;
  /** Bumps whenever a call or timer must (re)start, so an effect keyed on it runs once per attempt (StrictMode-safe). */
  run: number;
  /** The card was already ordered (a reorder): its QR cannot be changed. */
  locked: boolean;
}

export type CheckoutEvent =
  | { type: 'START_OK'; orderId: string }
  | { type: 'START_FAILED'; error: DescribableError }
  /** Resume an order already in `checkout` (a "Continue checkout"). */
  | { type: 'RESUME'; orderId: string; expectedVersion: number; now: number }
  | { type: 'RETRY_START' }
  | { type: 'PICK_PACKS'; packs: Packs }
  | { type: 'CONTINUE_QUANTITY' }
  | { type: 'GO_QUANTITY' }
  | { type: 'GO_ADDRESS' }
  | { type: 'ADDRESS_SUBMITTED'; address: CardShippingAddress }
  | { type: 'QUOTE_OK'; quote: CardOrderQuote }
  | { type: 'QUOTE_FAILED'; error: DescribableError }
  | { type: 'PAY'; expectedVersion: number; now: number }
  | { type: 'CHECKOUT_OK'; url: string }
  | { type: 'CHECKOUT_FAILED'; error: DescribableError; now: number }
  | { type: 'BACKOFF_ELAPSED' }
  | { type: 'DISMISS_ERROR' };

export type InitialOrder =
  | null
  /** A draft or quoted order to carry on with (no new draft is created). */
  | { orderId: string; status: 'draft' | 'quoted' };

export function initialModel(options: { locked: boolean; order?: InitialOrder }): CheckoutModel {
  const order = options.order ?? null;
  const step: CheckoutStep = order ? { kind: 'quantity', orderId: order.orderId, packs: null } : { kind: 'starting' };
  return { step, run: 0, locked: options.locked };
}

function enter(model: CheckoutModel, step: CheckoutStep, restart = false): CheckoutModel {
  return { ...model, step, run: restart ? model.run + 1 : model.run };
}

export function checkoutReducer(model: CheckoutModel, event: CheckoutEvent): CheckoutModel {
  const { step } = model;
  const describe = (error: DescribableError) => describeCheckoutError(error, { locked: model.locked });

  switch (event.type) {
    case 'START_OK':
      if (step.kind !== 'starting') return model;
      return enter(model, { kind: 'quantity', orderId: event.orderId, packs: null });

    case 'START_FAILED':
      if (step.kind !== 'starting') return model;
      return enter(model, { kind: 'failed', error: describe(event.error), resume: null });

    case 'RETRY_START':
      if (step.kind !== 'failed' || step.resume) return model;
      return enter(model, { kind: 'starting' }, true);

    case 'RESUME':
      if (step.kind !== 'starting' && step.kind !== 'failed') return model;
      return enter(
        model,
        { kind: 'creating', orderId: event.orderId, back: null, expectedVersion: event.expectedVersion, startedAt: event.now, attempt: 0, waiting: false, delayMs: 0 },
        true,
      );

    case 'PICK_PACKS':
      if (step.kind !== 'quantity') return model;
      return enter(model, { ...step, packs: event.packs });

    case 'CONTINUE_QUANTITY':
      if (step.kind !== 'quantity' || step.packs === null) return model;
      return enter(model, { kind: 'address', orderId: step.orderId, packs: step.packs, address: null, error: null });

    case 'GO_QUANTITY':
      if (step.kind === 'address' || step.kind === 'summary') return enter(model, { kind: 'quantity', orderId: step.orderId, packs: step.packs });
      return model;

    case 'GO_ADDRESS':
      if (step.kind === 'summary') return enter(model, { kind: 'address', orderId: step.orderId, packs: step.packs, address: step.address, error: null });
      return model;

    case 'ADDRESS_SUBMITTED':
      if (step.kind !== 'address') return model;
      return enter(model, { kind: 'quoting', orderId: step.orderId, packs: step.packs, address: event.address }, true);

    case 'QUOTE_OK':
      if (step.kind !== 'quoting') return model;
      return enter(model, { kind: 'summary', orderId: step.orderId, packs: step.packs, address: step.address, quote: event.quote, error: null });

    case 'QUOTE_FAILED':
      if (step.kind !== 'quoting') return model;
      return enter(model, { kind: 'address', orderId: step.orderId, packs: step.packs, address: step.address, error: describe(event.error) });

    case 'PAY':
      if (step.kind !== 'summary') return model;
      return enter(
        model,
        {
          kind: 'creating',
          orderId: step.orderId,
          back: { packs: step.packs, address: step.address, quote: step.quote },
          expectedVersion: event.expectedVersion,
          startedAt: event.now,
          attempt: 0,
          waiting: false,
          delayMs: 0,
        },
        true,
      );

    case 'CHECKOUT_OK':
      if (step.kind !== 'creating') return model;
      return enter(model, { kind: 'redirecting', url: event.url });

    case 'CHECKOUT_FAILED': {
      if (step.kind !== 'creating') return model;
      const elapsed = event.now - step.startedAt;
      if (isStillPreparing(event.error)) {
        if (elapsed < GIVE_UP_AFTER_MS) {
          const delayMs = backoffDelayMs(step.attempt);
          return enter(model, { ...step, attempt: step.attempt + 1, waiting: true, delayMs }, true);
        }
        return leaveCreating(model, step, GAVE_UP_ERROR);
      }
      return leaveCreating(model, step, describe(event.error));
    }

    case 'BACKOFF_ELAPSED':
      if (step.kind !== 'creating' || !step.waiting) return model;
      return enter(model, { ...step, waiting: false, delayMs: 0 }, true);

    case 'DISMISS_ERROR':
      if (step.kind === 'summary' && step.error) return enter(model, { ...step, error: null });
      if (step.kind === 'address' && step.error) return enter(model, { ...step, error: null });
      return model;
  }
}

function leaveCreating(model: CheckoutModel, step: Extract<CheckoutStep, { kind: 'creating' }>, error: ErrorView): CheckoutModel {
  if (step.back) {
    return enter(model, { kind: 'summary', orderId: step.orderId, packs: step.back.packs, address: step.back.address, quote: step.back.quote, error });
  }
  return enter(model, { kind: 'failed', error, resume: { orderId: step.orderId, expectedVersion: step.expectedVersion } });
}

/** True while a draft / quote / checkout call or its backoff is the thing the screen is waiting on. */
export function isBusy(step: CheckoutStep): boolean {
  return step.kind === 'starting' || step.kind === 'quoting' || step.kind === 'creating' || step.kind === 'redirecting';
}

/**
 * Copy for the `creating` step. The print files are made after payment, so this
 * call returns in a second or two and reads exactly like the book's checkout
 * ("Redirecting to checkout…"); only a retry after a slow answer says more.
 */
export function creatingCopy(step: Extract<CheckoutStep, { kind: 'creating' }>): { title: string; body: string } {
  if (step.attempt === 0) return { title: 'Redirecting to checkout…', body: '' };
  return { title: 'Redirecting to checkout…', body: 'This is taking longer than expected. We’re trying again, so please keep this page open.' };
}

// ── The edits version the buyer reviewed ─────────────────────────────────

/** What the save queue and the loaded card say, reduced to what the pin needs. */
export interface PinInput {
  /** The save queue has seen a server read with an editor view. */
  queueReady: boolean;
  queueIdle: boolean;
  queueHasError: boolean;
  /** The queue's server-confirmed edits version. */
  serverVersion: number;
  /** The loaded card's `get` edits version, or null with no editor view yet. */
  viewVersion: number | null;
}

export type PinStatus = 'ready' | 'syncing' | 'save_error' | 'no_view';

/**
 * Whether the thumbnails and `expectedEditsVersion` can be pinned yet: the
 * queue must be idle with no failed save AND the loaded card must be at the
 * queue's confirmed version (after a save the card is refetched, so the view
 * briefly lags). `syncing` resolves by itself (or by one explicit refetch).
 */
export function pinStatus(input: PinInput): PinStatus {
  if (!input.queueReady || input.viewVersion === null) return 'no_view';
  if (input.queueHasError) return 'save_error';
  if (!input.queueIdle) return 'syncing';
  if (input.viewVersion !== input.serverVersion) return 'syncing';
  return 'ready';
}
