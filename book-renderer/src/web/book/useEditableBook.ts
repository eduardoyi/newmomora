import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import type { MemoryBookRow, MemoryBookEditsRow } from '../types';
import { parseManifest, parseOutline } from '../../model/loader';
import { fitBook } from '../../model/fitter';
import { applyPostFit, applyPreFit } from '../../model/edits';
import { saveEdit, undoSaveInput, type UndoAction } from '../edits/editsApi';
import { normalizeEditsShapeForClient } from './normalizeEdits';
import type { BookDocument, BookManifest } from '../../model/types';
import type { MemoryBookEditsShape, SkippedEdit } from '../../model/edits';
import { getFixtureSlug, loadFixtureBook, registerFixturePool } from '../dev/fixture';

export interface EditableBook {
  book: MemoryBookRow;
  /** The manifest AFTER `applyPreFit` — what asset-key collection and the
   * fitter itself actually ran against (see `media/manifestKeys.ts`). */
  editedManifest: BookManifest;
  document: BookDocument;
  edits: MemoryBookEditsShape;
  skipped: SkippedEdit[];
  canEdit: boolean;
}

interface State {
  loading: boolean;
  error: string | null;
  data: EditableBook | null;
}

/**
 * Loads one book + its saved edits and runs the full render pipeline the
 * plan specifies (Step 6): `book_document -> applyPreFit -> fitBook ->
 * applyPostFit -> existing spread pager`. Re-derives the document whenever
 * `edits` changes (including the optimistic update `applyEditsPatch` makes
 * right after a successful `save_edit` — Design Decision "optimistic
 * re-render": the SERVER's own returned `edits` object is applied
 * immediately, no extra round trip needed to see the change).
 */
