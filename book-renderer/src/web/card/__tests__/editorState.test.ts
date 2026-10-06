import { describe, expect, it } from 'vitest';
import { buildCardDocument } from '../../../card/document';
import { emptyEdits, setChoices, setFrontImage, setLetter } from '../../../card/edits';
import { cardInputFromData } from '../../../card/fromData';
import type { MeasureFn } from '../../../card/textFit';
import {
  CHECKOUT_OPEN_NOTE,
  deriveScreenState,
  isCancelDoneCode,
  reorderGate,
  draftWarning,
  effectiveQrState,
  frontRejectionMessage,
  letterToneOptions,
  needsRefetchAfterSave,
  orderGate,
  pollIntervalMs,
  FILM_SLOW_AFTER_MS,
  PREPARING_SLOW_AFTER_MS,
  previewQrOn,
  qrControl,
  QR_NOTES,
  serverReadFrom,
  shouldRefetchOnImageError,
  shouldRefetchOnVisible,
  type ScreenInput,
  type ScreenState,
} from '../editorState';
import { fictionalCardData, fictionalView } from './helpers';

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const input = (over: Partial<ScreenInput> = {}): ScreenInput => ({
  load: 'ready',
  error: null,
  view: fictionalView(),
  queueLocked: false,
  queueCheckoutOpen: false,
  nowMs: NOW,
  firstSeenMs: NOW,
  ...over,
});

