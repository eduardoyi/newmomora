import type { MemoryBookEditsShape } from '../../model/edits';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defensive normalization of `memory_book_edits.edits` as read by THIS
 * client — the row's jsonb default is `'{}'`, and a category (`text`/
 * `images`/`focalPoints`) may simply be absent on a row saved before some
 * edit kind existed. Mirrors `memory-book-edits/index.ts`'s own
 * `normalizeEdits` (server-side, un-importable from this browser package —
 * see `edits.ts`'s header comment on the deliberate decoupled mirror), but
 * against `model/edits.ts`'s `MemoryBookEditsShape` (whose categories are
 * already `?:`), so this just guards against `undefined`/malformed input,
 * never throws.
 */
export function normalizeEditsShapeForClient(raw: unknown): MemoryBookEditsShape {
  if (!isPlainObject(raw)) return {};
  const out: MemoryBookEditsShape = {};
  if (isPlainObject(raw.text)) out.text = raw.text as MemoryBookEditsShape['text'];
  if (isPlainObject(raw.images)) out.images = raw.images as MemoryBookEditsShape['images'];
  if (isPlainObject(raw.focalPoints)) out.focalPoints = raw.focalPoints as MemoryBookEditsShape['focalPoints'];
  return out;
}