export function useEditableBook(bookId: string | null) {
  const [state, setState] = useState<State>({ loading: true, error: null, data: null });
  const [editsOverride, setEditsOverride] = useState<MemoryBookEditsShape | null>(null);

  const load = useCallback(async () => {
    if (!bookId) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    setEditsOverride(null);
    setPendingUndo(null);

    // DEV-ONLY fixture mode (owner-approved follow-up round) — bypasses
    // every Supabase read below entirely when `?fixture=<slug>` names THIS
    // bookId (see `App.tsx`: fixture mode always passes the slug itself as
    // `bookId`). `getFixtureSlug()` — and this whole block — is dead code
    // in a production build (`import.meta.env.DEV` is statically `false`
    // there; see `dev/fixture.ts`'s header comment for the tree-shaking
    // contract `check-web-bundle.mjs` verifies).
    if (import.meta.env.DEV) {
      const fixtureSlug = getFixtureSlug();
      if (fixtureSlug && fixtureSlug === bookId) {
        try {
          const { book, manifest, outline } = await loadFixtureBook(fixtureSlug);
          registerFixturePool(fixtureSlug, manifest);
          const built = buildDocument(outline, manifest, {});
          setState({ loading: false, error: null, data: { book, canEdit: true, ...built } });
        } catch (e) {
          setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to load fixture book', data: null });
        }
        return;
      }
    }

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id ?? null;

    const [{ data: bookRow, error: bookError }, { data: editsRow, error: editsError }] = await Promise.all([
      supabase
        .from('memory_books')
        .select('id, family_id, child_id, status, scope_label, failure_reason, created_at, updated_at, book_document, child:family_members(name)')
        .eq('id', bookId)
        .maybeSingle(),
      supabase.from('memory_book_edits').select('book_id, family_id, edits, updated_at').eq('book_id', bookId).maybeSingle(),
    ]);

    if (bookError) {
      setState({ loading: false, error: bookError.message, data: null });
      return;
    }
    if (!bookRow) {
      setState({ loading: false, error: 'Book not found, or you do not have access to it.', data: null });
      return;
    }
    const book = bookRow as unknown as MemoryBookRow;

    let canEdit = false;
    if (userId) {
      const { data: membership } = await supabase
        .from('family_memberships')
        .select('role')
        .eq('family_id', book.family_id)
        .eq('user_id', userId)
        .maybeSingle();
      canEdit = membership?.role === 'owner' || membership?.role === 'manager';
    }

    if (book.status !== 'ready' || !book.book_document) {
      setState({
        loading: false,
        error: null,
        data: {
          book,
          editedManifest: { child: { id: '', name: '' }, scope: { kind: '', label: '', start: '', end: '' }, generatedAt: '', outlineRun: '', memories: {}, portraits: [] },
          document: { childName: '', scopeLabel: '', pages: [], totalPages: 0 },
          edits: {},
          skipped: [],
          canEdit,
        },
      });
      return;
    }

    if (editsError) {
      setState({ loading: false, error: editsError.message, data: null });
      return;
    }

    const edits = normalizeEditsShapeForClient((editsRow as unknown as MemoryBookEditsRow | null)?.edits);

    try {
      const outline = parseOutline(book.book_document.outline);
      const manifest = parseManifest(book.book_document.manifest);
      const built = buildDocument(outline, manifest, edits);
      setState({ loading: false, error: null, data: { book, canEdit, ...built } });
    } catch (e) {
      setState({ loading: false, error: e instanceof Error ? e.message : 'Failed to render book', data: null });
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-derive the document whenever an optimistic edits patch lands, without
  // re-fetching the book row.
  const data = useMemo(() => {
    if (!state.data || !editsOverride) return state.data;
    if (!state.data.book.book_document) return state.data;
    try {
      const outline = parseOutline(state.data.book.book_document.outline);
      const manifest = parseManifest(state.data.book.book_document.manifest);
      const built = buildDocument(outline, manifest, editsOverride);
      return { ...state.data, ...built };
    } catch {
      return state.data;
    }
  }, [state.data, editsOverride]);

  /** Applies a fresh, server-authoritative `edits` object (the `save_edit`
   * response) immediately — the "optimistic re-render" the plan calls for:
   * the parent sees its change reflected without a second fetch. */
  const applyEditsPatch = useCallback((nextEdits: MemoryBookEditsShape) => {
    setEditsOverride(nextEdits);
  }, []);

  // Owner-approved round-3 polish, item 3b: one-shot toast-undo bookkeeping.
  // `pendingUndo` is the SINGLE most recent `UndoAction` any edit surface
  // reported alongside its save — a fresh save always REPLACES it (no
  // multi-level history), and a successful/attempted undo always clears it
  // (one-shot: undoing never itself becomes undoable).
  const [pendingUndo, setPendingUndo] = useState<UndoAction | null>(null);
  const [undoing, setUndoing] = useState(false);

  const handleEditsSaved = useCallback(
    (nextEdits: MemoryBookEditsShape, undo: UndoAction) => {
      applyEditsPatch(nextEdits);
      setPendingUndo(undo);
    },
    [applyEditsPatch],
  );

  const handleUndo = useCallback(async () => {
    if (!bookId || !pendingUndo || undoing) return;
    setUndoing(true);
    const result = await saveEdit(bookId, undoSaveInput(pendingUndo));
    setUndoing(false);
    setPendingUndo(null);
    if (!result.error) applyEditsPatch(result.edits);
  }, [bookId, pendingUndo, undoing, applyEditsPatch]);

  const dismissUndo = useCallback(() => setPendingUndo(null), []);

  return { ...state, data, reload: load, applyEditsPatch, handleEditsSaved, pendingUndo, undoing, handleUndo, dismissUndo };
}

function buildDocument(outline: ReturnType<typeof parseOutline>, manifest: ReturnType<typeof parseManifest>, edits: MemoryBookEditsShape) {
  const pre = applyPreFit(outline, manifest, edits);
  const fit = fitBook(pre.outline, pre.manifest);
  const post = applyPostFit(fit.document, edits);
  return {
    editedManifest: pre.manifest,
    document: post.document,
    edits,
    skipped: [...pre.skipped, ...post.skipped],
  };
}
