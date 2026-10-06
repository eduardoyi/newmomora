import { useCallback, useEffect, useState } from 'react';
import { registerCardFonts } from './cardFonts';

/** Registers the aliased card fonts once; `error` when any face failed (the editor cannot measure honestly without them). */
export function useCardFonts(): { status: 'loading' | 'ready' | 'error'; retry: () => void } {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    registerCardFonts().then(
      () => !cancelled && setState('ready'),
      () => !cancelled && setState('error'),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status: state, retry };
}

/** The element's live width. A callback ref because the stage only mounts after the card has loaded. */
export function useElementWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return undefined;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

/** A coarse "now" that ticks (for the "taking longer than usual" copy). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** A live `matchMedia` match (false where matchMedia does not exist). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** Phone-width viewport: front/back toggle and tap-to-zoom on the front. */
export function useIsPhone(): boolean {
  return useMediaQuery('(max-width: 700px)');
}

/** Touch-first device: text editing uses the full-width sheet that follows the keyboard. */
export function useIsTouch(): boolean {
  return useMediaQuery('(pointer: coarse)');
}

export interface ViewportBox {
  /** The visible viewport (shrinks when the keyboard opens). */
  height: number;
  offsetTop: number;
  /** The soft keyboard is (probably) open. */
  keyboardOpen: boolean;
}

/** `window.visualViewport`, so a fixed sheet can follow the keyboard instead of hiding behind it. */
export function useVisualViewport(active: boolean): ViewportBox {
  const read = (): ViewportBox => {
    const vv = window.visualViewport;
    const height = vv ? vv.height : window.innerHeight;
    return { height, offsetTop: vv ? vv.offsetTop : 0, keyboardOpen: window.innerHeight - height > 120 };
  };
  const [box, setBox] = useState<ViewportBox>(read);
  useEffect(() => {
    if (!active) return undefined;
    const vv = window.visualViewport;
    const on = () => setBox(read());
    on();
    vv?.addEventListener('resize', on);
    vv?.addEventListener('scroll', on);
    window.addEventListener('resize', on);
    return () => {
      vv?.removeEventListener('resize', on);
      vv?.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  return box;
}
