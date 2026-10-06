import type { ReactNode } from 'react';
import './CheckoutScreen.css';

/**
 * The presentational pieces of the "Order this ..." checkout, shared by the
 * Memory Book flow (`CheckoutScreen.tsx`) and the holiday card flow
 * (`card/checkout/CardCheckoutScreen.tsx`) so both look and read the same: the
 * full-takeover frame (back link, title, notice, body) and the quote card
 * (lines, total, tax note, pay button). Extracted verbatim from
 * `CheckoutScreen.tsx`: with the book's props the markup is unchanged
 * (`__tests__/bookScreensUnchanged.test.ts` pins it).
 */

export function CheckoutFrame({
  title,
  backLabel,
  onBack,
  backDisabled,
  notice,
  children,
}: {
  title: string;
  /** The text after the arrow, e.g. the book's label. */
  backLabel: string;
  onBack: () => void;
  backDisabled?: boolean;
  /** The "your edits freeze at payment" line shown on every step (omitted by the card flow's non-order screens). */
  notice?: string;
  children: ReactNode;
}) {
  return (
    <div className="checkout-screen">
      <header className="checkout-screen__header">
        <button type="button" className="checkout-screen__back" onClick={onBack} disabled={backDisabled}>
          ← {backLabel}
        </button>
        <h1 className="checkout-screen__title">{title}</h1>
      </header>

      <div className="checkout-screen__body">
        {notice && <p className="checkout-screen__freeze-notice">{notice}</p>}
        {children}
      </div>
    </div>
  );
}

export interface QuoteLine {
  label: string;
  value: string;
}

export function CheckoutQuote({
  lines,
  total,
  taxNote,
  error,
  payLabel,
  paying,
  payDisabled,
  onPay,
  before,
  extra,
}: {
  lines: QuoteLine[];
  total: string;
  taxNote: string;
  error: ReactNode;
  payLabel: string;
  paying: boolean;
  /** Disables the pay button on top of `paying` (a card still syncing its latest edits). */
  payDisabled?: boolean;
  onPay: () => void;
  /** Rendered above the lines (the card's front/back thumbnails). */
  before?: ReactNode;
  /** Rendered between the tax note and the error (the card's address block). */
  extra?: ReactNode;
}) {
  return (
    <div className="checkout-quote">
      {before}
      <dl className="checkout-quote__lines">
        {lines.map((line) => (
          <LineRow key={line.label} line={line} />
        ))}
        <dt className="checkout-quote__total-label">Total</dt>
        <dd className="checkout-quote__total-value">{total}</dd>
      </dl>
      <p className="checkout-quote__tax-note">{taxNote}</p>
      {extra}
      {error}
      <button type="button" className="checkout-quote__pay" disabled={paying || payDisabled} onClick={onPay}>
        {payLabel}
      </button>
    </div>
  );
}

function LineRow({ line }: { line: QuoteLine }) {
  return (
    <>
      <dt>{line.label}</dt>
      <dd>{line.value}</dd>
    </>
  );
}

export function CheckoutError({ message }: { message: string }) {
  return <p className="checkout-screen__error">{message}</p>;
}

export function CheckoutHint({ children }: { children: ReactNode }) {
  return <p className="checkout-screen__hint">{children}</p>;
}
