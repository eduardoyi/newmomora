import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { deriveSuggestedMemoryDate } from '@/utils/media-capture-date';
import { todayIsoDate } from '@/utils/dates';

export type MemoryDateSource = 'default' | 'media' | 'user';

interface AttachmentWithCaptureDate {
  capturedAtIso?: string;
}

/** Where a `'media'` suggestion came from: an attachment's capture date or an imported voice note. */
export type MemoryDateSuggestionKind = 'media' | 'audio';

interface UseSuggestedMemoryDateOptions {
  attachments: readonly AttachmentWithCaptureDate[];
  /**
   * `YYYY-MM-DD` suggested by an imported voice note (file-name or container
   * date). Behaves like an attachment-derived date (`dateSource: 'media'`),
   * never like a user edit. A memory is either media or a sound, so the two
   * normally can't coexist; if both are somehow present, attachments win.
   */
  audioCapturedAtIso?: string | null;
}

interface UseSuggestedMemoryDateResult {
  memoryDate: string;
  setMemoryDate: (isoDate: string) => void;
  dateSource: MemoryDateSource;
  /** What produced the current suggestion; null unless `dateSource === 'media'`. */
  suggestionKind: MemoryDateSuggestionKind | null;
}

interface State {
  memoryDate: string;
  dateSource: MemoryDateSource;
  suggestionKind: MemoryDateSuggestionKind | null;
}

type Action =
  | { type: 'media'; date: string; kind: MemoryDateSuggestionKind }
  | { type: 'default'; date: string }
  | { type: 'user'; date: string };

// Once the source is 'user', every later media/default action is rejected --
// this is the guardrail that makes the manual override robust to queued
// effects (an in-flight suggestion recompute landing after the user already
// picked a date) and to later attachment add/remove/reorder/replacement.
function reducer(state: State, action: Action): State {
  if (state.dateSource === 'user' && action.type !== 'user') {
    return state;
  }

  return {
    memoryDate: action.date,
    dateSource: action.type,
    suggestionKind: action.type === 'media' ? action.kind : null,
  };
}

/**
 * Derives the new-memory date pill's value from attached media's capture-date
 * scalar, regardless of whether it came from a library picker or OS share,
 * while remaining fully overridable by the user.
 *
 * - The session baseline (`today`, at mount) is captured once via a lazy
 *   initializer so it never drifts if the screen stays open across
 *   midnight.
 * - `memoryDate` and `dateSource` live in one reducer/state object so they
 *   can never be observed in an inconsistent combination.
 * - While `dateSource !== 'user'`, a non-null derived suggestion applies
 *   with source `'media'`; a null suggestion (no dated media attached)
 *   restores the session baseline with source `'default'`. An imported voice
 *   note's date (`audioCapturedAtIso`) is a `'media'` suggestion too, with
 *   `suggestionKind: 'audio'` so the pill can say where it came from.
 * - `setMemoryDate` is the only way to reach source `'user'`; after that,
 *   attachment changes never touch `memoryDate` again for the life of this
 *   hook instance.
 */
export function useSuggestedMemoryDate({
  attachments,
  audioCapturedAtIso = null,
}: UseSuggestedMemoryDateOptions): UseSuggestedMemoryDateResult {
  const [baselineDate] = useState(() => todayIsoDate());
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): State => ({ memoryDate: baselineDate, dateSource: 'default', suggestionKind: null }),
  );

  // Depending on the derived ISO string (not `attachments` array identity)
  // means a reorder that keeps the same earliest date triggers no dispatch.
  const attachmentIso = useMemo(
    () => deriveSuggestedMemoryDate(attachments),
    [attachments],
  );
  // Same strict calendar validation as an attachment's date. Future dates are
  // already dropped by `pickImportedMemoryDate` before they reach this hook.
  const audioIso = useMemo(
    () => (audioCapturedAtIso ? deriveSuggestedMemoryDate([{ capturedAtIso: audioCapturedAtIso }]) : null),
    [audioCapturedAtIso],
  );
  const suggestedIso = attachmentIso ?? audioIso;
  const suggestionKind: MemoryDateSuggestionKind | null = attachmentIso ? 'media' : audioIso ? 'audio' : null;

  useEffect(() => {
    if (suggestedIso && suggestionKind) {
      dispatch({ type: 'media', date: suggestedIso, kind: suggestionKind });
    } else {
      dispatch({ type: 'default', date: baselineDate });
    }
  }, [suggestedIso, suggestionKind, baselineDate]);

  const setMemoryDate = useCallback((isoDate: string) => {
    dispatch({ type: 'user', date: isoDate });
  }, []);

  return {
    memoryDate: state.memoryDate,
    setMemoryDate,
    dateSource: state.dateSource,
    suggestionKind: state.suggestionKind,
  };
}
