import type { BookManifest, BookOutline, ManifestMemory, OutlineElement } from './types';

/**
 * Loaders are intentionally light-touch: the manifest/outline are produced
 * by a trusted internal pipeline (Stage A/B export script), not user input.
 * We validate just enough structure to fail loudly and early on a shape
 * mismatch, rather than let `undefined` silently propagate into the fitter.
 */

export class BookDataError extends Error {}

export function parseManifest(raw: unknown): BookManifest {
  if (!raw || typeof raw !== 'object') {
    throw new BookDataError('manifest.json is not an object');
  }
  const m = raw as Partial<BookManifest>;
  if (!m.child?.id || !m.child?.name) {
    throw new BookDataError('manifest.child.{id,name} is required');
  }
  if (!m.memories || typeof m.memories !== 'object') {
    throw new BookDataError('manifest.memories map is required');
  }
  if (!Array.isArray(m.portraits)) {
    throw new BookDataError('manifest.portraits must be an array');
  }
  return m as BookManifest;
}

export function parseOutline(raw: unknown): BookOutline {
  if (!raw || typeof raw !== 'object') {
    throw new BookDataError('book.outline.json is not an object');
  }
  const o = raw as Partial<BookOutline>;
  if (!Array.isArray(o.elements)) {
    throw new BookDataError('outline.elements must be an array');
  }
  for (const el of o.elements) {
    if (!el.id || !el.kind) {
      throw new BookDataError(`outline element missing id/kind: ${JSON.stringify(el)}`);
    }
    if (!Array.isArray(el.memoryIds)) {
      throw new BookDataError(`outline element ${el.id} missing memoryIds[]`);
    }
  }
  // `coverCandidates` (data contract addition, owner review 2026-08-31) is
  // optional and absent on every outline.json produced before this landed —
  // tolerant of absence, same as `heroCandidates`/`panoramaCandidates`. A
  // PRESENT-but-malformed value is still rejected loudly, matching this
  // loader's "fail early on a shape mismatch" posture.
  if (o.coverCandidates !== undefined && !Array.isArray(o.coverCandidates)) {
    throw new BookDataError('outline.coverCandidates must be an array when present');
  }
  return o as BookOutline;
}

/** Resolves a memory id to its manifest record, or null if the export dropped it. */
export function resolveMemory(manifest: BookManifest, memoryId: string): ManifestMemory | null {
  return manifest.memories[memoryId] ?? null;
}

/** Resolves an outline element's memoryIds to manifest records, skipping any missing. */
export function resolveElementMemories(
  manifest: BookManifest,
  element: OutlineElement,
): Array<{ id: string; memory: ManifestMemory }> {
  const out: Array<{ id: string; memory: ManifestMemory }> = [];
  for (const id of element.memoryIds) {
    const memory = resolveMemory(manifest, id);
    if (memory) out.push({ id, memory });
  }
  return out;
}

/**
 * Convenience for asset URL resolution relative to a book's own directory.
 *
 * Contract note: manifest `file` values (both `memories[].assets[].file` and
 * `portraits[].file`) already include the `assets/` prefix (e.g.
 * `"assets/photo.jpg"`), per the data-export agent's implementation of the
 * manifest contract. Do NOT prepend `assets/` here — that would double it up
 * into `/slug/assets/assets/photo.jpg` and 404.
 */
function staticAssetUrl(bookSlug: string, file: string): string {
  return `/${bookSlug}/${file}`;
}

export type AssetUrlProvider = (bookSlug: string, file: string) => string;

let assetUrlProvider: AssetUrlProvider = staticAssetUrl;

/**
 * Design Decision 8 (memory-book-5b plan, "Pluggable asset resolution"):
 * swaps how every template resolves a manifest `file` value into an
 * `<img src>`. Default (never called, or called with `null`) is
 * `staticAssetUrl` above — untouched, so the print entry (`print.html`) and
 * the local preview entry (`index.html`) never call this and keep their
 * byte-identical static asset URLs; the template snapshot suite is
 * unaffected by this module existing.
 *
 * Deliberately module-level state, not a prop threaded through every
 * template (`TemplateProps` stays `{ page, manifest, bookSlug, showGuides
 * }`) — per the plan's own documented constraint, the ONLY caller expected
 * to use this (the future web app, `src/web/`) renders exactly one book's
 * templates on screen at a time; the book LIST there is plain thumbnails
 * resolved through its own media coalescer, never these photo templates.
 * A caller that swaps between books MUST swap the provider first and guard
 * whatever async work it resolves through it against a stale book id
 * itself — this module has no way to do that guarding; it only ever calls
 * whichever provider is currently set, synchronously, at render time.
 */
export function setAssetUrlProvider(provider: AssetUrlProvider | null): void {
  assetUrlProvider = provider ?? staticAssetUrl;
}

export function assetUrl(bookSlug: string, file: string): string {
  return assetUrlProvider(bookSlug, file);
}
