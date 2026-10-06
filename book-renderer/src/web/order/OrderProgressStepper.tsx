import { BOOK_STEPPER, currentProgressStepIndex, progressStepState, type StepperConfig } from './orderProgressSteps';
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
  config = BOOK_STEPPER,
}: {
  /** A status the config's steps know (a Memory Book status by default). */
  status: string;
  /** Another product's waypoints (holiday cards); omitted = the Memory Book's six steps, exactly as before. */
  config?: StepperConfig;
  /** Prodigi's carrier name (memory-book-5c order-status UX round, item 3
   * — `_shared/prodigi.ts#getProdigiOrderStatus`'s shipments parse), shown
   * as the `shipped` step's "carrier estimate line" while that step is
   * current. `null`/`undefined` (Prodigi reported no carrier, or the order
   * hasn't shipped yet) simply omits the line — never a fabricated ETA. */
  carrier?: string | null;
}) {
  const { steps } = config;
  const currentIndex = currentProgressStepIndex(status, steps);

  return (
    <ol className="order-progress" aria-label="Order progress">
      {steps.map((step, i) => {
        const state = progressStepState(i, currentIndex, status, config.terminalKey);
        const isLast = i === steps.length - 1;
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
