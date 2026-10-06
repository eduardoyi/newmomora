import { setChoices, type CardEdits } from '../../../card/edits';
import { buildAssetUrl } from '../pickerProvider';
import type { CardData } from '../../../card/types';
import type { HolidayCardView } from '../cardTypes';
import { effectiveQrState, previewQrOn } from '../editorState';

/**
 * What the summary's front/back thumbnails are drawn from: the SERVER-confirmed
 * edits the buyer reviewed (pinned at one edits version) applied to the card
 * data the editor view carries, with the same QR rule the editor preview uses.
 * Pure (no DOM), so it unit-tests in node; `CardThumbnails.tsx` runs the fit
 * and draws the two sheets.
 */

/** A 1x1 transparent GIF: what an asset the server did not sign draws (an empty `src` would fire `error` and loop refetches). */
export const BLANK_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
/** Drawn in a preview while the QR's real link is not published yet. */
export const PREVIEW_QR_URL = 'https://usemomora.com';

export interface ThumbnailInput {
  cardData: CardData;
  /** The edits to draw: the pinned ones with the QR resolved to what will actually print. */
  edits: CardEdits;
  assetUrl: (file: string) => string;
  /** Whether the printed card carries the film QR code. */
  qrOn: boolean;
  /** The film's state matters to the buyer ("still being made"). */
  qrState: NonNullable<HolidayCardView['editorView']>['qrState'];
}

/** `pinnedEdits` = the edits at the confirmed version (for an ordered card, the frozen ones). Null while there is no editor view. */
export function buildThumbnailInput(view: HolidayCardView | null, pinnedEdits: CardEdits): ThumbnailInput | null {
  const editor = view?.editorView;
  if (!view || !editor) return null;
  const edits = editor.locked ? editor.edits : pinnedEdits;
  const cardData: CardData = { ...editor.cardData, qr: { ...editor.cardData.qr, url: editor.cardData.qr.url || PREVIEW_QR_URL } };
  const qrState = effectiveQrState(editor.qrState, edits.choices.qr, editor.edits.choices.qr);
  const qrOn = previewQrOn(qrState, view.linkDisabled, edits.choices.qr, cardData.qr.enabled);
  return {
    cardData,
    edits: setChoices(edits, { qr: qrOn, greeting: undefined }),
    assetUrl: buildAssetUrl(editor.assets, [], BLANK_IMAGE),
    qrOn,
    qrState,
  };
}
