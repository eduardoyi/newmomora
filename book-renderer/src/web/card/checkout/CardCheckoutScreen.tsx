import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { setChoices } from '../../../card/edits';
import { AddressStep } from '../../order/AddressStep';
import { CARD_COUNTRY_CODES, formatAddressLines, validateCardAddress } from '../../order/cardAddress';
import { CheckoutError, CheckoutFrame, CheckoutHint, CheckoutQuote } from '../../order/CheckoutShell';
import { useDocumentTitle } from '../../useDocumentTitle';
import type { CardCheckoutContext } from '../CardRoute';
import { CardApiError } from '../cardTypes';
import { FIXTURE_BACKOFF_SCALE, isCardFixture } from '../dev/cardFixture';
import { useCardFonts } from '../useCardHooks';
import { CardOrderStatusPanel } from './CardOrderStatusPanel';
import { CardThumbnails } from './CardThumbnails';
import { cancelCardCheckout, createCardCheckout, createCardDraft, getCardOrderStatus, quoteCardOrder } from './cardOrdersApi';
import { checkoutReducer, creatingCopy, initialModel, pinStatus, type CheckoutStep, type PinStatus } from './checkoutMachine';
import { PRICE_NOTE } from './cardPricing';
import { FREEZE_NOTICE, REORDER_NOTICE, shipByNoteFor } from './checkoutCopy';
import { PACK_OPTIONS, formatMoney, type Packs } from './checkoutTypes';
import { describeCheckoutError, interpretCancelOutcome, type ErrorView } from './errorCopy';
import { buildThumbnailInput, qrSummaryLine } from './thumbnailInput';
import { useCall } from './useCall';
import './CardCheckout.css';

/**
 * The holiday card checkout (docs/plans/holiday-cards-p2.md Step 5), rendered by
 * `CardRoute` in place of the editor. It is the Memory Book's checkout
 * (`order/CheckoutScreen.tsx`: same full-takeover frame, address step, quote
 * card and Stripe redirect, built from the same `CheckoutShell` pieces) plus
 * the card's own additions: a quantity step first, front/back thumbnails in the
 * summary, and the longer "preparing your print files" wait.
 *
 * It reads the route's card and ONE save queue: nothing here saves edits except
 * the QR toggle offered by "turn the QR code off", and every review is of the
 * SERVER-confirmed edits at one version (`expectedEditsVersion` pins it for
 * `create_checkout`).
 *
 *   new / reorder   quantity -> address -> quote -> summary -> Stripe
 *   ?order=…        resume: carry on a draft/quoted order, continue an open checkout, or show its status
 *   ?checkout=success   status page (polls until the printer has it)
 *   ?checkout=cancelled cancel the open checkout once, then back to the editor
 *
 * The state machine is `checkoutMachine.ts` (pure); this file runs its effects.
 */

const TITLE = 'Order your cards';

export function CardCheckoutScreen({ ctx }: { ctx: CardCheckoutContext }) {
  useDocumentTitle('Order your holiday cards · Momora');
  // The buyer was sent to a specific order's status (ORDER_ALREADY_PAID, a past order's "View").
  const [statusFor, setStatusFor] = useState<string | null>(null);

  if (statusFor) return <CardOrderStatusPanel orderId={statusFor} returnedFromPayment={false} onBack={ctx.onBack} />;
  if (ctx.returnStatus === 'cancelled') return <CancelReturn ctx={ctx} onShowStatus={setStatusFor} />;
  if (ctx.returnStatus === 'success') {
    if (ctx.orderId) return <CardOrderStatusPanel orderId={ctx.orderId} returnedFromPayment onBack={ctx.onBack} />;
    return (
      <Frame ctx={ctx}>
        <Message message="We could not tell which order this was. If you paid, it is safe: open your card to see it, or write to us." onBack={ctx.onBack} />
      </Frame>
    );
  }
  if (ctx.orderId) return <ResumeOrder ctx={ctx} orderId={ctx.orderId} onShowStatus={setStatusFor} />;
  return <OrderFlow ctx={ctx} initialOrder={null} resumeOrderId={null} onShowStatus={setStatusFor} />;
}

// ── Frame and small pieces ───────────────────────────────────────────────

function isLocked(ctx: CardCheckoutContext): boolean {
  return Boolean(ctx.card.view?.isOrdered || ctx.card.view?.editorView?.locked);
}

