import type { CardDocument, RegionTarget } from '../../card/document';
import type { CardEdits } from '../../card/edits';
import type { CardData } from '../../card/types';
import type { HolidayCardView, QrState } from './cardTypes';
import type { ServerRead } from './editQueue';

/**
 * Pure state + selectors for the card editor screen (docs/plans/holiday-cards-
 * p2.md Step 4), kept out of the component so every branch unit-tests in plain
 * node: which screen shows, what the QR control does per `qrState`, when
 * "Order cards" is enabled, polling cadence, and the "does this still fit"
 * warning while typing.
 */

// ── Polling / refetch cadence ────────────────────────────────────────────

export const POLL_GENERATING_MS = 5_000;
export const POLL_FILM_RENDERING_MS = 30_000;
/** The QR film takes about 20 minutes: "taking longer than usual" after this. */
export const FILM_SLOW_AFTER_MS = 45 * 60_000;
/** An image failing to load (an expired signed URL) refetches at most this often. */
export const IMAGE_ERROR_REFETCH_MIN_MS = 15_000;
/** Returning to the tab refetches when the data is at least this old. */
export const VISIBLE_REFETCH_MIN_AGE_MS = 10_000;

/** Next poll delay for the loaded card, or null when nothing is in motion. */
export function pollIntervalMs(view: HolidayCardView | null): number | null {
  if (!view) return null;
  if (view.readiness === 'film') return POLL_FILM_RENDERING_MS;
  if (view.card.status === 'generating' || view.readiness === 'generating') return POLL_GENERATING_MS;
  if (view.film.state === 'rendering') return POLL_FILM_RENDERING_MS;
  return null;
}

export function shouldRefetchOnImageError(lastFetchAtMs: number, nowMs: number): boolean {
  return nowMs - lastFetchAtMs >= IMAGE_ERROR_REFETCH_MIN_MS;
}

export function shouldRefetchOnVisible(lastFetchAtMs: number, nowMs: number): boolean {
  return nowMs - lastFetchAtMs >= VISIBLE_REFETCH_MIN_AGE_MS;
}

/** A confirmed save that changed these needs a fresh `get` (new `qrState`, or the picked photo's real size and sharp original). */
export function needsRefetchAfterSave(previous: CardEdits, saved: CardEdits): boolean {
  return previous.choices.qr !== saved.choices.qr || previous.frontImage !== saved.frontImage;
}


/** The queue's view of a server read: the editor view's edits (the frozen ones for an ordered card) at the card's edits version. */
export function serverReadFrom(view: HolidayCardView | null): ServerRead | null {
  if (!view?.editorView) return null;
  return {
    edits: view.editorView.edits,
    version: view.card.editsVersion,
    checkoutOpen: view.hasOpenCheckout || view.openCheckout !== null,
    locked: view.editorView.locked || view.isOrdered,
  };
}

// ── Which screen ─────────────────────────────────────────────────────────

/** Generation failures the server retries by itself. */
export const RETRYABLE_FAILURE_CODES: readonly string[] = [
  'CONTEXT_LOAD_FAILED',
  'FRONT_PICK_FAILED',
  'FILM_SETUP_FAILED',
  'LETTERS_FAILED',
  'UNKNOWN_ERROR',
];

export const SUPPORT_EMAIL = 'hello@usemomora.com';
export const PREPARING_SLOW_AFTER_MS = 5 * 60_000;

export function isRetryableFailure(code: string | null): boolean {
  return code !== null && RETRYABLE_FAILURE_CODES.includes(code);
}

export type ScreenState =
  | { kind: 'loading' }
  /** Signed in as someone who cannot see this card (403 / 404). */
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  /**
   * `phase` 'film': the artwork is done and the QR film renders (~20 min); the
   * editor opens by itself when the server says `ready`. 'generating' (also
   * the fallback when the server sends no `readiness`): the artwork.
   */
  | { kind: 'preparing'; slow: boolean; phase: 'generating' | 'film' }
  | { kind: 'failed'; code: string | null; retrying: boolean }
  /**
   * Ordered: read-only frozen snapshot, order list, "Order more cards".
   * `checkout` is a reorder checkout that is open right now (null = none).
   */
  | { kind: 'locked'; checkout: OpenCheckout | null }
  | { kind: 'checkoutOpen'; mine: boolean; orderId: string | null }
  | { kind: 'editing'; needsRepick: boolean };

export interface OpenCheckout {
  mine: boolean;
  orderId: string | null;
}

export interface ScreenInput {
  load: 'loading' | 'ready' | 'error';
  error: { status: number; code: string; message?: string } | null;
  view: HolidayCardView | null;
  /** From the save queue (a 409 `card_ordered` / 423 seen while saving). */
  queueLocked: boolean;
  queueCheckoutOpen: boolean;
  nowMs: number;
  /** When this screen first saw the card (fallback clock for "taking longer than usual"). */
  firstSeenMs: number;
}

export function isForbiddenError(error: { status: number; code: string } | null): boolean {
  if (!error) return false;
  return error.status === 404 || (error.status === 403 && error.code !== 'SUBSCRIPTION_REQUIRED');
}