describe('deriveScreenState', () => {
  it('loads, then shows the editor', () => {
    expect(deriveScreenState(input({ load: 'loading', view: null }))).toEqual({ kind: 'loading' });
    expect(deriveScreenState(input())).toEqual({ kind: 'editing', needsRepick: false });
  });

  it('403 / 404 → forbidden ("belongs to another account"); other errors are retryable errors', () => {
    expect(deriveScreenState(input({ load: 'error', view: null, error: { status: 403, code: 'forbidden' } })).kind).toBe('forbidden');
    expect(deriveScreenState(input({ load: 'error', view: null, error: { status: 404, code: 'card_not_found' } })).kind).toBe('forbidden');
    expect(deriveScreenState(input({ load: 'error', view: null, error: { status: 0, code: 'network_error', message: 'offline' } }))).toEqual({ kind: 'error', message: 'offline' });
    // A billing 403 is not "wrong account".
    expect(deriveScreenState(input({ load: 'error', view: null, error: { status: 403, code: 'SUBSCRIPTION_REQUIRED' } })).kind).toBe('error');
  });

  it('generating → preparing, "taking longer than usual" after 5 minutes', () => {
    const young = fictionalView({ card: { ...fictionalView().card, status: 'generating', createdAt: new Date(NOW - 60_000).toISOString() } }, null);
    expect(deriveScreenState(input({ view: young }))).toEqual({ kind: 'preparing', slow: false, phase: 'generating' });
    const old = fictionalView({ card: { ...fictionalView().card, status: 'generating', createdAt: new Date(NOW - PREPARING_SLOW_AFTER_MS - 1000).toISOString() } }, null);
    expect(deriveScreenState(input({ view: old }))).toEqual({ kind: 'preparing', slow: true, phase: 'generating' });
    // No usable created time: fall back to when this screen first saw the card.
    const noTime = fictionalView({ card: { ...fictionalView().card, status: 'generating', createdAt: null } }, null);
    expect(deriveScreenState(input({ view: noTime, firstSeenMs: NOW - PREPARING_SLOW_AFTER_MS - 1 }))).toEqual({ kind: 'preparing', slow: true, phase: 'generating' });
  });

  it('readiness "film": preparing (film phase) even though the status is ready, with a 45 minute slow threshold', () => {
    const base = { readiness: 'film', film: { state: 'rendering', filmId: 'f', readyAt: null } };
    const young = fictionalView({ ...base, card: { ...fictionalView().card, createdAt: new Date(NOW - PREPARING_SLOW_AFTER_MS - 1000).toISOString() } }, null);
    // Past the artwork's 5-minute mark but well inside the film's ~20 minutes: not slow.
    expect(deriveScreenState(input({ view: young }))).toEqual({ kind: 'preparing', slow: false, phase: 'film' });
    const old = fictionalView({ ...base, card: { ...fictionalView().card, createdAt: new Date(NOW - FILM_SLOW_AFTER_MS - 1000).toISOString() } }, null);
    expect(deriveScreenState(input({ view: old }))).toEqual({ kind: 'preparing', slow: true, phase: 'film' });
  });

  it('readiness "film" never shows the editor, even if an editor view were present', () => {
    expect(deriveScreenState(input({ view: fictionalView({ readiness: 'film' }) })).kind).toBe('preparing');
  });

  it('readiness "generating" is the artwork phase', () => {
    expect(deriveScreenState(input({ view: fictionalView({ readiness: 'generating' }, null) }))).toMatchObject({ kind: 'preparing', phase: 'generating' });
  });

  it('film -> ready switches to the editor by itself once the editor view arrives', () => {
    const film = fictionalView({ readiness: 'film' }, null);
    expect(deriveScreenState(input({ view: film })).kind).toBe('preparing');
    const ready = fictionalView({ readiness: 'ready' });
    expect(deriveScreenState(input({ view: ready }))).toEqual({ kind: 'editing', needsRepick: false });
  });

  it('without readiness (older backend) behaves as before: status/editor view decide', () => {
    expect(fictionalView().readiness).toBeNull();
    expect(deriveScreenState(input({ view: fictionalView() })).kind).toBe('editing');
    expect(deriveScreenState(input({ view: fictionalView({}, null) }))).toMatchObject({ kind: 'preparing', phase: 'generating' });
  });

  it('ready without an editor view yet is still preparing', () => {
    expect(deriveScreenState(input({ view: fictionalView({}, null) })).kind).toBe('preparing');
  });

  it('failed: retryable codes say "we are retrying", the rest point at support', () => {
    for (const code of ['CONTEXT_LOAD_FAILED', 'FRONT_PICK_FAILED', 'FILM_SETUP_FAILED', 'LETTERS_FAILED', 'UNKNOWN_ERROR']) {
      const v = fictionalView({ card: { ...fictionalView().card, status: 'failed' }, generation: { state: 'failed', failureCode: code, attempts: 2 } }, null);
      expect(deriveScreenState(input({ view: v }))).toEqual({ kind: 'failed', code, retrying: true });
    }
    const terminal = fictionalView({ card: { ...fictionalView().card, status: 'failed' }, generation: { state: 'failed', failureCode: 'NOT_ENOUGH_PHOTOS', attempts: 3 } }, null);
    expect(deriveScreenState(input({ view: terminal }))).toEqual({ kind: 'failed', code: 'NOT_ENOUGH_PHOTOS', retrying: false });
  });

  it('ordered / locked → locked (even before the first refetch, from the queue)', () => {
    expect(deriveScreenState(input({ view: fictionalView({}, { locked: true }) })).kind).toBe('locked');
    expect(deriveScreenState(input({ view: fictionalView({ isOrdered: true }) })).kind).toBe('locked');
    expect(deriveScreenState(input({ queueLocked: true })).kind).toBe('locked');
  });

  it('an open checkout → checkoutOpen, with whose it is', () => {
    expect(deriveScreenState(input({ view: fictionalView({ hasOpenCheckout: true }) }))).toEqual({ kind: 'checkoutOpen', mine: false, orderId: null });
    expect(deriveScreenState(input({ view: fictionalView({ openCheckout: { orderId: 'order-1', mine: true } }) }))).toEqual({ kind: 'checkoutOpen', mine: true, orderId: 'order-1' });
    expect(deriveScreenState(input({ queueCheckoutOpen: true })).kind).toBe('checkoutOpen');
    // An ordered card keeps its locked screen, but it carries the open reorder checkout so Continue / Cancel can show.
    expect(deriveScreenState(input({ view: fictionalView({ isOrdered: true, hasOpenCheckout: true }) }))).toEqual({ kind: 'locked', checkout: { mine: false, orderId: null } });
    expect(deriveScreenState(input({ view: fictionalView({ isOrdered: true, openCheckout: { orderId: 'order-9', mine: true } }) }))).toEqual({ kind: 'locked', checkout: { mine: true, orderId: 'order-9' } });
    expect(deriveScreenState(input({ view: fictionalView({ isOrdered: true }) }))).toEqual({ kind: 'locked', checkout: null });
  });

  it('frontMissing forces a re-pick', () => {
    expect(deriveScreenState(input({ view: fictionalView({}, { frontMissing: true }) }))).toEqual({ kind: 'editing', needsRepick: true });
  });
});

