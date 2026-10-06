import { emptyEdits, normalizeEdits, type CardEdits } from '../../../card/edits';
import type { CardData } from '../../../card/types';
import { validateCardAddress } from '../../order/cardAddress';
import { CardApiError, type FilmUrls, type PickerPoolPage } from '../cardTypes';

/**
 * DEV-ONLY walkthrough data for the holiday card editor (`?fixture=card`):
 * one fictional card ("the Rivera family") served from memory, with a working
 * compare-and-set save, a photo pool and film URLs, so the editor can be
 * exercised on a phone or desktop without a backend. Inline SVG pictures only:
 * no real photos, names or ids (the repo is public).
 *
 * SAFETY: every use of this module is behind `import.meta.env.DEV` (a
 * compile-time constant), so a production build drops it and
 * `scripts/check-web-bundle.mjs` (which fails on the word this query parameter
 * is named after) proves it. Variants: `&state=generating|failed|failed-terminal|
 * locked|checkout|front-missing|waiting-film|no-film|forbidden|slow-save|conflict`.
 *
 * Checkout (`holiday-card-orders`) walkthrough: the order lifecycle (draft,
 * quote, checkout, status, cancel) is kept in `sessionStorage` so it survives
 * the "Stripe" round trip (a same-page return URL). `&co=` picks what
 * `create_checkout` does: `timeout` (a client timeout, then "still preparing",
 * then success), `cancel` (the return says cancelled), or an error code such as
 * `LETTER_OVERFLOW` (the QR codes only fail while the QR is on, so "turn the QR
 * off" can be walked). `&qe=<CODE>` makes `quote` fail once. `&state=order-shipped`
 * / `order-failed` pick where a paid order ends up.
 */

const PARAM = 'fixture';
const CARD_ID = '00000000-0000-4000-8000-0000000000c1';

export function isCardFixture(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(PARAM) === 'card';
}

function variant(): string {
  return new URLSearchParams(window.location.search).get('state') ?? 'ready';
}

function svgUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function scene(w: number, h: number, hue: number): string {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,78%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,52%)"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
      `<circle cx="${w * 0.72}" cy="${h * 0.28}" r="${h * 0.12}" fill="#fff6d6"/>` +
      `<path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.6} ${w * 0.55} ${h * 0.76} T ${w} ${h * 0.7} V ${h} H0 Z" fill="hsl(${hue + 90},35%,32%)"/>` +
      `<circle cx="${w * 0.35}" cy="${h * 0.62}" r="${h * 0.07}" fill="#f7d9bd"/><rect x="${w * 0.33}" y="${h * 0.68}" width="${w * 0.04}" height="${h * 0.14}" rx="8" fill="#b4436c"/>` +
      `<circle cx="${w * 0.46}" cy="${h * 0.66}" r="${h * 0.055}" fill="#f2c9a5"/><rect x="${w * 0.445}" y="${h * 0.71}" width="${w * 0.03}" height="${h * 0.11}" rx="8" fill="#4a3f6b"/>` +
      `</svg>`,
  );
}

