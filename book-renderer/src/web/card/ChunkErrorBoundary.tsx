import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reloadOnce, RELOAD_STORAGE_KEY } from './chunkError';

/**
 * Catches a lazy chunk that failed to load (a tab left open across a deploy)
 * and offers a reload instead of a blank page. Wrap any `React.lazy` subtree
 * with it: `CardRouteLazy` does, and `CardRoute` wraps the checkout's output.
 */

function browserReloadDeps() {
  return {
    read: () => window.sessionStorage.getItem(RELOAD_STORAGE_KEY),
    write: (v: string) => window.sessionStorage.setItem(RELOAD_STORAGE_KEY, v),
    reload: () => window.location.reload(),
    now: () => Date.now(),
  };
}

let preloadListenerRegistered = false;

/** Vite fires `vite:preloadError` when a dynamic import's preload fails: reload once (rate-limited). Registered once per page. */
export function registerPreloadErrorReload(): void {
  if (preloadListenerRegistered || typeof window === 'undefined') return;
  preloadListenerRegistered = true;
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    reloadOnce(browserReloadDeps());
  });
}

interface State {
  error: unknown;
}

export class ChunkErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('unknown') };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // A stale tab: try one automatic reload (rate-limited); the button covers the rest.
    if (isChunkLoadError(error)) {
      try {
        reloadOnce(browserReloadDeps());
      } catch {
        // The button below is the fallback.
      }
    }
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const stale = isChunkLoadError(error);
    return (
      <div className="app-boot" role="alert" style={{ flexDirection: 'column', gap: 12, textAlign: 'center', padding: 24 }}>
        <p>{stale ? 'The shop was updated.' : 'Something went wrong.'}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ font: 'inherit', fontWeight: 600, padding: '10px 20px', borderRadius: 999, border: 0, background: '#4a3f6b', color: '#fff', cursor: 'pointer' }}
        >
          Reload
        </button>
      </div>
    );
  }
}
