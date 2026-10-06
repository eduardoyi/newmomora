import { describe, expect, it } from 'vitest';
import { CONTRACT_ERROR_CODES, ERROR_TABLE, SUPPORT_EMAIL, describeCheckoutError, interpretCancelOutcome, isStillPreparing, type ErrorAction } from '../errorCopy';

const ACTIONS: ErrorAction[] = ['retry', 'requote', 'back_to_editor', 'turn_qr_off', 'reload', 'status', 'none'];

describe('error table', () => {
  it('has copy and a valid action for every code in the contract', () => {
    for (const code of CONTRACT_ERROR_CODES) {
      const copy = ERROR_TABLE[code];
      expect(copy, code).toBeDefined();
      expect(copy.message.length, code).toBeGreaterThan(20);
      expect(ACTIONS, code).toContain(copy.action);
    }
  });

  it('covers every backend code the order function documents', () => {
    const documented = [
      'CARD_NOT_READY', 'HOLIDAY_CARD_ORDERS_PAUSED', 'SUBSCRIPTION_REQUIRED', 'forbidden',
      'COUNTRY_NOT_SUPPORTED', 'NOT_DELIVERABLE', 'OVER_COST_GUARD', 'ORDER_NOT_QUOTABLE', 'CHECKOUT_IN_PROGRESS', 'CHECKOUT_OPEN_ELSEWHERE',
      'PACKS_INVALID', 'validation_error', 'EMAIL_REQUIRED', 'GELATO_UNAVAILABLE',
      'CARD_CHANGED', 'ORDER_NOT_QUOTED', 'QUOTE_STALE', 'FILM_NOT_READY', 'FILM_BLOCKED', 'QR_LINK_DISABLED', 'REORDER_UNAVAILABLE', 'ORDER_ALREADY_PAID',
      'LETTER_OVERFLOW', 'SAFE_MARGIN', 'IMAGE_MISSING', 'IMAGE_LOW_RES', 'PAGE_SIZE', 'FONTS', 'BAD_INPUT', 'NO_FRONT_PHOTO', 'FRONT_PHOTO_UNREADABLE', 'NO_LETTERS', 'INVALID_CARD', 'DRAFT_REJECTED',
      'RENDER_UNAVAILABLE', 'STRIPE_UNAVAILABLE', 'ORDER_NOT_CANCELLABLE', 'ORDER_NOT_FOUND', 'CHECKOUT_NOT_OPEN',
    ];
    for (const code of documented) expect(ERROR_TABLE[code], code).toBeDefined();
  });

  it('maps the plan-specified recoveries', () => {
    const action = (code: string) => describeCheckoutError({ status: 409, code }).action;
    expect(action('LETTER_OVERFLOW')).toBe('back_to_editor');
    expect(action('SAFE_MARGIN')).toBe('back_to_editor');
    expect(action('IMAGE_LOW_RES')).toBe('back_to_editor');
    expect(action('FILM_NOT_READY')).toBe('turn_qr_off');
    expect(action('FILM_BLOCKED')).toBe('turn_qr_off');
    expect(action('QR_LINK_DISABLED')).toBe('turn_qr_off');
    expect(action('CARD_CHANGED')).toBe('reload');
    expect(action('QUOTE_STALE')).toBe('requote');
    expect(action('ORDER_NOT_QUOTED')).toBe('requote');
    expect(action('ORDER_ALREADY_PAID')).toBe('status');
    expect(action('SUBSCRIPTION_REQUIRED')).toBe('none');
    expect(action('NOT_DELIVERABLE')).toBe('requote');
  });

  it('says specific things (not just "something went wrong") for the print checks', () => {
    expect(describeCheckoutError({ status: 422, code: 'LETTER_OVERFLOW' }).message).toMatch(/letter/i);
    expect(describeCheckoutError({ status: 409, code: 'FILM_NOT_READY' }).message).toMatch(/film is still being made/i);
    expect(describeCheckoutError({ status: 403, code: 'SUBSCRIPTION_REQUIRED' }).message).toMatch(/active Momora subscription/i);
  });

  it('a 401 is always "sign in again", whatever the body said', () => {
    const view = describeCheckoutError({ status: 401, code: 'http_error' });
    expect(view.action).toBe('reload');
    expect(view.message).toMatch(/sign-in/i);
    expect(describeCheckoutError({ status: 401, code: 'CARD_NOT_READY' }).action).toBe('reload');
  });

  it('unknown codes fall back by status', () => {
    expect(describeCheckoutError({ status: 500, code: 'WEIRD' })).toMatchObject({ code: 'WEIRD', action: 'retry' });
    expect(describeCheckoutError({ status: 403, code: 'WEIRD' }).action).toBe('none');
    expect(describeCheckoutError({ status: 418, code: 'WEIRD' }).action).toBe('retry');
  });

  it('a QR problem on an already-ordered card cannot be fixed by turning the QR off', () => {
    const view = describeCheckoutError({ status: 409, code: 'QR_LINK_DISABLED' }, { locked: true });
    expect(view.action).toBe('none');
    expect(view.message).toContain(SUPPORT_EMAIL);
    // Other codes are unaffected.
    expect(describeCheckoutError({ status: 409, code: 'CARD_CHANGED' }, { locked: true }).action).toBe('reload');
  });

  it('keeps the book\'s voice: contractions, and the keepsakes pointer for a missing card', () => {
    expect(ERROR_TABLE.CARD_NOT_FOUND.message).toBe('We couldn’t find this card. Open it again from your keepsakes.');
    for (const [code, copy] of Object.entries(ERROR_TABLE)) {
      expect(copy.message, code).not.toMatch(/\b(could not|cannot|does not|did not|is not|has not|We are)\b/);
    }
  });

  it('covers the reorder codes and a server error on the reorder snapshot', () => {
    for (const code of ['QR_LINK_DISABLED', 'FILM_BLOCKED', 'FILM_NOT_READY', 'REORDER_UNAVAILABLE', 'internal_error']) expect(ERROR_TABLE[code], code).toBeDefined();
    expect(describeCheckoutError({ status: 500, code: 'internal_error' }).action).toBe('retry');
    for (const code of ['QR_LINK_DISABLED', 'FILM_BLOCKED', 'FILM_NOT_READY']) {
      expect(describeCheckoutError({ status: 409, code }, { locked: true }).action, code).toBe('none');
    }
    expect(describeCheckoutError({ status: 409, code: 'REORDER_UNAVAILABLE' }, { locked: true }).action).toBe('none');
  });

  it('client-side codes have copy', () => {
    for (const code of ['SAVE_PENDING', 'NO_CARD_VIEW', 'timeout', 'network_error', 'bad_response']) expect(ERROR_TABLE[code], code).toBeDefined();
  });
});

