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

/** A video or a format a browser `<img>` cannot show (HEIC): never a tile picture. */
const NOT_DISPLAYABLE = /\.(mp4|mov|m4v|webm|avi|heic|heif)$/i;

/** At most this many keys are asked about per book (a first choice that cannot be signed falls through to the next). */
export const MAX_THUMBNAIL_CANDIDATES = 4;

/**
 * Ordered, de-duplicated candidate keys for a ready book's tile: the
 * denormalized `cover_asset_key` first, then the cover candidates' own photos,
 * then the first photo of other memories. The list asks the signer about all of
 * them and uses the first that comes back signed, because `get-media-url`
 * silently omits any key it cannot authorize (a video poster, a replaced
 * photo): a single unsigned first choice must not leave the tile blank.
 */
export function pickListThumbnailCandidates(
  book: { cover_asset_key?: string | null; book_document: { outline: unknown; manifest: unknown } | null },
  max: number = MAX_THUMBNAIL_CANDIDATES,
): string[] {
  const out: string[] = [];
  const add = (key: unknown) => {
    if (typeof key === 'string' && key.length > 0 && !NOT_DISPLAYABLE.test(key) && !out.includes(key)) out.push(key);
  };
  add(book.cover_asset_key);
  const doc = book.book_document;
  if (doc) {
    const outline = doc.outline as { coverCandidates?: unknown } | null;
    const manifest = doc.manifest as { memories?: Record<string, { assets?: Array<{ file?: unknown }> }> } | null;
    const memories = manifest?.memories && typeof manifest.memories === 'object' ? manifest.memories : null;
    if (memories) {
      const candidates = Array.isArray(outline?.coverCandidates) ? (outline!.coverCandidates as unknown[]) : [];
      for (const id of candidates) {
        if (typeof id !== 'string') continue;
        for (const asset of memories[id]?.assets ?? []) add(asset?.file);
      }
      for (const memory of Object.values(memories)) add(memory?.assets?.[0]?.file);
    }
  }
  return out.slice(0, max);
}

/** The first candidate that has a signed URL. */
export function firstSignedKey(candidates: readonly string[], urls: ReadonlyMap<string, string>): string | null {
  for (const key of candidates) if (urls.has(key)) return key;
  return null;
}
