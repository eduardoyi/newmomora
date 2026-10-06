import { emptyEdits } from '../../../card/edits';
import type { CardData } from '../../../card/types';
import { parseHolidayCard, type HolidayCardView } from '../cardTypes';

/** Fictional card data for tests (the repo is public: no real names, photos or ids). */
export function fictionalCardData(overrides: Partial<CardData> = {}): CardData {
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
    qr: { enabled: true, token: 'AAAAAAAAAAAAAAAAAAAAAA', url: 'https://m.example.test/f/AAAAAAAAAAAAAAAAAAAAAA' },
    letters: [
      { tone: 'classic', text: 'A classic letter about the park and the ice cream.' },
      { tone: 'reflective', text: 'A warm letter about growing up.' },
      { tone: 'playful', text: 'A playful letter about puddles.' },
    ],
    photo: { mediaId: 'media-1', file: 'front-1.jpg', width: 4032, height: 3024 },
    illustrations: [],
    frontOptions: [
      { id: 'media-1', kind: 'photo', file: 'front-1.jpg', width: 4032, height: 3024, rank: 1 },
      { id: 'media-2', kind: 'photo', file: 'front-2.jpg', width: 3024, height: 4032, rank: 2 },
    ],
    portraits: [],
    ...overrides,
  };
}

/** A raw `get` response (what the Edge Function returns), overridable. */
export function rawGet(overrides: Record<string, unknown> = {}, editor: Record<string, unknown> | null | undefined = {}): Record<string, unknown> {
  const data = fictionalCardData();
  return {
    card: {
      id: 'card-1',
      familyId: 'family-1',
      year: 2026,
      status: 'ready',
      lastFailureCode: null,
      language: 'en',
      locale: 'en-US',
      greeting: 'christmas',
      letters: data.letters,
      qrCaption: 'Scan to watch our year',
      signature: data.signature,
      edits: emptyEdits(),
      editsVersion: 3,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    film: { state: 'ready', filmId: 'film-1', readyAt: '2026-10-01T10:30:00.000Z' },
    qrUrl: data.qr.url,
    linkDisabled: false,
    hasOpenCheckout: false,
    isOrdered: false,
    generation: { state: 'ready', failureCode: null, attempts: 1 },
    editorView:
      editor === null
        ? null
        : {
            cardData: data,
            edits: emptyEdits(),
            assets: { 'front-1.jpg': 'https://cdn.example.test/front-1.jpg?sig=1', 'front-2.jpg': 'https://cdn.example.test/front-2.jpg?sig=1' },
            frontMissing: false,
            qrState: 'on',
            locked: false,
            ...(editor ?? {}),
          },
    openCheckout: null,
    myOrders: [],
    ...overrides,
  };
}

export function fictionalView(overrides: Record<string, unknown> = {}, editor: Record<string, unknown> | null | undefined = {}): HolidayCardView {
  return parseHolidayCard(rawGet(overrides, editor));
}
