import { describe, expect, it } from 'vitest';
import { CardApiError, parseFilmUrls, parseHolidayCard, parsePickerPool, parseSaveEdits, toCardApiError } from '../cardTypes';
import { fictionalCardData, rawGet } from './helpers';

function httpError(status: number, body: unknown) {
  return { name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: { status, json: async () => body } };
}

describe('toCardApiError', () => {
  it('unwraps status, code, message and currentVersion from the response body', async () => {
    const err = await toCardApiError(httpError(409, { error: 'The card changed since you loaded it', code: 'edits_version_mismatch', currentVersion: 7 }));
    expect(err).toBeInstanceOf(CardApiError);
    expect(err).toMatchObject({ status: 409, code: 'edits_version_mismatch', currentVersion: 7, message: 'The card changed since you loaded it' });
  });
  it('423 and plain codes', async () => {
    expect(await toCardApiError(httpError(423, { error: 'A checkout is open for this card', code: 'holiday_card_checkout_open' }))).toMatchObject({ status: 423, code: 'holiday_card_checkout_open', currentVersion: null });
  });
  it('an HTTP error with an unreadable body keeps the status', async () => {
    const err = await toCardApiError({ message: 'boom', context: { status: 502, json: async () => Promise.reject(new Error('not json')) } });
    expect(err).toMatchObject({ status: 502, code: 'http_error', message: 'boom' });
  });
  it('a relay/fetch failure is status 0 network_error', async () => {
    expect(await toCardApiError({ name: 'FunctionsFetchError', message: 'Failed to send a request', context: new TypeError('x') })).toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('parseHolidayCard', () => {
  it('parses the P1 + editor fields', () => {
    const view = parseHolidayCard(rawGet({ openCheckout: { orderId: 'order-1', mine: true }, myOrders: [{ id: 'order-1', status: 'paid', packs: 2, cards: 20, priceCents: 4980, createdAt: '2026-10-05T10:00:00Z' }] }));
    expect(view.card).toMatchObject({ id: 'card-1', status: 'ready', editsVersion: 3, greeting: 'christmas' });
    expect(view.film).toEqual({ state: 'ready', filmId: 'film-1', readyAt: '2026-10-01T10:30:00.000Z' });
    expect(view.editorView?.qrState).toBe('on');
    expect(view.editorView?.cardData.frontOptions).toHaveLength(2);
    expect(view.editorView?.assets['front-1.jpg']).toContain('front-1.jpg');
    expect(view.openCheckout).toEqual({ orderId: 'order-1', mine: true });
    expect(view.hasOpenCheckout).toBe(true);
    expect(view.myOrders).toEqual([{ id: 'order-1', status: 'paid', packs: 2, cards: 20, priceCents: 4980, createdAt: '2026-10-05T10:00:00Z' }]);
  });
  it('defaults the P2 fields a P1 server does not send', () => {
    const raw = rawGet();
    delete (raw as Record<string, unknown>).editorView;
    delete (raw as Record<string, unknown>).openCheckout;
    delete (raw as Record<string, unknown>).myOrders;
    const view = parseHolidayCard(raw);
    expect(view.editorView).toBeNull();
    expect(view.editorViewInvalid).toBe(false);
    expect(view.openCheckout).toBeNull();
    expect(view.myOrders).toEqual([]);
  });
  it('flags an editor view that does not parse instead of crashing', () => {
    const view = parseHolidayCard(rawGet({}, { cardData: { version: 2 } }));
    expect(view.editorView).toBeNull();
    expect(view.editorViewInvalid).toBe(true);
  });
  it('an unknown qrState degrades to the one that blocks ordering', () => {
    expect(parseHolidayCard(rawGet({}, { qrState: 'mystery' })).editorView?.qrState).toBe('waiting_film');
  });
  it('rejects a malformed core', () => {
    expect(() => parseHolidayCard(null)).toThrow(CardApiError);
    expect(() => parseHolidayCard({ card: { id: 'x', status: 'weird' } })).toThrow(CardApiError);
  });
  it('cardData round-trips through parseCardData defaults', () => {
    const view = parseHolidayCard(rawGet());
    expect(view.editorView?.cardData.slug).toBe(fictionalCardData().slug);
  });
});

describe('other responses', () => {
  it('picker_pool', () => {
    const page = parsePickerPool({ items: [{ memoryId: 'm', mediaId: 'x', previewKey: 'k', date: '2026-01-02', aspectRatio: 1.33 }, { mediaId: 7 }, { memoryId: 'm', mediaId: 'y', previewKey: 'k2', date: '2026-01-03', aspectRatio: null }], nextCursor: null });
    expect(page.items.map((i) => i.mediaId)).toEqual(['x', 'y']);
    expect(page.items[1].aspectRatio).toBeNull();
    expect(page.nextCursor).toBeNull();
    expect(() => parsePickerPool({})).toThrow(CardApiError);
  });
  it('save_edits', () => {
    expect(parseSaveEdits({ success: true, editsVersion: 4, edits: { version: 1, choices: { layout: 'full-bleed', tone: 'playful' } } })).toMatchObject({ editsVersion: 4, edits: { choices: { layout: 'full-bleed', tone: 'playful' } } });
    expect(() => parseSaveEdits({ success: true })).toThrow(CardApiError);
  });
  it('film url', () => {
    expect(parseFilmUrls({ videoUrl: 'https://v.example.test/a.mp4', posterUrl: 'https://v.example.test/a.jpg', durationMs: 60000 })).toEqual({ videoUrl: 'https://v.example.test/a.mp4', posterUrl: 'https://v.example.test/a.jpg', durationMs: 60000 });
    expect(() => parseFilmUrls({})).toThrow(CardApiError);
  });
});