describe('isStillPreparing', () => {
  it('is a client timeout, a dropped connection and the server\'s "still running"', () => {
    expect(isStillPreparing({ status: 0, code: 'timeout' })).toBe(true);
    expect(isStillPreparing({ status: 0, code: 'network_error' })).toBe(true);
    expect(isStillPreparing({ status: 409, code: 'CHECKOUT_IN_PROGRESS' })).toBe(true);
  });
  it('is not a deterministic error, or a malformed answer', () => {
    expect(isStillPreparing({ status: 422, code: 'LETTER_OVERFLOW' })).toBe(false);
    expect(isStillPreparing({ status: 502, code: 'RENDER_UNAVAILABLE' })).toBe(false);
    expect(isStillPreparing({ status: 0, code: 'bad_response' })).toBe(false);
    expect(isStillPreparing({ status: 409, code: 'CHECKOUT_OPEN_ELSEWHERE' })).toBe(false);
  });
});

describe('interpretCancelOutcome', () => {
  it('success and "already not cancellable" both mean cancelled', () => {
    expect(interpretCancelOutcome(null)).toBe('cancelled');
    expect(interpretCancelOutcome({ status: 409, code: 'ORDER_NOT_CANCELLABLE' })).toBe('cancelled');
    expect(interpretCancelOutcome({ status: 409, code: 'CHECKOUT_NOT_OPEN' })).toBe('cancelled');
  });
  it('an order that was paid after all shows its status', () => {
    expect(interpretCancelOutcome({ status: 409, code: 'ORDER_ALREADY_PAID' })).toBe('status');
  });
  it('anything else is an error to show', () => {
    expect(interpretCancelOutcome({ status: 0, code: 'timeout' })).toBe('error');
    expect(interpretCancelOutcome({ status: 404, code: 'ORDER_NOT_FOUND' })).toBe('error');
  });
});
