import { describe, expect, it } from 'vitest';
import { CANCELLED_AFTER_PAYMENT_MESSAGE, ORDER_THANKS_MESSAGE, orderStatusCopy } from '../../../order/orderStatusCopy';
import {
  CONFIRMING_SLOW_AFTER_MS,
  SETTLED_STATUSES,
  STATUS_POLL_MS,
  cardOrderStatusCopy,
  cardStatusLayoutModel,
  isCardOrderListTerminal,
  isConfirmingPayment,
  shouldPollStatus,
} from '../cardOrderStatusCopy';
import { CARD_STEPPER, cardShowsStepper } from '../cardProgress';
import { CARD_ORDER_STATUS_NAMES, parseOrderStatus, type CardOrderStatus } from '../checkoutTypes';
import { BOOK_STEPPER, currentProgressStepIndex, progressStepState } from '../../../order/orderProgressSteps';

function order(overrides: Record<string, unknown> = {}): CardOrderStatus {
  return parseOrderStatus({
    orderId: 'order-1',
    cardId: 'card-1',
    status: 'paid',
    packs: 3,
    cards: 30,
    priceCents: 6870,
    currency: 'USD',
    region: 'US',
    shippingAddress: { name: 'Lucía Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' },
    ...overrides,
  });
}

describe('cardOrderStatusCopy (the book\'s voice)', () => {
  it('has copy for every status the server can report', () => {
    for (const status of CARD_ORDER_STATUS_NAMES) {
      const copy = cardOrderStatusCopy(status);
      expect(copy.label.length, status).toBeGreaterThan(0);
      expect(copy.message.length, status).toBeGreaterThan(10);
      expect(['positive', 'neutral', 'negative']).toContain(copy.tone);
    }
  });

  it('reuses the book\'s wording where the statuses mean the same thing', () => {
    expect(cardOrderStatusCopy('failed').message).toBe(orderStatusCopy('failed').message);
    expect(cardOrderStatusCopy('failed').label).toBe(orderStatusCopy('failed').label);
    expect(cardOrderStatusCopy('cancelled', { refunded: true }).message).toBe(CANCELLED_AFTER_PAYMENT_MESSAGE);
    for (const status of ['in_production', 'submitted', 'shipped'] as const) {
      expect(cardOrderStatusCopy(status).label).toBe(orderStatusCopy(status).label);
    }
  });

  it('an unknown future status degrades to generic copy', () => {
    expect(cardOrderStatusCopy('unknown').label).toBe('In progress');
  });

  it('paid says the payment arrived and the print files are being prepared (made after payment, like the book)', () => {
    expect(cardOrderStatusCopy('paid').message).toBe("Payment received! We're preparing your print files.");
  });

  it('a late webhook after the success return is "confirming", not an open checkout', () => {
    expect(cardOrderStatusCopy('checkout', { returnedFromPayment: true }).message).toBe('Confirming your payment…');
    expect(cardOrderStatusCopy('checkout').message).toMatch(/Checkout is open/);
    expect(isConfirmingPayment('checkout', true)).toBe(true);
    expect(isConfirmingPayment('checkout', false)).toBe(false);
    expect(isConfirmingPayment('paid', true)).toBe(false);
  });
});

describe('polling', () => {
  it('polls every 5 s until the printer has it (or it failed / was cancelled)', () => {
    expect(STATUS_POLL_MS).toBe(5_000);
    for (const status of ['draft', 'quoted', 'checkout', 'paid'] as const) expect(shouldPollStatus(status), status).toBe(true);
    for (const status of ['submitted', 'in_production', 'shipped', 'failed', 'cancelled', 'unknown'] as const) expect(shouldPollStatus(status), status).toBe(false);
    expect(SETTLED_STATUSES.has('shipped')).toBe(true);
    expect(CONFIRMING_SLOW_AFTER_MS).toBeGreaterThanOrEqual(60_000);
  });
  it('the orders list stops at shipped / failed / cancelled', () => {
    for (const status of ['shipped', 'failed', 'cancelled']) expect(isCardOrderListTerminal(status)).toBe(true);
    for (const status of ['quoted', 'checkout', 'paid', 'submitted', 'in_production']) expect(isCardOrderListTerminal(status)).toBe(false);
    // A status this build does not know must not poll forever.
    expect(isCardOrderListTerminal('brand_new')).toBe(true);
  });
});

