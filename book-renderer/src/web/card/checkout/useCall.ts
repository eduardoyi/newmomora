import { useEffect, useRef } from 'react';

/**
 * Runs one async call per `run` while `active`, and delivers its result once.
 * StrictMode-safe: React's dev double-invoked effect would otherwise fire the
 * call twice (a stray draft order, a second quote), or deliver to a cleaned-up
 * subscriber and drop the result. The promise is cached per `run` in a ref
 * (it survives the simulated remount) and every effect invocation SUBSCRIBES
 * to it, the same pattern the book checkout uses for `create_draft`.
 *
 * `start` / `onOk` / `onErr` always run their latest closure.
 */
export function useCall<T>(active: boolean, run: number, start: () => Promise<T>, onOk: (value: T) => void, onErr: (error: unknown) => void): void {
  const cache = useRef<{ run: number; promise: Promise<T> } | null>(null);
  const latest = useRef({ start, onOk, onErr });
  latest.current = { start, onOk, onErr };

  useEffect(() => {
    if (!active) return undefined;
    if (cache.current?.run !== run) cache.current = { run, promise: latest.current.start() };
    let cancelled = false;
    cache.current.promise.then(
      (value) => {
        if (!cancelled) latest.current.onOk(value);
      },
      (error: unknown) => {
        if (!cancelled) latest.current.onErr(error);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, run]);
}
