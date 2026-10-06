import { useEffect, useState } from 'react';
import { OrderProgressStepper } from '../../order/OrderProgressStepper';
import { OrderStatusLayout } from '../../order/OrderStatusLayout';
import { CONFIRMING_SLOW_AFTER_MS, CONFIRMING_SLOW_NOTE, cardStatusLayoutModel, isConfirmingPayment } from './cardOrderStatusCopy';
import { CARD_STEPPER, cardShowsStepper } from './cardProgress';
import { SUPPORT_EMAIL } from './errorCopy';
import { useCardOrderStatus } from './useCardOrderStatus';

/**
 * A holiday card order's status page (docs/plans/holiday-cards-p2.md Step 5):
 * the return from Stripe's success page, and "View" on an order in the editor
 * or the orders list. It is the Memory Book's order page (`OrderStatusLayout`
 * + `OrderProgressStepper`) fed by a card adapter (`cardStatusLayoutModel`),
 * polling while the order is before the printer. A payment still in `checkout`
 * right after the success return is "Confirming your payment…" (the webhook is
 * late): there is never a cancel button here.
 */
export function CardOrderStatusPanel({
  orderId,
  returnedFromPayment,
  onBack,
}: {
  orderId: string;
  /** The buyer just came back from Stripe's success page. */
  returnedFromPayment: boolean;
  /** Back to the card (also refreshes it: a paid order locks the card). */
  onBack: () => void;
}) {
  const { status, order, error, stale, startedAt, reload } = useCardOrderStatus(orderId);

  // "Taking longer than usual" while the payment is still unconfirmed.
  const [now, setNow] = useState(() => Date.now());
  const confirming = order ? isConfirmingPayment(order.status, returnedFromPayment) : false;
  useEffect(() => {
    if (!confirming) return undefined;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [confirming]);

  if (status === 'loading') {
    return (
      <div className="order-status order-status--center">
        <p className="order-status__hint">Loading your order…</p>
      </div>
    );
  }
  if (status === 'error' || !order) {
    return (
      <div className="order-status order-status--center">
        <p className="order-status__error">{error?.message ?? 'Order not found.'}</p>
        <button type="button" className="order-status__resume" onClick={reload}>
          Try again
        </button>
        <button type="button" className="order-status__resume" onClick={onBack}>
          Back to your card
        </button>
      </div>
    );
  }

  const model = cardStatusLayoutModel(order, {
    returnedFromPayment,
    showStepper: cardShowsStepper(order.status, order.refundedAt) && !order.refunded,
  });
  const slow = confirming && now - startedAt >= CONFIRMING_SLOW_AFTER_MS;

  return (
    <OrderStatusLayout
      backLabel="← Your card"
      onBack={onBack}
      thanks={model.thanks}
      chip={model.chip}
      message={model.message}
      note={
        slow || stale ? (
          <p className="order-status__hint">
            {slow ? CONFIRMING_SLOW_NOTE : 'We are having trouble refreshing this page. We will keep trying.'}
          </p>
        ) : null
      }
      refundedAt={model.refundedAt}
      stepper={model.showStepper ? <OrderProgressStepper status={order.status} carrier={order.carrier} config={CARD_STEPPER} /> : null}
      tracking={model.tracking}
      facts={model.facts}
      shipTo={model.shipTo}
      resume={model.showResume ? { label: 'Back to your card', onClick: onBack } : null}
      contact={
        <>
          Questions about your order? Just reply to your confirmation email or message us at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </>
      }
    />
  );
}
