import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

/**
 * Pure-JS PDF inspection for the card print path (docs/plans/holiday-cards-p1.md
 * Step 5): replaces `pdffonts` / page-size probing so the render service image
 * needs no poppler. The local `card:pdf` CLI keeps poppler for its extra raster
 * and report output; this module is what both paths and the service rely on.
 */

export interface PdfPageInfo {
  widthPt: number;
  heightPt: number;
  /** Any of these boxes on a card page is a defect: Gelato shifted the art when TrimBox was set. */
  extraBoxes: string[];
}

export interface PdfFontInfo {
  subtype: string;
  embedded: boolean;
}

export interface PdfInspection {
  pages: PdfPageInfo[];
  fonts: PdfFontInfo[];
  type3Count: number;
  notEmbeddedCount: number;
  /** At least one font, none Type 3, every one embedded. */
  fontsEmbedded: boolean;
}

const PAGE_BOX_KEYS = ['TrimBox', 'BleedBox', 'ArtBox', 'CropBox'] as const;
const FONT_SUBTYPES = new Set(['Type1', 'MMType1', 'TrueType', 'Type3', 'CIDFontType0', 'CIDFontType2']);
const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;

function nameOf(dict: PDFDict, key: string): string | null {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : null;
}

function pageSize(page: PDFDict): { width: number; height: number } | null {
  const box = page.lookup(PDFName.of('MediaBox'));
  if (!(box instanceof PDFArray) || box.size() !== 4) return null;
  const n = [0, 1, 2, 3].map((i) => {
    const v = box.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : Number.NaN;
  });
  if (n.some(Number.isNaN)) return null;
  return { width: Math.abs(n[2] - n[0]), height: Math.abs(n[3] - n[1]) };
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const doc = await PDFDocument.load(bytes);

  const pages: PdfPageInfo[] = doc.getPages().map((p) => {
    const size = pageSize(p.node) ?? { width: p.getWidth(), height: p.getHeight() };
    return {
      widthPt: size.width,
      heightPt: size.height,
      extraBoxes: PAGE_BOX_KEYS.filter((k) => p.node.has(PDFName.of(k))),
    };
  });

  const fonts: PdfFontInfo[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (nameOf(obj, 'Type') !== 'Font') continue;
    const subtype = nameOf(obj, 'Subtype');
    // Type0 is a wrapper: its descendant CIDFont dictionaries carry the descriptor and are enumerated on their own.
    if (!subtype || !FONT_SUBTYPES.has(subtype)) continue;
    if (subtype === 'Type3') {
      fonts.push({ subtype, embedded: false });
      continue;
    }
    const descriptor = obj.lookup(PDFName.of('FontDescriptor'));
    const embedded = descriptor instanceof PDFDict && FONT_FILE_KEYS.some((k) => descriptor.has(PDFName.of(k)));
    fonts.push({ subtype, embedded });
  }

  const type3Count = fonts.filter((f) => f.subtype === 'Type3').length;
  const notEmbeddedCount = fonts.filter((f) => f.subtype !== 'Type3' && !f.embedded).length;
  return { pages, fonts, type3Count, notEmbeddedCount, fontsEmbedded: fonts.length > 0 && type3Count === 0 && notEmbeddedCount === 0 };
}
