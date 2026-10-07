// One-shot toast hand-off to the Keepsakes tab (docs/plans/keepsakes-redesign.md
// D2). A product page sets the text just before it leaves; the tab consumes it
// on focus. A module store rather than a route param: the tab never unmounts,
// so a param could re-show the same toast on every focus.
let pendingText: string | null = null;

export function setPendingKeepsakesToast(text: string): void {
  pendingText = text;
}

/** Returns the pending toast text once, then clears it. */
export function consumePendingKeepsakesToast(): string | null {
  const text = pendingText;
  pendingText = null;
  return text;
}
