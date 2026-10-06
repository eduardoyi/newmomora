/**
 * Hang guard for `supabase.functions.invoke` (owner-hit 2026-09-09: an
 * infinite "Getting your quote…" spinner). `invoke` can fail to settle at
 * all — supabase-js serializes the pre-flight auth-token refresh through a
 * cross-tab `navigator.locks` lock that is known to deadlock with the same
 * origin open in other tabs, and neither it nor a stalled network request
 * carries any timeout of its own. Racing the invoke against a cap turns any
 * such hang into the `TIMED_OUT` sentinel the callers map to an ordinary
 * error with a retry path.
 *
 * Lives in its own module (no Supabase import) so it can be unit-tested;
 * `order/ordersApi.ts` re-exports it unchanged. The default stays 45 s, which
 * comfortably exceeds the server's own 30 s upstream timeout, so a
 * slow-but-alive server still answers first with its more specific error.
 */
export const INVOKE_TIMEOUT_MS = 45_000;
export const TIMED_OUT = Symbol('invoke-timed-out');

export async function raceInvokeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = INVOKE_TIMEOUT_MS,
): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
