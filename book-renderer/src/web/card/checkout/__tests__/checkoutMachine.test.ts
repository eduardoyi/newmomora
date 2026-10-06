import { describe, expect, it } from 'vitest';
import type { CardShippingAddress } from '../../../order/cardAddress';
import {
  BACKOFF_MS,
  GAVE_UP_ERROR,
  GIVE_UP_AFTER_MS,
  backoffDelayMs,
  checkoutReducer,
  initialModel,
  isBusy,
  pinStatus,
  type CheckoutEvent,
  type CheckoutModel,
} from '../checkoutMachine';
import type { CardOrderQuote } from '../checkoutTypes';

const ADDRESS: CardShippingAddress = { name: 'Mara Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' };
const QUOTE: CardOrderQuote = { orderId: 'order-1', packs: 3, cards: 30, priceCents: 7470, currency: 'USD', region: 'US', format: '5R' };

function run(model: CheckoutModel, ...events: CheckoutEvent[]): CheckoutModel {
  return events.reduce(checkoutReducer, model);
}

/** Drives a fresh order to the summary. */
function toSummary(locked = false): CheckoutModel {
  return run(
    initialModel({ locked }),
    { type: 'START_OK', orderId: 'order-1' },
    { type: 'PICK_PACKS', packs: 3 },
    { type: 'CONTINUE_QUANTITY' },
    { type: 'ADDRESS_SUBMITTED', address: ADDRESS },
    { type: 'QUOTE_OK', quote: QUOTE },
  );
}

function toCreating(now = 1_000): CheckoutModel {
  return run(toSummary(), { type: 'PAY', expectedVersion: 7, now });
}

describe('happy path', () => {
  it('starting -> quantity -> address -> quoting -> summary -> creating -> redirecting', () => {
    let m = initialModel({ locked: false });
    expect(m.step.kind).toBe('starting');
    m = run(m, { type: 'START_OK', orderId: 'order-1' });
    expect(m.step).toEqual({ kind: 'quantity', orderId: 'order-1', packs: null });
    m = run(m, { type: 'PICK_PACKS', packs: 3 }, { type: 'CONTINUE_QUANTITY' });
    expect(m.step).toMatchObject({ kind: 'address', orderId: 'order-1', packs: 3, address: null, error: null });
    m = run(m, { type: 'ADDRESS_SUBMITTED', address: ADDRESS });
    expect(m.step).toMatchObject({ kind: 'quoting', packs: 3 });
    m = run(m, { type: 'QUOTE_OK', quote: QUOTE });
    expect(m.step).toMatchObject({ kind: 'summary', quote: QUOTE, error: null });
    m = run(m, { type: 'PAY', expectedVersion: 7, now: 5 });
    expect(m.step).toMatchObject({ kind: 'creating', orderId: 'order-1', expectedVersion: 7, attempt: 0, waiting: false, startedAt: 5 });
    m = run(m, { type: 'CHECKOUT_OK', url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
    expect(m.step).toEqual({ kind: 'redirecting', url: 'https://checkout.stripe.test/c/pay/cs_test_1' });
  });

  it('cannot continue without a quantity', () => {
    const m = run(initialModel({ locked: false }), { type: 'START_OK', orderId: 'o' }, { type: 'CONTINUE_QUANTITY' });
    expect(m.step.kind).toBe('quantity');
  });

  it('a reorder (or a resumed draft) starts at the quantity with its order', () => {
    const m = initialModel({ locked: true, order: { orderId: 'order-9', status: 'quoted' } });
    expect(m.step).toEqual({ kind: 'quantity', orderId: 'order-9', packs: null });
    expect(m.locked).toBe(true);
  });

  it('bumps `run` whenever a call has to (re)start', () => {
    const quoting = run(initialModel({ locked: false }), { type: 'START_OK', orderId: 'o' }, { type: 'PICK_PACKS', packs: 2 }, { type: 'CONTINUE_QUANTITY' });
    const a = run(quoting, { type: 'ADDRESS_SUBMITTED', address: ADDRESS });
    expect(a.run).toBe(quoting.run + 1);
    const retried = run(a, { type: 'QUOTE_FAILED', error: { status: 502, code: 'GELATO_UNAVAILABLE' } }, { type: 'ADDRESS_SUBMITTED', address: ADDRESS });
    expect(retried.run).toBe(a.run + 1);
  });
});

describe('going back and editing', () => {
  it('back from the address goes to the quantity; from the summary to the address with it prefilled', () => {
    const m = toSummary();
    const address = run(m, { type: 'GO_ADDRESS' });
    expect(address.step).toMatchObject({ kind: 'address', packs: 3, address: ADDRESS, error: null });
    const quantity = run(m, { type: 'GO_QUANTITY' });
    expect(quantity.step).toEqual({ kind: 'quantity', orderId: 'order-1', packs: 3 });
    // Quantity -> address again: the quote must be redone (price depends on the quantity).
    expect(run(quantity, { type: 'CONTINUE_QUANTITY' }).step.kind).toBe('address');
  });

  it('ignores events that do not belong to the current step', () => {
    const m = toSummary();
    expect(run(m, { type: 'QUOTE_OK', quote: QUOTE })).toBe(m);
    expect(run(m, { type: 'BACKOFF_ELAPSED' })).toBe(m);
    expect(run(m, { type: 'CHECKOUT_OK', url: 'https://x.test' })).toBe(m);
    expect(run(initialModel({ locked: false }), { type: 'PAY', expectedVersion: 1, now: 1 }).step.kind).toBe('starting');
  });
});

describe('failures', () => {
  it('a failed draft is a failed start that can be retried', () => {
    const failed = run(initialModel({ locked: false }), { type: 'START_FAILED', error: { status: 403, code: 'SUBSCRIPTION_REQUIRED' } });
    expect(failed.step).toMatchObject({ kind: 'failed', error: { code: 'SUBSCRIPTION_REQUIRED', action: 'none' }, resume: null });
    const retry = run(failed, { type: 'RETRY_START' });
    expect(retry.step.kind).toBe('starting');
    expect(retry.run).toBe(failed.run + 1);
  });

  it('a failed quote returns to the address with the copy, keeping what was typed', () => {
    let m = run(initialModel({ locked: false }), { type: 'START_OK', orderId: 'o' }, { type: 'PICK_PACKS', packs: 2 }, { type: 'CONTINUE_QUANTITY' }, { type: 'ADDRESS_SUBMITTED', address: ADDRESS });
    m = run(m, { type: 'QUOTE_FAILED', error: { status: 422, code: 'NOT_DELIVERABLE' } });
    expect(m.step).toMatchObject({ kind: 'address', address: ADDRESS, error: { code: 'NOT_DELIVERABLE', action: 'requote' } });
    expect(run(m, { type: 'DISMISS_ERROR' }).step).toMatchObject({ kind: 'address', error: null });
  });

  it('a deterministic create_checkout error returns to the summary with its action', () => {
    const m = run(toCreating(), { type: 'CHECKOUT_FAILED', error: { status: 422, code: 'LETTER_OVERFLOW' }, now: 4_000 });
    expect(m.step).toMatchObject({ kind: 'summary', orderId: 'order-1', quote: QUOTE, address: ADDRESS, error: { code: 'LETTER_OVERFLOW', action: 'back_to_editor' } });
  });

  it('turning the QR off clears a QR error and keeps the summary', () => {
    const failed = run(toCreating(), { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'FILM_NOT_READY' }, now: 2_000 });
    expect(failed.step).toMatchObject({ kind: 'summary', error: { action: 'turn_qr_off' } });
    expect(run(failed, { type: 'DISMISS_ERROR' }).step).toMatchObject({ kind: 'summary', error: null });
  });

  it('on a reorder, a QR error cannot offer to turn the QR off', () => {
    const m = run(toSummary(true), { type: 'PAY', expectedVersion: 1, now: 0 }, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'QR_LINK_DISABLED' }, now: 100 });
    expect(m.step).toMatchObject({ kind: 'summary', error: { action: 'none' } });
  });
});

