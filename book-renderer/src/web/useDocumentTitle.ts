import { useEffect } from 'react';

/**
 * Sets `document.title` for as long as this component stays mounted, then
 * restores whatever title was in place immediately before it took over —
 * the previous screen's own title, or (if nothing had claimed it yet)
 * `web.html`'s static `"Momora — Book"` fallback, which is what a pre-auth
 * visitor (`LoginScreen`, or the brief auth-loading state in `App.tsx`)
 * always sees since neither of those screens calls this hook.
 *
 * `title` is `null` while the caller has nothing concrete to show yet (e.g.
 * `BookViewScreen` before its book has loaded) — the hook is a no-op in that
 * case, deliberately leaving whatever title is already showing (the static
 * fallback, or the previous screen's) rather than flashing a placeholder.
 */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
