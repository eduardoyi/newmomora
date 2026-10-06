import { useEffect, useMemo, useRef, useState } from 'react';
import { FocalPointModalView } from '../edits/FocalPointModalView';
import { buildCardDocument, type CardDocument, type RegionTarget } from '../../card/document';
import {
  resetFocal,
  resetLetter,
  resetText,
  setChoices,
  setFocal,
  setFrontImage,
  setLetter,
  setText,
  type CardEdits,
  type TextTarget,
} from '../../card/edits';
import { cardInputFromData, defaultFrontId, frontOptionsOf, letterFor, resolveFront } from '../../card/fromData';
import { greetingText } from '../../card/greetings';
import { createCanvasMeasure } from '../../card/measure';
import { cardFontStacks } from '../../card/fonts';
import type { FrontPhotoProvider, PickerItem } from '../../card/preview/photoProvider';
import { CardPhotoPicker } from '../../card/preview/CardPhotoPicker';
import { EditableSheet, type FieldState } from '../../card/preview/EditableSheet';
import type { CardData } from '../../card/types';
import { useAuthSession } from '../auth/useAuthSession';
import { ConnectedShopHeader } from '../shell/ConnectedShopHeader';
import { useDocumentTitle } from '../useDocumentTitle';
import { cardOrderStatusCopy } from './checkout/cardOrderStatusCopy';
import { SHOP_CARD_FONTS } from './cardFonts';
import type { CardApiError, FilmUrls, HolidayCardView } from './cardTypes';
import { useCardEdits } from './CardEditsProvider';
import {
  SUPPORT_EMAIL,
  deriveScreenState,
  draftWarning,
  effectiveQrState,
  formatPrice,
  frontRejectionMessage,
  letterToneOptions,
  ORDER_BLOCK_COPY,
  orderGate,
  orderStatusName,
  previewQrOn,
  reorderGate,
  CHECKOUT_OPEN_NOTE,
  qrControl,
  type ScreenState,
} from './editorState';
import { FilmPanel } from './FilmPanel';
import { PhoneTextSheet } from './PhoneTextSheet';
import { buildAssetUrl, frontIdForPick, localFrontFromPick, mergeFrontOptions, pruneLocalFronts, removeLocalFront, type LocalFront } from './pickerProvider';
import { useElementWidth, useIsPhone, useIsTouch, useNow } from './useCardHooks';
import './CardEditorScreen.css';

/**
 * The shop's holiday-card editor (docs/plans/holiday-cards-p2.md Step 4): the
 * card dogfood editor (`src/card/preview/App.tsx`) minus its local-only parts,
 * wired to the server. This screen does NOT fetch or save: it renders the view
 * `CardRoute` loaded and reads/writes edits through the shared save queue
 * (`useCardEdits`), so the same edits survive moving to checkout and back.
 */

/** A 1x1 transparent GIF: what an asset the server did not sign draws (an empty `src` would fire `error` and loop refetches). */
const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** Drawn in the preview only while the QR's real link is not published yet. */
const PREVIEW_QR_URL = 'https://usemomora.com';

export interface CardEditorScreenProps {
  view: HolidayCardView | null;
  load: 'loading' | 'ready' | 'error';
  error: CardApiError | null;
  fontsStatus: 'loading' | 'ready' | 'error';
  photoProvider: FrontPhotoProvider;
  loadFilmUrls: (filmId: string) => Promise<FilmUrls>;
  onRetryLoad: () => void;
  onRetryFonts: () => void;
  /** An `<img>` failed to load (an expired signed URL): ask for fresh ones. */
  onImageError: () => void;
  /** "Order cards" / "Order more cards": the queue has been flushed and is idle. */
  onOrder: () => void;
  onSignOut: () => void;
  /** Your own open checkout: continue it. */
  onResumeCheckout?: (orderId: string) => void;
  /** Your own open checkout: cancel it (resolves once it is gone and the card was refetched; rejects with a message-bearing error). */
  onCancelCheckout?: (orderId: string) => Promise<void>;
  onOpenOrder?: (orderId: string) => void;
  /** The header's wordmark and "← Home" (navigates to "/"). */
  onHome: () => void;
  /** The header's "Your orders" (navigates to "/orders"). */
  onOpenOrders: () => void;
}