describe('create_checkout timeout and backoff', () => {
  it('waits 5, 10, 20, 30 s and then 30 s again', () => {
    expect(BACKOFF_MS).toEqual([5_000, 10_000, 20_000, 30_000]);
    expect([0, 1, 2, 3, 4, 9].map(backoffDelayMs)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
    expect(backoffDelayMs(-1)).toBe(5_000);
  });

  it('a client timeout waits, then calls again with the same pinned version', () => {
    let m = toCreating(0);
    const first = m.run;
    m = run(m, { type: 'CHECKOUT_FAILED', error: { status: 0, code: 'timeout' }, now: 90_000 });
    expect(m.step).toMatchObject({ kind: 'creating', waiting: true, attempt: 1, delayMs: 5_000, expectedVersion: 7 });
    expect(m.run).toBeGreaterThan(first);
    m = run(m, { type: 'BACKOFF_ELAPSED' });
    expect(m.step).toMatchObject({ kind: 'creating', waiting: false, attempt: 1, delayMs: 0, expectedVersion: 7 });
    // The second call is still being prepared server-side.
    m = run(m, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'CHECKOUT_IN_PROGRESS' }, now: 95_000 });
    expect(m.step).toMatchObject({ waiting: true, attempt: 2, delayMs: 10_000 });
    m = run(m, { type: 'BACKOFF_ELAPSED' }, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'CHECKOUT_IN_PROGRESS' }, now: 110_000 });
    expect(m.step).toMatchObject({ waiting: true, attempt: 3, delayMs: 20_000 });
    m = run(m, { type: 'BACKOFF_ELAPSED' }, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'CHECKOUT_IN_PROGRESS' }, now: 135_000 });
    expect(m.step).toMatchObject({ waiting: true, attempt: 4, delayMs: 30_000 });
    // The resumed call succeeds.
    m = run(m, { type: 'BACKOFF_ELAPSED' }, { type: 'CHECKOUT_OK', url: 'https://checkout.stripe.test/x' });
    expect(m.step.kind).toBe('redirecting');
  });

  it('gives up after about three minutes, back on the summary with a retry button', () => {
    let m = toCreating(0);
    m = run(m, { type: 'CHECKOUT_FAILED', error: { status: 0, code: 'timeout' }, now: GIVE_UP_AFTER_MS - 1 });
    expect(m.step).toMatchObject({ kind: 'creating', waiting: true });
    m = run(m, { type: 'BACKOFF_ELAPSED' }, { type: 'CHECKOUT_FAILED', error: { status: 0, code: 'timeout' }, now: GIVE_UP_AFTER_MS });
    expect(m.step).toMatchObject({ kind: 'summary', error: GAVE_UP_ERROR });
    expect(GAVE_UP_ERROR.action).toBe('retry');
    // Retry: a fresh attempt counter and clock.
    m = run(m, { type: 'PAY', expectedVersion: 7, now: 300_000 });
    expect(m.step).toMatchObject({ kind: 'creating', attempt: 0, startedAt: 300_000, waiting: false });
  });

  it('a dropped connection is retried like a timeout, but a real error is not', () => {
    const dropped = run(toCreating(0), { type: 'CHECKOUT_FAILED', error: { status: 0, code: 'network_error' }, now: 1_000 });
    expect(dropped.step).toMatchObject({ kind: 'creating', waiting: true });
    const real = run(toCreating(0), { type: 'CHECKOUT_FAILED', error: { status: 502, code: 'RENDER_UNAVAILABLE' }, now: 1_000 });
    expect(real.step).toMatchObject({ kind: 'summary', error: { code: 'RENDER_UNAVAILABLE', action: 'retry' } });
  });

  it('a deterministic error during a retry ends the loop', () => {
    let m = run(toCreating(0), { type: 'CHECKOUT_FAILED', error: { status: 0, code: 'timeout' }, now: 90_000 }, { type: 'BACKOFF_ELAPSED' });
    m = run(m, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'CARD_CHANGED' }, now: 91_000 });
    expect(m.step).toMatchObject({ kind: 'summary', error: { code: 'CARD_CHANGED', action: 'reload' } });
  });
});

