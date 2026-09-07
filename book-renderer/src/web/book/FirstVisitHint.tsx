import { useState } from 'react';
import './FirstVisitHint.css';

/**
 * Owner-approved round-3 polish, item 6: a small dismissible bar explaining
 * the always-on inline-editing affordances (`EditOverlay.tsx`) the first
 * time an editor opens a book's view. English copy matches this app's own
 * existing UI-copy convention — every other web-app string (`PickerSheet`,
 * `FocalPointModal`, `TextEditPopover`, `SkippedEditsToast`,
 * `BookViewScreen` itself: "Choose a photo", "Loading photos…", "Back to
 * your books", ...) is English, regardless of the book's own `manifest.
 * language` (Spanish "furniture" copy is book CONTENT, not app chrome —
 * `templates/furniture.ts`'s own doc comment draws that same distinction).
 *
 * Dismissal is remembered in `localStorage`, globally (not per-book) — once
 * an owner has seen this once, on any book, it stays dismissed. Every
 * read/write is guarded in try/catch: a private-mode/disabled-storage
 * browser simply sees the hint again next visit, never an error.
 */
const DISMISS_KEY = 'momora:bookEditHintDismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // Storage unavailable (private mode, disabled, quota) — the hint simply
    // reappears next visit, never a hard failure.
  }
}

export function FirstVisitHint() {
  const [dismissed, setDismissed] = useState(() => readDismissed());

  if (dismissed) return null;

  return (
    <div className="first-visit-hint" role="status">
      <span className="first-visit-hint__message">Click any text to edit it · hover a photo to replace or reposition</span>
      <button
        type="button"
        className="first-visit-hint__close"
        aria-label="Dismiss"
        onClick={() => {
          writeDismissed();
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
