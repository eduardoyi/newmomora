import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { emptyEdits, type CardEdits } from '../../card/edits';
import { saveCardEdits } from './cardApi';
import { needsRefetchAfterSave } from './editorState';
import { EditQueue, type EditUpdater, type QueueSnapshot, type ServerRead } from './editQueue';

/**
 * ONE save queue per card, mounted above both the editor and the checkout
 * screen so edits survive moving between them (and Order can wait for the
 * flush). The server state comes in as `server` (from `useHolidayCard`); the
 * queue keeps the user's pending changes as updater functions and rebases them
 * onto each fresh read.
 */

export interface CardEditsContextValue extends QueueSnapshot {
  /** False until the first server read with an editor view arrived. */
  ready: boolean;
  update: (fn: EditUpdater, opts?: { tag?: string }) => void;
  /** Saves everything now; resolves when the queue settles. Check `idle` / `error` afterwards. */
  flush: () => Promise<void>;
  /** Live (not render-time) idle check: use it right after `await flush()`. */
  isIdle: () => boolean;
  retry: () => Promise<void>;
  discard: () => void;
  dismissReloaded: () => void;
}

const CardEditsContext = createContext<CardEditsContextValue | null>(null);

const NOT_READY: QueueSnapshot = {
  edits: emptyEdits(),
  idle: true,
  saving: false,
  error: null,
  checkoutOpen: false,
  locked: false,
  reloaded: false,
  rejection: null,
  serverVersion: -1,
};

export function CardEditsProvider({
  cardId,
  server,
  fetchServer,
  onSaved,
  children,
}: {
  cardId: string;
  /** The latest server edits + version (null before the first editor view). */
  server: ServerRead | null;
  /** A fresh server read for the queue (timeouts and conflicts refetch through this). */
  fetchServer: () => Promise<ServerRead | null>;
  /** After a save changed the QR choice or the front photo: refetch `get` for the new `qrState` / sharp front. */
  onSaved?: () => void;
  children: ReactNode;
}) {
  // Latest props for the queue's long-lived callbacks.
  const fetchRef = useRef(fetchServer);
  fetchRef.current = fetchServer;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const [queue] = useState(
    () =>
      new EditQueue(
        { edits: emptyEdits(), version: -1 },
        {
          save: (expectedVersion: number, edits: CardEdits) => saveCardEdits(cardId, expectedVersion, edits).then((r) => ({ version: r.editsVersion, edits: r.edits })),
          refetch: () => fetchRef.current(),
          onSaved: (previous, saved) => {
            if (needsRefetchAfterSave(previous, saved)) onSavedRef.current?.();
          },
        },
      ),
  );

  useEffect(() => {
    queue.activate();
    return () => queue.dispose();
  }, [queue]);

  useEffect(() => {
    if (server) queue.ingestServer(server);
  }, [queue, server]);

  const snapshot = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const ready = server !== null;

  // Save what is pending the moment the tab is hidden, and warn before closing with unsaved changes.
  useEffect(() => {
    function onHidden() {
      if (document.visibilityState === 'hidden') void queue.flush();
    }
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!queue.getSnapshot().idle) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [queue]);

  const value: CardEditsContextValue = {
    ...(ready ? snapshot : NOT_READY),
    ready,
    update: queue.update,
    flush: queue.flush,
    isIdle: () => queue.getSnapshot().idle,
    retry: queue.retry,
    discard: queue.discard,
    dismissReloaded: queue.dismissReloaded,
  };
  return <CardEditsContext.Provider value={value}>{children}</CardEditsContext.Provider>;
}

export function useCardEdits(): CardEditsContextValue {
  const ctx = useContext(CardEditsContext);
  if (!ctx) throw new Error('useCardEdits must be used inside a CardEditsProvider');
  return ctx;
}
