import { CANCELLED_AFTER_PAYMENT_MESSAGE, ORDER_THANKS_MESSAGE } from '../../order/orderStatusCopy';
import { formatMoney } from '../../order/formatMoney';
import { type CardOrderStatus, type CardOrderStatusName } from './checkoutTypes';

/** Country display name for the card order pages ("Ships to"): the two countries a card ships to, else the bare code. */
export function formatCountryName(code: string): string {
  if (code === 'US') return 'United States';
  if (code === 'CA') return 'Canada';
  return code;
}

/**
 * Buyer-facing copy and polling rules for a holiday card order's status
 * (docs/plans/holiday-cards-p2.md Step 5), in the SAME voice as the Memory
 * Book's `order/orderStatusCopy.ts` (and reusing its shared strings: the thanks
 * banner, the cancelled-after-payment sentence). Pure so every status is
 * unit-tested to have copy. Statuses: draft | quoted | checkout | paid |
 * submitted | in_production | shipped | failed | cancelled; anything newer
 * degrades to generic copy.
 */

export type StatusTone = 'positive' | 'neutral' | 'negative';

export interface CardStatusCopy {
  label: string;
  message: string;
  tone: StatusTone;
}

export interface StatusCopyOptions {
  /** The buyer just came back from Stripe's success page: an order still in `checkout` is "confirming payment". */
  returnedFromPayment?: boolean;
  /** The money was refunded. */
  refunded?: boolean;
}

const COPY: Record<CardOrderStatusName, CardStatusCopy> = {
  draft: {
    label: 'Not started',
    message: "This order hasn't been paid for yet — head back to your card to pick it up where you left off.",
    tone: 'neutral',
  },
  quoted: {
    label: 'Awaiting payment',
    message: "You started this order but haven't completed checkout yet — head back to your card to finish paying.",
    tone: 'neutral',
  },
  checkout: {
    label: 'Checkout open',
    message: "Checkout is open for this order — head back to your card to finish paying.",
    tone: 'neutral',
  },
  paid: {
    label: 'Payment received',
    message: 'Payment received — sending to the printer.',
    tone: 'positive',
  },
  submitted: {
    label: 'Sent to print',
    message: 'Your cards have been sent to our print partner.',
    tone: 'positive',
  },
  in_production: {
    label: 'In production',
    message: 'Your cards are being printed.',
    tone: 'positive',
  },
  shipped: {
    label: 'Shipped',
    message: 'Your cards have shipped!',
    tone: 'positive',
  },
  failed: {
    label: 'Something went wrong',
    message: "Something went wrong on our side — we're fixing it or refunding you.",
    tone: 'negative',
  },
  cancelled: {
    label: 'Cancelled',
    message: "This order was cancelled — checkout wasn't completed, so nothing was charged.",
    tone: 'neutral',
  },
};

const CONFIRMING: CardStatusCopy = {
  label: 'Confirming your payment',
  message: 'Confirming your payment…',
  tone: 'neutral',
};

const UNKNOWN: CardStatusCopy = {
  label: 'In progress',
  message: 'Your order is in progress. This page shows the latest we know.',
  tone: 'neutral',
};

export function cardOrderStatusCopy(status: CardOrderStatusName | 'unknown', options: StatusCopyOptions = {}): CardStatusCopy {
  if (status === 'unknown') return UNKNOWN;
  if (status === 'checkout' && options.returnedFromPayment) return CONFIRMING;
  if (status === 'cancelled' && options.refunded) return { ...COPY.cancelled, message: CANCELLED_AFTER_PAYMENT_MESSAGE };
  return COPY[status];
}

/** Shown after the payment has stayed "confirming" for a while (the Stripe webhook can be late). */
export const CONFIRMING_SLOW_NOTE =
  'This is taking a little longer than usual. If your payment went through, this page will update by itself. You can also close it: we will email you when your order is on its way.';

