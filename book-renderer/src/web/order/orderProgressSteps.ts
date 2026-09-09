import type { MemoryBookOrderStatus } from '../types';

/**
 * Pure step-mapping logic for `OrderProgressStepper.tsx` (memory-book-5c
 * order-status UX round, item 1) — split out the same way
 * `orderStatusCopy.ts` is, so the status→step mapping is unit-testable
 * without a DOM environment.
 *
 * Six steps only: `draft`/`quoted` (pre-payment) and
 * `failed`/`cancelled`/a refunded order all render the EXISTING full-width
 * chip+message copy instead (the task's explicit "don't show a sad
 * half-filled bar" instruction) — see `showsProgressStepper` below, which
 * `OrderStatusScreen.tsx` calls to decide which UI to render.
 */
export type ProgressStepKey = 'paid' | 'rendering' | 'submitted' | 'in_production' | 'shipped' | 'delivered';

export interface ProgressStepInfo {
  key: ProgressStepKey;
  /** Short step label, distinct from `orderStatusCopy.ts`'s chip label —
   * this is a WAYPOINT name (fits a compact stepper), not a full sentence. */
  label: string;
  /** Best-effort time estimate shown under the label while this step is
   * CURRENT (never shown for a done or upcoming step) — the task's exact
   * "about 10 minutes" / "4–6 days" wording. `undefined` where the task
   * specifies no hint (`paid`, `submitted`, `delivered`) or where the hint
   * is data-dependent (`shipped`'s carrier line, computed separately). */
  hint?: string;
}

export const PROGRESS_STEPS: readonly ProgressStepInfo[] = [
  { key: 'paid', label: 'Paid' },
  { key: 'rendering', label: 'Preparing', hint: 'about 10 minutes' },
  { key: 'submitted', label: 'Sent to print' },
  { key: 'in_production', label: 'Printing', hint: '4–6 days' },
  { key: 'shipped', label: 'Shipped' },
  { key: 'delivered', label: 'Delivered' },
];

const STEP_STATUSES: ReadonlySet<MemoryBookOrderStatus> = new Set(
  PROGRESS_STEPS.map((step) => step.key as MemoryBookOrderStatus),
);

/**
 * `true` for exactly the statuses the stepper knows how to draw
 * (`paid` through `delivered`) — AND only when the order hasn't been
 * refunded. `draft`/`quoted` (nothing paid yet) and `failed`/`cancelled`
 * (explicitly excluded by the task) all fall through to `false`, and so
 * does any status once `refundedAt` is set, regardless of which status it's
 * sitting in — a refund is orthogonal to the state machine
 * (`orderStatusCopy.ts`'s own header comment on `refunded_at`), and the
 * task groups it with failed/cancelled for display purposes: once money
 * has been given back, the print-progress bar stops being the honest thing
 * to show.
 */
export function showsProgressStepper(status: MemoryBookOrderStatus, refundedAt: string | null): boolean {
  if (refundedAt) return false;
  return STEP_STATUSES.has(status);
}

/** Index into `PROGRESS_STEPS` for the order's CURRENT step, or -1 if
 * `status` isn't a stepper status at all (callers should already have
 * checked `showsProgressStepper` first). */
export function currentProgressStepIndex(status: MemoryBookOrderStatus): number {
  return PROGRESS_STEPS.findIndex((step) => step.key === status);
}

export type ProgressStepState = 'done' | 'current' | 'upcoming';

/** Per-step render state relative to the order's current step index —
 * `delivered` is the one terminal stepper status, so every step (including
 * `delivered` itself) reads as `done` rather than `current`: there's
 * nothing left to pulse once the book has arrived. */
export function progressStepState(stepIndex: number, currentIndex: number, status: MemoryBookOrderStatus): ProgressStepState {
  if (status === 'delivered') return 'done';
  if (stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return 'current';
  return 'upcoming';
}