export function isPreparingSlow(createdAtIso: string | null, firstSeenMs: number, nowMs: number, afterMs: number = PREPARING_SLOW_AFTER_MS): boolean {
  const created = createdAtIso ? Date.parse(createdAtIso) : NaN;
  const since = Number.isFinite(created) ? Math.max(created, 0) : firstSeenMs;
  return nowMs - since > afterMs;
}

function preparing(view: HolidayCardView, input: ScreenInput, phase: 'generating' | 'film'): ScreenState {
  const slow = phase === 'film' ? isPreparingSlow(view.card.createdAt, input.firstSeenMs, input.nowMs, FILM_SLOW_AFTER_MS) : isPreparingSlow(view.card.createdAt, input.firstSeenMs, input.nowMs);
  return { kind: 'preparing', slow, phase };
}

export function deriveScreenState(input: ScreenInput): ScreenState {
  const { view } = input;
  if (!view) {
    if (input.load === 'error' && input.error) {
      if (isForbiddenError(input.error)) return { kind: 'forbidden' };
      return { kind: 'error', message: input.error.message ?? 'We could not load your card.' };
    }
    return { kind: 'loading' };
  }

  if (view.card.status === 'failed') {
    return { kind: 'failed', code: view.generation.failureCode ?? view.card.lastFailureCode, retrying: isRetryableFailure(view.generation.failureCode ?? view.card.lastFailureCode) };
  }
  if (view.card.status === 'generating') return preparing(view, input, 'generating');
  // The card's artwork is done but its QR film is not: not editable yet (the
  // server withholds `editorView`; never show an editor that cannot order).
  if (view.readiness === 'film') return preparing(view, input, 'film');
  if (view.readiness === 'generating') return preparing(view, input, 'generating');
  // Ready.
  if (view.editorViewInvalid) return { kind: 'error', message: 'We could not open the editor for this card. Please try again in a moment.' };
  const editor = view.editorView;
  if (!editor) return preparing(view, input, 'generating');

  const checkoutIsOpen = view.hasOpenCheckout || view.openCheckout !== null || input.queueCheckoutOpen;
  const checkout: OpenCheckout | null = checkoutIsOpen ? { mine: view.openCheckout?.mine === true, orderId: view.openCheckout?.orderId ?? null } : null;
  // An ordered card can still have its own reorder checkout open: the locked screen must show it.
  if (editor.locked || view.isOrdered || input.queueLocked) return { kind: 'locked', checkout };
  if (checkout) return { kind: 'checkoutOpen', ...checkout };
  return { kind: 'editing', needsRepick: editor.frontMissing };
}

// ── The QR control ───────────────────────────────────────────────────────

/**
 * `waiting_film` + the QR toggled off locally is `off` already (that is what
 * the next `get` will say); the rest is the server's word. Used for the
 * Order gate so a just-turned-off QR does not wait for the refetch.
 */
export function effectiveQrState(qrState: QrState, localQr: boolean | undefined, serverQr: boolean | undefined): QrState {
  if (qrState === 'waiting_film' && localQr === false) return 'off';
  // Turned back on locally while the server still says "chosen off": the real state (on / waiting) is unknown until the refetch.
  if (qrState === 'off' && localQr === true && serverQr === false) return 'waiting_film';
  return qrState;
}

export interface QrControl {
  /** Whether the toggle is shown at all. */
  visible: boolean;
  checked: boolean;
  disabled: boolean;
  note: string | null;
}

export const QR_NOTES = {
  waiting: 'Your film is still being made. Order when it is ready, or turn the QR off.',
  unavailable: 'This card prints without a QR code: there is no film to link to.',
  revoked: 'The film link was turned off, so this card prints without a QR code.',
} as const;

export function qrControl(args: {
  qrState: QrState;
  linkDisabled: boolean;
  /** The edits' own QR choice (undefined = follow the card). */
  choice: boolean | undefined;
  /** The card's own default (`cardData.qr.enabled`). */
  cardDefault: boolean;
}): QrControl {
  const { qrState, linkDisabled, choice, cardDefault } = args;
  switch (qrState) {
    case 'on':
      return { visible: true, checked: choice ?? cardDefault, disabled: false, note: null };
    case 'waiting_film':
      return { visible: true, checked: choice ?? true, disabled: false, note: QR_NOTES.waiting };
    case 'off':
      if (linkDisabled) return { visible: true, checked: false, disabled: true, note: QR_NOTES.revoked };
      return { visible: true, checked: choice ?? false, disabled: false, note: null };
    case 'unavailable':
      return { visible: true, checked: false, disabled: true, note: QR_NOTES.unavailable };
  }
}

/** Whether the card preview draws a QR (the control's checked state, never for a state that cannot print one). */
export function previewQrOn(qrState: QrState, linkDisabled: boolean, choice: boolean | undefined, cardDefault: boolean): boolean {
  return qrControl({ qrState, linkDisabled, choice, cardDefault }).checked;
}

// ── "Order cards" ────────────────────────────────────────────────────────

