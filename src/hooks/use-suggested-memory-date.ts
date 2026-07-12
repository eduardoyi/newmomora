import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';

import { deriveSuggestedMemoryDate } from '@/utils/media-capture-date';
import { todayIsoDate } from '@/utils/dates';

export type MemoryDateSource = 'default' | 'media' | 'user';

interface AttachmentWithCaptureDate {
  capturedAtIso?: string;
}

interface UseSuggestedMemoryDateOptions {
  attachments: readonly AttachmentWithCaptureDate[];
}

interface UseSuggestedMemoryDateResult {
  memoryDate: string;
  setMemoryDate: (isoDate: string) => void;
  dateSource: MemoryDateSource;
}

interface State {
  memoryDate: string;
  dateSource: MemoryDateSource;
}

type Action =
  | { type: 'media'; date: string }
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

  return { memoryDate: action.date, dateSource: action.type };
}

/**
 * Derives the new-memory date pill's value from attached library photos'
 * EXIF capture dates, while remaining fully overridable by the user.
 *
 * - The session baseline (`today`, at mount) is captured once via a lazy
 *   initializer so it never drifts if the screen stays open across
 *   midnight.
 * - `memoryDate` and `dateSource` live in one reducer/state object so they
 *   can never be observed in an inconsistent combination.
 * - While `dateSource !== 'user'`, a non-null derived suggestion applies
 *   with source `'media'`; a null suggestion (no dated photo attached)
 *   restores the session baseline with source `'default'`.
 * - `setMemoryDate` is the only way to reach source `'user'`; after that,
 *   attachment changes never touch `memoryDate` again for the life of this
 *   hook instance.
 */
export function useSuggestedMemoryDate({
  attachments,
}: UseSuggestedMemoryDateOptions): UseSuggestedMemoryDateResult {
  const [baselineDate] = useState(() => todayIsoDate());
  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): State => ({ memoryDate: baselineDate, dateSource: 'default' }),
  );

  // Depending on the derived ISO string (not `attachments` array identity)
  // means a reorder that keeps the same earliest date triggers no dispatch.
  const suggestedIso = useMemo(
    () => deriveSuggestedMemoryDate(attachments),
    [attachments],
  );

  useEffect(() => {
    if (suggestedIso) {
      dispatch({ type: 'media', date: suggestedIso });
    } else {
      dispatch({ type: 'default', date: baselineDate });
    }
  }, [suggestedIso, baselineDate]);

  const setMemoryDate = useCallback((isoDate: string) => {
    dispatch({ type: 'user', date: isoDate });
  }, []);

  return {
    memoryDate: state.memoryDate,
    setMemoryDate,
    dateSource: state.dateSource,
  };
}
