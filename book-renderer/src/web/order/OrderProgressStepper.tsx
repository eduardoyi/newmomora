import { PROGRESS_STEPS, currentProgressStepIndex, progressStepState } from './orderProgressSteps';
import type { MemoryBookOrderStatus } from '../types';
import './OrderProgressStepper.css';

/**
 * The linear paid→delivered progress bar (memory-book-5c order-status UX
 * round, item 1). Callers must already have checked
 * `orderProgressSteps.ts#showsProgressStepper` — this component always
 * renders a six-step bar and does not itself decide when that's
 * appropriate (`OrderStatusScreen.tsx` owns that branch, same separation
 * `orderStatusCopy.ts` keeps from the screen that renders it).
 */
export function OrderProgressStepper({
  status,
  carrier,
}: {
  status: MemoryBookOrderStatus;
  /** Prodigi's carrier name (memory-book-5c order-status UX round, item 3
   * — `_shared/prodigi.ts#getProdigiOrderStatus`'s shipments parse), shown
   * as the `shipped` step's "carrier estimate line" while that step is
   * current. `null`/`undefined` (Prodigi reported no carrier, or the order
   * hasn't shipped yet) simply omits the line — never a fabricated ETA. */
  carrier?: string | null;
}) {
  const currentIndex = currentProgressStepIndex(status);

  return (
    <ol className="order-progress" aria-label="Order progress">
      {PROGRESS_STEPS.map((step, i) => {
        const state = progressStepState(i, currentIndex, status);
        const isLast = i === PROGRESS_STEPS.length - 1;
        const hint =
          state === 'current' ? (step.key === 'shipped' ? (carrier ? `Shipped via ${carrier}` : undefined) : step.hint) : undefined;

        return (
          <li
            key={step.key}
            className={`order-progress__step order-progress__step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <div className="order-progress__marker">
              {state === 'done' ? (
                <svg viewBox="0 0 16 16" className="order-progress__check" aria-hidden="true">
                  <path d="M3 8.5L6.5 12L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <span className="order-progress__dot" aria-hidden="true" />
              )}
            </div>
            <div className="order-progress__text">
              <span className="order-progress__label">{step.label}</span>
              {hint && <span className="order-progress__hint">{hint}</span>}
            </div>
            {!isLast && <div className="order-progress__connector" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
