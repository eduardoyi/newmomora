/**
 * ONE table mapping every error the card checkout can meet to buyer-facing
 * copy and the single recovery action the screen offers (docs/plans/
 * holiday-cards-p2.md Step 5). Pure and framework-free so every code is
 * unit-tested to have copy; the screen only decides how to render an action.
 *
 *   retry           try the same step again (transient or one-off)
 *   requote         the address / quote has to be checked again (back to the address step)
 *   back_to_editor  something in the card has to change first
 *   turn_qr_off     the film QR code cannot print: offer to turn it off and carry on
 *   reload          reload the page (the card changed elsewhere, or the sign-in ended)
 *   status          the order is further along than this screen: show its status
 *   none            nothing the buyer can do here (the message says who to write to)
 */

export type ErrorAction = 'retry' | 'requote' | 'back_to_editor' | 'turn_qr_off' | 'reload' | 'status' | 'none';

export interface ErrorCopy {
  message: string;
  action: ErrorAction;
}

export interface ErrorView extends ErrorCopy {
  /** The error code it came from (for support: "mention ..."). */
  code: string;
}

export const SUPPORT_EMAIL = 'hello@usemomora.com';

/** What an error must expose to be described (a `CardApiError` does). */
export interface DescribableError {
  status: number;
  code: string;
}

const WRITE_TO_US = `please write to ${SUPPORT_EMAIL}`;

