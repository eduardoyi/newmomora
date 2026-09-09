import { supabase } from '../supabaseClient';
import { COVER_SLOT_KEY, type FocalPointEditRecord, type ImageEditRecord, type MemoryBookEditsShape, type SkippedEdit, type TextEditRecord } from '../../model/edits';
import { getFixtureSlug, fixtureFetchPickerPool, fixtureSaveEdit } from '../dev/fixture';

/**
 * Thin client for the `memory-book-edits` Edge Function (plan Step 2,
 * `supabase/functions/memory-book-edits/index.ts`) — every write to
 * `memory_book_edits` goes through here; nothing in this app writes that
 * table directly (RLS wouldn't allow it anyway — client SELECT-only).
 */

export type SaveEditInput =
  | { kind: 'text'; target: string; value: string }
  | { kind: 'imageReplace'; slot: string; mediaId: string }
  | { kind: 'coverPhoto'; mediaId: string }
  | { kind: 'focalPoint'; slot: string; x: number; y: number }
  /** "Reset to original" (owner-approved follow-up round, item 3a) — removes
   * one key from one category of the saved `edits`. Mirrors
   * `memory-book-edits/index.ts`'s identically-shaped `delete` variant. */
  | { kind: 'delete'; category: 'text' | 'images' | 'focalPoints'; key: string };

/**
 * One-shot toast-undo bookkeeping (owner-approved follow-up round, item 3b):
 * every edit-surface component (`TextEditPopover`, `PickerSheet`,
 * `FocalPointModal`) reports the record that occupied this exact
 * category/key BEFORE the save/reset it just made — `null` when there was
 * none (the ordinary "first edit on this field" case). `undoSaveInput`
 * below turns that back into a `SaveEditInput` an "Undo" button can replay:
 * restore the prior record if there was one, else delete the key again (a
 * reset can itself be undone this way). No multi-level history — the caller
 * (`BookViewScreen`) keeps at most ONE pending `UndoAction` at a time,
 * always overwritten by the next save.
 */
export type UndoAction =
  | { category: 'text'; key: string; previous: TextEditRecord | null }
  | { category: 'images'; key: string; previous: ImageEditRecord | null }
  | { category: 'focalPoints'; key: string; previous: FocalPointEditRecord | null };

export function undoSaveInput(action: UndoAction): SaveEditInput {
  if (!action.previous) {
    return { kind: 'delete', category: action.category, key: action.key };
  }
  switch (action.category) {
    case 'text':
      return { kind: 'text', target: action.key, value: action.previous.value };
    case 'images':
      return action.key === COVER_SLOT_KEY
        ? { kind: 'coverPhoto', mediaId: action.previous.mediaId }
        : { kind: 'imageReplace', slot: action.key, mediaId: action.previous.mediaId };
    case 'focalPoints':
      return { kind: 'focalPoint', slot: action.key, x: action.previous.x, y: action.previous.y };
  }
}

/**
 * `SkippedEditsToast`'s "Remove" action (owner-approved follow-up round,
 * item 1): turns one orphaned `SkippedEdit` (from `edits.ts`'s
 * `applyPreFit`/`applyPostFit` — a saved edit whose stable key no longer
 * resolves) into the `delete` input that permanently drops it from the row.
 * `SkippedEdit.kind` and `SaveEditInput`'s `delete.category` use different
 * vocab for the same three buckets ('image' vs 'images', 'focalPoint' vs
 * 'focalPoints') because `SkippedEdit` names the KIND of edit while
 * `MemoryBookEditsShape`'s categories name the jsonb column's own map keys
 * (`text`/`images`/`focalPoints`) — this is the one place that translation
 * needs to happen.
 */
export function skippedDeleteInput(skipped: SkippedEdit): SaveEditInput {
  const category = skipped.kind === 'text' ? 'text' : skipped.kind === 'image' ? 'images' : 'focalPoints';
  return { kind: 'delete', category, key: skipped.key };
}

export interface SaveEditResult {
  edits: MemoryBookEditsShape;
  error: string | null;
}

export async function saveEdit(bookId: string, edit: SaveEditInput): Promise<SaveEditResult> {
  // DEV-ONLY fixture mode (owner-approved follow-up round) — see
  // `dev/fixture.ts`'s header comment for the tree-shaking contract.
  if (import.meta.env.DEV) {
    const fixtureSlug = getFixtureSlug();
    if (fixtureSlug && fixtureSlug === bookId) return fixtureSaveEdit(fixtureSlug, edit);
  }
  const { data, error } = await supabase.functions.invoke<{ success: true; edits: MemoryBookEditsShape }>(
    'memory-book-edits',
    { body: { op: 'save_edit', bookId, edit } },
  );
  if (error) {
    return { edits: {}, error: await describeFunctionError(error) };
  }
  return { edits: data?.edits ?? {}, error: null };
}

export interface PickerPoolItem {
  memoryId: string;
  mediaId: string;
  previewKey: string;
  date: string;
  aspectRatio: number | null;
  alreadyInBook: boolean;
}

export interface PickerPoolPage {
  items: PickerPoolItem[];
  nextCursor: string | null;
  error: string | null;
}

/** Item 1 (owner-approved editing-UX round): optional `picker_pool`
 * narrowing filters — mirrors the Edge Function's own optional
 * `dateStart`/`dateEnd`/`memberId` request fields exactly (see
 * `memory-book-edits/index.ts`'s `handlePickerPool`). All three absent is
 * the pre-existing, unfiltered contract — no behavior change for a caller
 * that never passes this second argument. */
export interface PickerPoolFilters {
  /** ISO `YYYY-MM-DD`, inclusive. */
  dateStart?: string;
  /** ISO `YYYY-MM-DD`, inclusive. */
  dateEnd?: string;
  memberId?: string;
}

export async function fetchPickerPool(
  bookId: string,
  cursor: string | null,
  filters: PickerPoolFilters = {},
): Promise<PickerPoolPage> {
  if (import.meta.env.DEV) {
    const fixtureSlug = getFixtureSlug();
    if (fixtureSlug && fixtureSlug === bookId) return fixtureFetchPickerPool(fixtureSlug, cursor, filters);
  }
  const { data, error } = await supabase.functions.invoke<{ items: PickerPoolItem[]; nextCursor: string | null }>(
    'memory-book-edits',
    { body: { op: 'picker_pool', bookId, cursor, ...filters } },
  );
  if (error) {
    return { items: [], nextCursor: null, error: await describeFunctionError(error) };
  }
  return { items: data?.items ?? [], nextCursor: data?.nextCursor ?? null, error: null };
}

/** supabase-js's `FunctionsHttpError` carries the real JSON body (our
 * `{ error, code }` shape) on `.context` (a `Response`) rather than in
 * `.message` (which is a generic "non-2xx status code" string) — same
 * unwrap the app's own `mapFunctionError` skips because it doesn't need the
 * body text, but this UI wants the real message to show the parent (e.g.
 * "Memory book is not ready to edit"). */
async function describeFunctionError(error: { message: string; context?: unknown }): Promise<string> {
  const context = error.context;
  if (context && typeof context === 'object' && 'json' in context && typeof (context as Response).json === 'function') {
    try {
      const body = await (context as Response).json();
      if (body && typeof body.error === 'string') return body.error;
    } catch {
      // Fall through to the generic message.
    }
  }
  return error.message;
}
