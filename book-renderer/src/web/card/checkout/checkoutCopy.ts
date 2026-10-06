/**
 * Static copy for the card checkout (one place to change it), in the voice of
 * the Memory Book checkout (`order/CheckoutScreen.tsx`). The delivery note comes
 * from the server (`holiday_card_settings.ship_by_note`).
 */

/**
 * The server's ship-by note (`holiday-cards get` -> `shipByNote`), shown only
 * for US addresses (it is about Christmas delivery in the US). Nothing when the
 * server sends none, or the address is Canadian.
 */
export function shipByNoteFor(note: string | null | undefined, countryCode: string | null | undefined): string | null {
  const text = note?.trim();
  if (!text || countryCode === 'CA') return null;
  return text;
}

export const PRICE_NOTE = '$2.49 per card · shipping included · plus tax';

/** The book's "edits freeze at payment" line, said for a card (shown on every step, like the book's). */
export const FREEZE_NOTICE = 'Your card prints exactly as it looks right now. Once you pay, it can no longer be edited, but you can order more copies of it later.';

/** A reorder prints what was printed the first time. */
export const REORDER_NOTICE = 'These will be printed exactly like the card you ordered before.';