describe('qrControl / effectiveQrState / previewQrOn (one table)', () => {
  it.each([
    // [qrState, linkDisabled, choice, cardDefault] → [checked, disabled, note]
    ['on', false, undefined, true, true, false, null],
    ['on', false, false, true, false, false, null],
    ['on', false, undefined, false, false, false, null],
    ['waiting_film', false, undefined, true, true, false, QR_NOTES.waiting],
    ['waiting_film', false, false, true, false, false, QR_NOTES.waiting],
    ['off', false, undefined, true, false, false, null],
    ['off', false, true, true, true, false, null],
    ['off', true, undefined, true, false, true, QR_NOTES.revoked],
    ['off', true, true, true, false, true, QR_NOTES.revoked],
    ['unavailable', false, undefined, true, false, true, QR_NOTES.unavailable],
    ['unavailable', false, true, true, false, true, QR_NOTES.unavailable],
  ] as const)('%s link-disabled=%s choice=%s default=%s → checked=%s disabled=%s', (qrState, linkDisabled, choice, cardDefault, checked, disabled, note) => {
    const c = qrControl({ qrState, linkDisabled, choice, cardDefault });
    expect(c).toEqual({ visible: true, checked, disabled, note });
    expect(previewQrOn(qrState, linkDisabled, choice, cardDefault)).toBe(checked);
  });

  it('turning the QR off while waiting counts as off locally; turning it back on after "off" is unknown until the refetch', () => {
    expect(effectiveQrState('waiting_film', false, undefined)).toBe('off');
    expect(effectiveQrState('waiting_film', undefined, undefined)).toBe('waiting_film');
    expect(effectiveQrState('off', true, false)).toBe('waiting_film');
    expect(effectiveQrState('off', undefined, false)).toBe('off');
    expect(effectiveQrState('on', false, undefined)).toBe('on');
    expect(effectiveQrState('unavailable', true, undefined)).toBe('unavailable');
  });
});

describe('orderGate', () => {
  const editing: ScreenState = { kind: 'editing', needsRepick: false };
  const ok = { screen: editing, queueIdle: true, queueHasError: false, qrState: 'on' as const };
  it('enables only when idle, ready, unlocked, no checkout, qrState on/off/unavailable', () => {
    for (const qrState of ['on', 'off', 'unavailable'] as const) expect(orderGate({ ...ok, qrState })).toEqual({ enabled: true, blocked: null });
    expect(orderGate({ ...ok, qrState: 'waiting_film' })).toEqual({ enabled: false, blocked: 'qr_waiting' });
    expect(orderGate({ ...ok, queueIdle: false })).toEqual({ enabled: false, blocked: 'saving' });
    expect(orderGate({ ...ok, queueIdle: false, queueHasError: true })).toEqual({ enabled: false, blocked: 'save_error' });
    expect(orderGate({ ...ok, screen: { kind: 'editing', needsRepick: true } })).toEqual({ enabled: false, blocked: 'front_missing' });
    expect(orderGate({ ...ok, screen: { kind: 'locked', checkout: null } })).toEqual({ enabled: false, blocked: 'locked' });
    expect(orderGate({ ...ok, screen: { kind: 'checkoutOpen', mine: true, orderId: 'o' } })).toEqual({ enabled: false, blocked: 'checkout_open' });
    expect(orderGate({ ...ok, screen: { kind: 'preparing', slow: false, phase: 'generating' } }).enabled).toBe(false);
    expect(orderGate({ ...ok, screen: { kind: 'failed', code: null, retrying: false } }).enabled).toBe(false);
    expect(orderGate({ ...ok, qrState: null }).enabled).toBe(false);
  });
});

describe('reorder gate and cancelling', () => {
  it('"Order more cards" is disabled while any checkout is open; a stranger\'s gets the 35-minute note', () => {
    expect(reorderGate({ kind: 'locked', checkout: null })).toEqual({ enabled: true, note: null });
    expect(reorderGate({ kind: 'locked', checkout: { mine: true, orderId: 'o' } })).toEqual({ enabled: false, note: null });
    expect(reorderGate({ kind: 'locked', checkout: { mine: false, orderId: null } })).toEqual({ enabled: false, note: CHECKOUT_OPEN_NOTE });
    expect(CHECKOUT_OPEN_NOTE).toMatch(/35 minutes/);
    expect(reorderGate({ kind: 'editing', needsRepick: false }).enabled).toBe(false);
  });
  it('a cancel that finds the checkout already gone counts as done', () => {
    expect(isCancelDoneCode('ORDER_NOT_CANCELLABLE')).toBe(true);
    expect(isCancelDoneCode('CHECKOUT_NOT_OPEN')).toBe(true);
    expect(isCancelDoneCode('STRIPE_UNAVAILABLE')).toBe(false);
  });
});

