import type { StepperConfig } from '../../order/orderProgressSteps';

/**
 * The holiday card order's progress bar: the Memory Book's stepper
 * (`order/OrderProgressStepper.tsx`) with the card's waypoints mapped onto it,
 * paid -> sent to print -> printing -> shipped. `shipped` is the last step the
 * server reports for a card (there is no `delivered`), so a shipped order reads
 * as complete. Same drawing, same markup, different config.
 */
export const CARD_STEPPER: StepperConfig = {
  steps: [
    { key: 'paid', label: 'Paid' },
    { key: 'submitted', label: 'Sent to print' },
    { key: 'in_production', label: 'Printing' },
    { key: 'shipped', label: 'Shipped' },
  ],
  terminalKey: 'shipped',
};

/** Whether to draw the bar: only for a paid order that was not refunded (failed / cancelled / unpaid statuses have their own copy). */
export function cardShowsStepper(status: string, refundedAt: string | null): boolean {
  if (refundedAt) return false;
  return CARD_STEPPER.steps.some((step) => step.key === status);
}
