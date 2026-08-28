import { useEffect, useState } from 'react';
import { parseManifest, parseOutline } from '../model/loader';
import { fitBook } from '../model/fitter';
import { auditBookDocument, type IntegrityViolation } from '../model/audit';
import type { BookManifest, BookOutline, FitResult } from '../model/types';
import type { BookIndex } from '../vite-plugins/book-index-plugin';

export function useBookIndex() {
  const [index, setIndex] = useState<BookIndex | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/index.json')
      .then((r) => r.json())
      .then((data: BookIndex) => {
        if (!cancelled) setIndex(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { index, error };
}

export interface LoadedBook {
  manifest: BookManifest;
  outline: BookOutline;
  fit: FitResult;
  /** Round-5 item 1: automated content-integrity audit, run once per fit — see `auditBookDocument`. */
  violations: IntegrityViolation[];
}

export function useBook(slug: string | null) {
  const [book, setBook] = useState<LoadedBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slug) {
      setBook(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      fetch(`/${slug}/manifest.json`).then((r) => r.json()),
      fetch(`/${slug}/book.outline.json`).then((r) => r.json()),
    ])
      .then(([manifestRaw, outlineRaw]) => {
        if (cancelled) return;
        const manifest = parseManifest(manifestRaw);
        const outline = parseOutline(outlineRaw);
        const fit = fitBook(outline, manifest);
        const violations = auditBookDocument(fit.document, outline, manifest);
        setBook({ manifest, outline, fit, violations });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  return { book, error, loading };
}