export type OrderBlock =
  | 'saving'
  | 'save_error'
  | 'not_ready'
  | 'locked'
  | 'checkout_open'
  | 'qr_waiting'
  | 'front_missing'
  | 'no_view';

export const ORDER_BLOCK_COPY: Record<OrderBlock, string> = {
  saving: 'Saving your changes…',
  save_error: 'Your last change has not been saved yet.',
  not_ready: 'Your card is still being prepared.',
  locked: '',
  checkout_open: 'A checkout is already open for this card.',
  qr_waiting: QR_NOTES.waiting,
  front_missing: 'Choose a new front photo first.',
  no_view: '',
};

export interface OrderGateInput {
  screen: ScreenState;
  queueIdle: boolean;
  queueHasError: boolean;
  qrState: QrState | null;
}

/** `blocked: null` = the button is enabled. The screen must also have flushed the queue before navigating. */
export function orderGate(input: OrderGateInput): { enabled: boolean; blocked: OrderBlock | null } {
  const { screen } = input;
  const block = (b: OrderBlock) => ({ enabled: false, blocked: b });
  if (screen.kind === 'locked') return block('locked');
  if (screen.kind === 'checkoutOpen') return block('checkout_open');
  if (screen.kind !== 'editing') return block(screen.kind === 'preparing' || screen.kind === 'failed' ? 'not_ready' : 'no_view');
  if (screen.needsRepick) return block('front_missing');
  if (input.queueHasError) return block('save_error');
  if (!input.queueIdle) return block('saving');
  if (input.qrState === null) return block('no_view');
  if (input.qrState === 'waiting_film') return block('qr_waiting');
  return { enabled: true, blocked: null };
}

/**
 * "Order more cards" on a locked card: while any checkout is open (yours: continue or cancel it; someone
 * else's: wait for it to expire) a second one would only fail with CHECKOUT_OPEN_ELSEWHERE.
 */
export function reorderGate(screen: ScreenState): { enabled: boolean; note: string | null } {
  if (screen.kind !== 'locked') return { enabled: false, note: null };
  if (!screen.checkout) return { enabled: true, note: null };
  return { enabled: false, note: screen.checkout.mine ? null : CHECKOUT_OPEN_NOTE };
}

export const CHECKOUT_OPEN_NOTE = 'A checkout is open for this card. It expires within 35 minutes, and editing is paused until then.';

/** `cancel_checkout` answers that mean the checkout is already gone (paid, expired or cancelled): treat as done. */
export function isCancelDoneCode(code: string): boolean {
  return code === 'ORDER_NOT_CANCELLABLE' || code === 'CHECKOUT_NOT_OPEN';
}

// ── Labels ───────────────────────────────────────────────────────────────

export const TONE_LABELS: Record<string, string> = { classic: 'Classic', reflective: 'Warm', playful: 'Playful', short: 'Short' };
const TONE_ORDER = ['classic', 'reflective', 'playful', 'short'];

/** The letter versions this card actually has, in a stable order, with their labels. */
export function letterToneOptions(data: Pick<CardData, 'letters'>): { tone: string; label: string }[] {
  const present = new Set(data.letters.map((l) => l.tone));
  const known = TONE_ORDER.filter((t) => present.has(t));
  const other = [...present].filter((t) => !TONE_ORDER.includes(t));
  return [...known, ...other].map((tone) => ({ tone, label: TONE_LABELS[tone] ?? tone }));
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  checkout: 'Checkout open',
  paid: 'Paid, getting ready',
  submitted: 'Sent to the printer',
  in_production: 'Being printed',
  shipped: 'Shipped',
  failed: 'Needs attention',
  cancelled: 'Cancelled',
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? 'In progress';
}

export function formatPrice(cents: number | null): string {
  if (cents === null) return '';
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Typing guard ─────────────────────────────────────────────────────────

/** While typing: block Save (never shrink text below the readable minimum) when the draft would not fit. */
export function draftWarning(doc: CardDocument | null, draftTarget: RegionTarget | null): { warning: string | null; blockSave: boolean } {
  if (!doc || !draftTarget) return { warning: null, blockSave: false };
  if (!doc.back.letter.fit.fits) {
    return {
      warning: draftTarget === 'letter' ? 'This is too long: it would drop below 9 pt. Shorten it a little to keep it readable.' : 'There isn’t room for that: it would push the letter below 9 pt.',
      blockSave: true,
    };
  }
  if (doc.safeViolations.length > 0) return { warning: 'That is too wide for the card: it would run too close to the edge.', blockSave: true };
  return { warning: null, blockSave: false };
}

// ── Front messages ───────────────────────────────────────────────────────

export function frontRejectionMessage(code: string): string {
  switch (code) {
    case 'front_low_resolution':
      return 'That photo is too small to print well on a card. Pick another one.';
    case 'front_unreadable':
      return 'We could not read that photo. Pick another one.';
    case 'MEDIA_NOT_PRINTABLE':
    case 'MEDIA_NOT_PHOTO':
      return 'That photo cannot be printed on a card. Pick another one.';
    case 'MEDIA_NOT_FOUND':
      return 'That photo is no longer available. Pick another one.';
    default:
      return 'That photo could not be used. Pick another one.';
  }
}
