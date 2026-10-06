import type { StepperConfig } from '../../order/orderProgressSteps';

/**
 * The holiday card order's progress bar: the Memory Book's stepper
 * (`order/OrderProgressStepper.tsx`) with the card's waypoints, the same
 * post-purchase shape the book shows: Paid, Preparing (the print files are made
 * AFTER payment), Sent to print, Printing, Shipped. A card has no `rendering`
 * status, so its `paid` status is drawn on the Preparing step (Paid done,
 * Preparing current); a `rendering` status, if the server ever reports one,
 * lands on the same step. `shipped` is the last step (no `delivered`), so a
 * shipped order reads as complete. Same drawing, same markup, different config.
 */
export const CARD_STEPPER: StepperConfig = {
  steps: [
    { key: 'paid', label: 'Paid' },
    { key: 'rendering', label: 'Preparing', hint: 'just a few minutes' },
    { key: 'submitted', label: 'Sent to print' },
    { key: 'in_production', label: 'Printing', hint: '4–6 days' },
    { key: 'shipped', label: 'Shipped' },
  ],
  terminalKey: 'shipped',
  stepForStatus: { paid: 'rendering' },
};

const STEPPER_STATUSES: ReadonlySet<string> = new Set(['paid', 'rendering', 'submitted', 'in_production', 'shipped']);

/** Whether to draw the bar: only for a paid order that was not refunded (failed / cancelled / unpaid statuses have their own copy). */
export function cardShowsStepper(status: string, refundedAt: string | null): boolean {
  if (refundedAt) return false;
  return STEPPER_STATUSES.has(status);
}