export const CONFIRMING_SLOW_AFTER_MS = 90_000;

// ── Polling ──────────────────────────────────────────────────────────────

export const STATUS_POLL_MS = 5_000;

/** Statuses that are done changing on the buyer's time scale: the poll stops. */
export const SETTLED_STATUSES: ReadonlySet<CardOrderStatusName | 'unknown'> = new Set(['submitted', 'in_production', 'shipped', 'failed', 'cancelled', 'unknown']);

/** Keep polling while the order is still before the printer (draft, quoted, checkout, paid). */
export function shouldPollStatus(status: CardOrderStatusName | 'unknown'): boolean {
  return !SETTLED_STATUSES.has(status);
}

/** `checkout` right after the success return: the payment is real but the webhook has not landed. Never offer to cancel. */
export function isConfirmingPayment(status: CardOrderStatusName | 'unknown', returnedFromPayment: boolean): boolean {
  return returnedFromPayment && status === 'checkout';
}

/**
 * Only these statuses can still change on the buyer's time scale, so the orders
 * list keeps polling for them. Everything else (shipped, failed, cancelled, and
 * any status this build does not know) is terminal for polling.
 */
const LIST_POLLED_STATUSES: ReadonlySet<string> = new Set(['quoted', 'checkout', 'paid', 'submitted', 'in_production']);

export function isCardOrderListTerminal(status: string): boolean {
  return !LIST_POLLED_STATUSES.has(status);
}

// ── Adapter: card order -> the shared status layout ──────────────────────

export interface CardStatusLayoutModel {
  thanks: string | null;
  chip: { label: string; tone: StatusTone };
  message: string;
  refundedAt: string | null;
  /** Draw the stepper (with `card/checkout/cardProgress.ts`'s config). */
  showStepper: boolean;
  tracking: { url: string | null; number: string | null; carrier: string | null } | null;
  facts: { label: string; value: string }[] | null;
  shipTo: {
    name: string;
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode: string;
    countryName: string;
    hint: string | null;
  } | null;
  /** The "back to your card" button for an order that was never paid. */
  showResume: boolean;
}

const WRONG_ADDRESS_HINT = 'Wrong address? Reply to your confirmation email right away — mistakes caught quickly can sometimes still be fixed.';

/** Maps a card order onto the props the shared `OrderStatusLayout` renders (the same page the Memory Book uses). */
export function cardStatusLayoutModel(order: CardOrderStatus, options: { returnedFromPayment: boolean; showStepper: boolean }): CardStatusLayoutModel {
  const refunded = order.refundedAt !== null || order.refunded;
  const copy = cardOrderStatusCopy(order.status, { returnedFromPayment: options.returnedFromPayment, refunded });
  const facts: { label: string; value: string }[] = [];
  if (order.cards !== null) facts.push({ label: 'Cards', value: String(order.cards) });
  if (order.priceCents !== null) facts.push({ label: 'Total', value: `${formatMoney(order.priceCents, order.currency)} (shipping included, plus tax if applicable)` });
  const address = order.shippingAddress;
  return {
    thanks: options.returnedFromPayment && order.status !== 'draft' && order.status !== 'quoted' ? ORDER_THANKS_MESSAGE : null,
    chip: { label: copy.label, tone: copy.tone },
    message: copy.message,
    refundedAt: order.refundedAt,
    showStepper: options.showStepper,
    tracking: order.trackingUrl || order.trackingNumber ? { url: order.trackingUrl, number: order.trackingNumber, carrier: order.carrier } : null,
    facts: facts.length > 0 ? facts : null,
    shipTo: address
      ? {
          ...address,
          countryName: formatCountryName(address.countryCode),
          hint: ['paid', 'submitted', 'in_production'].includes(order.status) ? WRONG_ADDRESS_HINT : null,
        }
      : null,
    showResume: order.status === 'draft' || order.status === 'quoted',
  };
}
