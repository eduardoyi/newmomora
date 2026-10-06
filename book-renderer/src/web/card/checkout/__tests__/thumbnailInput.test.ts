import { describe, expect, it } from 'vitest';
import { buildCardDocument } from '../../../../card/document';
import { emptyEdits, setChoices, setLetter } from '../../../../card/edits';
import { cardInputFromData } from '../../../../card/fromData';
import { ptToMm } from '../../../../card/geometry';
import { fictionalView } from '../../__tests__/helpers';
import { BLANK_IMAGE, PREVIEW_QR_URL, buildThumbnailInput, qrSummaryLine } from '../thumbnailInput';

/** A fixed-width fake: 0.5 em per character. */
const measure = (text: string, _font: unknown, sizePt: number) => text.length * 0.5 * ptToMm(sizePt);

describe('buildThumbnailInput', () => {
  it('is null without an editor view', () => {
    expect(buildThumbnailInput(null, emptyEdits())).toBeNull();
    expect(buildThumbnailInput(fictionalView({}, null), emptyEdits())).toBeNull();
  });

  it('draws the pinned edits through the card components\' own input builder', () => {
    const view = fictionalView();
    const pinned = setLetter(emptyEdits(), 'classic', 'Dear friends, a short letter.');
    const input = buildThumbnailInput(view, pinned);
    expect(input).not.toBeNull();
    const cardInput = cardInputFromData(input!.cardData, input!.edits, input!.assetUrl);
    expect(cardInput.letter).toBe('Dear friends, a short letter.');
    expect(cardInput.frontImage.url).toContain('front-1.jpg?sig=1');
    const doc = buildCardDocument(cardInput, measure);
    expect(doc.geometry.pageW).toBeGreaterThan(100);
    expect(doc.back.letter.fit.fits).toBe(true);
  });

  it('an asset the server did not sign draws a blank image, not an empty src', () => {
    const view = fictionalView({}, { assets: {} });
    expect(buildThumbnailInput(view, emptyEdits())!.assetUrl('front-1.jpg')).toBe(BLANK_IMAGE);
  });

  it('an ordered card is drawn from its frozen edits, whatever the queue says', () => {
    const frozen = setLetter(emptyEdits(), 'classic', 'The letter that was printed.');
    const view = fictionalView({ isOrdered: true }, { locked: true, edits: frozen });
    const input = buildThumbnailInput(view, setLetter(emptyEdits(), 'classic', 'Something else'));
    expect(cardInputFromData(input!.cardData, input!.edits, input!.assetUrl).letter).toBe('The letter that was printed.');
  });

  it('QR: on when the film is ready, off when the buyer turned it off, off when the link was revoked', () => {
    expect(buildThumbnailInput(fictionalView(), emptyEdits())!.qrOn).toBe(true);
    const off = setChoices(emptyEdits(), { qr: false });
    expect(buildThumbnailInput(fictionalView({}, { edits: off, qrState: 'off' }), off)!.qrOn).toBe(false);
    expect(buildThumbnailInput(fictionalView({ linkDisabled: true }, { qrState: 'off' }), emptyEdits())!.qrOn).toBe(false);
    expect(buildThumbnailInput(fictionalView({}, { qrState: 'unavailable' }), emptyEdits())!.qrOn).toBe(false);
  });

  it('a QR with no link yet is drawn with a placeholder link (the preview only)', () => {
    const view = fictionalView();
    const data = view.editorView!.cardData;
    const noUrl = { ...view, editorView: { ...view.editorView!, cardData: { ...data, qr: { ...data.qr, url: '' } } } };
    expect(buildThumbnailInput(noUrl, emptyEdits())!.cardData.qr.url).toBe(PREVIEW_QR_URL);
  });
});

describe('qrSummaryLine', () => {
  it('says what the back will carry', () => {
    expect(qrSummaryLine({ qrOn: true, qrState: 'on' })).toBe('QR code to your film on the back.');
    expect(qrSummaryLine({ qrOn: false, qrState: 'off' })).toBe('No QR code on the back.');
    expect(qrSummaryLine({ qrOn: true, qrState: 'waiting_film' })).toMatch(/still being made/);
  });
});
