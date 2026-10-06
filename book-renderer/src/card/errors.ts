/**
 * Typed print-render failures (docs/plans/holiday-cards-p1.md Step 5). The card
 * print page (`print/CardPrintApp.tsx`) reports a hard failure through
 * `data-print-error` + `data-print-error-code`; `scripts/lib/renderCardPdf.ts`
 * rethrows it as a `CardRenderError` carrying the same code, which the render
 * service maps to a 422 the shop can show ("the letter is too long for this size").
 *
 *   LETTER_OVERFLOW  the letter does not fit its readable minimum on the back
 *   SAFE_MARGIN      text/QR/portrait closer to the trim than the safe margin
 *   IMAGE_MISSING    a picture the card references is absent, unreadable or undecodable
 *   IMAGE_LOW_RES    the front picture is below the caller's minimum effective dpi
 *   PAGE_SIZE        the PDF's page count/size/boxes are not the format's exact size
 *   FONTS            the vendored print faces did not load, or the PDF has non-embedded / Type 3 fonts
 *   BAD_INPUT        the card document or edits are malformed
 */
export const CARD_ERROR_CODES = ['LETTER_OVERFLOW', 'SAFE_MARGIN', 'IMAGE_MISSING', 'IMAGE_LOW_RES', 'PAGE_SIZE', 'FONTS', 'BAD_INPUT'] as const;
export type CardErrorCode = (typeof CARD_ERROR_CODES)[number];

export function isCardErrorCode(value: unknown): value is CardErrorCode {
  return typeof value === 'string' && (CARD_ERROR_CODES as readonly string[]).includes(value);
}

/** A content problem with a code; messages carry counts, sizes and ids only, never letter text, names or URLs. */
export class CardRenderError extends Error {
  readonly code: CardErrorCode;
  constructor(code: CardErrorCode, message: string) {
    super(message);
    this.name = 'CardRenderError';
    this.code = code;
  }
}