/** Every backend code this checkout can meet, keyed by the `code` the server sends. */
export const ERROR_TABLE: Readonly<Record<string, ErrorCopy>> = {
  // ── quote
  COUNTRY_NOT_SUPPORTED: { message: 'We can only ship holiday cards to the United States and Canada for now.', action: 'requote' },
  NOT_DELIVERABLE: { message: 'Our printer could not deliver to that address. Check it, or use a different one.', action: 'requote' },
  OVER_COST_GUARD: { message: 'We could not price delivery to that address. Try a different one, or write to us and we will help.', action: 'requote' },
  validation_error: { message: 'Something in the address does not look right. Please check it and try again.', action: 'requote' },
  PACKS_INVALID: { message: 'Please choose how many cards you would like.', action: 'retry' },
  EMAIL_REQUIRED: { message: `Your Momora account needs an email address to place an order, ${WRITE_TO_US}.`, action: 'none' },
  ORDER_NOT_QUOTABLE: { message: 'This order has moved on and can no longer be changed. Here is where it stands.', action: 'status' },

  // ── the card itself
  CARD_NOT_READY: { message: 'Your card is still being prepared. Go back to your card and order again when it is ready.', action: 'back_to_editor' },
  CARD_CHANGED: { message: 'This card was changed on another screen, so what you reviewed is out of date. Reload to see the latest version.', action: 'reload' },
  INVALID_CARD: { message: `Something is wrong with this card and it cannot be printed, ${WRITE_TO_US}.`, action: 'none' },
  BAD_INPUT: { message: 'Something in your card could not be read for printing. Go back to your card, check the text and photo, and try again.', action: 'back_to_editor' },

  // ── checkout claim and session
  CHECKOUT_IN_PROGRESS: { message: 'We are still setting up your checkout. This can take a moment.', action: 'retry' },
  CHECKOUT_OPEN_ELSEWHERE: {
    message: 'A checkout is already open for this card, maybe on another device or by someone else in your family. It expires within 35 minutes. Come back after it finishes or expires.',
    action: 'back_to_editor',
  },
  QUOTE_STALE: { message: 'The price was refreshed while you were reviewing. Please check the quote again.', action: 'requote' },
  ORDER_NOT_QUOTED: { message: 'This order needs a fresh quote first. Please check your address and quantity again.', action: 'requote' },
  ORDER_ALREADY_PAID: { message: 'This order has already been paid. Here is where it stands.', action: 'status' },
  CHECKOUT_NOT_OPEN: { message: 'This checkout is no longer open. Here is where the order stands.', action: 'status' },
  ORDER_NOT_CANCELLABLE: { message: 'This order can no longer be cancelled. Here is where it stands.', action: 'status' },
  ORDER_NOT_FOUND: { message: 'We could not find that order. Go back to your card to start a new one.', action: 'back_to_editor' },
  REORDER_UNAVAILABLE: { message: `This card cannot be reordered right now, ${WRITE_TO_US} and we will sort it out.`, action: 'none' },

  // ── film / QR
  FILM_NOT_READY: { message: 'Your film is still being made, and the QR code on the card points to it. Turn the QR code off to order now, or come back when the film is ready.', action: 'turn_qr_off' },
  FILM_BLOCKED: { message: 'Your film could not be shared, so the card cannot print a QR code for it. Turn the QR code off to order.', action: 'turn_qr_off' },
  QR_LINK_DISABLED: { message: 'The film link for this card was turned off, so it cannot print a QR code. Turn the QR code off to order.', action: 'turn_qr_off' },

  // ── print checks
  LETTER_OVERFLOW: { message: 'Your letter is too long to fit on the card. Shorten it, or switch to a shorter letter version, then order again.', action: 'back_to_editor' },
  SAFE_MARGIN: { message: 'Some text runs too close to the edge of the card to print safely. Shorten it in the card editor, then order again.', action: 'back_to_editor' },
  IMAGE_MISSING: { message: 'A picture on your card could not be found. Choose another front photo, then order again.', action: 'back_to_editor' },
  IMAGE_LOW_RES: { message: 'The front photo is too small to print sharply. Choose a larger one, then order again.', action: 'back_to_editor' },
  PAGE_SIZE: { message: 'We could not fit your card to the print size. Try another layout or less text, then order again.', action: 'back_to_editor' },
  FONTS: { message: 'The print fonts did not load. Please try again in a moment.', action: 'retry' },
  NO_FRONT_PHOTO: { message: 'Your card has no front photo yet. Choose one in the editor, then order again.', action: 'back_to_editor' },
  FRONT_PHOTO_UNREADABLE: { message: 'We could not read the front photo. Choose another one, then order again.', action: 'back_to_editor' },
  NO_LETTERS: { message: 'Your card has no letter yet. Add one in the editor, then order again.', action: 'back_to_editor' },
  DRAFT_REJECTED: { message: 'Our print partner could not accept the card files. Please try again, and if it keeps happening, write to us.', action: 'retry' },

  // ── services
  RENDER_UNAVAILABLE: { message: 'Our print-file service is busy right now. Please try again in a minute.', action: 'retry' },
  GELATO_UNAVAILABLE: { message: 'Our print partner is not responding right now. Please try again in a minute.', action: 'retry' },
  STRIPE_UNAVAILABLE: { message: 'Our payment provider is not responding right now. Please try again in a minute.', action: 'retry' },

  // ── account / switches
  HOLIDAY_CARD_ORDERS_PAUSED: { message: 'Card orders are paused for a short while. Please try again later.', action: 'none' },
  SUBSCRIPTION_REQUIRED: { message: 'Ordering cards needs an active Momora subscription. You can subscribe in the Momora app, then come back here.', action: 'none' },
  forbidden: { message: 'Only the owner or a manager of the family can order cards.', action: 'none' },

  // ── the server itself
  CARD_NOT_FOUND: { message: 'We could not find this card. Go back to your cards and open it again.', action: 'back_to_editor' },
  CARD_DELETED: { message: 'This card was deleted, so it cannot be ordered.', action: 'back_to_editor' },
  FAMILY_NOT_FOUND: { message: `We could not find the family for this card, ${WRITE_TO_US}.`, action: 'none' },
  LOAD_FAILED: { message: 'We could not load your card for printing. Please try again in a minute.', action: 'retry' },
  unauthorized: { message: 'Your sign-in has ended. Reload the page to sign in again.', action: 'reload' },
  invalid_json: { message: 'Something went wrong sending your request. Please try again.', action: 'retry' },
  method_not_allowed: { message: 'Something went wrong sending your request. Please try again.', action: 'retry' },
  internal_error: { message: 'Something went wrong on our side. Please try again in a minute.', action: 'retry' },

  // ── client-side
  SAVE_PENDING: { message: 'Your last change to the card has not been saved yet. Go back to your card and try again.', action: 'back_to_editor' },
  NO_CARD_VIEW: { message: 'We could not load your card for this order. Reload and try again.', action: 'reload' },
  timeout: { message: 'This is taking longer than expected. Please try again.', action: 'retry' },
  network_error: { message: 'We could not reach Momora. Check your connection and try again.', action: 'retry' },
  bad_response: { message: 'We got an unexpected answer. Please try again.', action: 'retry' },
};

