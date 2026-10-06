import type { ReactNode } from 'react';
import './OrderStatusScreen.css';

/**
 * The presentational body of an order status page, shared by the Memory Book
 * screen (`OrderStatusScreen.tsx`) and the holiday card status panel
 * (`card/checkout/CardOrderStatusPanel.tsx`): header, one-time "thanks"
 * banner, status chip + message, refund line, progress stepper, tracking
 * button, facts, "Ships to" block, resume button and the contact line.
 * Extracted verbatim from `OrderStatusScreen.tsx`: with the book's props the
 * markup is unchanged (`__tests__/bookScreensUnchanged.test.ts` pins it).
 * Each product builds its props from its own order shape (the adapters).
 */

export interface OrderStatusLayoutProps {
  backLabel: string;
  onBack: () => void;
  /** The one-time "Thanks for your order" banner (null = none). */
  thanks: string | null;
  chip: { label: string; tone: 'positive' | 'neutral' | 'negative' };
  message: string;
  /** Extra text under the message (the card page's "taking longer than usual" notes). */
  note?: ReactNode;
  /** ISO timestamp of a refund: renders "A refund was issued on <date>." */
  refundedAt: string | null;
  /** The `<OrderProgressStepper>` (or nothing). */
  stepper: ReactNode;
  tracking: { url: string | null; number: string | null; carrier: string | null } | null;
  /** The facts list; `null` omits it entirely (the book always passes an array). */
  facts: { label: string; value: string }[] | null;
  shipTo: {
    name: string;
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode: string;
    countryName: string;
    /** The "wrong address?" line (only while it can still be fixed). */
    hint: string | null;
  } | null;
  /** A "back to ..." button for orders that were never paid. */
  resume: { label: string; onClick: () => void } | null;
  /** The always-visible exit hatch line. */
  contact: ReactNode;
  /** Rendered inside the page after the body (the dev state switcher). */
  footer?: ReactNode;
}

export function OrderStatusLayout(props: OrderStatusLayoutProps) {
  const { chip, tracking, shipTo } = props;
  return (
    <div className="order-status">
      <header className="order-status__header">
        <button type="button" className="order-status__back" onClick={props.onBack}>
          {props.backLabel}
        </button>
        <span className="order-status__title">Order status</span>
      </header>

      <div className="order-status__body">
        {props.thanks && (
          <div className="order-status__thanks" role="status">
            {props.thanks}
          </div>
        )}

        <span className={`order-status-chip order-status-chip--${chip.tone}`}>{chip.label}</span>
        <p className="order-status__message">{props.message}</p>
        {props.note}

        {props.refundedAt && (
          <p className="order-status__refunded" role="status">
            A refund was issued on {new Date(props.refundedAt).toLocaleDateString()}.
          </p>
        )}

        {props.stepper}

        {/* A prominent tracking CTA once something is known: a real button when the
            carrier gave a URL, a plain (non-clickable) number when it only gave that. */}
        {tracking && (
          <div className="order-status__tracking">
            {tracking.url ? (
              <a className="order-status__tracking-btn" href={tracking.url} target="_blank" rel="noreferrer noopener">
                Track your package
              </a>
            ) : (
              <p className="order-status__tracking-plain">
                Tracking number: <span>{tracking.number}</span>
                {tracking.carrier ? ` (${tracking.carrier})` : ''}
              </p>
            )}
          </div>
        )}

        {props.facts && (
          <dl className="order-status__facts">
            {props.facts.map((fact) => (
              <FactRow key={fact.label} label={fact.label} value={fact.value} />
            ))}
          </dl>
        )}

        {shipTo && (
          <div className="order-status__ship-to">
            <p className="order-status__ship-to-label">Ships to</p>
            <p className="order-status__ship-to-address">
              {shipTo.name}
              <br />
              {shipTo.line1}
              {shipTo.line2 && (
                <>
                  <br />
                  {shipTo.line2}
                </>
              )}
              <br />
              {[shipTo.city, shipTo.state, shipTo.postalCode].filter(Boolean).join(', ')}
              <br />
              {shipTo.countryName}
            </p>
            {shipTo.hint && <p className="order-status__ship-to-hint">{shipTo.hint}</p>}
          </div>
        )}

        {props.resume && (
          <button type="button" className="order-status__resume" onClick={props.resume.onClick}>
            {props.resume.label}
          </button>
        )}

        <p className="order-status__contact-hint">{props.contact}</p>
      </div>

      {props.footer}
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