const SHEET_FONTS = SHOP_CARD_FONTS;

export function CardEditorScreen(props: CardEditorScreenProps) {
  const queue = useCardEdits();
  const now = useNow(30_000);
  const firstSeen = useRef(Date.now()).current;
  const nav: Nav = { onHome: props.onHome, onOpenOrders: props.onOpenOrders };
  const screen = deriveScreenState({
    load: props.load,
    error: props.error,
    view: props.view,
    queueLocked: queue.locked,
    queueCheckoutOpen: queue.checkoutOpen,
    nowMs: now,
    firstSeenMs: firstSeen,
  });

  if (screen.kind === 'locked' || screen.kind === 'checkoutOpen' || screen.kind === 'editing') {
    if (props.view?.editorView) {
      if (props.fontsStatus === 'error') {
        return (
          <Shell nav={nav}>
            <StatusCard title="The card fonts didn't load" body="We need them to show your card exactly as it will print. Check your connection and try again.">
              <button type="button" className="ce-btn" onClick={props.onRetryFonts}>
                Try again
              </button>
            </StatusCard>
          </Shell>
        );
      }
      return <EditorBody {...props} view={props.view} screen={screen} />;
    }
  }
  return <StatusPanel screen={screen} {...props} />;
}

// ── Non-editing states ───────────────────────────────────────────────────

type Nav = Pick<CardEditorScreenProps, 'onHome' | 'onOpenOrders'>;

function Shell({ nav, children }: { nav: Nav; children: React.ReactNode }) {
  return (
    <div className="ce ce--status">
      <ConnectedShopHeader onHome={nav.onHome} onOpenOrders={nav.onOpenOrders} showBack />
      <div className="ce-status">{children}</div>
    </div>
  );
}

function StatusCard({ title, body, children }: { title: string; body: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section className="ce-statuscard">
      <h1 className="ce-statuscard__title">{title}</h1>
      <p className="ce-statuscard__body">{body}</p>
      {children && <div className="ce-statuscard__actions">{children}</div>}
    </section>
  );
}

