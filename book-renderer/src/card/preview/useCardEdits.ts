import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyEdits, normalizeEdits, type CardEdits } from '../edits';

/**
 * The editor's edits store (local preview): loads `card-data/<slug>/edits.json`
 * (falling back to localStorage), and saves every change back through the dev
 * server (`PUT /api/card-edits/<slug>`, debounced) so `card:pdf --saved` prints
 * the same card. In P1 this hook is replaced by a database-backed one with the
 * same `(edits, update)` contract.
 */
const storageKey = (slug: string) => `momora-card-edits:${slug}`;

export function useCardEdits(slug: string | null): { edits: CardEdits; ready: boolean; update: (fn: (e: CardEdits) => CardEdits) => void; saveError: boolean } {
  const [edits, setEdits] = useState<CardEdits>(emptyEdits());
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const timer = useRef<number | null>(null);
  const latest = useRef(edits);
  latest.current = edits;

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      let loaded: CardEdits | null = null;
      try {
        const r = await fetch(`/${slug}/edits.json?ts=${Date.now()}`);
        if (r.ok) loaded = normalizeEdits(await r.json());
      } catch {
        // none saved yet
      }
      if (!loaded) {
        try {
          const raw = window.localStorage.getItem(storageKey(slug));
          if (raw) loaded = normalizeEdits(JSON.parse(raw));
        } catch {
          // storage unavailable
        }
      }
      if (!cancelled) {
        setEdits(loaded ?? emptyEdits());
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const persist = useCallback(
    (next: CardEdits) => {
      if (!slug) return;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        const body = JSON.stringify(next, null, 2);
        try {
          const r = await fetch(`/api/card-edits/${slug}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
          if (!r.ok) throw new Error(String(r.status));
          setSaveError(false);
        } catch {
          setSaveError(true);
        }
        try {
          window.localStorage.setItem(storageKey(slug), body);
        } catch {
          // storage unavailable
        }
      }, 350);
    },
    [slug],
  );

  const update = useCallback(
    (fn: (e: CardEdits) => CardEdits) => {
      const next = fn(latest.current);
      latest.current = next;
      setEdits(next);
      persist(next);
    },
    [persist],
  );

  return { edits, ready, update, saveError };
}
