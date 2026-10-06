import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { inspectPdf } from '../cardPdfChecks';
import { CARD_ERROR_CODES, CardRenderError, isCardErrorCode } from '../../../src/card/errors';

// Synthetic PDFs only (no card data): exercise the pure-JS checks the render
// service relies on instead of poppler's pdffonts/pdfimages.

const MM = 72 / 25.4;

async function pdfWith(register: (doc: PDFDocument) => void, size: [number, number] = [185.8 * MM, 135 * MM]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage(size);
  register(doc);
  return doc.save();
}

function embeddedFont(doc: PDFDocument, subtype: 'TrueType' | 'CIDFontType2' | 'Type1', fontFileKey: 'FontFile' | 'FontFile2' | 'FontFile3') {
  const file = doc.context.register(doc.context.flateStream(new Uint8Array([1, 2, 3, 4])));
  const descriptor = doc.context.register(doc.context.obj({ Type: 'FontDescriptor', FontName: 'ABCDEF+Fake', [fontFileKey]: file }));
  doc.context.register(doc.context.obj({ Type: 'Font', Subtype: subtype, BaseFont: 'ABCDEF+Fake', FontDescriptor: descriptor }));
}

describe('inspectPdf', () => {
  it('reads each page MediaBox size in pt', async () => {
    const info = await inspectPdf(await pdfWith(() => {}));
    expect(info.pages).toHaveLength(1);
    expect(info.pages[0].widthPt).toBeCloseTo(185.8 * MM, 2);
    expect(info.pages[0].heightPt).toBeCloseTo(135 * MM, 2);
    expect(info.pages[0].extraBoxes).toEqual([]);
  });

  it('a PDF with no fonts is not "fonts embedded" (a card always has text)', async () => {
    const info = await inspectPdf(await pdfWith(() => {}));
    expect(info.fonts).toEqual([]);
    expect(info.fontsEmbedded).toBe(false);
  });

  it('accepts embedded TrueType / CID / Type1 font programs', async () => {
    const bytes = await pdfWith((doc) => {
      embeddedFont(doc, 'TrueType', 'FontFile2');
      embeddedFont(doc, 'CIDFontType2', 'FontFile2');
      embeddedFont(doc, 'Type1', 'FontFile3');
    });
    const info = await inspectPdf(bytes);
    expect(info.fonts.map((f) => f.subtype).sort()).toEqual(['CIDFontType2', 'TrueType', 'Type1']);
    expect(info.fonts.every((f) => f.embedded)).toBe(true);
    expect(info.fontsEmbedded).toBe(true);
  });

  it('flags a standard (non-embedded) font', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('hello', { font, size: 12 });
    const info = await inspectPdf(await doc.save());
    expect(info.notEmbeddedCount).toBe(1);
    expect(info.fontsEmbedded).toBe(false);
  });

  it('flags Type 3 fonts even next to embedded ones', async () => {
    const bytes = await pdfWith((doc) => {
      embeddedFont(doc, 'TrueType', 'FontFile2');
      doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1, 1], FontMatrix: [1, 0, 0, 1, 0, 0] }));
    });
    const info = await inspectPdf(bytes);
    expect(info.type3Count).toBe(1);
    expect(info.fontsEmbedded).toBe(false);
  });

  it('ignores the Type0 wrapper and judges its descendant CIDFont', async () => {
    const bytes = await pdfWith((doc) => {
      embeddedFont(doc, 'CIDFontType2', 'FontFile2');
      doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'ABCDEF+Fake', Encoding: 'Identity-H' }));
    });
    const info = await inspectPdf(bytes);
    expect(info.fonts).toHaveLength(1);
    expect(info.fontsEmbedded).toBe(true);
  });

  it('reports TrimBox/BleedBox (they shifted the art at Gelato) but not the MediaBox', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([527, 383]);
    page.setTrimBox(11, 11, 505, 361);
    page.node.set(PDFName.of('BleedBox'), doc.context.obj([0, 0, 527, 383]));
    const info = await inspectPdf(await doc.save());
    expect(info.pages[0].extraBoxes.sort()).toEqual(['BleedBox', 'TrimBox']);
  });
});

describe('CardRenderError', () => {
  it('carries a known code', () => {
    const e = new CardRenderError('LETTER_OVERFLOW', 'letter does not fit');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('LETTER_OVERFLOW');
  });

  it('isCardErrorCode accepts exactly the contract codes', () => {
    for (const c of CARD_ERROR_CODES) expect(isCardErrorCode(c)).toBe(true);
    expect([...CARD_ERROR_CODES].sort()).toEqual(['BAD_INPUT', 'FONTS', 'IMAGE_LOW_RES', 'IMAGE_MISSING', 'LETTER_OVERFLOW', 'PAGE_SIZE', 'SAFE_MARGIN']);
    expect(isCardErrorCode('NOPE')).toBe(false);
    expect(isCardErrorCode(null)).toBe(false);
  });
});
