/**
 * Tracks whether a `ShopHeader` is mounted. The header folds the handoff's
 * "Signed in as … · Not you?" info into itself, so the floating chip (which
 * covers a page's sticky bottom bar on phones) renders only on pages that have
 * no header.
 */
let count = 0;
const listeners = new Set<() => void>();

export function registerHeader(): () => void {
  count += 1;
  for (const l of listeners) l();
  return () => {
    count -= 1;
    for (const l of listeners) l();
  };
}

export function subscribeHeaderPresence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasHeader(): boolean {
  return count > 0;
}