describe('polling and refetch cadence', () => {
  it('5 s while generating, 30 s while the film renders, otherwise none', () => {
    expect(pollIntervalMs(null)).toBeNull();
    expect(pollIntervalMs(fictionalView({ card: { ...fictionalView().card, status: 'generating' } }, null))).toBe(5_000);
    expect(pollIntervalMs(fictionalView({ film: { state: 'rendering', filmId: 'f', readyAt: null } }))).toBe(30_000);
    expect(pollIntervalMs(fictionalView())).toBeNull();
    // Readiness from the server: 'film' polls at the film cadence, 'generating' at the fast one, 'ready' stops.
    expect(pollIntervalMs(fictionalView({ readiness: 'film' }, null))).toBe(30_000);
    expect(pollIntervalMs(fictionalView({ readiness: 'generating' }, null))).toBe(5_000);
    expect(pollIntervalMs(fictionalView({ readiness: 'ready' }))).toBeNull();
    // Generating wins over a rendering film.
    expect(pollIntervalMs(fictionalView({ card: { ...fictionalView().card, status: 'generating' }, film: { state: 'rendering', filmId: 'f', readyAt: null } }, null))).toBe(5_000);
  });
  it('throttles image-error and visibility refetches', () => {
    expect(shouldRefetchOnImageError(NOW - 1_000, NOW)).toBe(false);
    expect(shouldRefetchOnImageError(NOW - 20_000, NOW)).toBe(true);
    expect(shouldRefetchOnVisible(NOW - 2_000, NOW)).toBe(false);
    expect(shouldRefetchOnVisible(NOW - 60_000, NOW)).toBe(true);
  });
  it('refetches after a save only when the QR choice or the front changed', () => {
    const a = emptyEdits();
    expect(needsRefetchAfterSave(a, setChoices(a, { qr: false }))).toBe(true);
    expect(needsRefetchAfterSave(a, setFrontImage(a, 'media-2'))).toBe(true);
    expect(needsRefetchAfterSave(a, setLetter(a, 'classic', 'Hello'))).toBe(false);
  });
});

describe('serverReadFrom', () => {
  it('reads the editor view edits, the card version and the lock flags', () => {
    expect(serverReadFrom(fictionalView({}, null))).toBeNull();
    const read = serverReadFrom(fictionalView({ hasOpenCheckout: true }));
    expect(read).toMatchObject({ version: 3, checkoutOpen: true, locked: false });
    expect(serverReadFrom(fictionalView({ isOrdered: true }))).toMatchObject({ locked: true });
  });
});

describe('letter versions and messages', () => {
  it('labels classic / reflective / playful as Classic / Warm / Playful and shows only those present', () => {
    expect(letterToneOptions(fictionalCardData())).toEqual([
      { tone: 'classic', label: 'Classic' },
      { tone: 'reflective', label: 'Warm' },
      { tone: 'playful', label: 'Playful' },
    ]);
    expect(letterToneOptions({ letters: [{ tone: 'playful', text: 'x' }, { tone: 'classic', text: 'y' }] })).toEqual([
      { tone: 'classic', label: 'Classic' },
      { tone: 'playful', label: 'Playful' },
    ]);
  });
  it('explains every front rejection', () => {
    for (const code of ['front_low_resolution', 'front_unreadable', 'MEDIA_NOT_PRINTABLE', 'MEDIA_NOT_FOUND', 'other']) {
      expect(frontRejectionMessage(code)).toMatch(/Pick another one\./);
    }
  });
});

describe('draftWarning', () => {
  const measure: MeasureFn = (text, _f, pt) => text.length * pt * 0.47 * (25.4 / 72);
  const doc = (letter: string) => buildCardDocument(cardInputFromData(fictionalCardData(), setLetter(emptyEdits(), 'classic', letter), (f) => `/${f}`), measure);
  it('does nothing without a draft', () => {
    expect(draftWarning(doc('Short and sweet.'), null)).toEqual({ warning: null, blockSave: false });
    expect(draftWarning(null, 'letter')).toEqual({ warning: null, blockSave: false });
  });
  it('blocks save when the letter would drop below the readable minimum', () => {
    const long = 'We went to the park and ate ice cream together. '.repeat(40);
    const result = draftWarning(doc(long), 'letter');
    expect(result.blockSave).toBe(true);
    expect(result.warning).toMatch(/9 pt/);
    expect(draftWarning(doc(long), 'back.signature').warning).toMatch(/room/);
    expect(draftWarning(doc('Short and sweet.'), 'letter').blockSave).toBe(false);
  });
});