function portrait(hue: number): string {
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="hsl(${hue},55%,86%)"/>` +
      `<circle cx="512" cy="430" r="190" fill="#f3d2b4"/><path d="M180 1024 Q512 600 844 1024 Z" fill="hsl(${hue},45%,48%)"/></svg>`,
  );
}

const LANDSCAPE = scene(4032, 3024, 210);
const PORTRAIT = scene(3024, 4032, 280);

const LETTERS = [
  {
    tone: 'classic',
    text: 'Dear family and friends,\n\nThis year Lía learned to ride her bike without training wheels, and Teo took his first steps across the kitchen straight into the dog. We spent long afternoons at the park, built a very crooked snowman in January, and ate far too much ice cream in July.\n\nWe are grateful for every one of you who shared a piece of our year. Wishing you a warm and happy season.',
  },
  {
    tone: 'reflective',
    text: 'Dear family and friends,\n\nLooking back, it was the small things that stayed with us: sleepy mornings, muddy boots by the door, Lía humming while she drew. Teo grew taller than we noticed, and somehow we grew too.\n\nThank you for being part of it. May your season be gentle and full of light.',
  },
  {
    tone: 'playful',
    text: 'Hello you!\n\nA year in three words: puddles, pancakes, pajamas. Lía is now the boss of the backyard, Teo is the boss of the snack drawer, and we are mostly just following orders.\n\nHappy holidays from our noisy little house to yours!',
  },
];

function cardData(opts: { frontOptions: CardData['frontOptions']; qrEnabled: boolean }): CardData {
  return {
    version: 1,
    slug: 'rivera-2026',
    year: 2026,
    language: 'en',
    locale: 'en-US',
    greeting: 'christmas',
    familyName: 'Rivera',
    signature: 'With love, the Rivera family',
    qrCaption: 'Scan to watch our year',
    qr: { enabled: opts.qrEnabled, token: 'AAAAAAAAAAAAAAAAAAAAAA', url: 'https://m.example.test/f/AAAAAAAAAAAAAAAAAAAAAA' },
    letters: LETTERS,
    photo: { mediaId: 'fx-media-1', file: 'front-1.jpg', width: 4032, height: 3024, greetingPosition: 'bottom-left' },
    illustrations: [],
    frontOptions: opts.frontOptions,
    portraits: [
      { memberId: 'p1', name: 'Mara', role: 'parent', file: 'portrait-1.png', width: 1024, height: 1024 },
      { memberId: 'p2', name: 'Diego', role: 'parent', file: 'portrait-2.png', width: 1024, height: 1024 },
      { memberId: 'c1', name: 'Lía', role: 'child', file: 'portrait-3.png', width: 1024, height: 1024 },
      { memberId: 'c2', name: 'Teo', role: 'child', file: 'portrait-4.png', width: 1024, height: 1024 },
    ],
  };
}

const ASSETS: Record<string, string> = {
  'front-1.jpg': LANDSCAPE,
  'front-2.jpg': PORTRAIT,
  'portrait-1.png': portrait(330),
  'portrait-2.png': portrait(210),
  'portrait-3.png': portrait(30),
  'portrait-4.png': portrait(140),
};

// ── In-memory server state ───────────────────────────────────────────────

let edits: CardEdits = emptyEdits();
let version = 1;
let pendingCreatedAt = Date.now();
let conflictOnce = true;

function delay<T>(value: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export function fixtureGet(cardId: string): Promise<unknown> {
  const state = variant();
  if (state === 'forbidden') return Promise.reject(new CardApiError(403, 'forbidden', 'Not authorized for this card'));
  const generating = state === 'generating';
  const failed = state === 'failed' || state === 'failed-terminal';
  const locked = state === 'locked';
  const waiting = state === 'waiting-film';
  const noFilm = state === 'no-film';
  const frontMissing = state === 'front-missing';
  const qrState = waiting ? 'waiting_film' : noFilm ? 'unavailable' : edits.choices.qr === false ? 'off' : 'on';
  const picked = edits.frontImage;
  const frontOptions: NonNullable<CardData['frontOptions']> = [
    { id: 'fx-media-1', kind: 'photo', file: 'front-1.jpg', width: 4032, height: 3024, rank: 1, date: '2026-09-02' },
    { id: 'fx-media-2', kind: 'photo', file: 'front-2.jpg', width: 3024, height: 4032, rank: 2, date: '2026-08-14' },
  ];
  if (picked && !frontOptions.some((o) => o.id === picked)) {
    ASSETS[`pool-${picked}.jpg`] = scene(4032, 3024, (Number(picked.replace(/\D/g, '')) * 37) % 360);
    frontOptions.push({ id: picked, kind: 'photo', file: `pool-${picked}.jpg`, width: 4032, height: 3024 });
  }
  const view = {
    card: {
      id: cardId || CARD_ID,
      familyId: 'fx-family',
      year: 2026,
      status: failed ? 'failed' : generating ? 'generating' : 'ready',
      lastFailureCode: failed ? (state === 'failed' ? 'LETTERS_FAILED' : 'NOT_ENOUGH_PHOTOS') : null,
      language: 'en',
      locale: 'en-US',
      greeting: 'christmas',
      letters: LETTERS,
      qrCaption: 'Scan to watch our year',
      signature: 'With love, the Rivera family',
      edits: locked ? emptyEdits() : edits,
      editsVersion: version,
      createdAt: new Date(state === 'generating' ? pendingCreatedAt : Date.now() - 3_600_000).toISOString(),
    },
    film: { state: noFilm ? 'none' : waiting ? 'rendering' : 'ready', filmId: 'fx-film', readyAt: waiting || noFilm ? null : '2026-10-01T10:30:00.000Z' },
    qrUrl: null,
    linkDisabled: false,
    hasOpenCheckout: state === 'checkout',
    isOrdered: locked,
    generation: { state: failed ? 'failed' : generating ? 'generating' : 'ready', failureCode: failed ? (state === 'failed' ? 'LETTERS_FAILED' : 'NOT_ENOUGH_PHOTOS') : null, attempts: 1 },
    editorView:
      generating || failed
        ? null
        : {
            cardData: cardData({ frontOptions, qrEnabled: qrState !== 'unavailable' && qrState !== 'off' }),
            edits: locked ? emptyEdits() : edits,
            assets: ASSETS,
            frontMissing,
            qrState,
            locked,
          },
    openCheckout: state === 'checkout' ? { orderId: 'fx-order-open', mine: true } : null,
    shipByNote: 'Order by early December for Christmas delivery in the US.',
    myOrders: locked ? [{ id: 'fx-order-1', status: 'shipped', packs: 2, cards: 20, priceCents: 4980, createdAt: '2026-10-03T16:00:00.000Z' }] : [],
  };
  return delay(view);
}

export function fixtureSave(expectedVersion: number, next: CardEdits): Promise<{ editsVersion: number; edits: CardEdits }> {
  const state = variant();
  if (state === 'conflict' && conflictOnce && expectedVersion === version) {
    conflictOnce = false;
    version += 1; // someone else saved first
    return Promise.reject(new CardApiError(409, 'edits_version_mismatch', 'The card changed since you loaded it', version));
  }
  if (expectedVersion !== version) return Promise.reject(new CardApiError(409, 'edits_version_mismatch', 'The card changed since you loaded it', version));
  if (next.frontImage === 'fx-media-bad') return delay(null, 150).then(() => Promise.reject(new CardApiError(422, 'front_low_resolution', 'That photo is too small to print well on a card')));
  edits = normalizeEdits(next);
  version += 1;
  return delay({ editsVersion: version, edits }, state === 'slow-save' ? 3000 : 150);
}

export function fixturePickerPool(cursor: string | null): PickerPoolPage {
  const start = cursor ? Number(cursor) : 0;
  const items = Array.from({ length: 12 }, (_, i) => start + i + 1).map((n) => ({
    memoryId: `fx-mem-${n}`,
    mediaId: n === 3 ? 'fx-media-bad' : `fx-media-${n + 10}`,
    previewKey: `fx-key-${n}`,
    date: `2026-0${(n % 9) + 1}-1${n % 9}`,
    aspectRatio: n % 4 === 0 ? 0.75 : n % 5 === 0 ? null : 1.333,
  }));
  return { items, nextCursor: start + 12 < 36 ? String(start + 12) : null };
}

export function fixtureMediaUrls(keys: string[]): Map<string, string> {
  return new Map(keys.map((k) => [k, scene(400, 300, (Number(k.replace(/\D/g, '')) * 53) % 360)]));
}

export function fixtureFilmUrls(): Promise<FilmUrls> {
  return delay({ videoUrl: '', posterUrl: scene(640, 360, 250), durationMs: 60_000 });
}

// ── Checkout (`holiday-card-orders`) ─────────────────────────────────────

type FxOrderStatus = 'draft' | 'quoted' | 'checkout' | 'paid' | 'submitted' | 'in_production' | 'shipped' | 'failed' | 'cancelled';

interface FxOrder {
  id: string;
  status: FxOrderStatus;
  packs: number | null;
  priceCents: number | null;
  /** The quoted destination (shown on the status page). */
  address?: unknown;
  /** `status` reads since the order reached `checkout` (drives the fake webhook / printer progress). */
  polls: number;
}

const ORDERS_KEY = 'momora-card-orders';

function loadOrders(): Record<string, FxOrder> {
  try {
    return JSON.parse(window.sessionStorage.getItem(ORDERS_KEY) ?? '{}') as Record<string, FxOrder>;
  } catch {
    return {};
  }
}

function saveOrders(orders: Record<string, FxOrder>): void {
  try {
    window.sessionStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch {
    // Storage blocked: the walkthrough just loses its memory on reload.
  }
}

function param(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

let createCalls = 0;
let quoteFailedOnce = false;

/** `&qe=` fails the first quote only (then the retry succeeds). */
function qeDone(): boolean {
  if (quoteFailedOnce) return true;
  quoteFailedOnce = true;
  return false;
}

function readOrder(id: string): FxOrder | null {
  if (id === 'fx-order-1') return { id, status: 'shipped', packs: 2, priceCents: 4980, polls: 99, address: { name: 'Mara Rivera', line1: '1 Example Street', city: 'Springfield', state: 'IL', postalCode: '62701', countryCode: 'US' } };
  const stored = loadOrders()[id];
  if (stored) return stored;
  if (id === 'fx-order-open') return { id, status: 'checkout', packs: 2, priceCents: 4980, polls: 0 };
  return null;
}

function writeOrder(order: FxOrder): void {
  const all = loadOrders();
  all[order.id] = order;
  saveOrders(all);
}

function notFound(): CardApiError {
  return new CardApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
}

export function fixtureCreateDraft(_cardId: string): Promise<unknown> {
  const all = loadOrders();
  const id = `fx-order-${Object.keys(all).length + 2}`;
  all[id] = { id, status: 'draft', packs: null, priceCents: null, polls: 0 };
  saveOrders(all);
  return delay({ success: true, orderId: id, status: 'draft' }, 250);
}

export function fixtureQuote(orderId: string, packs: number, address: unknown): Promise<unknown> {
  const order = readOrder(orderId);
  if (!order) return Promise.reject(notFound());
  if (order.status !== 'draft' && order.status !== 'quoted') return Promise.reject(new CardApiError(409, 'ORDER_NOT_QUOTABLE', 'Order can no longer be quoted'));
  const check = validateCardAddress(address as Parameters<typeof validateCardAddress>[0]);
  if (!check.ok) return Promise.reject(new CardApiError(400, 'validation_error', Object.values(check.errors)[0] ?? 'Invalid address'));
  const qe = param('qe');
  if (qe && !qeDone()) {
    return delay(null, 300).then(() => Promise.reject(new CardApiError(422, qe, 'Quote refused')));
  }
  const priceCents = packs * 10 * 249;
  writeOrder({ ...order, status: 'quoted', packs, priceCents, address: check.address });
  return delay({ success: true, orderId, status: 'quoted', region: 'US', format: '5R', packs, cards: packs * 10, priceCents, currency: 'USD' }, 600);
}

const QR_ERRORS = ['FILM_NOT_READY', 'FILM_BLOCKED', 'QR_LINK_DISABLED'];

export function fixtureCreateCheckout(orderId: string, expectedEditsVersion: number): Promise<unknown> {
  const order = readOrder(orderId);
  if (!order) return Promise.reject(notFound());
  if (order.status === 'paid' || order.status === 'submitted') return Promise.reject(new CardApiError(409, 'ORDER_ALREADY_PAID', 'Order already paid'));
  if (expectedEditsVersion !== version) return Promise.reject(new CardApiError(409, 'CARD_CHANGED', 'The card changed since you reviewed it'));
  const co = param('co');
  createCalls += 1;
  if (co === 'timeout') {
    // The first call "hangs" past the client timeout, the second finds it still running, the third resumes it.
    if (createCalls === 1) return delay(null, 600).then(() => Promise.reject(new CardApiError(0, 'timeout', 'This is taking longer than expected.')));
    if (createCalls === 2) return delay(null, 200).then(() => Promise.reject(new CardApiError(409, 'CHECKOUT_IN_PROGRESS', 'A checkout is already being prepared')));
  } else if (co && co !== 'cancel') {
    const qrBlocked = QR_ERRORS.includes(co) && edits.choices.qr !== false;
    if (!QR_ERRORS.includes(co) || qrBlocked) {
      const status = co.endsWith('_UNAVAILABLE') ? 502 : co === 'SUBSCRIPTION_REQUIRED' ? 403 : [ 'LETTER_OVERFLOW', 'SAFE_MARGIN', 'IMAGE_MISSING', 'IMAGE_LOW_RES', 'PAGE_SIZE', 'FONTS', 'BAD_INPUT', 'NO_FRONT_PHOTO', 'FRONT_PHOTO_UNREADABLE', 'NO_LETTERS', 'INVALID_CARD', 'DRAFT_REJECTED' ].includes(co) ? 422 : 409;
      return delay(null, 900).then(() => Promise.reject(new CardApiError(status, co, 'Checkout refused')));
    }
  }
  writeOrder({ ...order, status: 'checkout', polls: 0 });
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.set('order', orderId);
  returnUrl.searchParams.set('checkout', co === 'cancel' ? 'cancelled' : 'success');
  returnUrl.searchParams.delete('co');
  return delay({ success: true, orderId, status: 'checkout', checkoutUrl: returnUrl.toString(), sessionId: 'cs_test_fx', resumed: createCalls > 1 }, 1500);
}

export function fixtureCancelCheckout(orderId: string): Promise<unknown> {
  const order = readOrder(orderId);
  if (!order) return Promise.reject(notFound());
  if (order.status === 'cancelled') return Promise.reject(new CardApiError(409, 'ORDER_NOT_CANCELLABLE', 'Order is not cancellable'));
  if (order.status !== 'checkout' && order.status !== 'quoted' && order.status !== 'draft') return Promise.reject(new CardApiError(409, 'ORDER_ALREADY_PAID', 'Order already paid'));
  writeOrder({ ...order, status: 'cancelled' });
  return delay({ success: true, status: 'cancelled' }, 300);
}

export function fixtureOrderStatus(orderId: string): Promise<unknown> {
  const order = readOrder(orderId);
  if (!order) return Promise.reject(notFound());
  let status: FxOrderStatus = order.status;
  if (status === 'checkout' && orderId !== 'fx-order-open') {
    // The fake webhook and printer: a couple of polls in "checkout" (late webhook), then paid, then on.
    const end = param('state') === 'order-shipped' ? 'shipped' : param('state') === 'order-failed' ? 'failed' : 'in_production';
    const path: FxOrderStatus[] = ['checkout', 'checkout', 'paid', 'submitted', end === 'failed' ? 'failed' : 'in_production'];
    if (end === 'shipped') path.push('shipped');
    status = path[Math.min(order.polls, path.length - 1)];
    writeOrder({ ...order, polls: order.polls + 1 });
  }
  const shipped = status === 'shipped';
  return delay(
    {
      orderId,
      cardId: CARD_ID,
      status,
      packs: order.packs,
      cards: order.packs === null ? null : order.packs * 10,
      priceCents: order.priceCents,
      currency: 'USD',
      region: 'US',
      gelatoStatus: shipped ? 'shipped' : null,
      trackingNumber: shipped ? '1Z999AA10123456784' : null,
      trackingUrl: shipped ? 'https://tracking.example.test/track?n=1Z999AA10123456784' : null,
      carrier: shipped ? 'UPS' : null,
      shippedAt: shipped ? '2026-10-20T15:00:00.000Z' : null,
      failureReason: status === 'failed' ? 'FIXTURE_FAILURE' : null,
      refunded: false,
      refundedAt: null,
      shippingAddress: order.address ?? null,
      createdAt: '2026-10-03T16:00:00.000Z',
    },
    200,
  );
}

/** Backoff waits are shortened in the walkthrough so the timeout path can be seen in seconds. */
export const FIXTURE_BACKOFF_SCALE = 0.2;
/** And the status poll is quicker. */
export const FIXTURE_STATUS_POLL_MS = 1500;
