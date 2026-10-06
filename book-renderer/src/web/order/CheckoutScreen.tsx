import { useEffect, useRef, useState } from 'react';
import { AddressStep } from './AddressStep';
import { CheckoutError, CheckoutFrame, CheckoutHint, CheckoutQuote } from './CheckoutShell';
import { formatMoney } from './formatMoney';
import { createOrderDraft, quoteOrder, createCheckoutSession } from './ordersApi';
import type { QuoteResult, ShippingAddressInput } from './types';
import { useDocumentTitle } from '../useDocumentTitle';
import './CheckoutScreen.css';

type Step =
  | { kind: 'starting' }
  | { kind: 'start_failed'; error: string }
  | { kind: 'address'; orderId: string; error: string | null }
  | { kind: 'quoting'; orderId: string }
  | { kind: 'quote'; orderId: string; quote: QuoteResult; submitting: boolean; error: string | null };

/**
 * "Order this book" checkout flow (memory-book-5c plan Step 6, Design
 * Decisions 5+6): address → quote (our price + real shipping, USD) → Stripe
 * Checkout redirect. Deliberately NOT a routed screen (no `/checkout/<id>`
 * URL) — the plan's only new route is `/order/<id>` (Stripe's own return
 * target); this flow is reached and left entirely by in-app navigation from
 * `BookViewScreen`, matching how `PickerSheet`/`FocalPointModal` are
 * full-takeover surfaces without their own URL.
 *
 * A bare `draft` order row is created the moment this screen mounts (before
 * the parent has entered anything) so the "book must be `ready`"/role checks
 * happen server-side up front — see `memory-book-orders/index.ts`'s header
 * comment on why `create_draft` exists as its own op. If the parent backs
 * out before paying, the draft simply sits unpaid forever; that's fine, see
 * the schema doc's state machine (nothing auto-expires a `draft`).
 */
export function CheckoutScreen({
  bookId,
  bookLabel,
  onBack,
  onOrderPlaced,
}: {
  bookId: string;
  bookLabel: string;
  onBack: () => void;
  onOrderPlaced: (orderId: string) => void;
}) {
  useDocumentTitle('Order this book · Momora');
  const [step, setStep] = useState<Step>({ kind: 'starting' });

  // StrictMode guard (dev-only issue): React's double-invoked mount effect
  // fired createOrderDraft twice, leaving a stray empty draft row per
  // checkout open — visible on /orders as a confusing "Not started" entry.
  // The ref (which survives StrictMode's simulated remount) caches the
  // in-flight dispatch per bookId; every effect invocation SUBSCRIBES to the
  // cached promise rather than skipping outright, because under StrictMode
  // the first invocation's cleanup has already cancelled its subscription —
  // only the second invocation is live to apply the result.
  const draftDispatch = useRef<{ bookId: string; promise: ReturnType<typeof createOrderDraft> } | null>(null);

  useEffect(() => {
    if (draftDispatch.current?.bookId !== bookId) {
      draftDispatch.current = { bookId, promise: createOrderDraft(bookId) };
    }
    let cancelled = false;
    void draftDispatch.current.promise.then((result) => {
      if (cancelled) return;
      if ('error' in result) {
        setStep({ kind: 'start_failed', error: result.error });
      } else {
        setStep({ kind: 'address', orderId: result.orderId, error: null });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  async function handleAddressSubmit(orderId: string, address: ShippingAddressInput) {
    setStep({ kind: 'quoting', orderId });
    const result = await quoteOrder(orderId, address);
    if ('error' in result) {
      setStep({ kind: 'address', orderId, error: result.error });
      return;
    }
    setStep({ kind: 'quote', orderId, quote: result, submitting: false, error: null });
  }

  async function handlePay(orderId: string, quote: QuoteResult) {
    setStep({ kind: 'quote', orderId, quote, submitting: true, error: null });
    const result = await createCheckoutSession(orderId);
    if ('error' in result) {
      setStep({ kind: 'quote', orderId, quote, submitting: false, error: result.error });
      return;
    }
    if (result.checkoutUrl) {
      // Leaves the app for real Stripe Checkout — the return URL
      // (`/order/<id>` on success, `/b/<bookId>` on cancel) is what brings
      // the parent back in, per memory-book-orders/index.ts's
      // `create_checkout` handler.
      window.location.href = result.checkoutUrl;
      return;
    }
    // DEV fixture mode only: no real Stripe session exists, so "pay" already
    // jumped the order straight to `paid` — navigate in-app instead of
    // leaving the page.
    onOrderPlaced(result.orderId);
  }

  return (
    <CheckoutFrame
      title="Order this book"
      backLabel={bookLabel}
      onBack={onBack}
      // Design Decision 6: edits freeze at payment. Shown on every step of
      // this flow, not just once, since a parent may have opened this
      // screen, wandered off, and come back later after editing more.
      notice="Your book prints exactly as it looks right now. Edits you make after ordering only affect future orders."
    >
      {step.kind === 'starting' && <CheckoutHint>Starting your order…</CheckoutHint>}

      {step.kind === 'start_failed' && <CheckoutError message={step.error} />}

      {step.kind === 'address' && (
        <>
          {step.error && <CheckoutError message={step.error} />}
          <AddressStep submitting={false} onSubmit={(address) => void handleAddressSubmit(step.orderId, address)} />
        </>
      )}

      {step.kind === 'quoting' && <CheckoutHint>Getting your quote…</CheckoutHint>}

      {step.kind === 'quote' && (
        <CheckoutQuote
          lines={[
            { label: 'Book', value: formatMoney(step.quote.priceCents, step.quote.currency) },
            { label: 'Shipping', value: formatMoney(step.quote.shippingCostCents, step.quote.currency) },
          ]}
          total={formatMoney(step.quote.totalCents, step.quote.currency)}
          taxNote="Tax, if applicable, is calculated at checkout."
          error={step.error ? <CheckoutError message={step.error} /> : null}
          payLabel={step.submitting ? 'Redirecting to checkout…' : 'Continue to payment'}
          paying={step.submitting}
          onPay={() => void handlePay(step.orderId, step.quote)}
        />
      )}
    </CheckoutFrame>
  );
}