describe('resuming an open checkout', () => {
  it('goes straight to creating with no summary behind it', () => {
    const m = run(initialModel({ locked: false }), { type: 'RESUME', orderId: 'order-5', expectedVersion: 4, now: 10 });
    expect(m.step).toMatchObject({ kind: 'creating', orderId: 'order-5', back: null, expectedVersion: 4, attempt: 0 });
  });

  it('a failure becomes a failed start that can resume again', () => {
    let m = run(initialModel({ locked: false }), { type: 'RESUME', orderId: 'order-5', expectedVersion: 4, now: 10 });
    m = run(m, { type: 'CHECKOUT_FAILED', error: { status: 409, code: 'CHECKOUT_OPEN_ELSEWHERE' }, now: 20 });
    expect(m.step).toMatchObject({ kind: 'failed', resume: { orderId: 'order-5', expectedVersion: 4 }, error: { code: 'CHECKOUT_OPEN_ELSEWHERE' } });
    // RETRY_START is for a failed draft only.
    expect(run(m, { type: 'RETRY_START' })).toBe(m);
    expect(run(m, { type: 'RESUME', orderId: 'order-5', expectedVersion: 4, now: 30 }).step.kind).toBe('creating');
  });
});

describe('isBusy', () => {
  it('is true while a call is the thing being waited on', () => {
    expect(isBusy({ kind: 'starting' })).toBe(true);
    expect(isBusy(toCreating().step)).toBe(true);
    expect(isBusy(toSummary().step)).toBe(false);
  });
});

describe('pinStatus', () => {
  const ready = { queueReady: true, queueIdle: true, queueHasError: false, serverVersion: 5, viewVersion: 5 };
  it('is ready only when the queue is idle and the card is at the confirmed version', () => {
    expect(pinStatus(ready)).toBe('ready');
    expect(pinStatus({ ...ready, queueIdle: false })).toBe('syncing');
    expect(pinStatus({ ...ready, viewVersion: 4 })).toBe('syncing');
    expect(pinStatus({ ...ready, serverVersion: 6 })).toBe('syncing');
  });
  it('a failed save blocks, and there is nothing to pin without an editor view', () => {
    expect(pinStatus({ ...ready, queueHasError: true, queueIdle: false })).toBe('save_error');
    expect(pinStatus({ ...ready, viewVersion: null })).toBe('no_view');
    expect(pinStatus({ ...ready, queueReady: false })).toBe('no_view');
  });
});
