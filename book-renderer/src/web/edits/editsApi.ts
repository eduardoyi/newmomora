import { supabase } from '../supabaseClient';
import type { MemoryBookEditsShape } from '../../model/edits';

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
  | { kind: 'focalPoint'; slot: string; x: number; y: number };

export interface SaveEditResult {
  edits: MemoryBookEditsShape;
  error: string | null;
}

export async function saveEdit(bookId: string, edit: SaveEditInput): Promise<SaveEditResult> {
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

export async function fetchPickerPool(
  bookId: string,
  cursor: string | null,
): Promise<PickerPoolPage> {
  const { data, error } = await supabase.functions.invoke<{ items: PickerPoolItem[]; nextCursor: string | null }>(
    'memory-book-edits',
    { body: { op: 'picker_pool', bookId, cursor } },
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