/** The shared checkout frame: the same header, notice and body the book's checkout uses. */
function Frame({
  ctx,
  title = TITLE,
  onBack,
  backLabel = 'Your card',
  backDisabled,
  children,
}: {
  ctx: CardCheckoutContext;
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  backDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <CheckoutFrame title={title} backLabel={backLabel} onBack={onBack ?? ctx.onBack} backDisabled={backDisabled} notice={isLocked(ctx) ? REORDER_NOTICE : FREEZE_NOTICE}>
      {children}
    </CheckoutFrame>
  );
}

function Message({ message, onBack, onRetry, retryLabel = 'Try again' }: { message: string; onBack: () => void; onRetry?: () => void; retryLabel?: string }) {
  return (
    <>
      <CheckoutError message={message} />
      {onRetry && (
        <button type="button" className="cc-action" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
      <button type="button" className="cc-action" onClick={onBack}>
        Back to your card
      </button>
    </>
  );
}

// ── Cancelled return ─────────────────────────────────────────────────────

/** `?checkout=cancelled`: cancel the open checkout ONCE (ref-guarded: StrictMode), then back to the editor. */
function CancelReturn({ ctx, onShowStatus }: { ctx: CardCheckoutContext; onShowStatus: (orderId: string) => void }) {
  const orderId = ctx.orderId;
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<ErrorView | null>(null);
  const latest = useRef({ onBack: ctx.onBack, onShowStatus });
  latest.current = { onBack: ctx.onBack, onShowStatus };

  useCall(
    orderId !== null && failure === null,
    attempt,
    () => cancelCardCheckout(orderId as string).then(() => null, (e: unknown) => (e instanceof CardApiError ? e : new CardApiError(0, 'network_error', 'Network error'))),
    (error) => {
      const outcome = interpretCancelOutcome(error);
      if (outcome === 'cancelled') latest.current.onBack();
      else if (outcome === 'status') latest.current.onShowStatus(orderId as string);
      else setFailure(describeCheckoutError(error as CardApiError));
    },
    () => undefined,
  );
  // No order to cancel: just go back.
  useEffect(() => {
    if (orderId === null) latest.current.onBack();
  }, [orderId]);

  return (
    <Frame ctx={ctx} title="Checkout cancelled">
      {failure ? (
        <Message
          message={`${failure.message} Nothing was charged.`}
          onRetry={() => {
            setFailure(null);
            setAttempt((n) => n + 1);
          }}
          onBack={ctx.onBack}
        />
      ) : (
        <CheckoutHint>Cancelling this checkout… Nothing was charged.</CheckoutHint>
      )}
    </Frame>
  );
}

// ── Resume (?order=…) ────────────────────────────────────────────────────

/** An order id with no return status: carry on a draft/quoted order, continue an open checkout, or show where a later order stands. */
function ResumeOrder({ ctx, orderId, onShowStatus }: { ctx: CardCheckoutContext; orderId: string; onShowStatus: (orderId: string) => void }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; error: ErrorView } | { kind: 'order'; status: Awaited<ReturnType<typeof getCardOrderStatus>>['status'] }
  >({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useCall(
    state.kind !== 'order',
    attempt,
    () => getCardOrderStatus(orderId),
    (order) => setState({ kind: 'order', status: order.status }),
    (e) => setState({ kind: 'error', error: describeCheckoutError(e instanceof CardApiError ? e : new CardApiError(0, 'network_error', 'Network error')) }),
  );

  if (state.kind === 'loading') {
    return (
      <Frame ctx={ctx}>
        <CheckoutHint>Loading your order…</CheckoutHint>
      </Frame>
    );
  }
  if (state.kind === 'error') {
    return (
      <Frame ctx={ctx}>
        <Message
          message={state.error.message}
          onBack={ctx.onBack}
          onRetry={() => {
            setState({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        />
      </Frame>
    );
  }
  const needsCard = state.status === 'draft' || state.status === 'quoted' || state.status === 'checkout';
  if (needsCard && !ctx.card.view) {
    // The card itself has to be loaded to review it (a page load straight onto `?order=`).
    return (
      <Frame ctx={ctx}>
        {ctx.card.status === 'error' ? <Message message="We could not load your card." onBack={ctx.onBack} onRetry={() => void ctx.card.refetch()} /> : <CheckoutHint>Loading your card…</CheckoutHint>}
      </Frame>
    );
  }
  if (state.status === 'draft' || state.status === 'quoted') {
    return <OrderFlow ctx={ctx} initialOrder={{ orderId, status: state.status }} resumeOrderId={null} onShowStatus={onShowStatus} />;
  }
  if (state.status === 'checkout') {
    return <OrderFlow ctx={ctx} initialOrder={null} resumeOrderId={orderId} onShowStatus={onShowStatus} />;
  }
  return <CardOrderStatusPanel orderId={orderId} returnedFromPayment={false} onBack={ctx.onBack} />;
}

// ── The order flow ───────────────────────────────────────────────────────

function usePin(ctx: CardCheckoutContext): { status: PinStatus; version: number } {
  const { edits, card } = ctx;
  const view = card.view;
  const status = pinStatus({
    queueReady: edits.ready,
    queueIdle: edits.idle,
    queueHasError: edits.error !== null,
    serverVersion: edits.serverVersion,
    viewVersion: view?.editorView ? view.card.editsVersion : null,
  });
  // After a save the card is refetched; if that read lagged, ask again (a few times at most).
  const requests = useRef(0);
  const { refetch } = card;
  useEffect(() => {
    if (status === 'syncing' && edits.idle && requests.current < 3) {
      requests.current += 1;
      void refetch();
    }
  }, [status, edits.idle, edits.serverVersion, card.fetchedAt, refetch]);
  return { status, version: edits.serverVersion };
}

const SAVE_PENDING = () => new CardApiError(0, 'SAVE_PENDING', 'Your last change has not been saved yet.');

function toApiError(e: unknown): CardApiError {
  return e instanceof CardApiError ? e : new CardApiError(0, 'network_error', e instanceof Error ? e.message : 'Network error');
}

function OrderFlow({
  ctx,
  initialOrder,
  resumeOrderId,
  onShowStatus,
}: {
  ctx: CardCheckoutContext;
  initialOrder: { orderId: string; status: 'draft' | 'quoted' } | null;
  /** An order already in `checkout` to continue (its create_checkout resumes the Stripe session). */
  resumeOrderId: string | null;
  onShowStatus: (orderId: string) => void;
}) {
  const locked = isLocked(ctx);
  const [model, dispatch] = useReducer(checkoutReducer, undefined, () => initialModel({ locked, order: initialOrder }));
  const { step } = model;
  const pin = usePin(ctx);
  const fonts = useCardFonts();

  // Latest values for effects and async handlers (their closures outlive a render).
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const modelRef = useRef(model);
  modelRef.current = model;
  const pinRef = useRef(pin);
  pinRef.current = pin;

  // 1. A new order: save anything pending, then create the draft.
  useCall(
    step.kind === 'starting' && resumeOrderId === null,
    model.run,
    async () => {
      await ctxRef.current.edits.flush();
      if (!ctxRef.current.edits.isIdle()) throw SAVE_PENDING();
      return createCardDraft(ctxRef.current.cardId);
    },
    (draft) => dispatch({ type: 'START_OK', orderId: draft.orderId }),
    (e) => dispatch({ type: 'START_FAILED', error: toApiError(e) }),
  );

  // 1b. Continuing an open checkout: wait for the card to be at its confirmed version, then re-call create_checkout.
  useEffect(() => {
    if (resumeOrderId === null || step.kind !== 'starting') return;
    if (pin.status === 'ready') dispatch({ type: 'RESUME', orderId: resumeOrderId, expectedVersion: pin.version, now: Date.now() });
    else if (pin.status === 'save_error') dispatch({ type: 'START_FAILED', error: SAVE_PENDING() });
  }, [resumeOrderId, step.kind, pin.status, pin.version]);

  // 2. The quote.
  useCall(
    step.kind === 'quoting',
    model.run,
    () => {
      const s = modelRef.current.step;
      if (s.kind !== 'quoting') return Promise.reject(new CardApiError(0, 'bad_response', 'Unexpected state'));
      return quoteCardOrder(s.orderId, s.packs, s.address);
    },
    (quote) => dispatch({ type: 'QUOTE_OK', quote }),
    (e) => dispatch({ type: 'QUOTE_FAILED', error: toApiError(e) }),
  );

  // 3. Checkout (prints files, ~30-60 s). A timeout / "still preparing" waits out a backoff and calls again.
  const creatingNow = step.kind === 'creating' && !step.waiting;
  useCall(
    creatingNow,
    model.run,
    () => {
      const s = modelRef.current.step;
      if (s.kind !== 'creating') return Promise.reject(new CardApiError(0, 'bad_response', 'Unexpected state'));
      return createCardCheckout(s.orderId, s.expectedVersion);
    },
    (session) => dispatch({ type: 'CHECKOUT_OK', url: session.checkoutUrl }),
    (e) => dispatch({ type: 'CHECKOUT_FAILED', error: toApiError(e), now: Date.now() }),
  );
  const waiting = step.kind === 'creating' && step.waiting;
  const waitMs = step.kind === 'creating' ? step.delayMs : 0;
  useEffect(() => {
    if (!waiting) return undefined;
    // The dev walkthrough shortens the waits so the timeout path can be watched in seconds.
    const scale = import.meta.env.DEV && isCardFixture() ? FIXTURE_BACKOFF_SCALE : 1;
    const timer = setTimeout(() => dispatch({ type: 'BACKOFF_ELAPSED' }), waitMs * scale);
    return () => clearTimeout(timer);
  }, [waiting, waitMs, model.run]);

  // 4. Off to Stripe (the same full-page redirect the book checkout does).
  const redirectUrl = step.kind === 'redirecting' ? step.url : null;
  const redirected = useRef<string | null>(null);
  useEffect(() => {
    if (redirectUrl && redirected.current !== redirectUrl) {
      redirected.current = redirectUrl;
      window.location.assign(redirectUrl);
    }
  }, [redirectUrl]);

  // 5. On the summary, make sure nothing is waiting to save (the review is of saved edits).
  const onSummary = step.kind === 'summary';
  useEffect(() => {
    if (onSummary) void ctxRef.current.edits.flush();
  }, [onSummary]);

  async function pay() {
    await ctxRef.current.edits.flush();
    const p = pinRef.current;
    if (!ctxRef.current.edits.isIdle() || p.status !== 'ready') return;
    dispatch({ type: 'PAY', expectedVersion: p.version, now: Date.now() });
  }

  async function turnQrOff() {
    ctx.edits.update((e) => setChoices(e, { qr: false }), { tag: 'qr' });
    await ctxRef.current.edits.flush();
    dispatch({ type: 'DISMISS_ERROR' });
  }

  function runAction(error: ErrorView, orderId: string | null) {
    switch (error.action) {
      case 'retry':
        if (step.kind === 'summary') void pay();
        else if (step.kind === 'failed') {
          if (step.resume) dispatch({ type: 'RESUME', orderId: step.resume.orderId, expectedVersion: pin.status === 'ready' ? pin.version : step.resume.expectedVersion, now: Date.now() });
          else dispatch({ type: 'RETRY_START' });
        } else dispatch({ type: 'DISMISS_ERROR' });
        break;
      case 'requote':
        if (step.kind === 'summary') dispatch({ type: 'GO_ADDRESS' });
        else dispatch({ type: 'DISMISS_ERROR' });
        break;
      case 'back_to_editor':
        ctx.onBack();
        break;
      case 'turn_qr_off':
        void turnQrOff();
        break;
      case 'reload':
        window.location.reload();
        break;
      case 'status':
        if (orderId) onShowStatus(orderId);
        else ctx.onBack();
        break;
      case 'none':
        break;
    }
  }

  // ── render ──
  switch (step.kind) {
    case 'starting':
      return (
        <Frame ctx={ctx}>
          <CheckoutHint>{resumeOrderId !== null && pin.status !== 'ready' ? 'Checking your latest changes…' : 'Starting your order…'}</CheckoutHint>
        </Frame>
      );

    case 'failed':
      return (
        <Frame ctx={ctx}>
          <ErrorNotice error={step.error} orderId={step.resume?.orderId ?? null} locked={locked} onAction={runAction} />
        </Frame>
      );

    case 'quantity':
      return (
        <Frame ctx={ctx}>
          <QuantityStep packs={step.packs} onPick={(packs) => dispatch({ type: 'PICK_PACKS', packs })} onContinue={() => dispatch({ type: 'CONTINUE_QUANTITY' })} />
        </Frame>
      );

    case 'address':
    case 'quoting':
      return (
        <Frame ctx={ctx} onBack={() => dispatch({ type: 'GO_QUANTITY' })} backLabel="Quantity" backDisabled={step.kind === 'quoting'}>
          <CheckoutHint>We deliver to the United States and Canada. {shipByNoteFor(ctx.card.view?.shipByNote, step.address?.countryCode ?? null)}</CheckoutHint>
          {step.kind === 'address' && step.error && <ErrorNotice error={step.error} orderId={step.orderId} locked={locked} onAction={runAction} />}
          {/* One AddressStep for both steps (the same component the book uses), so what was typed survives a failed quote. */}
          <AddressStep
            submitting={step.kind === 'quoting'}
            allowedCountries={CARD_COUNTRY_CODES}
            requireRegion
            defaultAddress={step.address ?? undefined}
            onSubmit={(input) => {
              const checked = validateCardAddress(input);
              if (checked.ok) dispatch({ type: 'ADDRESS_SUBMITTED', address: checked.address });
            }}
          />
        </Frame>
      );

    case 'summary':
    case 'creating':
    case 'redirecting': {
      const shown = summaryFor(step);
      if (!shown) {
        // Continuing an open checkout: nothing to review, just the wait.
        const copy = step.kind === 'creating' ? creatingCopy(step) : { title: 'Redirecting to checkout…', body: '' };
        return (
          <Frame ctx={ctx} backDisabled>
            <CheckoutHint>
              {copy.title} {copy.body}
            </CheckoutHint>
          </Frame>
        );
      }
      return (
        <Frame ctx={ctx} onBack={() => dispatch({ type: 'GO_ADDRESS' })} backLabel="Address" backDisabled={step.kind !== 'summary'}>
          <SummaryStep
            shown={shown}
            busy={step.kind === 'summary' ? null : step.kind === 'creating' ? step : 'redirecting'}
            pinState={pin.status}
            ctx={ctx}
            fontsReady={fonts.status === 'ready'}
            fontsFailed={fonts.status === 'error'}
            onPay={() => void pay()}
            onChangeQuantity={() => dispatch({ type: 'GO_QUANTITY' })}
            onChangeAddress={() => dispatch({ type: 'GO_ADDRESS' })}
            onAction={runAction}
          />
        </Frame>
      );
    }
  }
}

/** What the summary shows for the summary / creating / redirecting steps (null when there is nothing behind it: a resumed checkout). */
interface SummaryShown {
  orderId: string;
  packs: Packs;
  address: Extract<CheckoutStep, { kind: 'summary' }>['address'];
  quote: Extract<CheckoutStep, { kind: 'summary' }>['quote'];
  error: ErrorView | null;
}

function summaryFor(step: CheckoutStep): SummaryShown | null {
  if (step.kind === 'summary') return { orderId: step.orderId, packs: step.packs, address: step.address, quote: step.quote, error: step.error };
  if (step.kind === 'creating' && step.back) return { orderId: step.orderId, ...step.back, error: null };
  return null;
}

// ── Steps ────────────────────────────────────────────────────────────────

function QuantityStep({ packs, onPick, onContinue }: { packs: Packs | null; onPick: (packs: Packs) => void; onContinue: () => void }) {
  return (
    <>
      <fieldset className="cc-options">
        <legend className="cc-options__legend">How many cards would you like?</legend>
        {PACK_OPTIONS.map((option) => (
          <label key={option.packs} className={`cc-option${packs === option.packs ? ' is-selected' : ''}`}>
            <input type="radio" name="packs" value={option.packs} checked={packs === option.packs} onChange={() => onPick(option.packs)} />
            <span className="cc-option__main">
              <span className="cc-option__cards">{option.cards} cards</span>
              <span className="cc-option__each">
                {formatMoney(option.pricePerCardCents)} per card
                {option.savingsPercent > 0 && <span className="cc-option__save">Save {option.savingsPercent}%</span>}
              </span>
            </span>
            <span className="cc-option__price">{formatMoney(option.totalCents)}</span>
          </label>
        ))}
      </fieldset>
      <CheckoutHint>{PRICE_NOTE}</CheckoutHint>
      <button type="button" className="checkout-quote__pay" disabled={packs === null} onClick={onContinue}>
        Continue
      </button>
    </>
  );
}

function SummaryStep({
  shown,
  busy,
  pinState,
  ctx,
  fontsReady,
  fontsFailed,
  onPay,
  onChangeQuantity,
  onChangeAddress,
  onAction,
}: {
  shown: SummaryShown;
  /** The creating step (with its copy) or the redirect: the pay button is spent. */
  busy: Extract<CheckoutStep, { kind: 'creating' }> | 'redirecting' | null;
  pinState: PinStatus;
  ctx: CardCheckoutContext;
  fontsReady: boolean;
  fontsFailed: boolean;
  onPay: () => void;
  onChangeQuantity: () => void;
  onChangeAddress: () => void;
  onAction: (error: ErrorView, orderId: string | null) => void;
}) {
  const { quote, address } = shown;
  const view = ctx.card.view;
  // The same resolution the thumbnails use, so the words match the picture.
  const thumbInput = pinState === 'ready' || busy ? buildThumbnailInput(view, ctx.edits.edits) : null;
  const shipBy = shipByNoteFor(view?.shipByNote, address.countryCode);
  const payLabel = busy === 'redirecting' ? 'Redirecting to checkout…' : busy ? creatingCopy(busy).title : 'Continue to payment';

  let before: ReactNode;
  if (pinState === 'ready' && view) {
    before = fontsFailed ? (
      <CheckoutHint>We could not load the card fonts for a preview here. Your card will print as you saw it in the editor.</CheckoutHint>
    ) : (
      <CardThumbnails view={view} edits={ctx.edits.edits} fontsReady={fontsReady} onImageError={ctx.card.reportImageError} />
    );
  } else if (pinState === 'save_error') {
    before = <CheckoutError message="Your last change to the card has not been saved yet. Go back to your card to try again." />;
  } else {
    before = <CheckoutHint>Checking your latest changes…</CheckoutHint>;
  }

  return (
    <CheckoutQuote
      before={before}
      lines={[
        { label: 'Cards', value: `${quote.cards} cards` },
        { label: 'Price per card', value: formatMoney(Math.round(quote.priceCents / quote.cards), quote.currency) },
      ]}
      total={formatMoney(quote.priceCents, quote.currency)}
      taxNote="Shipping is included. Tax, if applicable, is calculated at checkout."
      extra={
        <>
          <div className="cc-block">
            <span className="cc-block__label">Sending to</span>
            {formatAddressLines(address).map((line, i) => (
              <span key={i} className="cc-block__line">
                {line}
              </span>
            ))}
            {!busy && (
              <span>
                <button type="button" className="cc-link" onClick={onChangeAddress}>
                  Change address
                </button>
                <button type="button" className="cc-link" onClick={onChangeQuantity}>
                  Change quantity
                </button>
              </span>
            )}
          </div>
          {thumbInput && <CheckoutHint>{qrSummaryLine(thumbInput)}</CheckoutHint>}
          {shipBy && <CheckoutHint>{shipBy}</CheckoutHint>}
          {busy && busy !== 'redirecting' && <CheckoutHint>{creatingCopy(busy).body}</CheckoutHint>}
        </>
      }
      error={shown.error ? <ErrorNotice error={shown.error} orderId={shown.orderId} locked={isLocked(ctx)} onAction={onAction} /> : null}
      payLabel={payLabel}
      paying={busy !== null}
      payDisabled={pinState !== 'ready'}
      onPay={onPay}
    />
  );
}

// ── Errors ───────────────────────────────────────────────────────────────

const ACTION_LABEL: Record<ErrorView['action'], string | null> = {
  retry: 'Try again',
  requote: 'Check address and quantity',
  back_to_editor: 'Back to your card',
  turn_qr_off: 'Turn the QR code off',
  reload: 'Reload',
  status: 'See order status',
  none: null,
};

function ErrorNotice({ error, orderId, locked, onAction }: { error: ErrorView; orderId: string | null; locked: boolean; onAction: (error: ErrorView, orderId: string | null) => void }) {
  const label = ACTION_LABEL[error.action];
  return (
    <>
      <CheckoutError message={error.message} />
      {label && !(locked && error.action === 'turn_qr_off') && (
        <button type="button" className="cc-action" onClick={() => onAction(error, orderId)}>
          {label}
        </button>
      )}
    </>
  );
}