function StatusPanel({ screen, onRetryLoad, onSignOut, onHome, onOpenOrders }: { screen: ScreenState } & CardEditorScreenProps) {
  const nav: Nav = { onHome, onOpenOrders };
  const { session } = useAuthSession();
  const email = session?.user.email ?? null;
  switch (screen.kind) {
    case 'loading':
      return (
        <Shell nav={nav}>
          <p className="ce-loading">Loading your card…</p>
        </Shell>
      );
    case 'notFound':
      return (
        <Shell nav={nav}>
          <StatusCard title="We couldn't find this card" body="It may have been deleted, or the link is incomplete.">
            <button type="button" className="ce-btn" onClick={onHome}>
              Go to your keepsakes
            </button>
          </StatusCard>
        </Shell>
      );
    case 'forbidden':
      return (
        <Shell nav={nav}>
          <StatusCard
            title="You can't open this card"
            body={`Only the family's owner or a manager can open the holiday card.${email ? ` You're signed in as ${email}.` : ''}`}
          >
            <button type="button" className="ce-btn" onClick={onHome}>
              Go to your keepsakes
            </button>
            <button type="button" className="ce-btn ce-btn--ghost" onClick={onSignOut}>
              Sign out
            </button>
          </StatusCard>
        </Shell>
      );
    case 'error':
      return (
        <Shell nav={nav}>
          <StatusCard title="We couldn't open your card" body={screen.message}>
            <button type="button" className="ce-btn" onClick={onRetryLoad}>
              Retry
            </button>
          </StatusCard>
        </Shell>
      );
    case 'preparing':
      if (screen.phase === 'film') {
        return (
          <Shell nav={nav}>
            <StatusCard
              title={screen.slow ? 'This is taking longer than usual' : 'Your card is almost ready'}
              body={
                screen.slow ? (
                  <>We're still making the film for the QR code. You can close this page: we'll notify you in the Momora app when it's ready. If it doesn't arrive soon, write to {SUPPORT_EMAIL}.</>
                ) : (
                  <>We're making the film for its QR code. This takes about 20 minutes; we'll notify you in the Momora app when it's ready. You can close this page.</>
                )
              }
            >
              <span className="ce-spinner" aria-hidden="true" />
            </StatusCard>
          </Shell>
        );
      }
      return (
        <Shell nav={nav}>
          <StatusCard
            title={screen.slow ? 'This is taking longer than usual' : 'Getting your card ready'}
            body={
              screen.slow ? (
                <>We're still putting your card together. You can leave this page open or come back later: your card will be here. If it doesn't appear soon, write to {SUPPORT_EMAIL}.</>
              ) : (
                <>We're choosing a photo and writing your letter. This usually takes about two minutes, and this page updates by itself.</>
              )
            }
          >
            <span className="ce-spinner" aria-hidden="true" />
          </StatusCard>
        </Shell>
      );
    case 'failed':
      return (
        <Shell nav={nav}>
          {screen.retrying ? (
            <StatusCard title="We hit a snag, and we're retrying" body="Something went wrong while putting your card together. We're trying again, and this page updates by itself." />
          ) : (
            <StatusCard
              title="We couldn't make this card"
              body={
                <>
                  Something went wrong that we can't fix by retrying. Please write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
                  {screen.code ? <> and mention {screen.code}</> : null}, and we'll sort it out.
                </>
              }
            />
          )}
        </Shell>
      );
    default:
      return null;
  }
}

// ── The editor ───────────────────────────────────────────────────────────

type EditorBodyProps = CardEditorScreenProps & { view: HolidayCardView; screen: ScreenState };

function withDraft(edits: CardEdits, draft: { target: RegionTarget; value: string } | null): CardEdits {
  if (!draft) return edits;
  if (draft.target === 'letter') return setLetter(edits, edits.choices.tone, draft.value);
  return setText(edits, draft.target as TextTarget, draft.value);
}

function EditorBody(props: EditorBodyProps) {
  const { view, screen } = props;
  const editor = view.editorView!;
  const queue = useCardEdits();
  const isPhone = useIsPhone();
  const isTouch = useIsTouch();
  const textSheet = isPhone || isTouch;
  useDocumentTitle(`Holiday card ${editor.cardData.year} · Momora`);
  const fontsReady = props.fontsStatus === 'ready';
  const readOnly = screen.kind !== 'editing';
  const locked = screen.kind === 'locked';
  const stacks = cardFontStacks(SHEET_FONTS);

  const [active, setActive] = useState<RegionTarget | null>(null);
  const [draft, setDraft] = useState<{ target: RegionTarget; value: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [focalOpen, setFocalOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [locals, setLocals] = useState<LocalFront[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [stageRef, stageWidth] = useElementWidth<HTMLDivElement>();
  const [viewportH, setViewportH] = useState(window.innerHeight);

  useEffect(() => {
    const on = () => setViewportH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // A picture on the card failed to load (its signed URL expired): ask for fresh ones.
  const onImageError = props.onImageError;
  useEffect(() => {
    function onError(e: Event) {
      const t = e.target;
      if (t instanceof HTMLImageElement && t.closest('.card-sheet')) onImageError();
    }
    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, [onImageError]);

  // The server rejected the picked front: forget the local pick and say why.
  const seenRejection = useRef(0);
  const currentFrontId = queue.edits.frontImage;
  useEffect(() => {
    const r = queue.rejection;
    if (!r || r.id === seenRejection.current) return;
    seenRejection.current = r.id;
    setLocals((prev) => prev.filter((l) => l.option.id === currentFrontId));
    setNotice(frontRejectionMessage(r.code));
  }, [queue.rejection, currentFrontId]);

  // The server lists the picked photo now: its real file replaces the local placeholder.
  const serverOptions = useMemo(() => frontOptionsOf(editor.cardData), [editor.cardData]);
  useEffect(() => {
    setLocals((prev) => {
      const next = pruneLocalFronts(prev, serverOptions);
      return next.length === prev.length ? prev : next;
    });
  }, [serverOptions]);

  const cardData: CardData = useMemo(
    () => ({
      ...editor.cardData,
      frontOptions: mergeFrontOptions(serverOptions, locals),
      qr: { ...editor.cardData.qr, url: editor.cardData.qr.url || PREVIEW_QR_URL },
    }),
    [editor.cardData, serverOptions, locals],
  );
  const assetUrl = useMemo(() => buildAssetUrl(editor.assets, locals, BLANK_IMAGE), [editor.assets, locals]);

  const baseEdits = locked ? editor.edits : queue.edits;
  const front = resolveFront(cardData, baseEdits);
  const isIllustration = front.option.kind === 'illustration';
  const imageId = front.option.id;
  const qrState = effectiveQrState(editor.qrState, queue.edits.choices.qr, editor.edits.choices.qr);
  const qr = qrControl({ qrState, linkDisabled: view.linkDisabled, choice: baseEdits.choices.qr, cardDefault: cardData.qr.enabled });
  const qrOn = previewQrOn(qrState, view.linkDisabled, baseEdits.choices.qr, cardData.qr.enabled);

  const shown = useMemo(() => setChoices(withDraft(baseEdits, draft), { qr: qrOn, greeting: undefined }), [baseEdits, draft, qrOn]);
  const measure = useMemo(() => (fontsReady ? createCanvasMeasure(SHEET_FONTS) : null), [fontsReady]);
  const result = useMemo(() => {
    if (!measure) return null;
    try {
      return { doc: buildCardDocument(cardInputFromData(cardData, shown, assetUrl), measure), error: null as string | null };
    } catch (e) {
      return { doc: null as CardDocument | null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [cardData, shown, assetUrl, measure]);
  const doc = result?.doc ?? null;

  const choices = baseEdits.choices;
  const tones = letterToneOptions(cardData);
  const greetingKey = cardData.greeting;
  const greeting = greetingText(cardData.language, greetingKey);
  const needsRepick = editor.frontMissing && queue.edits.frontImage === editor.edits.frontImage && !locked;
  const savedFocal = baseEdits.focalPoints[imageId] ?? (imageId === defaultFrontId(cardData) ? (cardData.photo.focal ?? null) : null);

  const fields: Record<RegionTarget, FieldState> = {
    'front.greeting': { value: baseEdits.text['front.greeting'] ?? greeting, edited: baseEdits.text['front.greeting'] !== undefined },
    'front.subline': { value: baseEdits.text['front.subline'] ?? String(cardData.year), edited: baseEdits.text['front.subline'] !== undefined },
    'back.heading': { value: baseEdits.text['back.heading'] ?? greeting, edited: baseEdits.text['back.heading'] !== undefined },
    letter: { value: letterFor(cardData, choices.tone, baseEdits), edited: baseEdits.letters[choices.tone] !== undefined },
    'back.signature': {
      value: baseEdits.text['back.signature'] ?? cardData.signature,
      edited: baseEdits.text['back.signature'] !== undefined,
      placeholder: cardData.language === 'en' ? 'With love…' : 'Con cariño…',
    },
    'back.qrCaption': { value: baseEdits.text['back.qrCaption'] ?? cardData.qrCaption ?? '', edited: baseEdits.text['back.qrCaption'] !== undefined },
  };
  const { warning, blockSave } = draftWarning(doc, draft?.target ?? null);

  function saveText(target: RegionTarget, value: string) {
    if (target === 'letter') queue.update((e) => setLetter(e, e.choices.tone, value));
    else queue.update((e) => setText(e, target as TextTarget, value));
    setActive(null);
    setDraft(null);
  }
  function resetField(target: RegionTarget) {
    if (target === 'letter') queue.update((e) => resetLetter(e, e.choices.tone));
    else queue.update((e) => resetText(e, target as TextTarget));
    setActive(null);
    setDraft(null);
  }
  function openText(target: RegionTarget) {
    if (readOnly) return;
    setActive(target);
    setDraft(null);
  }
  function closeText() {
    setActive(null);
    setDraft(null);
  }
  function pick(item: PickerItem) {
    if (!serverOptions.some((o) => o.id === item.id)) setLocals((prev) => [...removeLocalFront(prev, item.id), localFrontFromPick(item)]);
    // Re-picking after the saved front vanished must be explicit: never fall back to "the default" (null), even for the default photo.
    const frontId = frontIdForPick(item.id, defaultFrontId(cardData), needsRepick);
    queue.update((e) => setFrontImage(e, frontId), { tag: 'front' });
    setNotice(null);
    setPickerOpen(false);
  }

  // Geometry: two sheets side by side when they fit, else one with a Front/Back toggle.
  const pageW = doc?.geometry.pageW ?? 185.8;
  const pageH = doc?.geometry.pageH ?? 135;
  const gap = 32;
  const pad = isPhone ? 12 : 24;
  const avail = Math.max(240, stageWidth - pad * 2);
  const heightCap = Math.max(1.5, (viewportH - 230) / pageH);
  const sideBySide = !isPhone && (avail - gap) / (2 * pageW) >= 2.5;
  const fitZoom = avail / pageW;
  const zoom = isPhone ? fitZoom : Math.min(sideBySide ? (avail - gap) / (2 * pageW) : fitZoom, 4.6, Math.max(heightCap, sideBySide ? 2.5 : 1.5));
  const showFront = sideBySide || side === 'front';
  const showBack = sideBySide || side === 'back';

  const common = {
    zoom,
    editable: !readOnly,
    fields,
    // The phone/touch sheet renders its own editor; the desktop popover is the sheet's own.
    activeTarget: textSheet ? null : active,
    warning,
    blockSave,
    onOpenText: openText,
    onDraft: (value: string) => active && setDraft({ target: active, value }),
    onCloseText: closeText,
    onSaveText: saveText,
    onResetText: resetField,
    onReplace: () => setPickerOpen(true),
    onReposition: () => setFocalOpen(true),
    fonts: SHEET_FONTS,
    onPhotoClick: isPhone ? () => setZoomOpen(true) : undefined,
  };

  const gate = orderGate({ screen, queueIdle: queue.idle, queueHasError: queue.error !== null, qrState });
  async function handleOrder() {
    await queue.flush();
    if (!queue.isIdle()) return;
    props.onOrder();
  }

  const activeRegion = active && doc ? doc.regions.find((r) => r.target === active) : null;
  const forcedPicker = needsRepick;
  const openCheckout = screen.kind === 'checkoutOpen' ? { mine: screen.mine, orderId: screen.orderId } : screen.kind === 'locked' ? screen.checkout : null;
  const reorder = reorderGate(screen);
  async function cancelCheckout(orderId: string) {
    if (!props.onCancelCheckout) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await props.onCancelCheckout(orderId);
    } catch {
      setCancelError("We couldn't cancel the checkout just now. Try again in a moment.");
    } finally {
      setCancelling(false);
    }
  }
  const photoLabel = isIllustration ? 'Change picture' : 'Change photo';

  return (
    <div className={`ce${isPhone ? ' ce--phone' : ''}`}>
      <ConnectedShopHeader onHome={props.onHome} onOpenOrders={props.onOpenOrders} showBack />
      <h1 className="sr-only">Holiday card {cardData.year}</h1>
      <div className="ce-body">
        {openCheckout && (
          <div className="ce-banner" role="status">
            <span>{CHECKOUT_OPEN_NOTE}</span>
            {openCheckout.mine && openCheckout.orderId && (
              <span className="ce-actions">
                {props.onResumeCheckout && (
                  <button type="button" className="ce-btn ce-btn--small" onClick={() => props.onResumeCheckout?.(openCheckout.orderId!)}>
                    Continue checkout
                  </button>
                )}
                {props.onCancelCheckout && (
                  <button type="button" className="ce-btn ce-btn--ghost ce-btn--small" disabled={cancelling} onClick={() => void cancelCheckout(openCheckout.orderId!)}>
                    {cancelling ? 'Cancelling…' : 'Cancel checkout'}
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {cancelError && (
          <div className="ce-banner ce-banner--warn" role="alert">
            {cancelError}
          </div>
        )}
        {locked && (
          <div className="ce-banner" role="status">
            This card has been ordered, so it can't be changed any more. You can order more copies of exactly this card.
          </div>
        )}
        {queue.reloaded && (
          <div className="ce-banner ce-banner--warn" role="alert">
            <span>This card was edited somewhere else, so we reloaded it. Your last change wasn't saved.</span>
            <button type="button" className="ce-btn ce-btn--ghost ce-btn--small" onClick={queue.dismissReloaded}>
              OK
            </button>
          </div>
        )}
        {notice && (
          <div className="ce-banner ce-banner--warn" role="alert">
            <span>{notice}</span>
            <button type="button" className="ce-btn ce-btn--ghost ce-btn--small" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        )}
        {needsRepick && (
          <div className="ce-banner ce-banner--warn" role="alert">
            The photo chosen for the front is no longer available. Choose another one to continue.
          </div>
        )}

        {!readOnly && (
          <header className="ce-strip" role="toolbar" aria-label="Card options">
            {!isIllustration && (
              <div className="ce-field" role="group" aria-label="Layout">
                <span className="ce-field__label">Layout</span>
                <div className="ce-chips">
                  {([['bordered', 'Bordered'], ['full-bleed', 'Full-bleed']] as const).map(([k, label]) => (
                    <button key={k} type="button" className={`ce-chip${choices.layout === k ? ' on' : ''}`} onClick={() => queue.update((e) => setChoices(e, { layout: k }))}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {tones.length > 1 && (
              <div className="ce-field" role="group" aria-label="Letter version">
                <span className="ce-field__label">Letter</span>
                <div className="ce-chips">
                  {tones.map((t) => (
                    <button key={t.tone} type="button" className={`ce-chip${choices.tone === t.tone ? ' on' : ''}`} onClick={() => queue.update((e) => setChoices(e, { tone: t.tone }))}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="ce-field" aria-label="Greeting">
              <span className="ce-field__label">Greeting</span>
              <span className="ce-fixed" title="The greeting was chosen when the card was created">
                {greeting}
              </span>
            </div>
            {qr.visible && (
              <label className={`ce-field ce-field--check${qr.disabled ? ' is-disabled' : ''}`}>
                <input type="checkbox" checked={qr.checked} disabled={qr.disabled} onChange={(e) => queue.update((x) => setChoices(x, { qr: e.target.checked }))} />
                <span>Film QR code</span>
              </label>
            )}
            <div className="ce-actions">
              <button type="button" className="ce-btn" onClick={() => setPickerOpen(true)}>
                {photoLabel}
              </button>
              {doc?.front.image.canReposition && (
                <button type="button" className="ce-btn ce-btn--ghost" onClick={() => setFocalOpen(true)}>
                  Reposition
                </button>
              )}
            </div>
            {qr.note && <p className="ce-qrnote">{qr.note}</p>}
          </header>
        )}
        {readOnly && qr.note && <p className="ce-qrnote ce-qrnote--standalone">{qr.note}</p>}

        <main className="ce-stage" ref={stageRef}>
          {!sideBySide && (
            <div className="ce-flip" role="tablist" aria-label="Card side">
              {(['front', 'back'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={side === s}
                  className={`ce-chip${side === s ? ' on' : ''}`}
                  onClick={() => {
                    setSide(s);
                    closeText();
                  }}
                >
                  {s === 'front' ? 'Front' : 'Back'}
                </button>
              ))}
            </div>
          )}
          {!fontsReady && !result?.error && <div className="ce-loading">Loading fonts…</div>}
          {result?.error && <div className="ce-loading">{result.error}</div>}
          {doc && (
            <div className="ce-sheets">
              {showFront && <EditableSheet doc={doc} side="front" {...common} />}
              {showBack && <EditableSheet doc={doc} side="back" {...common} />}
            </div>
          )}
          {doc && !readOnly && (
            <p className="ce-hint">
              {isPhone ? (side === 'front' ? 'Tap the photo to look closer. Tap any text to edit it.' : 'Tap the letter to read it full size and edit it.') : 'Click any text to edit it. Hover the photo to replace or reposition it.'}
            </p>
          )}
        </main>

        <FilmPanel film={view.film} loadFilmUrls={props.loadFilmUrls} />

        {locked && view.myOrders.length > 0 && (
          <section className="ce-orders" aria-label="Your orders for this card">
            <h2 className="ce-orders__title">Your orders</h2>
            <ul className="ce-orders__list">
              {view.myOrders.map((o) => (
                <li key={o.id} className="ce-orders__row">
                  <span>
                    {o.cards} cards{o.priceCents !== null ? ` · ${formatPrice(o.priceCents)}` : ''}
                    {o.createdAt ? ` · ${new Date(o.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                  </span>
                  <span className="ce-orders__status">{cardOrderStatusCopy(orderStatusName(o.status)).label}</span>
                  {props.onOpenOrder && (
                    <button type="button" className="ce-btn ce-btn--ghost ce-btn--small" onClick={() => props.onOpenOrder?.(o.id)}>
                      View
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="ce-orderbar">
        <div className="ce-orderbar__status" role="status" aria-live="polite">
          {readOnly ? null : queue.error ? (
            <>
              <span className="ce-warn">{queue.error.message}</span>{' '}
              <button type="button" className="ce-link" onClick={() => void queue.retry()}>
                Try again
              </button>{' '}
              <button type="button" className="ce-link" onClick={queue.discard}>
                Undo unsaved changes
              </button>
            </>
          ) : queue.saving || !queue.idle ? (
            'Saving…'
          ) : (
            'All changes saved'
          )}
          {!readOnly && !queue.error && gate.blocked && gate.blocked !== 'saving' && ORDER_BLOCK_COPY[gate.blocked] && <div className="ce-orderbar__why">{ORDER_BLOCK_COPY[gate.blocked]}</div>}
        </div>
        {locked ? (
          <button type="button" className="ce-btn ce-btn--cta" disabled={!reorder.enabled} onClick={props.onOrder}>
            Order more cards
          </button>
        ) : screen.kind === 'checkoutOpen' ? (
          screen.mine && screen.orderId && props.onResumeCheckout ? (
            <button type="button" className="ce-btn ce-btn--cta" onClick={() => props.onResumeCheckout?.(screen.orderId!)}>
              Continue checkout
            </button>
          ) : null
        ) : (
          <button type="button" className="ce-btn ce-btn--cta" disabled={!gate.enabled} onClick={() => void handleOrder()}>
            Order cards
          </button>
        )}
      </div>

      {/* Desktop popover lives inside EditableSheet; the touch sheet is here, above everything. */}
      {textSheet && active && activeRegion && !readOnly && (
        <PhoneTextSheet
          label={activeRegion.label}
          value={fields[active].value}
          resetKey={active}
          placeholder={fields[active].placeholder}
          multiline={activeRegion.multiline}
          required={activeRegion.required}
          canReset={fields[active].edited}
          warning={warning}
          blockSave={blockSave}
          fontFamily={active === 'letter' || active === 'back.heading' || active === 'front.greeting' ? stacks.serif : stacks.sans}
          reading={active === 'letter'}
          onDraft={(value) => setDraft({ target: active, value })}
          onSave={(v) => saveText(active, v)}
          onReset={() => resetField(active)}
          onClose={closeText}
        />
      )}

      {(pickerOpen || forcedPicker) && !readOnly && (
        <CardPhotoPicker
          provider={props.photoProvider}
          currentId={imageId}
          canReset={baseEdits.frontImage !== null && !needsRepick}
          currentOrientation={doc?.geometry.orientation ?? 'landscape'}
          title={forcedPicker ? 'Choose a new front photo' : 'Choose the front'}
          dismissible={!forcedPicker}
          onPick={pick}
          onReset={() => {
            queue.update((e) => setFrontImage(e, null), { tag: 'front' });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {focalOpen && doc && !readOnly && (
        <FocalPointModalView
          url={assetUrl(frontOptionsOf(cardData).find((o) => o.id === imageId)?.file ?? cardData.photo.file)}
          targetAspect={doc.front.image.boxAspect}
          initial={savedFocal}
          saving={false}
          resetting={false}
          error={null}
          onSave={(p) => {
            queue.update((e) => setFocal(e, imageId, p));
            setFocalOpen(false);
          }}
          onReset={() => {
            queue.update((e) => resetFocal(e, imageId));
            setFocalOpen(false);
          }}
          onClose={() => setFocalOpen(false)}
        />
      )}

      {zoomOpen && doc && (
        <div className="ce-zoom" role="dialog" aria-modal="true" aria-label="The front of your card, larger">
          <button type="button" className="ce-zoom__close" onClick={() => setZoomOpen(false)} aria-label="Close">
            ×
          </button>
          <div className="ce-zoom__scroll">
            <EditableSheet
              doc={doc}
              side="front"
              zoom={fitZoom * 2.2}
              editable={false}
              fields={fields}
              activeTarget={null}
              warning={null}
              blockSave={false}
              onOpenText={() => {}}
              onDraft={() => {}}
              onCloseText={() => {}}
              onSaveText={() => {}}
              onResetText={() => {}}
              onReplace={() => {}}
              onReposition={() => {}}
              fonts={SHEET_FONTS}
            />
          </div>
          <p className="ce-zoom__hint">Drag to look around.</p>
        </div>
      )}
    </div>
  );
}