describe('the card stepper is the book\'s stepper with card waypoints', () => {
  it('mirrors the book\'s post-purchase steps: paid, preparing, sent to print, printing, shipped', () => {
    expect(CARD_STEPPER.steps.map((s) => s.key)).toEqual(['paid', 'rendering', 'submitted', 'in_production', 'shipped']);
    expect(CARD_STEPPER.steps.map((s) => s.label)).toEqual(['Paid', 'Preparing', 'Sent to print', 'Printing', 'Shipped']);
    for (const step of CARD_STEPPER.steps) expect(BOOK_STEPPER.steps.some((b) => b.key === step.key)).toBe(true);
  });

  it('right after payment the current step is Preparing (paid is drawn on it)', () => {
    const shown = CARD_STEPPER.stepForStatus?.paid ?? 'paid';
    expect(shown).toBe('rendering');
    const idx = currentProgressStepIndex(shown, CARD_STEPPER.steps);
    expect(CARD_STEPPER.steps.map((_, i) => progressStepState(i, idx, shown, CARD_STEPPER.terminalKey))).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('submitted -> Sent to print, in production -> Printing', () => {
    const states = (status: string) => {
      const shown = CARD_STEPPER.stepForStatus?.[status] ?? status;
      const idx = currentProgressStepIndex(shown, CARD_STEPPER.steps);
      return CARD_STEPPER.steps.map((_, i) => progressStepState(i, idx, shown, CARD_STEPPER.terminalKey));
    };
    expect(states('submitted')).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    expect(states('in_production')).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
  });

  it('shipped is the last step: every step reads done', () => {
    const idx = currentProgressStepIndex('shipped', CARD_STEPPER.steps);
    expect(CARD_STEPPER.steps.map((_, i) => progressStepState(i, idx, 'shipped', CARD_STEPPER.terminalKey))).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('draws only for a paid, unrefunded order', () => {
    for (const status of ['paid', 'rendering', 'submitted', 'in_production', 'shipped']) expect(cardShowsStepper(status, null), status).toBe(true);
    for (const status of ['draft', 'quoted', 'checkout', 'failed', 'cancelled']) expect(cardShowsStepper(status, null), status).toBe(false);
    expect(cardShowsStepper('in_production', '2026-10-03T12:00:00Z')).toBe(false);
  });
});

describe('cardStatusLayoutModel (card order -> the shared status page)', () => {
  const opts = { returnedFromPayment: false, showStepper: true };

  it('shows the one-time thanks banner only after the Stripe return and never for an unpaid order', () => {
    expect(cardStatusLayoutModel(order(), { ...opts, returnedFromPayment: true }).thanks).toBe(ORDER_THANKS_MESSAGE);
    expect(cardStatusLayoutModel(order(), opts).thanks).toBeNull();
    expect(cardStatusLayoutModel(order({ status: 'quoted' }), { ...opts, returnedFromPayment: true }).thanks).toBeNull();
  });

  it('facts: cards and the total, shipping included', () => {
    const model = cardStatusLayoutModel(order(), opts);
    expect(model.facts).toEqual([
      { label: 'Cards', value: '30' },
      { label: 'Total', value: '$68.70 (shipping included, plus tax if applicable)' },
    ]);
    expect(cardStatusLayoutModel(order({ cards: null, priceCents: null }), opts).facts).toBeNull();
  });

  it('tracking: a link, a bare number, or nothing', () => {
    expect(cardStatusLayoutModel(order({ status: 'shipped', trackingUrl: 'https://t.example.test/1', trackingNumber: 'ZZ1', carrier: 'UPS' }), opts).tracking).toEqual({ url: 'https://t.example.test/1', number: 'ZZ1', carrier: 'UPS' });
    expect(cardStatusLayoutModel(order({ status: 'shipped', trackingNumber: 'ZZ1' }), opts).tracking).toEqual({ url: null, number: 'ZZ1', carrier: null });
    expect(cardStatusLayoutModel(order(), opts).tracking).toBeNull();
  });

  it('the refund shows its date and turns a cancelled order into "cancelled and refunded"', () => {
    const model = cardStatusLayoutModel(order({ status: 'cancelled', refundedAt: '2026-10-03T12:00:00Z' }), opts);
    expect(model.refundedAt).toBe('2026-10-03T12:00:00Z');
    expect(model.message).toBe(CANCELLED_AFTER_PAYMENT_MESSAGE);
  });

  it('ships-to names the country and only hints at a fix while it can still be fixed', () => {
    expect(cardStatusLayoutModel(order({ status: 'paid' }), opts).shipTo).toMatchObject({ name: 'Lucía Rivera', countryName: 'United States', hint: expect.stringContaining('Wrong address?') });
    expect(cardStatusLayoutModel(order({ status: 'shipped' }), opts).shipTo?.hint).toBeNull();
    expect(cardStatusLayoutModel(order({ shippingAddress: null }), opts).shipTo).toBeNull();
  });

  it('an unpaid order offers the way back to the card', () => {
    expect(cardStatusLayoutModel(order({ status: 'quoted' }), opts).showResume).toBe(true);
    expect(cardStatusLayoutModel(order({ status: 'paid' }), opts).showResume).toBe(false);
  });
});