/** The codes the server contract documents, plus the plan's list (the unit test asserts every one has copy). */
export const CONTRACT_ERROR_CODES: readonly string[] = [
  'COUNTRY_NOT_SUPPORTED',
  'NOT_DELIVERABLE',
  'OVER_COST_GUARD',
  'ORDER_NOT_QUOTABLE',
  'CARD_NOT_READY',
  'CHECKOUT_IN_PROGRESS',
  'CHECKOUT_OPEN_ELSEWHERE',
  'CARD_CHANGED',
  'QUOTE_STALE',
  'ORDER_NOT_QUOTED',
  'LETTER_OVERFLOW',
  'SAFE_MARGIN',
  'IMAGE_MISSING',
  'IMAGE_LOW_RES',
  'PAGE_SIZE',
  'FONTS',
  'BAD_INPUT',
  'FRONT_PHOTO_UNREADABLE',
  'NO_FRONT_PHOTO',
  'NO_LETTERS',
  'INVALID_CARD',
  'FILM_NOT_READY',
  'FILM_BLOCKED',
  'QR_LINK_DISABLED',
  'REORDER_UNAVAILABLE',
  'DRAFT_REJECTED',
  'RENDER_UNAVAILABLE',
  'GELATO_UNAVAILABLE',
  'STRIPE_UNAVAILABLE',
  'EMAIL_REQUIRED',
  'HOLIDAY_CARD_ORDERS_PAUSED',
  'ORDER_ALREADY_PAID',
  'CHECKOUT_NOT_OPEN',
  'ORDER_NOT_CANCELLABLE',
  'ORDER_NOT_FOUND',
  'PACKS_INVALID',
  'SUBSCRIPTION_REQUIRED',
  'validation_error',
  'forbidden',
  'internal_error',
  'CARD_NOT_FOUND',
  'CARD_DELETED',
  'FAMILY_NOT_FOUND',
  'LOAD_FAILED',
  'unauthorized',
];

const SIGNED_OUT: ErrorCopy = { message: 'Your sign-in has ended. Reload the page to sign in again.', action: 'reload' };
const GENERIC: ErrorCopy = { message: 'Something went wrong. Please try again.', action: 'retry' };
const GENERIC_SERVER: ErrorCopy = { message: 'Something went wrong on our side. Please try again in a minute.', action: 'retry' };

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Buyer-facing copy for an error. A 401 is always "sign in again" (whatever the
 * body said); a code the table does not know falls back by HTTP status.
 * `locked` = the card was already ordered (a reorder): its QR cannot be turned
 * off (the content is frozen), so a QR problem becomes "write to us".
 */
export function describeCheckoutError(error: DescribableError, options: { locked?: boolean } = {}): ErrorView {
  const code = error.code;
  let copy: ErrorCopy;
  if (error.status === 401) copy = SIGNED_OUT;
  else if (ERROR_TABLE[code]) copy = ERROR_TABLE[code];
  else if (error.status === 403) copy = ERROR_TABLE.forbidden;
  else if (error.status >= 500) copy = GENERIC_SERVER;
  else copy = GENERIC;

  if (options.locked && copy.action === 'turn_qr_off') {
    copy = {
      message: `This card was printed before, with a QR code, and its film link is no longer available, so it cannot be reordered as it was. ${capitalize(WRITE_TO_US)} and we will help.`,
      action: 'none',
    };
  }
  return { code, message: copy.message, action: copy.action };
}

/**
 * The preparation is simply not finished yet (or never answered): the screen
 * re-calls `create_checkout`, which resumes an order already in `checkout`.
 * A client timeout (status 0 / `timeout`), a dropped connection and the
 * server's own "still running" are the same situation.
 */
export function isStillPreparing(error: DescribableError): boolean {
  return error.code === 'CHECKOUT_IN_PROGRESS' || (error.status === 0 && (error.code === 'timeout' || error.code === 'network_error'));
}

/** What a `cancel_checkout` result means on the cancelled-return page. */
export type CancelOutcome = 'cancelled' | 'status' | 'error';

/**
 * `ORDER_NOT_CANCELLABLE` / `CHECKOUT_NOT_OPEN` on the buyer's own order mean it
 * is already not an open checkout (expired or cancelled), which is the outcome
 * wanted; `ORDER_ALREADY_PAID` means money moved after all: show the status.
 */
export function interpretCancelOutcome(error: DescribableError | null): CancelOutcome {
  if (!error) return 'cancelled';
  if (error.code === 'ORDER_NOT_CANCELLABLE' || error.code === 'CHECKOUT_NOT_OPEN') return 'cancelled';
  if (error.code === 'ORDER_ALREADY_PAID') return 'status';
  return 'error';
}
