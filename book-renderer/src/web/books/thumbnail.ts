/**
 * Picks ONE representative R2 object key for a ready book's list-row
 * thumbnail — a PLAIN `<img>`, never the photo templates (plan Design
 * Decision 8: "the book LIST uses plain thumbnails via the coalescer,
 * never photo templates" — the templates render exactly one book at a
 * time, keyed to the single module-level `assetUrlProvider`). Prefers the
 * outline's own `coverCandidates[0]` (the same photo the real cover would
 * pick, ownership-honest for what the family will actually see on the
 * cover), falling back to the first photo asset found on any memory when
 * the outline has none (an older export, or a cover-photo edit not yet
 * reflected in this raw `book_document` — the list doesn't run
 * `applyPreFit`, so an edited cover photo shows up here only after the
 * next full manifest fetch, which is an acceptable list-thumbnail
 * staleness, not a correctness bug in the book itself).
 */
export function pickListThumbnailKey(bookDocument: { outline: unknown; manifest: unknown } | null): string | null {
  if (!bookDocument) return null;
  const outline = bookDocument.outline as { coverCandidates?: unknown } | null;
  const manifest = bookDocument.manifest as { memories?: Record<string, { assets?: Array<{ file?: unknown }> }> } | null;
  if (!manifest?.memories || typeof manifest.memories !== 'object') return null;

  const coverCandidates = Array.isArray(outline?.coverCandidates) ? (outline!.coverCandidates as unknown[]) : [];
  for (const candidateId of coverCandidates) {
    if (typeof candidateId !== 'string') continue;
    const memory = manifest.memories[candidateId];
    const file = memory?.assets?.[0]?.file;
    if (typeof file === 'string') return file;
  }

  for (const memory of Object.values(manifest.memories)) {
    const file = memory?.assets?.[0]?.file;
    if (typeof file === 'string') return file;
  }

  return null;
}
