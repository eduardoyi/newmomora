import type { MemoryBookOrderStatus } from '../types';

/**
 * Honest, buyer-facing copy per order status (memory-book-5c plan Step 6 /
 * Decision 6's edits-freeze UI, and the task brief's exact required wording
 * for `failed`). Pure + pulled out of `OrderStatusScreen.tsx` so it can be
 * unit-tested without a DOM environment (this package's vitest config has no
 * jsdom -- see `vite.config.ts`'s `test` block).
 *
 * `shipped` deliberately does NOT reference a tracking number/URL: the
 * `memory_book_orders` schema has no tracking column yet (see
 * `docs/features/memory-book-orders.md`'s Sweep contract -- "does NOT
 * advance to `delivered` ... no carrier-tracking integration exists in this
 * repo"). Inventing tracking copy here would show something print software
 * never populates. `OrderStatusScreen` renders a tracking link if/when the
 * schema ever grows one, but this module never asserts one exists.
 */
export interface OrderStatusCopy {
  /** Short label for the status chip. */
  label: string;
  /** The main sentence shown under the chip. */
  message: string;
  /** 'positive' | 'neutral' | 'negative' -- drives the chip's color, same
   * three-bucket vocabulary `StatusChip.tsx` (book statuses) already uses. */
  tone: 'positive' | 'neutral' | 'negative';
}

const COPY: Record<MemoryBookOrderStatus, OrderStatusCopy> = {
  draft: {
    label: 'Not started',
    message: "This order hasn't been paid for yet — head back to your book to pick it up where you left off.",
    tone: 'neutral',
  },
  quoted: {
    label: 'Awaiting payment',
    message: "You started this order but haven't completed checkout yet — head back to your book to finish paying.",
    tone: 'neutral',
  },
  paid: {
    label: 'Payment received',
    message: "Payment received! We're getting your book ready to print.",
    tone: 'positive',
  },
  rendering: {
    label: 'Preparing your book',
    message: "We're rendering your book's print files — this only takes a few minutes.",
    tone: 'positive',
  },
  submitted: {
    label: 'Sent to print',
    message: 'Your book has been sent to our print partner.',
    tone: 'positive',
  },
  in_production: {
    label: 'In production',
    message: 'Your book is being printed and bound.',
    tone: 'positive',
  },
  shipped: {
    label: 'Shipped',
    message: 'Your book has shipped!',
    tone: 'positive',
  },
  delivered: {
    label: 'Delivered',
    message: 'Delivered! We hope your family loves it.',
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

export function orderStatusCopy(status: MemoryBookOrderStatus): OrderStatusCopy {
  return COPY[status];
}

/** Order rows in these statuses are done changing on their own -- polling
 * (`useOrderStatus.ts`) stops here. `refunded_at` is deliberately excluded
 * (per docs/features/memory-book-orders.md#refund-recording, it is
 * independent of `status`), so a refund landing on an otherwise-terminal
 * status never needs polling to resume. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<MemoryBookOrderStatus> = new Set([
  'delivered',
  'failed',
  'cancelled',
]);

export function isTerminalOrderStatus(status: MemoryBookOrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.has(status);
}
